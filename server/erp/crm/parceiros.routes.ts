/** Cadastro 360º de clientes/fornecedores. Leitura: membros do módulo. Escrita: OWNER/ADMIN/AGENT (exclusão só OWNER/ADMIN). */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { isValidCnpj, isValidCpf, onlyDigits, normalizeCelular } from '../../lib/documento.js';
import { auditar } from '../shared/auditoria.js';
import { consultarCnpj, CnpjErro } from './cnpj.js';

export const parceirosRouter = Router();
const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const parceiroSchema = z.object({
  documento: z.string().transform(onlyDigits).refine((d) => (d.length === 11 ? isValidCpf(d) : d.length === 14 ? isValidCnpj(d) : false), 'CPF ou CNPJ inválido'),
  nome: z.string().trim().min(2, 'Informe o nome').max(200),
  fantasia: opt(200), ehCliente: z.boolean().default(true), ehFornecedor: z.boolean().default(false),
  inscricaoEstadual: opt(20), regimeTributario: z.enum(['SIMPLES', 'MEI', 'NORMAL']).nullish(),
  cnae: opt(10), cnaeDescricao: opt(300), situacaoCadastral: opt(40),
  email: z.string().trim().email('E-mail inválido').max(200).nullish().or(z.literal('')).transform((v) => (v ? v.toLowerCase() : null)),
  telefone: z.string().nullish().transform((v) => (v ? normalizeCelular(v) ?? (onlyDigits(v).length >= 10 ? `+55${onlyDigits(v).replace(/^55/, '')}` : null) : null)),
  cep: z.string().nullish().transform((v) => (v ? onlyDigits(v).slice(0, 8) || null : null)),
  logradouro: opt(200), numero: opt(20), complemento: opt(100), bairro: opt(100), municipio: opt(100), codigoMunicipio: opt(10),
  uf: z.string().trim().length(2).toUpperCase().nullish().or(z.literal('')).transform((v) => (v ? v : null)),
  limiteCreditoCents: z.number().int().min(0).max(2_000_000_000).default(0),
  status: z.enum(['ATIVO', 'INATIVO', 'BLOQUEADO']).default('ATIVO'),
  origem: opt(60), filialId: opt(40), contactId: opt(40),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  observacoes: opt(5000),
});

const toData = (b: z.infer<typeof parceiroSchema>) => ({ ...b, tipoPessoa: b.documento.length === 14 ? 'PJ' : 'PF', tags: JSON.stringify(b.tags), regimeTributario: b.regimeTributario ?? null });
const fromRow = <T extends { tags: string }>(p: T) => ({ ...p, tags: safeArr(p.tags) });
function safeArr(s: string): string[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

/** Consulta CNPJ na Receita (BrasilAPI) para preencher o formulário. */
parceirosRouter.get('/cnpj/:cnpj', ah(async (req, res) => {
  try { res.json(await consultarCnpj(req.params.cnpj)); }
  catch (e) { if (e instanceof CnpjErro) return res.status(e.status).json({ error: e.message }); throw e; }
}));

parceirosRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const tipo = req.query.tipo === 'fornecedor' ? { ehFornecedor: true } : req.query.tipo === 'cliente' ? { ehCliente: true } : {};
  const digits = onlyDigits(q);
  const where = {
    orgId, ...tipo, ...(status ? { status } : {}),
    ...(q ? { OR: [{ nome: { contains: q } }, { fantasia: { contains: q } }, ...(digits.length >= 3 ? [{ documento: { contains: digits } }] : []), { email: { contains: q.toLowerCase() } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.erpParceiro.findMany({ where, orderBy: { nome: 'asc' }, take: 200 }),
    prisma.erpParceiro.count({ where }),
  ]);
  res.json({ items: items.map(fromRow), total });
}));

/** Visão 360º: cadastro, contatos, oportunidades, linha do tempo e indicadores do cliente. */
parceirosRouter.get('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId }, include: { contatos: true, oportunidades: { orderBy: { createdAt: 'desc' }, take: 50 } } });
  if (!p) throw notFound('Cliente');
  const interacoes = await prisma.erpInteracao.findMany({ where: { orgId, parceiroId: p.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  const ganhas = p.oportunidades.filter((o) => o.status === 'GANHA');
  const totalGanho = ganhas.reduce((a, o) => a + o.valorCents, 0);
  res.json({
    ...fromRow(p), interacoes,
    resumo: {
      totalGanhoCents: totalGanho, negociosGanhos: ganhas.length,
      ticketMedioCents: ganhas.length ? Math.round(totalGanho / ganhas.length) : 0,
      emAbertoCents: p.oportunidades.filter((o) => o.status === 'ABERTA').reduce((a, o) => a + o.valorCents, 0),
      // Crédito usado vem do financeiro (etapa 4); por enquanto o disponível é o limite.
      creditoDisponivelCents: p.limiteCreditoCents,
    },
  });
}));

parceirosRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const body = parceiroSchema.parse(req.body);
  const existente = await prisma.erpParceiro.findUnique({ where: { orgId_documento: { orgId, documento: body.documento } } });
  if (existente) {
    // Clientes e Fornecedores são cadastros separados na tela, mas o mesmo CNPJ pode ser os dois: só acrescenta o papel.
    const add = { ...(body.ehCliente && !existente.ehCliente ? { ehCliente: true } : {}), ...(body.ehFornecedor && !existente.ehFornecedor ? { ehFornecedor: true } : {}) };
    if (!Object.keys(add).length) throw badRequest(`Já existe ${existente.ehFornecedor && !existente.ehCliente ? 'um fornecedor' : 'um cliente'} com este CPF/CNPJ`);
    const p = await prisma.erpParceiro.update({ where: { id: existente.id }, data: add });
    await auditar(req, 'parceiro.papel', 'erp_parceiro', p.id, { ehCliente: existente.ehCliente, ehFornecedor: existente.ehFornecedor }, add);
    return res.json({ ...fromRow(p), jaExistia: true });
  }
  const p = await prisma.erpParceiro.create({ data: { orgId, ...toData(body), situacaoConsultaEm: body.situacaoCadastral ? new Date() : null } });
  await auditar(req, 'parceiro.criar', 'erp_parceiro', p.id, null, { nome: p.nome, tipoPessoa: p.tipoPessoa });
  res.status(201).json(fromRow(p));
}));

parceirosRouter.put('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const antes = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId } });
  if (!antes) throw notFound('Cliente');
  const body = parceiroSchema.parse(req.body);
  if (body.documento !== antes.documento && await prisma.erpParceiro.findUnique({ where: { orgId_documento: { orgId, documento: body.documento } } })) throw badRequest('Já existe um cadastro com este CPF/CNPJ');
  const p = await prisma.erpParceiro.update({ where: { id: antes.id }, data: toData(body) });
  const mudou = Object.fromEntries(Object.entries(toData(body)).filter(([k, v]) => k !== 'documento' && (antes as any)[k] !== v).map(([k]) => [k, true]));
  await auditar(req, 'parceiro.editar', 'erp_parceiro', p.id, { status: antes.status, limiteCreditoCents: antes.limiteCreditoCents }, { campos: Object.keys(mudou), status: p.status, limiteCreditoCents: p.limiteCreditoCents });
  res.json(fromRow(p));
}));

/** Não exclui quem tem histórico: inativa. Sem histórico, exclui de verdade. */
parceirosRouter.delete('/:id', requireRole('OWNER', 'ADMIN'), ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId }, include: { _count: { select: { oportunidades: true } } } });
  if (!p) throw notFound('Cliente');
  if (p._count.oportunidades > 0) {
    await prisma.erpParceiro.update({ where: { id: p.id }, data: { status: 'INATIVO' } });
    await auditar(req, 'parceiro.inativar', 'erp_parceiro', p.id, { status: p.status }, { status: 'INATIVO' });
    return res.json({ ok: true, inativado: true });
  }
  await prisma.erpParceiro.delete({ where: { id: p.id } });
  await auditar(req, 'parceiro.excluir', 'erp_parceiro', p.id, { nome: p.nome }, null);
  res.json({ ok: true, excluido: true });
}));

// ---- Contatos do cliente ----
const contatoSchema = z.object({ nome: z.string().trim().min(1).max(120), cargo: opt(80), email: opt(200), telefone: opt(30), principal: z.boolean().default(false) });

parceirosRouter.post('/:id/contatos', ah(async (req, res) => {
  const p = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!p) throw notFound('Cliente');
  const c = await prisma.erpParceiroContato.create({ data: { parceiroId: p.id, ...contatoSchema.parse(req.body) } });
  res.status(201).json(c);
}));

parceirosRouter.delete('/:id/contatos/:contatoId', ah(async (req, res) => {
  const p = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!p) throw notFound('Cliente');
  await prisma.erpParceiroContato.deleteMany({ where: { id: req.params.contatoId, parceiroId: p.id } });
  res.json({ ok: true });
}));
