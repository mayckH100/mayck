import express, { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, notFound, HttpError, forbidden } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { audit } from '../../lib/audit.js';
import { parseJson } from '../../lib/json.js';
import { localDate, zonedToUtc } from './rules.js';
import { getConfig, reprogramar } from './engine.js';
import { salvarArquivo, getArquivo, lerConteudo, usosDoArquivo, MAX_MB_ABSOLUTO, TIPOS_SUPORTADOS, tiposPermitidos } from './arquivos.js';
import {
  STATUS_BOLETO, ABERTOS, STATUS_LABEL, evento, recalcularBoleto, registrarPagamento, estornarPagamento, interromperCobrancas, saldoDe, valorDevido, estaVencido, vencYmd,
} from './financeiro.js';
import { registrarComprovante } from './comprovantes.js';
import type { Boleto } from '@prisma/client';

/**
 * Automações e Cobranças — FASE 2: arquivos, boletos/parcelas, pagamentos (baixa/estorno), comprovantes e relatórios.
 * Montado dentro de automacoesRouter: herda o bloqueio de escrita para AGENT (somente leitura) e a regra 402 da assinatura.
 */
export const cobrancasRouter = Router();

const ehAdmin = (req: Request) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD');
const reais = z.number().min(0).max(100_000_000);
const cents = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));
const meioDia = (v: string) => new Date(`${v}T12:00:00.000Z`);
const opt = (s: z.ZodString) => s.optional().nullable().or(z.literal(''));
const vazio = (v: unknown) => (v === '' ? null : v);

/** Corpo binário (upload) com limite e erro 413 amigável. O nome vem no cabeçalho x-file-name (URI-encoded). */
const corpoBinario: RequestHandler = (req, res, next) => {
  express.raw({ type: () => true, limit: `${MAX_MB_ABSOLUTO + 1}mb` })(req, res, (err?: any) => {
    if (err) return next(err.type === 'entity.too.large' ? new HttpError(413, `Arquivo maior que o limite de ${MAX_MB_ABSOLUTO} MB`) : new HttpError(400, 'Falha ao ler o arquivo enviado'));
    next();
  });
};
function nomeDoUpload(req: Request) {
  const raw = String(req.header('x-file-name') ?? '');
  try { return decodeURIComponent(raw).slice(0, 200); } catch { return raw.slice(0, 200); }
}
const bufferDe = (req: Request) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

async function getCliente(orgId: string, id: string) {
  const c = await prisma.cliente.findFirst({ where: { id, orgId } });
  if (!c) throw notFound('Cliente');
  return c;
}

// ---------------- Arquivos ----------------

const arquivoView = (a: { id: string; nome: string; mime: string; tamanho: number; clienteId: string | null; origem: string; descricao: string | null; createdAt: Date }) =>
  ({ id: a.id, nome: a.nome, mime: a.mime, tamanho: a.tamanho, clienteId: a.clienteId, origem: a.origem, descricao: a.descricao, createdAt: a.createdAt });

cobrancasRouter.get('/arquivos/tipos', ah(async (req, res) => {
  const cfg = await getConfig(orgOf(req));
  res.json({ suportados: Object.values(TIPOS_SUPORTADOS), permitidos: tiposPermitidos(cfg), tamanhoMaxMb: Math.min(cfg.tamanhoMaxMb, MAX_MB_ABSOLUTO) });
}));

cobrancasRouter.post('/arquivos', corpoBinario, ah(async (req, res) => {
  const q = z.object({ clienteId: z.string().optional(), descricao: z.string().max(200).optional() }).parse(req.query);
  const orgId = orgOf(req);
  const arq = await salvarArquivo({ orgId, nome: nomeDoUpload(req), dados: bufferDe(req), clienteId: q.clienteId || null, descricao: q.descricao || null, criadoPorId: req.auth!.userId }, await getConfig(orgId));
  await audit(req, 'automacoes.arquivo.upload', { entity: 'Arquivo', entityId: arq.id, meta: { nome: arq.nome, tamanho: arq.tamanho, clienteId: arq.clienteId } });
  res.status(201).json(arquivoView(arq));
}));

cobrancasRouter.get('/arquivos', ah(async (req, res) => {
  const q = z.object({ clienteId: z.string().optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId };
  if (q.clienteId) where.clienteId = q.clienteId === 'nenhum' ? null : q.clienteId;
  if (q.q) where.nome = { contains: q.q };
  const [items, total] = await Promise.all([
    prisma.arquivo.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, skip: (q.page - 1) * 50 }),
    prisma.arquivo.count({ where }),
  ]);
  const cIds = [...new Set(items.map((a) => a.clienteId).filter(Boolean) as string[])];
  const nomes = Object.fromEntries((cIds.length ? await prisma.cliente.findMany({ where: { orgId, id: { in: cIds } }, select: { id: true, nome: true } }) : []).map((c) => [c.id, c.nome]));
  res.json({ items: items.map((a) => ({ ...arquivoView(a), cliente: a.clienteId ? nomes[a.clienteId] ?? '(excluído)' : null })), total, page: q.page, pageSize: 50 });
}));

/** Download autenticado (sessão + organização). Nunca há link público permanente; restrito a proprietário/administrador. */
cobrancasRouter.get('/arquivos/:id/download', ah(async (req, res) => {
  if (!ehAdmin(req)) throw forbidden('Download de documentos restrito a administradores');
  const orgId = orgOf(req);
  const a = await getArquivo(orgId, req.params.id);
  const dados = await lerConteudo(a.id);
  await audit(req, 'automacoes.arquivo.download', { entity: 'Arquivo', entityId: a.id });
  res.setHeader('content-type', a.mime);
  res.setHeader('content-length', String(dados.length));
  res.setHeader('content-disposition', `${req.query.inline === '1' && /^(image\/|application\/pdf)/.test(a.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.nome)}`);
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.end(dados);
}));

/** Remoção mediante permissão: só o proprietário, e só se o arquivo não estiver vinculado a boleto, automação ou comprovante. */
cobrancasRouter.delete('/arquivos/:id', ah(async (req, res) => {
  if (req.auth?.role !== 'OWNER') throw forbidden('Somente o proprietário pode excluir arquivos');
  const orgId = orgOf(req);
  const a = await getArquivo(orgId, req.params.id);
  const u = await usosDoArquivo(orgId, a.id);
  if (u.total) throw new HttpError(409, `Arquivo em uso (${u.boletos} boleto(s), ${u.anexos} automação(ões), ${u.comprovantes} comprovante(s)). Remova o vínculo antes — documentos financeiros não são apagados silenciosamente.`);
  await prisma.arquivoConteudo.deleteMany({ where: { arquivoId: a.id } });
  await prisma.arquivo.delete({ where: { id: a.id } });
  await audit(req, 'automacoes.arquivo.delete', { entity: 'Arquivo', entityId: a.id, meta: { nome: a.nome } });
  res.json({ ok: true });
}));

// ---------------- Boletos ----------------

const boletoSchema = z.object({
  clienteId: z.string().min(1),
  descricao: z.string().trim().min(1, 'Informe a descrição').max(200),
  numeroDocumento: opt(z.string().trim().max(60)),
  parcela: z.number().int().min(1).max(600).optional().nullable(),
  totalParcelas: z.number().int().min(1).max(600).optional().nullable(),
  valor: reais.refine((v) => v > 0, 'Informe um valor maior que zero'),
  valorAtualizado: reais.optional().nullable(),
  juros: reais.optional().nullable(),
  multa: reais.optional().nullable(),
  desconto: reais.optional().nullable(),
  emissao: ymd.optional().nullable().or(z.literal('')),
  vencimento: ymd,
  codigoBarras: opt(z.string().trim().max(80)),
  linhaDigitavel: opt(z.string().trim().max(80)),
  linkPagamento: opt(z.string().trim().url('Link de pagamento inválido').max(500)),
  arquivoId: z.string().optional().nullable().or(z.literal('')),
  observacoes: opt(z.string().max(4000)),
  rascunho: z.boolean().optional(),
});

async function validarArquivoBoleto(orgId: string, arquivoId: string | null | undefined, clienteId: string) {
  if (!arquivoId) return null;
  const a = await getArquivo(orgId, arquivoId);
  if (a.clienteId && a.clienteId !== clienteId) throw new HttpError(400, 'O arquivo pertence a outro cliente');
  if (!a.clienteId) await prisma.arquivo.update({ where: { id: a.id }, data: { clienteId } }); // vincula ao dono do boleto
  return a.id;
}

function boletoData(b: Partial<z.infer<typeof boletoSchema>>) {
  const d: any = {};
  for (const k of ['descricao', 'parcela', 'totalParcelas'] as const) if (b[k] !== undefined) d[k] = b[k];
  for (const k of ['numeroDocumento', 'codigoBarras', 'linhaDigitavel', 'linkPagamento', 'observacoes'] as const) if (b[k] !== undefined) d[k] = vazio(b[k]);
  if (b.valor !== undefined) d.valorCentavos = cents(b.valor);
  if (b.valorAtualizado !== undefined) d.valorAtualizadoCentavos = cents(b.valorAtualizado);
  if (b.juros !== undefined) d.jurosCentavos = cents(b.juros) ?? 0;
  if (b.multa !== undefined) d.multaCentavos = cents(b.multa) ?? 0;
  if (b.desconto !== undefined) d.descontoCentavos = cents(b.desconto) ?? 0;
  if (b.emissao !== undefined) d.emissao = b.emissao ? meioDia(b.emissao) : null;
  if (b.vencimento !== undefined) d.vencimento = meioDia(b.vencimento);
  if (d.parcela && d.totalParcelas && d.parcela > d.totalParcelas) throw new HttpError(400, 'O número da parcela não pode ser maior que o total de parcelas');
  return d;
}

async function boletoView(b: Boleto, tz: string, nomes?: Record<string, string>) {
  return {
    ...b, valor: b.valorCentavos / 100, devido: valorDevido(b) / 100, pago: b.valorPagoCentavos / 100, saldo: saldoDe(b) / 100,
    vencimentoData: vencYmd(b), statusLabel: STATUS_LABEL[b.status] ?? b.status, atrasado: (ABERTOS as string[]).includes(b.status) && estaVencido(b, new Date(), tz),
    cliente: nomes ? nomes[b.clienteId] ?? '(excluído)' : undefined,
  };
}

async function getBoleto(orgId: string, id: string) {
  const b = await prisma.boleto.findFirst({ where: { id, orgId } });
  if (!b) throw notFound('Boleto');
  return b;
}

function filtroBoletos(orgId: string, q: { clienteId?: string; status?: string; q?: string; de?: string; ate?: string }) {
  const where: any = { orgId };
  if (q.clienteId) where.clienteId = q.clienteId;
  if (q.status === 'ABERTOS') where.status = { in: ABERTOS };
  else if (q.status) where.status = q.status;
  if (q.de || q.ate) where.vencimento = { ...(q.de ? { gte: meioDia(q.de) } : {}), ...(q.ate ? { lte: meioDia(q.ate) } : {}) };
  if (q.q) where.OR = [{ descricao: { contains: q.q } }, { numeroDocumento: { contains: q.q } }, { linhaDigitavel: { contains: q.q.replace(/\D/g, '') || q.q } }];
  return where;
}

const listaBoletosQ = z.object({
  clienteId: z.string().optional(), status: z.enum([...STATUS_BOLETO, 'ABERTOS'] as [string, ...string[]]).optional(), q: z.string().max(100).optional(),
  de: ymd.optional(), ate: ymd.optional(), page: z.coerce.number().int().min(1).default(1),
});

cobrancasRouter.get('/boletos', ah(async (req, res) => {
  const q = listaBoletosQ.parse(req.query);
  const orgId = orgOf(req);
  const where = filtroBoletos(orgId, q);
  const [items, total, cfg] = await Promise.all([
    prisma.boleto.findMany({ where, orderBy: [{ vencimento: 'asc' }, { parcela: 'asc' }], take: 100, skip: (q.page - 1) * 100 }),
    prisma.boleto.count({ where }),
    getConfig(orgId),
  ]);
  const cIds = [...new Set(items.map((b) => b.clienteId))];
  const nomes = Object.fromEntries((cIds.length ? await prisma.cliente.findMany({ where: { orgId, id: { in: cIds } }, select: { id: true, nome: true } }) : []).map((c) => [c.id, c.nome]));
  res.json({ items: await Promise.all(items.map((b) => boletoView(b, cfg.timezone, nomes))), total, page: q.page, pageSize: 100 });
}));

cobrancasRouter.post('/boletos', ah(async (req, res) => {
  const b = boletoSchema.parse(req.body);
  const orgId = orgOf(req);
  await getCliente(orgId, b.clienteId);
  const arquivoId = await validarArquivoBoleto(orgId, b.arquivoId || null, b.clienteId);
  const criado = await prisma.boleto.create({ data: { orgId, clienteId: b.clienteId, ...boletoData(b), arquivoId, status: b.rascunho ? 'RASCUNHO' : 'PENDENTE', criadoPorId: req.auth!.userId } });
  await evento(criado, 'CRIADO', `Boleto cadastrado${b.rascunho ? ' como rascunho' : ''}`, { valor: criado.valorCentavos, vencimento: vencYmd(criado) }, req.auth!.userId);
  const u = await recalcularBoleto(criado.id, { operadorId: req.auth!.userId });
  await audit(req, 'automacoes.boleto.create', { entity: 'Boleto', entityId: u.id, meta: { clienteId: u.clienteId, valor: u.valorCentavos } });
  res.status(201).json(await boletoView(u, (await getConfig(orgId)).timezone));
}));

/** Cadastro em lote: gera N parcelas mensais (ou a cada X meses) a partir do primeiro vencimento. */
cobrancasRouter.post('/boletos/parcelas', ah(async (req, res) => {
  const b = z.object({
    clienteId: z.string().min(1), descricao: z.string().trim().min(1).max(200), valorParcela: reais.refine((v) => v > 0, 'Informe o valor da parcela'),
    parcelas: z.number().int().min(1).max(120), primeiroVencimento: ymd, intervaloMeses: z.number().int().min(1).max(12).default(1),
    numeroDocumentoBase: opt(z.string().trim().max(50)), rascunho: z.boolean().optional(),
  }).parse(req.body);
  const orgId = orgOf(req);
  await getCliente(orgId, b.clienteId);
  const [y, m, d] = b.primeiroVencimento.split('-').map(Number);
  const criados: Boleto[] = [];
  for (let i = 0; i < b.parcelas; i++) {
    const tm = m - 1 + i * b.intervaloMeses;
    const yy = y + Math.floor(tm / 12), mm = (tm % 12) + 1;
    const dd = Math.min(d, new Date(Date.UTC(yy, mm, 0)).getUTCDate());
    const venc = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const c = await prisma.boleto.create({
      data: {
        orgId, clienteId: b.clienteId, descricao: b.descricao, parcela: i + 1, totalParcelas: b.parcelas, valorCentavos: cents(b.valorParcela)!, vencimento: meioDia(venc),
        numeroDocumento: b.numeroDocumentoBase ? `${b.numeroDocumentoBase}-${i + 1}` : null, status: b.rascunho ? 'RASCUNHO' : 'PENDENTE', criadoPorId: req.auth!.userId,
      },
    });
    await evento(c, 'CRIADO', `Parcela ${i + 1}/${b.parcelas} cadastrada em lote`, undefined, req.auth!.userId);
    criados.push(await recalcularBoleto(c.id));
  }
  await audit(req, 'automacoes.boleto.lote', { meta: { clienteId: b.clienteId, parcelas: b.parcelas } });
  const tz = (await getConfig(orgId)).timezone;
  res.status(201).json(await Promise.all(criados.map((x) => boletoView(x, tz))));
}));

cobrancasRouter.get('/boletos/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = await getBoleto(orgId, req.params.id);
  const [eventos, pagamentos, comprovantes, envios, arquivo, cliente, automacoes, cfg] = await Promise.all([
    prisma.boletoEvento.findMany({ where: { boletoId: b.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.pagamento.findMany({ where: { boletoId: b.id }, orderBy: { pagoEm: 'desc' } }),
    prisma.comprovante.findMany({ where: { orgId, boletoId: b.id }, orderBy: { createdAt: 'desc' } }),
    prisma.ocorrencia.findMany({ where: { orgId, boletoId: b.id }, orderBy: { agendadoPara: 'asc' }, take: 200 }),
    b.arquivoId ? prisma.arquivo.findFirst({ where: { id: b.arquivoId, orgId } }) : null,
    prisma.cliente.findFirst({ where: { id: b.clienteId, orgId }, select: { id: true, nome: true } }),
    prisma.automacaoAnexo.findMany({ where: { orgId, boletoId: b.id }, select: { automacaoId: true, envio: true } }),
    getConfig(orgId),
  ]);
  const autos = automacoes.length ? await prisma.automacao.findMany({ where: { orgId, id: { in: [...new Set(automacoes.map((x) => x.automacaoId))] } }, select: { id: true, nome: true, status: true } }) : [];
  res.json({
    ...(await boletoView(b, cfg.timezone)), cliente: cliente?.nome ?? '(excluído)', arquivo: arquivo ? arquivoView(arquivo) : null, eventos,
    pagamentos: pagamentos.map((p) => ({ ...p, valor: p.valorCentavos / 100 })), comprovantes: comprovantes.map(comprovanteView), envios,
    automacoes: autos.map((a) => ({ ...a, envio: automacoes.find((x) => x.automacaoId === a.id)?.envio ?? null })),
  });
}));

const CAMPOS_FINANCEIROS = ['valor', 'valorAtualizado', 'juros', 'multa', 'desconto', 'vencimento', 'clienteId'];

cobrancasRouter.patch('/boletos/:id', ah(async (req, res) => {
  const body = boletoSchema.omit({ rascunho: true }).partial().parse(req.body);
  const orgId = orgOf(req);
  const b = await getBoleto(orgId, req.params.id);
  if (body.clienteId && body.clienteId !== b.clienteId) throw new HttpError(400, 'Não é possível trocar o cliente de um boleto. Cancele e cadastre outro.');
  if ((b.status === 'PAGO' || b.status === 'CANCELADO') && Object.keys(body).some((k) => CAMPOS_FINANCEIROS.includes(k))) throw new HttpError(400, `Boleto ${STATUS_LABEL[b.status].toLowerCase()}: valores e vencimento não podem ser alterados`);
  const data = boletoData(body);
  if (body.arquivoId !== undefined) data.arquivoId = await validarArquivoBoleto(orgId, body.arquivoId || null, b.clienteId);
  const mudou = Object.keys(data).filter((k) => String((b as any)[k] ?? '') !== String(data[k] ?? ''));
  await prisma.boleto.update({ where: { id: b.id }, data });
  if (mudou.length) await evento(b, mudou.includes('arquivoId') && mudou.length === 1 ? 'ANEXO' : 'EDITADO', `Alterado: ${mudou.join(', ')}`, { antes: Object.fromEntries(mudou.map((k) => [k, (b as any)[k]])), depois: Object.fromEntries(mudou.map((k) => [k, data[k]])) }, req.auth!.userId);
  const u = await recalcularBoleto(b.id, { operadorId: req.auth!.userId });
  // Vencimento alterado: reprograma os reenvios das sequências ativas que usam este boleto (o que já saiu não é reenviado).
  if (mudou.includes('vencimento')) {
    const ids = (await prisma.automacaoAnexo.findMany({ where: { orgId, boletoId: b.id }, select: { automacaoId: true } })).map((x) => x.automacaoId);
    for (const a of await prisma.automacao.findMany({ where: { orgId, id: { in: ids }, status: 'ATIVA' } })) await reprogramar(a);
  }
  await audit(req, 'automacoes.boleto.update', { entity: 'Boleto', entityId: b.id, meta: mudou });
  res.json(await boletoView(u, (await getConfig(orgId)).timezone));
}));

cobrancasRouter.post('/boletos/:id/emitir', ah(async (req, res) => {
  const b = await getBoleto(orgOf(req), req.params.id);
  if (b.status !== 'RASCUNHO') throw new HttpError(400, 'Só boletos em rascunho podem ser emitidos');
  await prisma.boleto.update({ where: { id: b.id }, data: { status: 'PENDENTE' } });
  await evento(b, 'STATUS', 'Rascunho emitido: boleto passa a ser cobrável', undefined, req.auth!.userId);
  const u = await recalcularBoleto(b.id, { operadorId: req.auth!.userId });
  await audit(req, 'automacoes.boleto.emitir', { entity: 'Boleto', entityId: b.id });
  res.json(u);
}));

cobrancasRouter.post('/boletos/:id/cancelar', ah(async (req, res) => {
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Informe o motivo').max(500) }).parse(req.body);
  const b = await getBoleto(orgOf(req), req.params.id);
  if (b.status === 'CANCELADO') throw new HttpError(400, 'Boleto já cancelado');
  if (b.status === 'PAGO' || b.valorPagoCentavos > 0) throw new HttpError(400, 'Boleto com pagamento registrado não pode ser cancelado. Estorne o pagamento antes, se for o caso.');
  const u = await prisma.boleto.update({ where: { id: b.id }, data: { status: 'CANCELADO' } });
  await evento(b, 'CANCELADO', `Boleto cancelado: ${motivo}`, undefined, req.auth!.userId);
  await interromperCobrancas(u, 'Boleto cancelado — cobrança interrompida');
  await audit(req, 'automacoes.boleto.cancelar', { entity: 'Boleto', entityId: b.id, meta: { motivo } });
  res.json(u);
}));

cobrancasRouter.post('/boletos/:id/reabrir', ah(async (req, res) => {
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Informe o motivo').max(500) }).parse(req.body);
  const b = await getBoleto(orgOf(req), req.params.id);
  if (b.status !== 'CANCELADO') throw new HttpError(400, 'Só boletos cancelados podem ser reabertos (pagamentos são reabertos por estorno)');
  await prisma.boleto.update({ where: { id: b.id }, data: { status: 'PENDENTE' } });
  await evento(b, 'REABERTO', `Boleto reaberto: ${motivo}. Revise as automações de cobrança relacionadas.`, undefined, req.auth!.userId);
  const u = await recalcularBoleto(b.id, { operadorId: req.auth!.userId });
  await audit(req, 'automacoes.boleto.reabrir', { entity: 'Boleto', entityId: b.id, meta: { motivo } });
  res.json(u);
}));

const pagamentoSchema = z.object({ valor: reais.refine((v) => v > 0, 'Informe o valor pago'), pagoEm: ymd, forma: opt(z.string().trim().max(60)), observacoes: opt(z.string().max(2000)) });

/** Baixa manual (total ou parcial), com responsável e data registrados. */
cobrancasRouter.post('/boletos/:id/pagamentos', ah(async (req, res) => {
  const p = pagamentoSchema.parse(req.body);
  const b = await getBoleto(orgOf(req), req.params.id);
  const r = await registrarPagamento({ boleto: b, valorCentavos: cents(p.valor)!, pagoEm: meioDia(p.pagoEm), forma: (vazio(p.forma) as string) ?? null, origem: 'MANUAL', observacoes: (vazio(p.observacoes) as string) ?? null, operadorId: req.auth!.userId });
  await audit(req, 'automacoes.pagamento.create', { entity: 'Pagamento', entityId: r.pagamento.id, meta: { boletoId: b.id, valor: r.pagamento.valorCentavos, status: r.boleto.status } });
  res.status(201).json({ pagamento: r.pagamento, boleto: r.boleto });
}));

/** Reenvio manual imediato de um boleto pendente/vencido, pela sequência de cobrança ativa em que ele está. */
cobrancasRouter.post('/boletos/:id/reenviar', ah(async (req, res) => {
  const b = await getBoleto(orgOf(req), req.params.id);
  if (b.status === 'PAGO') throw new HttpError(409, 'Boleto já pago: não é reenviado');
  if (!['PENDENTE', 'VENCIDO', 'PARCIAL'].includes(b.status)) throw new HttpError(400, `Boleto ${STATUS_LABEL[b.status].toLowerCase()} não pode ser reenviado`);
  const ids = (await prisma.automacaoAnexo.findMany({ where: { orgId: b.orgId, boletoId: b.id }, select: { automacaoId: true } })).map((x) => x.automacaoId);
  const a = await prisma.automacao.findFirst({ where: { orgId: b.orgId, id: { in: ids }, categoria: 'COBRANCA', status: 'ATIVA' }, orderBy: { createdAt: 'desc' } });
  if (!a) throw new HttpError(400, 'Este boleto não está em nenhuma sequência de cobrança ativa. Crie uma em Cobranças → Nova sequência.');
  const now = new Date();
  const canais = parseJson<string[]>(a.canais, []);
  for (const canal of canais) {
    await prisma.ocorrencia.create({ data: { orgId: b.orgId, automacaoId: a.id, clienteId: b.clienteId, canal, chave: `${a.id}:${b.clienteId}:${canal}:M:${b.id}:${now.toISOString()}`, agendadoPara: now, executarEm: now, tipo: 'MANUAL', boletoId: b.id } });
  }
  await evento(b, 'REENVIO', `Reenvio manual solicitado (${canais.join(' + ')})`, undefined, req.auth!.userId);
  await audit(req, 'automacoes.boleto.reenviar', { entity: 'Boleto', entityId: b.id, meta: { automacaoId: a.id } });
  res.json({ ok: true, automacaoId: a.id, canais });
}));

// ---------------- Pagamentos ----------------

cobrancasRouter.get('/pagamentos', ah(async (req, res) => {
  const q = z.object({ clienteId: z.string().optional(), de: ymd.optional(), ate: ymd.optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId };
  if (q.clienteId) where.clienteId = q.clienteId;
  if (q.de || q.ate) where.pagoEm = { ...(q.de ? { gte: new Date(`${q.de}T00:00:00Z`) } : {}), ...(q.ate ? { lte: new Date(`${q.ate}T23:59:59Z`) } : {}) };
  const [items, total] = await Promise.all([prisma.pagamento.findMany({ where, orderBy: { pagoEm: 'desc' }, take: 100, skip: (q.page - 1) * 100 }), prisma.pagamento.count({ where })]);
  const cIds = [...new Set(items.map((p) => p.clienteId))], bIds = [...new Set(items.map((p) => p.boletoId))];
  const [cs, bs] = await Promise.all([
    cIds.length ? prisma.cliente.findMany({ where: { orgId, id: { in: cIds } }, select: { id: true, nome: true } }) : [],
    bIds.length ? prisma.boleto.findMany({ where: { orgId, id: { in: bIds } }, select: { id: true, descricao: true, parcela: true, totalParcelas: true } }) : [],
  ]);
  res.json({ items: items.map((p) => ({ ...p, valor: p.valorCentavos / 100, cliente: cs.find((c) => c.id === p.clienteId)?.nome ?? '(excluído)', boleto: bs.find((b) => b.id === p.boletoId) ?? null })), total, page: q.page, pageSize: 100 });
}));

/** Estorno / pagamento inválido: só o proprietário. O registro é mantido (auditável) e a cobrança é reaberta. */
cobrancasRouter.post('/pagamentos/:id/estornar', ah(async (req, res) => {
  if (req.auth?.role !== 'OWNER') throw forbidden('Somente o proprietário pode estornar pagamentos');
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Informe o motivo').max(500) }).parse(req.body);
  const p = await prisma.pagamento.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!p) throw notFound('Pagamento');
  const b = await estornarPagamento(p, motivo, req.auth!.userId);
  if (p.comprovanteId) await prisma.comprovante.updateMany({ where: { id: p.comprovanteId, status: 'APROVADO' }, data: { status: 'REJEITADO', motivoRevisao: `Pagamento estornado: ${motivo}`, revisadoPorId: req.auth!.userId, revisadoEm: new Date() } });
  await audit(req, 'automacoes.pagamento.estornar', { entity: 'Pagamento', entityId: p.id, meta: { motivo, boletoId: p.boletoId } });
  res.json({ ok: true, boleto: b });
}));

// ---------------- Comprovantes ----------------

function comprovanteView(c: any) {
  const an = parseJson<{ motivos?: string[]; valores?: number[] }>(c.analise, {});
  return { ...c, motivos: an.motivos ?? [], valoresDetectados: (an.valores ?? []).map((v) => v / 100), valorDetectado: c.valorDetectadoCentavos != null ? c.valorDetectadoCentavos / 100 : null, duplicado: !!c.duplicadoDeId };
}

cobrancasRouter.get('/comprovantes', ah(async (req, res) => {
  const q = z.object({ status: z.enum(['EM_ANALISE', 'APROVADO', 'REJEITADO']).optional(), clienteId: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId, ...(q.status ? { status: q.status } : {}), ...(q.clienteId ? { clienteId: q.clienteId } : {}) };
  const [items, total, cfg] = await Promise.all([prisma.comprovante.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, skip: (q.page - 1) * 50 }), prisma.comprovante.count({ where }), getConfig(orgId)]);
  const cIds = [...new Set(items.map((c) => c.clienteId).filter(Boolean) as string[])], bIds = [...new Set(items.map((c) => c.boletoId).filter(Boolean) as string[])], aIds = [...new Set(items.map((c) => c.arquivoId).filter(Boolean) as string[])];
  const [cs, bs, as] = await Promise.all([
    cIds.length ? prisma.cliente.findMany({ where: { orgId, id: { in: cIds } }, select: { id: true, nome: true } }) : [],
    bIds.length ? prisma.boleto.findMany({ where: { orgId, id: { in: bIds } } }) : [],
    aIds.length ? prisma.arquivo.findMany({ where: { orgId, id: { in: aIds } } }) : [],
  ]);
  res.json({
    items: await Promise.all(items.map(async (c) => {
      const b = bs.find((x) => x.id === c.boletoId);
      const arq = as.find((x) => x.id === c.arquivoId);
      return { ...comprovanteView(c), cliente: cs.find((x) => x.id === c.clienteId)?.nome ?? null, boleto: b ? await boletoView(b, cfg.timezone) : null, arquivo: arq ? arquivoView(arq) : null };
    })),
    total, page: q.page, pageSize: 50,
  });
}));

/** Upload de comprovante pelo operador (ex.: recebido por e-mail). Entra em análise como os do WhatsApp. */
cobrancasRouter.post('/comprovantes', corpoBinario, ah(async (req, res) => {
  const q = z.object({ clienteId: z.string().min(1, 'Escolha o cliente'), boletoId: z.string().optional(), texto: z.string().max(2000).optional(), origem: z.enum(['UPLOAD', 'EMAIL']).default('UPLOAD') }).parse(req.query);
  const orgId = orgOf(req);
  await getCliente(orgId, q.clienteId);
  if (q.boletoId) { const b = await getBoleto(orgId, q.boletoId); if (b.clienteId !== q.clienteId) throw new HttpError(400, 'O boleto pertence a outro cliente'); }
  const arq = await salvarArquivo({ orgId, nome: nomeDoUpload(req), dados: bufferDe(req), clienteId: q.clienteId, descricao: 'Comprovante de pagamento', criadoPorId: req.auth!.userId }, await getConfig(orgId));
  const c = await registrarComprovante({ orgId, clienteId: q.clienteId, boletoId: q.boletoId || null, arquivo: arq, origem: q.origem === 'EMAIL' ? 'EMAIL' : 'UPLOAD', texto: q.texto, operadorId: req.auth!.userId });
  await audit(req, 'automacoes.comprovante.upload', { entity: 'Comprovante', entityId: c.id, meta: { clienteId: q.clienteId, boletoId: c.boletoId, confianca: c.confianca } });
  res.status(201).json(comprovanteView(c));
}));

async function getComprovante(orgId: string, id: string) {
  const c = await prisma.comprovante.findFirst({ where: { id, orgId } });
  if (!c) throw notFound('Comprovante');
  return c;
}

/** Vincula o comprovante a outro cliente/boleto enquanto está em análise. */
cobrancasRouter.patch('/comprovantes/:id', ah(async (req, res) => {
  const b = z.object({ clienteId: z.string().optional().nullable(), boletoId: z.string().optional().nullable() }).parse(req.body);
  const orgId = orgOf(req);
  const c = await getComprovante(orgId, req.params.id);
  if (c.status !== 'EM_ANALISE') throw new HttpError(400, 'Só comprovantes em análise podem ser alterados');
  const clienteId = b.clienteId !== undefined ? b.clienteId : c.clienteId;
  if (clienteId) await getCliente(orgId, clienteId);
  let boletoId = b.boletoId !== undefined ? b.boletoId : c.boletoId;
  if (boletoId) { const bo = await getBoleto(orgId, boletoId); if (clienteId && bo.clienteId !== clienteId) throw new HttpError(400, 'O boleto pertence a outro cliente'); }
  if (b.clienteId !== undefined && b.boletoId === undefined && c.boletoId && clienteId !== c.clienteId) boletoId = null;
  await prisma.comprovante.update({ where: { id: c.id }, data: { clienteId, boletoId } });
  if (c.arquivoId && clienteId) await prisma.arquivo.updateMany({ where: { id: c.arquivoId, orgId, clienteId: null }, data: { clienteId } });
  for (const id of new Set([c.boletoId, boletoId].filter(Boolean) as string[])) await recalcularBoleto(id, { operadorId: req.auth!.userId });
  if (boletoId && boletoId !== c.boletoId) await evento(await getBoleto(orgId, boletoId), 'COMPROVANTE', 'Comprovante vinculado manualmente pelo operador; aguardando conferência', { comprovanteId: c.id }, req.auth!.userId);
  await audit(req, 'automacoes.comprovante.vincular', { entity: 'Comprovante', entityId: c.id, meta: { clienteId, boletoId } });
  res.json(comprovanteView(await prisma.comprovante.findUniqueOrThrow({ where: { id: c.id } })));
}));

/** Aprovação: registra o pagamento (baixa) com responsável, data e observações. Total ou parcial. */
cobrancasRouter.post('/comprovantes/:id/aprovar', ah(async (req, res) => {
  const b = z.object({ boletoId: z.string().optional(), valor: reais.optional(), pagoEm: ymd.optional(), observacoes: opt(z.string().max(2000)), confirmarDuplicado: z.boolean().optional() }).parse(req.body);
  const orgId = orgOf(req);
  const c = await getComprovante(orgId, req.params.id);
  if (c.status !== 'EM_ANALISE') throw new HttpError(400, 'Comprovante já revisado');
  if (c.duplicadoDeId && !b.confirmarDuplicado) throw new HttpError(409, 'Comprovante possivelmente duplicado. Confira e confirme explicitamente para aprovar mesmo assim.');
  const boletoId = b.boletoId ?? c.boletoId;
  if (!boletoId) throw new HttpError(400, 'Escolha o boleto ao qual o pagamento se refere');
  const boleto = await getBoleto(orgId, boletoId);
  if (c.clienteId && boleto.clienteId !== c.clienteId) throw new HttpError(400, 'O boleto pertence a outro cliente');
  const valor = b.valor != null ? cents(b.valor)! : c.valorDetectadoCentavos && c.valorDetectadoCentavos <= saldoDe(boleto) ? c.valorDetectadoCentavos : saldoDe(boleto);
  const pagoEm = b.pagoEm ? meioDia(b.pagoEm) : c.dataDetectada && /^\d{4}-\d{2}-\d{2}$/.test(c.dataDetectada) && meioDia(c.dataDetectada).getTime() <= Date.now() + 86400e3 ? meioDia(c.dataDetectada) : new Date();
  // Marca como revisado antes da baixa (o recálculo do boleto não deve mais vê-lo "em análise").
  await prisma.comprovante.update({ where: { id: c.id }, data: { status: 'APROVADO', boletoId, clienteId: c.clienteId ?? boleto.clienteId, revisadoPorId: req.auth!.userId, revisadoEm: new Date(), motivoRevisao: (vazio(b.observacoes) as string) ?? null } });
  try {
    const r = await registrarPagamento({ boleto, valorCentavos: valor, pagoEm, origem: 'COMPROVANTE', comprovanteId: c.id, observacoes: (vazio(b.observacoes) as string) ?? null, operadorId: req.auth!.userId });
    await audit(req, 'automacoes.comprovante.aprovar', { entity: 'Comprovante', entityId: c.id, meta: { boletoId, valor, status: r.boleto.status } });
    res.json({ comprovante: comprovanteView(await prisma.comprovante.findUniqueOrThrow({ where: { id: c.id } })), pagamento: r.pagamento, boleto: r.boleto });
  } catch (e) {
    await prisma.comprovante.update({ where: { id: c.id }, data: { status: 'EM_ANALISE', boletoId: c.boletoId, clienteId: c.clienteId, revisadoPorId: null, revisadoEm: null, motivoRevisao: null } });
    throw e;
  }
}));

cobrancasRouter.post('/comprovantes/:id/rejeitar', ah(async (req, res) => {
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Informe o motivo').max(500) }).parse(req.body);
  const orgId = orgOf(req);
  const c = await getComprovante(orgId, req.params.id);
  if (c.status !== 'EM_ANALISE') throw new HttpError(400, 'Comprovante já revisado');
  await prisma.comprovante.update({ where: { id: c.id }, data: { status: 'REJEITADO', revisadoPorId: req.auth!.userId, revisadoEm: new Date(), motivoRevisao: motivo } });
  if (c.boletoId) {
    const b = await getBoleto(orgId, c.boletoId);
    await evento(b, 'COMPROVANTE', `Comprovante rejeitado: ${motivo}`, { comprovanteId: c.id }, req.auth!.userId);
    await recalcularBoleto(b.id, { operadorId: req.auth!.userId, motivo: 'comprovante rejeitado' });
  }
  await audit(req, 'automacoes.comprovante.rejeitar', { entity: 'Comprovante', entityId: c.id, meta: { motivo } });
  res.json(comprovanteView(await prisma.comprovante.findUniqueOrThrow({ where: { id: c.id } })));
}));

// ---------------- Relatórios ----------------

const relQ = z.object({ de: ymd.optional(), ate: ymd.optional(), clienteId: z.string().optional(), categoria: z.enum(['LEMBRETE', 'MARKETING', 'COBRANCA']).optional() });

function periodo(q: { de?: string; ate?: string }, tz: string) {
  const hoje = localDate(new Date(), tz);
  const de = q.de ?? localDate(new Date(Date.now() - 29 * 86400e3), tz);
  const ate = q.ate ?? hoje;
  if (de > ate) throw new HttpError(400, 'Período inválido');
  return { de, ate, ini: zonedToUtc(de, '00:00', tz), fim: new Date(zonedToUtc(ate, '00:00', tz).getTime() + 86400e3) };
}

/** Relatórios calculados dos registros reais (cada envio/pagamento contado uma vez). */
export async function calcularRelatorio(orgId: string, q: z.infer<typeof relQ>) {
  const cfg = await getConfig(orgId);
  const p = periodo(q, cfg.timezone);
  const cli = q.clienteId ? { clienteId: q.clienteId } : {};
  const cat = q.categoria ? { categoria: q.categoria } : {};
  const hist = await prisma.mensagemHistorico.findMany({
    where: { orgId, direcao: 'OUT', ocorrenciaId: { not: null }, ...cli, ...cat, status: { in: ['ENVIADA', 'FALHOU'] }, updatedAt: { gte: p.ini, lt: p.fim } },
    select: { status: true, canal: true, categoria: true, enviadoEm: true, updatedAt: true, automacaoId: true, ocorrenciaId: true, boletoId: true },
  });
  const porDia: Record<string, { enviadas: number; falhas: number }> = {};
  const porCanal: Record<string, { enviadas: number; falhas: number; taxaSucesso: number | null }> = { WHATSAPP: { enviadas: 0, falhas: 0, taxaSucesso: null }, EMAIL: { enviadas: 0, falhas: 0, taxaSucesso: null } };
  const porCategoria: Record<string, number> = { LEMBRETE: 0, MARKETING: 0, COBRANCA: 0 };
  const campanhas = new Set<string>();
  for (const h of hist) {
    const d = localDate(h.enviadoEm ?? h.updatedAt, cfg.timezone);
    porDia[d] ??= { enviadas: 0, falhas: 0 };
    const ok = h.status === 'ENVIADA';
    porDia[d][ok ? 'enviadas' : 'falhas']++;
    porCanal[h.canal] ??= { enviadas: 0, falhas: 0, taxaSucesso: null };
    porCanal[h.canal][ok ? 'enviadas' : 'falhas']++;
    if (ok) porCategoria[h.categoria] = (porCategoria[h.categoria] ?? 0) + 1;
    if (ok && h.categoria === 'MARKETING' && h.automacaoId) campanhas.add(h.automacaoId);
  }
  for (const c of Object.values(porCanal)) c.taxaSucesso = c.enviadas + c.falhas ? Math.round((c.enviadas / (c.enviadas + c.falhas)) * 1000) / 10 : null;
  const reenvios = await prisma.ocorrencia.count({ where: { orgId, ...cli, tipo: { in: ['REENVIO', 'MANUAL'] }, status: 'ENVIADA', enviadoEm: { gte: p.ini, lt: p.fim } } });
  const bWhere: any = { orgId, ...cli };
  const [emitidos, enviados, boletosAbertos, parciais, pagamentos, comprovantesPendentes, comprovantesRecebidos] = await Promise.all([
    prisma.boleto.count({ where: { ...bWhere, status: { not: 'RASCUNHO' }, createdAt: { gte: p.ini, lt: p.fim } } }),
    prisma.boleto.count({ where: { ...bWhere, enviadoEm: { gte: p.ini, lt: p.fim } } }),
    prisma.boleto.findMany({ where: { ...bWhere, status: { in: ABERTOS } } }),
    prisma.boleto.count({ where: { ...bWhere, status: 'PARCIAL' } }),
    prisma.pagamento.findMany({ where: { orgId, ...cli, estornadoEm: null, pagoEm: { gte: p.ini, lt: p.fim } }, select: { valorCentavos: true, boletoId: true } }),
    prisma.comprovante.count({ where: { orgId, ...cli, status: 'EM_ANALISE' } }),
    prisma.comprovante.count({ where: { orgId, ...cli, createdAt: { gte: p.ini, lt: p.fim } } }),
  ]);
  const now = new Date();
  const atrasados = boletosAbertos.filter((b) => estaVencido(b, now, cfg.timezone));
  const confirmados = new Set(pagamentos.map((x) => x.boletoId));
  return {
    periodo: { de: p.de, ate: p.ate, timezone: cfg.timezone },
    mensagens: {
      enviadas: hist.filter((h) => h.status === 'ENVIADA').length, falhas: hist.filter((h) => h.status === 'FALHOU').length,
      porDia: Object.entries(porDia).sort(([a], [b]) => a.localeCompare(b)).map(([dia, v]) => ({ dia, ...v })), porCanal,
      lembretesEnviados: porCategoria.LEMBRETE, marketingEnviados: porCategoria.MARKETING, cobrancasEnviadas: porCategoria.COBRANCA,
      campanhasExecutadas: campanhas.size, reenvios,
    },
    financeiro: {
      boletosEmitidos: emitidos, boletosEnviados: enviados, boletosVencidos: boletosAbertos.filter((b) => b.status === 'VENCIDO').length,
      parcelasEmAtraso: atrasados.length, valorEmAtraso: atrasados.reduce((s, b) => s + saldoDe(b), 0) / 100,
      pagamentosConfirmados: pagamentos.length, boletosComPagamento: confirmados.size, valoresRecebidos: pagamentos.reduce((s, x) => s + x.valorCentavos, 0) / 100,
      valoresPendentes: boletosAbertos.reduce((s, b) => s + saldoDe(b), 0) / 100, pagamentosParciais: parciais,
      comprovantesPendentes, comprovantesRecebidos,
    },
  };
}

cobrancasRouter.get('/relatorios', ah(async (req, res) => {
  res.json(await calcularRelatorio(orgOf(req), relQ.parse(req.query)));
}));

const csvEsc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (head: string[], rows: unknown[][]) => [head.join(','), ...rows.map((r) => r.map(csvEsc).join(','))].join('\n');
const dinheiro = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));

cobrancasRouter.get('/relatorios/export', ah(async (req, res) => {
  if (!ehAdmin(req)) throw forbidden('Exportação restrita a administradores');
  const q = relQ.extend({ tipo: z.enum(['boletos', 'pagamentos', 'mensagens', 'comprovantes']) }).parse(req.query);
  const orgId = orgOf(req);
  const cfg = await getConfig(orgId);
  const p = periodo(q, cfg.timezone);
  const cli = q.clienteId ? { clienteId: q.clienteId } : {};
  const nomesDe = async (ids: (string | null)[]) => {
    const u = [...new Set(ids.filter(Boolean) as string[])];
    return Object.fromEntries((u.length ? await prisma.cliente.findMany({ where: { orgId, id: { in: u } }, select: { id: true, nome: true } }) : []).map((c) => [c.id, c.nome]));
  };
  let out = '';
  if (q.tipo === 'boletos') {
    const bs = await prisma.boleto.findMany({ where: { orgId, ...cli, vencimento: { gte: meioDia(p.de), lte: meioDia(p.ate) } }, orderBy: { vencimento: 'asc' } });
    const n = await nomesDe(bs.map((b) => b.clienteId));
    out = csv(['cliente', 'descricao', 'documento', 'parcela', 'total_parcelas', 'vencimento', 'valor', 'valor_devido', 'valor_pago', 'saldo', 'status', 'status_envio', 'pago_em'],
      bs.map((b) => [n[b.clienteId] ?? '', b.descricao, b.numeroDocumento, b.parcela, b.totalParcelas, vencYmd(b), dinheiro(b.valorCentavos), dinheiro(valorDevido(b)), dinheiro(b.valorPagoCentavos), dinheiro(saldoDe(b)), STATUS_LABEL[b.status] ?? b.status, b.statusEnvio, b.pagoEm ? localDate(b.pagoEm, cfg.timezone) : '']));
  } else if (q.tipo === 'pagamentos') {
    const ps = await prisma.pagamento.findMany({ where: { orgId, ...cli, pagoEm: { gte: p.ini, lt: p.fim } }, orderBy: { pagoEm: 'asc' } });
    const n = await nomesDe(ps.map((x) => x.clienteId));
    out = csv(['cliente', 'boleto_id', 'pago_em', 'valor', 'forma', 'origem', 'estornado_em', 'motivo_estorno'], ps.map((x) => [n[x.clienteId] ?? '', x.boletoId, localDate(x.pagoEm, 'UTC'), dinheiro(x.valorCentavos), x.forma, x.origem, x.estornadoEm ? localDate(x.estornadoEm, cfg.timezone) : '', x.estornoMotivo]));
  } else if (q.tipo === 'comprovantes') {
    const cs = await prisma.comprovante.findMany({ where: { orgId, ...cli, createdAt: { gte: p.ini, lt: p.fim } }, orderBy: { createdAt: 'asc' } });
    const n = await nomesDe(cs.map((x) => x.clienteId));
    out = csv(['recebido_em', 'cliente', 'origem', 'boleto_id', 'valor_detectado', 'confianca', 'duplicado', 'status', 'motivo_revisao'], cs.map((x) => [x.createdAt.toISOString(), x.clienteId ? n[x.clienteId] ?? '' : '', x.origem, x.boletoId, dinheiro(x.valorDetectadoCentavos), x.confianca, x.duplicadoDeId ? 'sim' : 'nao', x.status, x.motivoRevisao]));
  } else {
    const hs = await prisma.mensagemHistorico.findMany({ where: { orgId, ...cli, ...(q.categoria ? { categoria: q.categoria } : {}), updatedAt: { gte: p.ini, lt: p.fim } }, orderBy: { updatedAt: 'asc' }, take: 50000 });
    const n = await nomesDe(hs.map((x) => x.clienteId));
    out = csv(['quando', 'cliente', 'categoria', 'canal', 'direcao', 'status', 'tentativas', 'erro', 'provedor_id', 'anexos', 'conteudo'], hs.map((x) => [(x.enviadoEm ?? x.updatedAt).toISOString(), x.clienteId ? n[x.clienteId] ?? '' : '', x.categoria, x.canal, x.direcao, x.status, x.tentativas, x.erro, x.provedorId, parseJson<{ nome: string }[]>(x.anexos, []).map((a) => a.nome).join(' | '), x.conteudo]));
  }
  await audit(req, 'automacoes.relatorio.export', { meta: { tipo: q.tipo, de: p.de, ate: p.ate } });
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${q.tipo}-${p.de}-a-${p.ate}.csv"`);
  res.send('\ufeff' + out);
}));

export { boletoView, comprovanteView, arquivoView };
