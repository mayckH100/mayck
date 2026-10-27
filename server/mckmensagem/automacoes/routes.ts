import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, notFound, HttpError, forbidden } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { audit } from '../../lib/audit.js';
import { parseJson } from '../../lib/json.js';
import { isProductActive } from '../../billing/service.js';
import { smtpConfigured, verifySmtp } from '../../lib/mailer.js';
import { qrManager } from '../../whatsapp/qr/manager.js';
import { CONSENT_SOURCES, toE164 } from '../constants.js';
import { regraSchema, zonedToUtc, isValidTimeZone, descreverRegra, localDate, gerarHorarios } from './rules.js';
import { renderMensagem, problemaRender, VARIAVEIS, VARIAVEIS_FASE2 } from './vars.js';
import { getConfig, reprogramar, regraDe, CANAIS, HORIZONTE_DIAS } from './engine.js';
import type { Automacao, Cliente } from '@prisma/client';

/**
 * Automações e Cobranças — FASE 1 (clientes, lembretes, marketing, calendário, histórico, configurações).
 * Permissões (papéis existentes): OWNER e ADMIN alteram; AGENT é somente leitura neste módulo.
 */
export const automacoesRouter = Router();

const podeEscrever = (req: Request) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';

automacoesRouter.use(ah(async (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.method === 'POST' && (req.path === '/preview' || req.path === '/regra/previa')) return next(); // só leitura
  if (!podeEscrever(req)) throw forbidden('Seu perfil é somente leitura neste módulo');
  if (!(await isProductActive(orgOf(req), 'MCKMENSAGEM'))) throw new HttpError(402, 'Assinatura MCK Mensagens inativa');
  next();
}));

const CATEGORIAS = ['LEMBRETE', 'MARKETING'] as const;
const STATUS_CLIENTE = ['ATIVO', 'INATIVO', 'INADIMPLENTE', 'CANCELADO'] as const;
const STATUS_OCORRENCIA = ['PENDENTE', 'PROCESSANDO', 'ENVIADA', 'FALHOU', 'IGNORADA', 'CANCELADA'] as const;
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM');
const opt = (s: z.ZodString) => s.optional().nullable().or(z.literal(''));

// ---------------- Clientes ----------------

const digits = (v?: string | null) => (v ?? '').replace(/\D/g, '');
const dataMeioDia = (v?: string | null) => (v ? new Date(`${v}T12:00:00.000Z`) : null);

function validarDocumento(raw?: string | null): string | null {
  const d = digits(raw);
  if (!d) return null;
  if (d.length !== 11 && d.length !== 14) throw new HttpError(400, 'CPF deve ter 11 dígitos e CNPJ 14 dígitos');
  return d;
}
function fone(raw: string | null | undefined, campo: string): string | null {
  if (!raw || !String(raw).trim()) return null;
  const e = toE164(String(raw));
  if (!e) throw new HttpError(400, `${campo} inválido. Use DDI + DDD + número, ex.: +5511999998888`);
  return e;
}

const clienteSchema = z.object({
  nome: z.string().trim().min(1, 'Informe o nome').max(160),
  documento: opt(z.string().max(30)),
  telefone: opt(z.string().max(30)),
  whatsapp: opt(z.string().max(30)),
  email: opt(z.string().trim().toLowerCase().email('E-mail inválido').max(160)),
  emailSecundario: opt(z.string().trim().toLowerCase().email('E-mail secundário inválido').max(160)),
  empresa: opt(z.string().trim().max(160)),
  plano: opt(z.string().trim().max(120)),
  dataContratacao: ymd.optional().nullable().or(z.literal('')),
  dataVencimento: ymd.optional().nullable().or(z.literal('')),
  valor: z.number().min(0).max(100_000_000).optional().nullable(),
  parcelas: z.number().int().min(1).max(600).optional().nullable(),
  formaPagamento: opt(z.string().trim().max(60)),
  status: z.enum(STATUS_CLIENTE).optional(),
  observacoes: opt(z.string().max(4000)),
  prefWhatsapp: z.boolean().optional(),
  prefEmail: z.boolean().optional(),
  consentimento: z.boolean().optional(),
  consentimentoOrigem: z.enum(CONSENT_SOURCES).optional(),
  marketingOptOut: z.boolean().optional(),
});

function clienteData(b: Partial<z.infer<typeof clienteSchema>>, atual?: Cliente) {
  const d: any = {};
  const s = (v: unknown) => (v === '' || v === undefined ? (v === '' ? null : undefined) : v);
  if (b.nome !== undefined) d.nome = b.nome;
  if (b.documento !== undefined) d.documento = validarDocumento(b.documento);
  if (b.telefone !== undefined) d.telefone = fone(b.telefone, 'Telefone');
  if (b.whatsapp !== undefined) d.whatsapp = fone(b.whatsapp, 'WhatsApp');
  for (const k of ['email', 'emailSecundario', 'empresa', 'plano', 'formaPagamento', 'observacoes'] as const) {
    const v = s(b[k]);
    if (v !== undefined) d[k] = v;
  }
  if (b.dataContratacao !== undefined) d.dataContratacao = dataMeioDia(b.dataContratacao);
  if (b.dataVencimento !== undefined) d.dataVencimento = dataMeioDia(b.dataVencimento);
  if (b.valor !== undefined) d.valorCentavos = b.valor == null ? null : Math.round(b.valor * 100);
  if (b.parcelas !== undefined) d.parcelas = b.parcelas;
  if (b.status) d.status = b.status;
  if (b.prefWhatsapp !== undefined) d.prefWhatsapp = b.prefWhatsapp;
  if (b.prefEmail !== undefined) d.prefEmail = b.prefEmail;
  if (b.consentimento !== undefined) {
    d.consentimentoAt = b.consentimento ? (atual?.consentimentoAt ?? new Date()) : null;
    d.consentimentoOrigem = b.consentimento ? (b.consentimentoOrigem ?? atual?.consentimentoOrigem ?? 'MANUAL') : null;
  }
  if (b.marketingOptOut !== undefined) d.marketingOptOutAt = b.marketingOptOut ? (atual?.marketingOptOutAt ?? new Date()) : null;
  return d;
}

/** Procura um cliente que colida por telefone/WhatsApp, e-mail ou CPF/CNPJ. */
async function duplicado(orgId: string, d: { telefone?: string | null; whatsapp?: string | null; email?: string | null; documento?: string | null }, excetoId?: string) {
  const fones = [d.telefone, d.whatsapp].filter(Boolean) as string[];
  const or: any[] = [];
  for (const f of fones) or.push({ telefone: f }, { whatsapp: f });
  if (d.email) or.push({ email: d.email });
  if (d.documento) or.push({ documento: d.documento });
  if (!or.length) return null;
  return prisma.cliente.findFirst({ where: { orgId, OR: or, ...(excetoId ? { id: { not: excetoId } } : {}) } });
}

const clienteView = (c: Cliente) => ({ ...c, valor: c.valorCentavos != null ? c.valorCentavos / 100 : null, consentimento: !!c.consentimentoAt, marketingOptOut: !!c.marketingOptOutAt });

function filtroClientes(orgId: string, q?: string, status?: string) {
  const where: any = { orgId };
  if (status) where.status = status;
  if (q) {
    const d = digits(q);
    where.OR = [{ nome: { contains: q } }, { email: { contains: q.toLowerCase() } }, { empresa: { contains: q } }, { id: q }];
    if (d.length >= 4) where.OR.push({ telefone: { contains: d } }, { whatsapp: { contains: d } }, { documento: { contains: d } });
  }
  return where;
}

automacoesRouter.get('/clientes', ah(async (req, res) => {
  const q = z.object({ q: z.string().max(100).optional(), status: z.enum(STATUS_CLIENTE).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
  const where = filtroClientes(orgOf(req), q.q, q.status);
  const [items, total] = await Promise.all([
    prisma.cliente.findMany({ where, orderBy: { nome: 'asc' }, take: q.pageSize, skip: (q.page - 1) * q.pageSize }),
    prisma.cliente.count({ where }),
  ]);
  res.json({ items: items.map(clienteView), total, page: q.page, pageSize: q.pageSize });
}));

automacoesRouter.post('/clientes', ah(async (req, res) => {
  const body = clienteSchema.parse(req.body);
  const orgId = orgOf(req);
  const data = clienteData(body);
  const dup = await duplicado(orgId, data);
  if (dup) throw new HttpError(409, `Já existe um cliente com este telefone, e-mail ou CPF/CNPJ: ${dup.nome}`, { id: dup.id });
  const c = await prisma.cliente.create({ data: { orgId, ...data } });
  await audit(req, 'automacoes.cliente.create', { entity: 'Cliente', entityId: c.id });
  res.status(201).json(clienteView(c));
}));

const CSV_COLS = ['nome', 'documento', 'telefone', 'whatsapp', 'email', 'emailSecundario', 'empresa', 'plano', 'dataContratacao', 'dataVencimento', 'valor', 'parcelas', 'formaPagamento', 'status', 'consentimento', 'marketingOptOut'];

automacoesRouter.get('/clientes/export', ah(async (req, res) => {
  if (!podeEscrever(req)) throw forbidden('Exportação restrita a administradores');
  const orgId = orgOf(req);
  const items = await prisma.cliente.findMany({ where: { orgId }, orderBy: { nome: 'asc' } });
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const ymdOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
  const rows = items.map((c) => [c.nome, c.documento, c.telefone, c.whatsapp, c.email, c.emailSecundario, c.empresa, c.plano, ymdOf(c.dataContratacao), ymdOf(c.dataVencimento),
    c.valorCentavos != null ? (c.valorCentavos / 100).toFixed(2) : '', c.parcelas, c.formaPagamento, c.status, c.consentimentoAt ? 'sim' : 'nao', c.marketingOptOutAt ? 'sim' : 'nao'].map(esc).join(','));
  await audit(req, 'automacoes.cliente.export', { meta: { count: items.length } });
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="clientes.csv"');
  res.send([CSV_COLS.join(','), ...rows].join('\n'));
}));

function splitCsv(line: string, sep: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === sep) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Importação CSV com cabeçalho (colunas de clientes.csv). Duplicados são mesclados (só preenche campos vazios). */
automacoesRouter.post('/clientes/import', ah(async (req, res) => {
  const body = z.object({ text: z.string().min(1).max(2_000_000), consentimentoDeclarado: z.boolean().default(false) }).parse(req.body);
  const orgId = orgOf(req);
  const lines = body.text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new HttpError(400, 'Envie o cabeçalho e ao menos uma linha');
  if (lines.length > 10001) throw new HttpError(400, 'Máximo de 10.000 linhas por importação');
  const sep = lines[0].includes(';') ? ';' : ',';
  const head = splitCsv(lines[0], sep).map((h) => h.toLowerCase());
  const idx = (k: string) => head.indexOf(k.toLowerCase());
  if (idx('nome') < 0) throw new HttpError(400, 'O cabeçalho precisa ter a coluna "nome"');
  let criados = 0, atualizados = 0; const erros: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i], sep);
    const get = (k: string) => { const j = idx(k); return j >= 0 ? cols[j] || '' : ''; };
    try {
      const sim = (v: string) => /^(sim|s|1|true|yes)$/i.test(v);
      const raw: any = {
        nome: get('nome'), documento: get('documento'), telefone: get('telefone'), whatsapp: get('whatsapp'), email: get('email'),
        emailSecundario: get('emailSecundario'), empresa: get('empresa'), plano: get('plano'), dataContratacao: get('dataContratacao'),
        dataVencimento: get('dataVencimento'), formaPagamento: get('formaPagamento'),
        ...(get('valor') ? { valor: Number(get('valor').replace(',', '.')) } : {}),
        ...(get('parcelas') ? { parcelas: Number(get('parcelas')) } : {}),
        ...(get('status') ? { status: get('status').toUpperCase() } : {}),
        ...(body.consentimentoDeclarado || sim(get('consentimento')) ? { consentimento: true, consentimentoOrigem: 'IMPORTACAO' } : {}),
        ...(sim(get('marketingOptOut')) ? { marketingOptOut: true } : {}),
      };
      const data = clienteData(clienteSchema.parse(raw));
      const dup = await duplicado(orgId, data);
      if (dup) {
        const merge: any = {};
        for (const [k, v] of Object.entries(data)) if (v != null && (dup as any)[k] == null) merge[k] = v;
        if (Object.keys(merge).length) await prisma.cliente.update({ where: { id: dup.id }, data: merge });
        atualizados++;
      } else {
        await prisma.cliente.create({ data: { orgId, ...data } });
        criados++;
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.issues[0]?.message : (e as Error).message;
      erros.push(`Linha ${i + 1}: ${msg}`);
    }
  }
  await audit(req, 'automacoes.cliente.import', { meta: { criados, atualizados, erros: erros.length } });
  res.json({ criados, atualizados, erros: erros.slice(0, 100) });
}));

async function getCliente(orgId: string, id: string) {
  const c = await prisma.cliente.findFirst({ where: { id, orgId } });
  if (!c) throw notFound('Cliente');
  return c;
}

automacoesRouter.get('/clientes/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await getCliente(orgId, req.params.id);
  const [historico, proximas, automacoes] = await Promise.all([
    prisma.mensagemHistorico.findMany({ where: { orgId, clienteId: c.id }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.ocorrencia.findMany({ where: { orgId, clienteId: c.id, status: 'PENDENTE' }, orderBy: { executarEm: 'asc' }, take: 20 }),
    prisma.automacao.findMany({ where: { orgId, clienteIds: { contains: JSON.stringify(c.id) } }, orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({ ...clienteView(c), historico, proximas, automacoes: automacoes.map((a) => ({ id: a.id, nome: a.nome, categoria: a.categoria, status: a.status })) });
}));

automacoesRouter.patch('/clientes/:id', ah(async (req, res) => {
  const body = clienteSchema.partial().parse(req.body);
  const orgId = orgOf(req);
  const c = await getCliente(orgId, req.params.id);
  const data = clienteData(body, c);
  const dup = await duplicado(orgId, { telefone: data.telefone, whatsapp: data.whatsapp, email: data.email, documento: data.documento }, c.id);
  if (dup) throw new HttpError(409, `Já existe um cliente com este telefone, e-mail ou CPF/CNPJ: ${dup.nome}`, { id: dup.id });
  const u = await prisma.cliente.update({ where: { id: c.id }, data });
  await audit(req, 'automacoes.cliente.update', { entity: 'Cliente', entityId: c.id, meta: Object.keys(data) });
  res.json(clienteView(u));
}));

/** Exclusão: só o OWNER. Cancela os envios pendentes; o histórico de mensagens é preservado. */
automacoesRouter.delete('/clientes/:id', ah(async (req, res) => {
  if (req.auth?.role !== 'OWNER') throw forbidden('Somente o proprietário pode excluir clientes');
  const orgId = orgOf(req);
  const c = await getCliente(orgId, req.params.id);
  await prisma.ocorrencia.updateMany({ where: { orgId, clienteId: c.id, status: 'PENDENTE' }, data: { status: 'CANCELADA', erro: 'Cliente excluído' } });
  await prisma.cliente.delete({ where: { id: c.id } });
  await audit(req, 'automacoes.cliente.delete', { entity: 'Cliente', entityId: c.id, meta: { nome: c.nome } });
  res.json({ ok: true });
}));

// ---------------- Variáveis, prévia e modelos ----------------

automacoesRouter.get('/variaveis', ah(async (_req, res) => {
  res.json({ disponiveis: Object.entries(VARIAVEIS).map(([k, v]) => ({ chave: k, rotulo: v.rotulo })), fase2: VARIAVEIS_FASE2 });
}));

automacoesRouter.post('/preview', ah(async (req, res) => {
  // Prévia é leitura: liberada também para o perfil somente leitura (não altera nada).
  const b = z.object({ mensagem: z.string().max(4000), assunto: z.string().max(200).optional().nullable(), clienteId: z.string() }).parse(req.body);
  const orgId = orgOf(req);
  const c = await getCliente(orgId, b.clienteId);
  const cfg = await getConfig(orgId);
  const r = renderMensagem(b.mensagem, c, cfg.timezone);
  const a = b.assunto ? renderMensagem(b.assunto, c, cfg.timezone) : null;
  const problema = problemaRender(r) ?? (a ? problemaRender(a) : null);
  res.json({ texto: r.texto, assunto: a?.texto ?? null, faltando: [...r.faltando, ...(a?.faltando ?? [])], desconhecidas: [...r.desconhecidas, ...(a?.desconhecidas ?? [])], bloqueado: !!problema, problema });
}));

const modeloSchema = z.object({ categoria: z.enum(CATEGORIAS), nome: z.string().trim().min(1).max(120), assunto: z.string().trim().max(200).optional().nullable(), corpo: z.string().trim().min(1).max(4000) });

automacoesRouter.get('/modelos', ah(async (req, res) => {
  const q = z.object({ categoria: z.enum(CATEGORIAS).optional() }).parse(req.query);
  res.json(await prisma.modeloMensagem.findMany({ where: { orgId: orgOf(req), ...(q.categoria ? { categoria: q.categoria } : {}) }, orderBy: { nome: 'asc' } }));
}));
automacoesRouter.post('/modelos', ah(async (req, res) => {
  const b = modeloSchema.parse(req.body);
  const m = await prisma.modeloMensagem.create({ data: { orgId: orgOf(req), ...b } });
  await audit(req, 'automacoes.modelo.create', { entity: 'ModeloMensagem', entityId: m.id });
  res.status(201).json(m);
}));
automacoesRouter.patch('/modelos/:id', ah(async (req, res) => {
  const b = modeloSchema.partial().parse(req.body);
  const m = await prisma.modeloMensagem.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!m) throw notFound('Modelo');
  res.json(await prisma.modeloMensagem.update({ where: { id: m.id }, data: b }));
}));
automacoesRouter.delete('/modelos/:id', ah(async (req, res) => {
  const m = await prisma.modeloMensagem.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!m) throw notFound('Modelo');
  await prisma.modeloMensagem.delete({ where: { id: m.id } });
  await audit(req, 'automacoes.modelo.delete', { entity: 'ModeloMensagem', entityId: m.id });
  res.json({ ok: true });
}));

// ---------------- Automações ----------------

const automacaoSchema = z.object({
  nome: z.string().trim().min(1, 'Informe o nome').max(160),
  categoria: z.enum(CATEGORIAS),
  canais: z.array(z.enum(CANAIS)).min(1, 'Escolha ao menos um canal'),
  channelId: z.string().optional().nullable(),
  assunto: z.string().trim().max(200).optional().nullable(),
  mensagem: z.string().trim().min(1, 'Escreva a mensagem').max(4000),
  clienteIds: z.array(z.string()).max(10000).optional(),
  todosClientes: z.object({ status: z.enum(STATUS_CLIENTE).optional(), q: z.string().max(100).optional() }).optional(),
  regra: regraSchema,
  timezone: z.string().optional(),
  inicio: ymd.optional(),
  fim: ymd.optional().nullable(),
  maxEnvios: z.number().int().min(1).max(100000).optional().nullable(),
  ativar: z.boolean().optional(),
});

async function resolverDestinatarios(orgId: string, b: { clienteIds?: string[]; todosClientes?: { status?: string; q?: string } }) {
  if (b.todosClientes) return (await prisma.cliente.findMany({ where: filtroClientes(orgId, b.todosClientes.q, b.todosClientes.status), select: { id: true } })).map((c) => c.id);
  const ids = [...new Set(b.clienteIds ?? [])];
  if (!ids.length) return [];
  const ok = await prisma.cliente.findMany({ where: { orgId, id: { in: ids } }, select: { id: true } });
  if (ok.length !== ids.length) throw new HttpError(400, 'Há clientes inválidos entre os destinatários');
  return ids;
}

async function automacaoData(orgId: string, b: Partial<z.infer<typeof automacaoSchema>>, atual?: Automacao) {
  const d: any = {};
  const tz = b.timezone ?? atual?.timezone ?? (await getConfig(orgId)).timezone;
  if (!isValidTimeZone(tz)) throw new HttpError(400, 'Fuso horário inválido');
  if (b.timezone) d.timezone = tz;
  for (const k of ['nome', 'categoria', 'mensagem'] as const) if (b[k] !== undefined) d[k] = b[k];
  if (b.assunto !== undefined) d.assunto = b.assunto || null;
  if (b.canais) d.canais = JSON.stringify([...new Set(b.canais)]);
  if (b.channelId !== undefined) {
    if (b.channelId && !(await prisma.channel.findFirst({ where: { id: b.channelId, orgId } }))) throw new HttpError(400, 'Canal WhatsApp inválido');
    d.channelId = b.channelId || null;
  }
  if (b.clienteIds !== undefined || b.todosClientes) d.clienteIds = JSON.stringify(await resolverDestinatarios(orgId, b));
  if (b.regra) d.regra = JSON.stringify(b.regra);
  const regra = b.regra ?? (atual ? regraDe(atual) : null);
  if (b.inicio !== undefined || b.regra || b.timezone || !atual) {
    const ini = b.inicio ?? (regra?.tipo === 'UNICO' ? regra.data : regra?.tipo === 'DATAS' ? [...regra.datas].sort((x, y) => x.data.localeCompare(y.data))[0].data : undefined)
      ?? (atual ? localDate(atual.inicio, tz) : localDate(new Date(), tz));
    d.inicio = zonedToUtc(ini, '00:00', tz);
  }
  if (b.fim !== undefined || b.timezone) {
    const fim = b.fim !== undefined ? b.fim : atual?.fim ? localDate(atual.fim, atual.timezone) : null;
    d.fim = fim ? zonedToUtc(fim, '23:59', tz) : null;
  }
  if (b.maxEnvios !== undefined) d.maxEnvios = b.maxEnvios;
  const ini = d.inicio ?? atual?.inicio, fim = d.fim !== undefined ? d.fim : atual?.fim;
  if (fim && ini && fim < ini) throw new HttpError(400, 'A data de término não pode ser anterior ao início');
  return d;
}

/** Bloqueia a ativação se faltar destinatário, canal ou alguma variável obrigatória para algum cliente. */
async function validarAtivacao(a: Automacao) {
  const ids = parseJson<string[]>(a.clienteIds, []);
  if (!ids.length) throw new HttpError(400, 'Escolha ao menos um cliente');
  const clientes = await prisma.cliente.findMany({ where: { orgId: a.orgId, id: { in: ids } } });
  const problemas: { clienteId: string; nome: string; problema: string }[] = [];
  for (const c of clientes) {
    const p = problemaRender(renderMensagem(a.mensagem, c, a.timezone)) ?? (a.assunto ? problemaRender(renderMensagem(a.assunto, c, a.timezone)) : null);
    if (p) problemas.push({ clienteId: c.id, nome: c.nome, problema: p });
  }
  if (problemas.length) throw new HttpError(400, `Não é possível ativar: ${problemas[0].nome} — ${problemas[0].problema}`, { problemas: problemas.slice(0, 100) });
  const canais = parseJson<string[]>(a.canais, []);
  const avisos: string[] = [];
  const semConsent = clientes.filter((c) => !c.consentimentoAt).length;
  if (semConsent) avisos.push(`${semConsent} cliente(s) sem consentimento registrado não receberão`);
  if (a.categoria === 'MARKETING') { const n = clientes.filter((c) => c.marketingOptOutAt).length; if (n) avisos.push(`${n} cliente(s) com opt-out de marketing não receberão`); }
  if (canais.includes('EMAIL')) { const n = clientes.filter((c) => !c.email).length; if (n) avisos.push(`${n} cliente(s) sem e-mail`); }
  if (canais.includes('WHATSAPP')) { const n = clientes.filter((c) => !c.whatsapp && !c.telefone).length; if (n) avisos.push(`${n} cliente(s) sem WhatsApp`); }
  return avisos;
}

async function automacaoView(a: Automacao) {
  const groups = await prisma.ocorrencia.groupBy({ by: ['status'], where: { automacaoId: a.id }, _count: { _all: true } });
  const proxima = await prisma.ocorrencia.findFirst({ where: { automacaoId: a.id, status: 'PENDENTE' }, orderBy: { executarEm: 'asc' }, select: { executarEm: true } });
  const regra = parseJson<any>(a.regra, {});
  let descricao = '';
  try { descricao = descreverRegra(regraSchema.parse(regra)); } catch { /* regra antiga/ inválida */ }
  return {
    ...a, canais: parseJson<string[]>(a.canais, []), clienteIds: parseJson<string[]>(a.clienteIds, []), regra, descricao,
    ocorrencias: Object.fromEntries(groups.map((g) => [g.status, g._count._all])), proximoEnvio: proxima?.executarEm ?? null,
  };
}

async function getAutomacao(orgId: string, id: string) {
  const a = await prisma.automacao.findFirst({ where: { id, orgId } });
  if (!a) throw notFound('Automação');
  return a;
}

automacoesRouter.get('/automacoes', ah(async (req, res) => {
  const q = z.object({ categoria: z.enum(CATEGORIAS).optional(), status: z.string().max(20).optional() }).parse(req.query);
  const items = await prisma.automacao.findMany({ where: { orgId: orgOf(req), ...(q.categoria ? { categoria: q.categoria } : {}), ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 500 });
  res.json(await Promise.all(items.map(automacaoView)));
}));

automacoesRouter.post('/automacoes', ah(async (req, res) => {
  const b = automacaoSchema.parse(req.body);
  const orgId = orgOf(req);
  const data = await automacaoData(orgId, b);
  let a = await prisma.automacao.create({ data: { orgId, createdById: req.auth!.userId, ...data, nome: b.nome, categoria: b.categoria, mensagem: b.mensagem, regra: JSON.stringify(b.regra) } });
  let avisos: string[] = [];
  if (b.ativar) {
    try {
      avisos = await validarAtivacao(a);
    } catch (e) {
      await audit(req, 'automacoes.automacao.create', { entity: 'Automacao', entityId: a.id, meta: { ativada: false } });
      throw e;
    }
    a = await prisma.automacao.update({ where: { id: a.id }, data: { status: 'ATIVA' } });
    await reprogramar(a);
  }
  await audit(req, 'automacoes.automacao.create', { entity: 'Automacao', entityId: a.id, meta: { categoria: a.categoria, ativada: !!b.ativar } });
  res.status(201).json({ ...(await automacaoView(a)), avisos });
}));

automacoesRouter.get('/automacoes/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const a = await getAutomacao(orgId, req.params.id);
  const ocorr = await prisma.ocorrencia.findMany({ where: { automacaoId: a.id }, orderBy: { agendadoPara: 'asc' }, take: 300 });
  const proximas = ocorr.filter((o) => o.status === 'PENDENTE' || o.status === 'PROCESSANDO').slice(0, 100);
  const processadas = ocorr.filter((o) => o.status !== 'PENDENTE' && o.status !== 'PROCESSANDO').slice(-100);
  res.json({ ...(await automacaoView(a)), proximas, processadas });
}));

/**
 * Edição. escopo:
 *  - PROXIMOS (padrão): altera a automação e reprograma só os envios futuros ainda não processados;
 *    nada já enviado/falhado é reenviado. Envios pendentes editados individualmente são preservados.
 */
automacoesRouter.patch('/automacoes/:id', ah(async (req, res) => {
  const b = automacaoSchema.partial().extend({ escopo: z.enum(['PROXIMOS']).default('PROXIMOS') }).parse(req.body);
  const orgId = orgOf(req);
  const a = await getAutomacao(orgId, req.params.id);
  if (a.status === 'CANCELADA' || a.status === 'CONCLUIDA') throw new HttpError(400, 'Automação encerrada não pode ser editada. Duplique para criar outra.');
  const data = await automacaoData(orgId, b, a);
  let u = await prisma.automacao.update({ where: { id: a.id }, data });
  let avisos: string[] = [];
  let reprogramadas = 0;
  if (u.status === 'ATIVA') {
    avisos = await validarAtivacao(u).catch(async (e) => { await prisma.automacao.update({ where: { id: a.id }, data: { ...pick(a, Object.keys(data)) } }); throw e; });
    reprogramadas = await reprogramar(u);
    u = await prisma.automacao.findUniqueOrThrow({ where: { id: a.id } });
  }
  await audit(req, 'automacoes.automacao.update', { entity: 'Automacao', entityId: a.id, meta: { campos: Object.keys(data), escopo: b.escopo } });
  res.json({ ...(await automacaoView(u)), avisos, reprogramadas, escopo: b.escopo });
}));

function pick(o: any, keys: string[]) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }

automacoesRouter.post('/automacoes/:id/ativar', ah(async (req, res) => {
  const a = await getAutomacao(orgOf(req), req.params.id);
  if (a.status !== 'RASCUNHO') throw new HttpError(400, 'Só rascunhos podem ser ativados (use Retomar para automações pausadas)');
  const avisos = await validarAtivacao(a);
  const u = await prisma.automacao.update({ where: { id: a.id }, data: { status: 'ATIVA' } });
  await reprogramar(u);
  await audit(req, 'automacoes.automacao.ativar', { entity: 'Automacao', entityId: a.id });
  res.json({ ...(await automacaoView(u)), avisos });
}));

automacoesRouter.post('/automacoes/:id/pausar', ah(async (req, res) => {
  const a = await getAutomacao(orgOf(req), req.params.id);
  if (a.status !== 'ATIVA') throw new HttpError(400, 'Só automações ativas podem ser pausadas');
  const u = await prisma.automacao.update({ where: { id: a.id }, data: { status: 'PAUSADA' } });
  await audit(req, 'automacoes.automacao.pausar', { entity: 'Automacao', entityId: a.id });
  res.json(await automacaoView(u));
}));

/** Retomar: os envios cujo horário passou durante a pausa são cancelados (não dispara tudo de uma vez). */
automacoesRouter.post('/automacoes/:id/retomar', ah(async (req, res) => {
  const a = await getAutomacao(orgOf(req), req.params.id);
  if (a.status !== 'PAUSADA') throw new HttpError(400, 'Só automações pausadas podem ser retomadas');
  const now = new Date();
  const perdidas = await prisma.ocorrencia.updateMany({ where: { automacaoId: a.id, status: 'PENDENTE', tentativas: 0, executarEm: { lt: now } }, data: { status: 'CANCELADA', erro: 'Horário passou enquanto a automação estava pausada' } });
  const u = await prisma.automacao.update({ where: { id: a.id }, data: { status: 'ATIVA' } });
  await reprogramar(u, now);
  await audit(req, 'automacoes.automacao.retomar', { entity: 'Automacao', entityId: a.id, meta: { canceladasNaPausa: perdidas.count } });
  res.json({ ...(await automacaoView(u)), canceladasNaPausa: perdidas.count });
}));

automacoesRouter.post('/automacoes/:id/cancelar', ah(async (req, res) => {
  const a = await getAutomacao(orgOf(req), req.params.id);
  if (a.status === 'CANCELADA') throw new HttpError(400, 'Automação já cancelada');
  const r = await prisma.ocorrencia.updateMany({ where: { automacaoId: a.id, status: 'PENDENTE' }, data: { status: 'CANCELADA', erro: 'Automação cancelada' } });
  const u = await prisma.automacao.update({ where: { id: a.id }, data: { status: 'CANCELADA' } });
  await audit(req, 'automacoes.automacao.cancelar', { entity: 'Automacao', entityId: a.id, meta: { canceladas: r.count } });
  res.json({ ...(await automacaoView(u)), canceladas: r.count });
}));

automacoesRouter.post('/automacoes/:id/duplicar', ah(async (req, res) => {
  const a = await getAutomacao(orgOf(req), req.params.id);
  const c = await prisma.automacao.create({
    data: {
      orgId: a.orgId, nome: `${a.nome} (cópia)`.slice(0, 160), categoria: a.categoria, canais: a.canais, channelId: a.channelId, assunto: a.assunto, mensagem: a.mensagem,
      clienteIds: a.clienteIds, regra: a.regra, timezone: a.timezone, inicio: a.inicio, fim: a.fim, maxEnvios: a.maxEnvios, status: 'RASCUNHO', createdById: req.auth!.userId,
    },
  });
  await audit(req, 'automacoes.automacao.duplicar', { entity: 'Automacao', entityId: c.id, meta: { origem: a.id } });
  res.status(201).json(await automacaoView(c));
}));

/** Prévia dos próximos horários de uma regra (sem salvar). */
automacoesRouter.post('/regra/previa', ah(async (req, res) => {
  const b = z.object({ regra: regraSchema, timezone: z.string().optional(), inicio: ymd.optional(), fim: ymd.optional().nullable(), maxEnvios: z.number().int().min(1).optional().nullable() }).parse(req.body);
  const tz = b.timezone ?? (await getConfig(orgOf(req))).timezone;
  if (!isValidTimeZone(tz)) throw new HttpError(400, 'Fuso horário inválido');
  const now = new Date();
  const inicio = b.inicio ? zonedToUtc(b.inicio, '00:00', tz) : b.regra.tipo === 'UNICO' ? zonedToUtc(b.regra.data, '00:00', tz) : now;
  const hs = gerarHorarios({ regra: b.regra, tz, inicio, fim: b.fim ? zonedToUtc(b.fim, '23:59', tz) : null, de: now, ate: new Date(now.getTime() + 366 * 86400e3), max: b.maxEnvios ?? undefined, limite: 20 });
  res.json({ descricao: descreverRegra(b.regra), proximos: hs });
}));

// ---------------- Ocorrências (edição pontual) ----------------

async function getOcorrencia(orgId: string, id: string) {
  const o = await prisma.ocorrencia.findFirst({ where: { id, orgId } });
  if (!o) throw notFound('Envio');
  return o;
}

/** "Só esta ocorrência": muda texto e/ou horário de um envio ainda pendente. */
automacoesRouter.patch('/ocorrencias/:id', ah(async (req, res) => {
  const b = z.object({ mensagem: z.string().trim().min(1).max(4000).optional().nullable(), data: ymd.optional(), horario: hhmm.optional() }).parse(req.body);
  const orgId = orgOf(req);
  const o = await getOcorrencia(orgId, req.params.id);
  if (o.status !== 'PENDENTE') throw new HttpError(400, 'Só envios pendentes podem ser editados (os já processados não são reenviados)');
  const a = await getAutomacao(orgId, o.automacaoId);
  const data: any = { editada: true };
  if (b.mensagem !== undefined) data.mensagem = b.mensagem || null;
  if (b.data || b.horario) {
    const t = zonedToUtc(b.data ?? localDate(o.agendadoPara, a.timezone), b.horario ?? new Intl.DateTimeFormat('en-GB', { timeZone: a.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(o.agendadoPara), a.timezone);
    if (t.getTime() < Date.now() - 60_000) throw new HttpError(400, 'O novo horário já passou');
    data.agendadoPara = t; data.executarEm = t;
  }
  const u = await prisma.ocorrencia.update({ where: { id: o.id }, data });
  await audit(req, 'automacoes.ocorrencia.update', { entity: 'Ocorrencia', entityId: o.id, meta: Object.keys(data) });
  res.json(u);
}));

automacoesRouter.post('/ocorrencias/:id/cancelar', ah(async (req, res) => {
  const o = await getOcorrencia(orgOf(req), req.params.id);
  const r = await prisma.ocorrencia.updateMany({ where: { id: o.id, status: 'PENDENTE' }, data: { status: 'CANCELADA', erro: 'Cancelado manualmente' } });
  if (!r.count) throw new HttpError(400, 'Só envios pendentes podem ser cancelados');
  await audit(req, 'automacoes.ocorrencia.cancelar', { entity: 'Ocorrencia', entityId: o.id });
  res.json({ ok: true });
}));

/** Reprocessamento seguro: só envios que FALHARAM ou foram IGNORADOS (nunca um já enviado). */
automacoesRouter.post('/ocorrencias/:id/reprocessar', ah(async (req, res) => {
  const o = await getOcorrencia(orgOf(req), req.params.id);
  const r = await prisma.ocorrencia.updateMany({ where: { id: o.id, status: { in: ['FALHOU', 'IGNORADA'] } }, data: { status: 'PENDENTE', tentativas: 0, erro: null, executarEm: new Date() } });
  if (!r.count) throw new HttpError(400, 'Só envios com falha ou ignorados podem ser reprocessados');
  await audit(req, 'automacoes.ocorrencia.reprocessar', { entity: 'Ocorrencia', entityId: o.id });
  res.json({ ok: true });
}));

// ---------------- Dashboard, calendário e histórico ----------------

automacoesRouter.get('/dashboard', ah(async (req, res) => {
  const orgId = orgOf(req);
  const cfg = await getConfig(orgId);
  const now = new Date();
  const hoje = zonedToUtc(localDate(now, cfg.timezone), '00:00', cfg.timezone);
  const [clientes, programadas, enviadasHoje, pendentes, falhas, marketingAtivas, lembretesAtivos, pausadas, proximos] = await Promise.all([
    prisma.cliente.count({ where: { orgId } }),
    prisma.ocorrencia.count({ where: { orgId, status: 'PENDENTE' } }),
    prisma.ocorrencia.count({ where: { orgId, status: 'ENVIADA', enviadoEm: { gte: hoje } } }),
    prisma.ocorrencia.count({ where: { orgId, status: { in: ['PENDENTE', 'PROCESSANDO'] }, executarEm: { lte: now } } }),
    prisma.ocorrencia.count({ where: { orgId, status: 'FALHOU' } }),
    prisma.automacao.count({ where: { orgId, categoria: 'MARKETING', status: 'ATIVA' } }),
    prisma.automacao.count({ where: { orgId, categoria: 'LEMBRETE', status: 'ATIVA' } }),
    prisma.automacao.count({ where: { orgId, status: 'PAUSADA' } }),
    prisma.ocorrencia.findMany({ where: { orgId, status: 'PENDENTE', executarEm: { gte: now } }, orderBy: { executarEm: 'asc' }, take: 10 }),
  ]);
  const nomes = await nomesDe(orgId, proximos);
  res.json({
    clientes, programadas, enviadasHoje, pendentes, falhas, marketingAtivas, lembretesAtivos, pausadas,
    proximos: proximos.map((o) => ({ ...o, cliente: nomes.c[o.clienteId] ?? '—', automacao: nomes.a[o.automacaoId]?.nome ?? '—', categoria: nomes.a[o.automacaoId]?.categoria })),
  });
}));

async function nomesDe(orgId: string, rows: { clienteId: string | null; automacaoId: string | null }[]) {
  const cIds = [...new Set(rows.map((r) => r.clienteId).filter(Boolean) as string[])];
  const aIds = [...new Set(rows.map((r) => r.automacaoId).filter(Boolean) as string[])];
  const [cs, as] = await Promise.all([
    cIds.length ? prisma.cliente.findMany({ where: { orgId, id: { in: cIds } }, select: { id: true, nome: true } }) : [],
    aIds.length ? prisma.automacao.findMany({ where: { orgId, id: { in: aIds } }, select: { id: true, nome: true, categoria: true, status: true } }) : [],
  ]);
  return { c: Object.fromEntries(cs.map((c) => [c.id, c.nome])), a: Object.fromEntries(as.map((a) => [a.id, a])) };
}

automacoesRouter.get('/calendario', ah(async (req, res) => {
  const q = z.object({ de: z.coerce.date(), ate: z.coerce.date(), categoria: z.enum(CATEGORIAS).optional() }).parse(req.query);
  if (q.ate.getTime() - q.de.getTime() > 45 * 86400e3) throw new HttpError(400, 'Período máximo de 45 dias');
  const orgId = orgOf(req);
  let automacaoIds: string[] | undefined;
  if (q.categoria) automacaoIds = (await prisma.automacao.findMany({ where: { orgId, categoria: q.categoria }, select: { id: true } })).map((a) => a.id);
  const rows = await prisma.ocorrencia.findMany({
    where: { orgId, agendadoPara: { gte: q.de, lt: q.ate }, ...(automacaoIds ? { automacaoId: { in: automacaoIds } } : {}) },
    orderBy: { agendadoPara: 'asc' }, take: 3000,
  });
  const nomes = await nomesDe(orgId, rows);
  const cfg = await getConfig(orgId);
  res.json({
    timezone: cfg.timezone, truncado: rows.length >= 3000,
    eventos: rows.map((o) => ({
      id: o.id, automacaoId: o.automacaoId, clienteId: o.clienteId, canal: o.canal, status: o.status, agendadoPara: o.agendadoPara, enviadoEm: o.enviadoEm, erro: o.erro,
      cliente: nomes.c[o.clienteId] ?? '—', automacao: nomes.a[o.automacaoId]?.nome ?? '—', categoria: nomes.a[o.automacaoId]?.categoria ?? null, automacaoStatus: nomes.a[o.automacaoId]?.status ?? null,
    })),
  });
}));

automacoesRouter.get('/historico', ah(async (req, res) => {
  const q = z.object({
    clienteId: z.string().optional(), automacaoId: z.string().optional(), categoria: z.enum(CATEGORIAS).optional(), canal: z.enum(CANAIS).optional(),
    status: z.string().max(20).optional(), de: z.coerce.date().optional(), ate: z.coerce.date().optional(), q: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
  }).parse(req.query);
  const orgId = orgOf(req);
  const where: any = { orgId };
  for (const k of ['clienteId', 'automacaoId', 'categoria', 'canal', 'status'] as const) if (q[k]) where[k] = q[k];
  if (q.de || q.ate) where.updatedAt = { ...(q.de ? { gte: q.de } : {}), ...(q.ate ? { lt: q.ate } : {}) };
  if (q.q) where.conteudo = { contains: q.q };
  const [items, total] = await Promise.all([
    prisma.mensagemHistorico.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 50, skip: (q.page - 1) * 50 }),
    prisma.mensagemHistorico.count({ where }),
  ]);
  const nomes = await nomesDe(orgId, items);
  res.json({ items: items.map((h) => ({ ...h, cliente: h.clienteId ? nomes.c[h.clienteId] ?? '(excluído)' : '—', automacao: h.automacaoId ? nomes.a[h.automacaoId]?.nome ?? '—' : '—' })), total, page: q.page, pageSize: 50 });
}));

// ---------------- Configurações ----------------

automacoesRouter.get('/config', ah(async (req, res) => {
  res.json(await getConfig(orgOf(req)));
}));

automacoesRouter.put('/config', ah(async (req, res) => {
  const b = z.object({
    timezone: z.string().refine(isValidTimeZone, 'Fuso horário inválido').optional(),
    janelaInicio: hhmm.optional(), janelaFim: hhmm.optional(),
    limiteDiario: z.number().int().min(1).max(100000).optional(),
    maxTentativas: z.number().int().min(1).max(10).optional(),
    backoffSeg: z.number().int().min(10).max(86400).optional(),
  }).parse(req.body);
  const orgId = orgOf(req);
  await getConfig(orgId);
  const u = await prisma.automacaoConfig.update({ where: { orgId }, data: b });
  await audit(req, 'automacoes.config.update', { meta: Object.keys(b) });
  res.json(u);
}));

/** Status real das integrações (nada simulado): canais WhatsApp do banco/sessão QR e SMTP configurado. */
automacoesRouter.get('/integracoes', ah(async (req, res) => {
  const channels = await prisma.channel.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: 'asc' } });
  res.json({
    whatsapp: channels.map((c) => ({
      id: c.id, nome: c.name, provedor: c.provider, telefone: c.displayPhone,
      status: c.provider === 'whatsapp_qr' ? (qrManager.isConnected(c.id) ? 'CONNECTED' : c.status === 'CONNECTED' ? 'DISCONNECTED' : c.status) : c.status,
      erro: c.lastError,
    })),
    email: { configurado: smtpConfigured(), remetente: smtpConfigured() ? (process.env.MAIL_FROM ?? null) : null },
    horizonteDias: HORIZONTE_DIAS,
  });
}));

automacoesRouter.post('/integracoes/email/verificar', ah(async (req, res) => {
  const r = await verifySmtp();
  await audit(req, 'automacoes.email.verificar', { meta: { ok: r.ok } });
  res.json(r);
}));

export { STATUS_OCORRENCIA };
