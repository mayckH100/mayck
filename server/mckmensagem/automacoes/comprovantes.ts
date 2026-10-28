import { inflateSync } from 'node:zlib';
import { prisma } from '../../db.js';
import { sendMail } from '../../lib/mailer.js';
import { ABERTOS, evento, recalcularBoleto, saldoDe, valorDevido } from './financeiro.js';
import { salvarArquivo, sha256, lerConteudo } from './arquivos.js';
import { brl } from './vars.js';
import type { Arquivo, Boleto, Comprovante, Contact } from '@prisma/client';

/**
 * Identificação de comprovantes (seção 9). Recursos 100% gratuitos e locais:
 *  - texto da legenda/mensagem + texto extraído de PDFs (fluxos FlateDecode) quando possível;
 *  - extração de valor, data, identificador da transação (E2E do Pix, autenticação) e instituição;
 *  - comparação com os boletos em aberto do cliente e nível de confiança (0–100).
 * Sem OCR de imagem (exigiria serviço pago ou biblioteca pesada): imagens dependem da legenda e da revisão humana.
 * Receber comprovante só inicia a análise: a baixa exige aprovação (ou baixa manual) — nunca é automática.
 */

const BANCOS = ['Nubank', 'Itaú', 'Itau', 'Bradesco', 'Santander', 'Caixa', 'Banco do Brasil', 'Inter', 'C6', 'PicPay', 'Mercado Pago', 'Sicoob', 'Sicredi', 'BTG', 'Original', 'Neon', 'PagBank', 'PagSeguro', 'Safra', 'Banrisul', 'Next', 'Stone', 'Cora'];
const PALAVRAS = /comprovante|\bpix\b|transfer[eê]ncia|pagamento|\bpago\b|paguei|quitad|autentica[cç][aã]o|recibo/i;

/** Texto de um PDF (melhor esforço): descomprime os fluxos e junta as strings dos operadores Tj/TJ. */
export function textoDoPdf(buf: Buffer): string {
  const s = buf.toString('latin1');
  const out: string[] = [];
  let total = 0;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s)) && n++ < 300 && total < 2_000_000) {
    const ini = m.index + m[0].length;
    const fim = s.indexOf('endstream', ini);
    if (fim < 0) break;
    const raw = Buffer.from(s.slice(ini, fim), 'latin1');
    let dec: string;
    try { dec = inflateSync(raw).toString('latin1'); } catch { dec = raw.toString('latin1'); }
    total += dec.length;
    const strs = dec.match(/\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[(?:[^\]]*)\]\s*TJ/g) ?? [];
    for (const t of strs) {
      const partes = t.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
      out.push(partes.map((p) => p.slice(1, -1).replace(/\\([nrtbf()\\])/g, (_x, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '' } as Record<string, string>)[c] ?? c)).join(''));
    }
    re.lastIndex = fim;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 20000);
}

const centavos = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);

export interface Extracao { valores: number[]; datas: string[]; transacaoId: string | null; instituicao: string | null; palavraChave: boolean; digitos: string }

export function extrair(texto: string): Extracao {
  const t = texto ?? '';
  let valores = [...t.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/g)].map((x) => centavos(x[1]));
  if (!valores.length) valores = [...t.matchAll(/(?:valor|total|pago)[^\d]{0,20}(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/gi)].map((x) => centavos(x[1]));
  const datas = [...t.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map((x) => `${x[3]}-${x[2]}-${x[1]}`);
  const e2e = t.match(/\bE\d{8}[A-Za-z0-9]{23}\b/);
  const aut = t.match(/(?:ID da transa[cç][aã]o|Autentica[cç][aã]o|Protocolo|NSU|C[oó]digo da transa[cç][aã]o)[:\s]*([A-Za-z0-9.\-]{6,60})/i);
  const banco = BANCOS.find((b) => new RegExp(`\\b${b.replace(/ /g, '\\s+')}\\b`, 'i').test(t)) ?? null;
  return { valores: [...new Set(valores.filter((v) => v > 0))], datas: [...new Set(datas)], transacaoId: e2e?.[0] ?? aut?.[1] ?? null, instituicao: banco, palavraChave: PALAVRAS.test(t), digitos: t.replace(/\D/g, '') };
}

export interface Identificacao { boleto: Boleto | null; confianca: number; motivos: string[] }

/** Compara a extração com os boletos em aberto do cliente e calcula o nível de confiança. */
export function identificar(ex: Extracao, boletos: Boleto[], clienteIdentificado: boolean): Identificacao {
  const motivos: string[] = [];
  if (clienteIdentificado) motivos.push('Remetente identificado como cliente cadastrado');
  else motivos.push('Remetente não vinculado a um cliente');
  let melhor: { b: Boleto; s: number; m: string[] } | null = null;
  const empates: Boleto[] = [];
  const ordenados = [...boletos].sort((a, b) => a.vencimento.getTime() - b.vencimento.getTime());
  for (const b of ordenados) {
    let s = 0; const m: string[] = [];
    const ld = (b.linhaDigitavel ?? '').replace(/\D/g, '');
    const cb = (b.codigoBarras ?? '').replace(/\D/g, '');
    if (ld.length >= 20 && ex.digitos.includes(ld)) { s += 60; m.push('Linha digitável confere'); }
    else if (cb.length >= 20 && ex.digitos.includes(cb)) { s += 60; m.push('Código de barras confere'); }
    if (b.numeroDocumento && b.numeroDocumento.replace(/\D/g, '').length >= 4 && ex.digitos.includes(b.numeroDocumento.replace(/\D/g, ''))) { s += 25; m.push('Número do documento confere'); }
    if (ex.valores.includes(saldoDe(b)) || ex.valores.includes(valorDevido(b))) { s += 40; m.push(`Valor confere (${brl(saldoDe(b))})`); }
    if (!s) continue;
    if (!melhor || s > melhor.s) { melhor = { b, s, m }; empates.length = 0; } else if (s === melhor.s) empates.push(b);
  }
  let confianca = clienteIdentificado ? 30 : 0;
  if (melhor) {
    motivos.push(...melhor.m);
    if (empates.length) motivos.push('Mais de um boleto confere: escolhida a parcela em aberto mais antiga — confira');
    confianca += Math.min(70, melhor.s) - (empates.length ? 20 : 0);
    if (ex.valores.length && !melhor.m.some((x) => x.startsWith('Valor'))) motivos.push(`Valor do comprovante (${ex.valores.map(brl).join(', ')}) diferente do saldo da parcela`);
    return { boleto: melhor.b, confianca: Math.max(0, Math.min(100, confianca)), motivos };
  }
  if (ordenados.length === 1 && clienteIdentificado) {
    motivos.push('Único boleto em aberto do cliente (nenhum dado do comprovante confere): baixa confiança');
    if (ex.valores.length) motivos.push(`Valor encontrado: ${ex.valores.map(brl).join(', ')}`);
    return { boleto: ordenados[0], confianca: confianca + 10, motivos };
  }
  motivos.push(ordenados.length ? 'Nenhum boleto em aberto confere com os dados do comprovante: inconclusivo' : 'Cliente sem boletos em aberto');
  if (!ex.valores.length) motivos.push('Nenhum valor legível no comprovante');
  return { boleto: null, confianca, motivos };
}

export interface NovoComprovante {
  orgId: string; clienteId?: string | null; boletoId?: string | null; arquivo?: Arquivo | null; origem: 'UPLOAD' | 'WHATSAPP' | 'EMAIL';
  origemId?: string | null; texto?: string | null; operadorId?: string | null; avisoArquivo?: string | null;
}

/** Registra e analisa um comprovante. Atualiza o boleto para "Comprovante em análise" (nunca para pago). */
export async function registrarComprovante(n: NovoComprovante): Promise<Comprovante> {
  let texto = n.texto ?? '';
  let hash: string | null = n.arquivo?.sha256 ?? null;
  if (n.arquivo?.mime === 'application/pdf') {
    try { texto = `${texto}\n${textoDoPdf(await lerConteudo(n.arquivo.id))}`; } catch { /* PDF ilegível: segue para revisão */ }
  }
  const ex = extrair(texto);
  const boletos = n.clienteId ? await prisma.boleto.findMany({ where: { orgId: n.orgId, clienteId: n.clienteId, status: { in: ABERTOS } } }) : [];
  let ident: Identificacao;
  if (n.boletoId) {
    const b = await prisma.boleto.findFirst({ where: { id: n.boletoId, orgId: n.orgId } });
    ident = identificar(ex, b ? [b] : [], !!n.clienteId);
    if (b && !ident.boleto) { ident.boleto = b; ident.motivos.push('Boleto escolhido pelo operador'); }
  } else ident = identificar(ex, boletos, !!n.clienteId);
  if (n.avisoArquivo) ident.motivos.push(n.avisoArquivo);

  // Duplicidade: mesmo arquivo (hash) ou mesmo identificador de transação já recebido.
  const or: any[] = [];
  if (hash) or.push({ sha256: hash });
  if (ex.transacaoId) or.push({ transacaoId: ex.transacaoId });
  const dup = or.length ? await prisma.comprovante.findFirst({ where: { orgId: n.orgId, OR: or }, orderBy: { createdAt: 'asc' } }) : null;
  if (dup) {
    ident.motivos.unshift(dup.sha256 && dup.sha256 === hash ? 'Arquivo idêntico a um comprovante já recebido (duplicado)' : 'Identificador da transação já usado em outro comprovante (duplicado)');
    ident.confianca = Math.min(ident.confianca, 10);
  }
  const c = await prisma.comprovante.create({
    data: {
      orgId: n.orgId, clienteId: n.clienteId ?? null, boletoId: ident.boleto?.id ?? null, arquivoId: n.arquivo?.id ?? null, origem: n.origem, origemId: n.origemId ?? null,
      texto: n.texto?.slice(0, 2000) ?? null, sha256: hash, valorDetectadoCentavos: ex.valores[0] ?? null, dataDetectada: ex.datas[0] ?? null,
      transacaoId: ex.transacaoId, instituicao: ex.instituicao, confianca: ident.confianca, analise: JSON.stringify({ motivos: ident.motivos, valores: ex.valores, datas: ex.datas }),
      duplicadoDeId: dup?.id ?? null, status: 'EM_ANALISE',
    },
  });
  if (ident.boleto) {
    await evento(ident.boleto, 'COMPROVANTE', `Comprovante recebido (${n.origem === 'WHATSAPP' ? 'WhatsApp' : n.origem === 'EMAIL' ? 'e-mail' : 'enviado pelo operador'}), confiança ${ident.confianca}%${dup ? ' — possível duplicado' : ''}. Aguardando conferência.`, { comprovanteId: c.id }, n.operadorId);
    await recalcularBoleto(ident.boleto.id, { operadorId: n.operadorId });
  }
  if (n.origem !== 'UPLOAD') {
    await prisma.mensagemHistorico.create({
      data: {
        orgId: n.orgId, clienteId: n.clienteId ?? null, categoria: 'COBRANCA', canal: n.origem === 'EMAIL' ? 'EMAIL' : 'WHATSAPP', direcao: 'IN',
        conteudo: n.texto?.trim() || `[${n.arquivo?.nome ?? 'arquivo'}]`, status: 'RECEBIDA', enviadoEm: new Date(), provedorId: n.origemId ?? null,
        anexos: n.arquivo ? JSON.stringify([{ arquivoId: n.arquivo.id, nome: n.arquivo.nome }]) : null, boletoId: ident.boleto?.id ?? null, comprovanteId: c.id,
      },
    });
  }
  void notificarAdmins(n.orgId, c, ident).catch(() => undefined);
  return c;
}

/** Notificação administrativa gratuita: e-mail (SMTP já configurado) para proprietários e administradores. */
async function notificarAdmins(orgId: string, c: Comprovante, ident: Identificacao) {
  const cfg = await prisma.automacaoConfig.findUnique({ where: { orgId } });
  if (cfg && !cfg.notificarComprovantes) return;
  const membros = await prisma.membership.findMany({ where: { orgId, role: { in: ['OWNER', 'ADMIN'] } }, include: { user: { select: { email: true, disabledAt: true } } } });
  const cliente = c.clienteId ? await prisma.cliente.findUnique({ where: { id: c.clienteId }, select: { nome: true } }) : null;
  const linhas = [
    `Cliente: ${cliente?.nome ?? 'não identificado'}`,
    `Boleto relacionado: ${ident.boleto ? `${ident.boleto.descricao}${ident.boleto.parcela ? ` — parcela ${ident.boleto.parcela}` : ''}` : 'não identificado'}`,
    `Confiança da identificação: ${c.confianca}%`, ...ident.motivos.map((m) => `• ${m}`), '',
    'O pagamento NÃO foi baixado automaticamente. Confira e aprove ou rejeite em MCK Mensagens → Automações e Cobranças → Comprovantes.',
  ];
  for (const m of membros) {
    if (m.user.disabledAt) continue;
    await sendMail({ to: m.user.email, subject: 'Comprovante de pagamento recebido para conferência', text: linhas.join('\n'), html: linhas.map((l) => `<p>${l.replace(/[<>&]/g, '')}</p>`).join(''), kind: 'comprovante' });
  }
}

const normFone = (v?: string | null) => (v ?? '').replace(/\D/g, '');

/** Cliente vinculado a um contato do WhatsApp (pelo vínculo salvo ou pelo número). */
export async function clienteDoContato(orgId: string, contact: Pick<Contact, 'id' | 'waId' | 'phone'>) {
  const porVinculo = await prisma.cliente.findFirst({ where: { orgId, contactId: contact.id } });
  if (porVinculo) return porVinculo;
  const num = normFone(contact.waId) || normFone(contact.phone);
  if (num.length < 8) return null;
  const e164 = `+${num}`;
  return prisma.cliente.findFirst({ where: { orgId, OR: [{ whatsapp: e164 }, { telefone: e164 }] } });
}

export interface MidiaRecebida { waMessageId: string; type: string; texto: string; baixar: () => Promise<{ dados: Buffer; nome: string; mime?: string }> }

/**
 * Mídia recebida no WhatsApp (imagem ou documento). Vira comprovante em análise quando:
 *  - o remetente é um cliente com boleto em aberto, ou
 *  - a legenda/mensagem fala de pagamento (pix, comprovante, paguei…) e a organização usa o módulo (tem clientes).
 * Falhas aqui nunca interrompem o atendimento (o chamador ignora erros).
 */
export async function receberMidiaWhatsApp(orgId: string, contact: Pick<Contact, 'id' | 'waId' | 'phone'>, m: MidiaRecebida): Promise<Comprovante | null> {
  if (m.type !== 'image' && m.type !== 'document') return null;
  if (await prisma.comprovante.findUnique({ where: { orgId_origemId: { orgId, origemId: m.waMessageId } } })) return null;
  const cliente = await clienteDoContato(orgId, contact);
  const palavra = PALAVRAS.test(m.texto ?? '');
  if (!cliente) {
    if (!palavra || !(await prisma.cliente.count({ where: { orgId } }))) return null;
  } else if (!palavra && !(await prisma.boleto.count({ where: { orgId, clienteId: cliente.id, status: { in: ABERTOS } } }))) return null;
  if (cliente && !cliente.contactId) await prisma.cliente.update({ where: { id: cliente.id }, data: { contactId: contact.id } });

  const cfg = (await prisma.automacaoConfig.findUnique({ where: { orgId } })) ?? { tiposArquivo: 'pdf,png,jpg,webp', tamanhoMaxMb: 10 };
  let arquivo: Arquivo | null = null; let aviso: string | null = null;
  try {
    const f = await m.baixar();
    arquivo = await salvarArquivo({ orgId, nome: f.nome, dados: f.dados, clienteId: cliente?.id ?? null, origem: 'WHATSAPP', descricao: 'Comprovante recebido pelo WhatsApp' }, cfg);
  } catch (e) {
    aviso = `Arquivo não armazenado: ${(e as Error).message}`;
  }
  try {
    return await registrarComprovante({ orgId, clienteId: cliente?.id ?? null, arquivo, origem: 'WHATSAPP', origemId: m.waMessageId, texto: m.texto, avisoArquivo: aviso });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return null; // mesmo evento processado em paralelo
    throw e;
  }
}

export { sha256 };
