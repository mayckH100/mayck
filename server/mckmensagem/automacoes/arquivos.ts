import { createHash } from 'node:crypto';
import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/http.js';
import type { Arquivo, AutomacaoConfig } from '@prisma/client';

/**
 * Armazenamento de arquivos do módulo (boletos, faturas, documentos e comprovantes).
 * O conteúdo fica no próprio Postgres (coluna bytea em ArquivoConteudo): sobrevive a novos deploys no Render Free
 * (o disco de lá é efêmero) e não exige serviço pago de armazenamento. Nada é exposto por link público.
 */

export interface TipoArquivo { ext: string; mime: string; rotulo: string }

/** Tipos suportados (o que a organização aceita é configurável em AutomacaoConfig.tiposArquivo). */
export const TIPOS_SUPORTADOS: Record<string, TipoArquivo> = {
  pdf: { ext: 'pdf', mime: 'application/pdf', rotulo: 'PDF' },
  png: { ext: 'png', mime: 'image/png', rotulo: 'PNG' },
  jpg: { ext: 'jpg', mime: 'image/jpeg', rotulo: 'JPG' },
  webp: { ext: 'webp', mime: 'image/webp', rotulo: 'WEBP' },
  gif: { ext: 'gif', mime: 'image/gif', rotulo: 'GIF' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rotulo: 'Word (DOCX)' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', rotulo: 'Excel (XLSX)' },
  txt: { ext: 'txt', mime: 'text/plain', rotulo: 'Texto (TXT)' },
  csv: { ext: 'csv', mime: 'text/csv', rotulo: 'CSV' },
};
export const MAX_MB_ABSOLUTO = 25;

const startsWith = (b: Buffer, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);

/** Descobre o tipo real pelo conteúdo (assinatura de bytes), não pela extensão informada. */
export function detectarTipo(buf: Buffer, nome = ''): string | null {
  if (buf.length < 4) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (startsWith(buf, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (startsWith(buf, 0xff, 0xd8, 0xff)) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  const ext = extDe(nome);
  if (startsWith(buf, 0x50, 0x4b, 0x03, 0x04)) {
    const s = buf.toString('latin1');
    if (ext === 'docx' && s.includes('word/')) return 'docx';
    if (ext === 'xlsx' && s.includes('xl/')) return 'xlsx';
    return null; // outros ZIP não são aceitos
  }
  if ((ext === 'txt' || ext === 'csv') && !buf.includes(0)) return ext;
  return null;
}

export const extDe = (nome: string) => {
  const e = (nome.split('.').pop() ?? '').toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
};

/** Verificação de segurança básica (gratuita, sem antivírus externo): executáveis e PDF com conteúdo ativo são recusados. */
export function problemaSeguranca(buf: Buffer, tipo: string): string | null {
  if (startsWith(buf, 0x4d, 0x5a) || startsWith(buf, 0x7f, 0x45, 0x4c, 0x46) || buf.subarray(0, 2).toString('latin1') === '#!') return 'Arquivo executável não é permitido';
  if (tipo === 'pdf') {
    const s = buf.toString('latin1');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/.test(s)) return 'PDF com conteúdo ativo (JavaScript, arquivo embutido ou ação de abertura) não é aceito';
  }
  if (tipo === 'docx' || tipo === 'xlsx') {
    if (buf.toString('latin1').includes('vbaProject.bin')) return 'Documento com macros não é aceito';
  }
  return null;
}

export function tiposPermitidos(cfg: Pick<AutomacaoConfig, 'tiposArquivo'>): string[] {
  return cfg.tiposArquivo.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s in TIPOS_SUPORTADOS);
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Nome seguro para download/anexo (sem caminho nem caracteres de controle). */
export function nomeSeguro(nome: string, tipo: string): string {
  const base = (nome.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').trim().slice(0, 120) || 'arquivo';
  return extDe(base) === tipo || (tipo === 'jpg' && /\.jpe?g$/i.test(base)) ? base : `${base}.${tipo}`;
}

export interface NovoArquivo {
  orgId: string; nome: string; dados: Buffer; clienteId?: string | null; origem?: 'UPLOAD' | 'WHATSAPP' | 'EMAIL';
  descricao?: string | null; criadoPorId?: string | null;
}

/** Valida (tipo real, tamanho, segurança, tipos permitidos) e grava. Lança HttpError 400/413 com a explicação. */
export async function salvarArquivo(a: NovoArquivo, cfg: Pick<AutomacaoConfig, 'tiposArquivo' | 'tamanhoMaxMb'>): Promise<Arquivo> {
  if (!a.dados?.length) throw new HttpError(400, 'Arquivo vazio');
  const maxMb = Math.min(MAX_MB_ABSOLUTO, cfg.tamanhoMaxMb);
  if (a.dados.length > maxMb * 1024 * 1024) throw new HttpError(413, `Arquivo maior que o limite de ${maxMb} MB`);
  const tipo = detectarTipo(a.dados, a.nome);
  const permitidos = tiposPermitidos(cfg);
  if (!tipo) throw new HttpError(400, `Tipo de arquivo não reconhecido ou não suportado. Permitidos: ${permitidos.join(', ')}`);
  if (!permitidos.includes(tipo)) throw new HttpError(400, `Tipo ${tipo.toUpperCase()} não está entre os permitidos nas configurações (${permitidos.join(', ')})`);
  const ext = extDe(a.nome);
  if (a.origem !== 'WHATSAPP' && a.origem !== 'EMAIL' && ext && ext in TIPOS_SUPORTADOS && ext !== tipo) {
    throw new HttpError(400, `A extensão .${ext} não corresponde ao conteúdo do arquivo (${tipo.toUpperCase()})`);
  }
  const seg = problemaSeguranca(a.dados, tipo);
  if (seg) throw new HttpError(400, seg);
  if (a.clienteId && !(await prisma.cliente.findFirst({ where: { id: a.clienteId, orgId: a.orgId }, select: { id: true } }))) throw new HttpError(400, 'Cliente inválido');
  const arq = await prisma.arquivo.create({
    data: {
      orgId: a.orgId, clienteId: a.clienteId ?? null, nome: nomeSeguro(a.nome, tipo), mime: TIPOS_SUPORTADOS[tipo].mime, tamanho: a.dados.length,
      sha256: sha256(a.dados), origem: a.origem ?? 'UPLOAD', descricao: a.descricao ?? null, criadoPorId: a.criadoPorId ?? null,
    },
  });
  await prisma.arquivoConteudo.create({ data: { arquivoId: arq.id, dados: new Uint8Array(a.dados) } });
  return arq;
}

export async function getArquivo(orgId: string, id: string): Promise<Arquivo> {
  const a = await prisma.arquivo.findFirst({ where: { id, orgId } });
  if (!a) throw notFound('Arquivo');
  return a;
}

export async function lerConteudo(arquivoId: string): Promise<Buffer> {
  const c = await prisma.arquivoConteudo.findUnique({ where: { arquivoId } });
  if (!c) throw new Error('Conteúdo do arquivo não encontrado');
  return Buffer.from(c.dados);
}

/** Onde o arquivo está em uso (impede excluir documento financeiro vinculado). */
export async function usosDoArquivo(orgId: string, id: string) {
  const [boletos, anexos, comprovantes] = await Promise.all([
    prisma.boleto.count({ where: { orgId, arquivoId: id } }),
    prisma.automacaoAnexo.count({ where: { orgId, arquivoId: id } }),
    prisma.comprovante.count({ where: { orgId, arquivoId: id } }),
  ]);
  return { boletos, anexos, comprovantes, total: boletos + anexos + comprovantes };
}
