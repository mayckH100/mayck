/** Cadastro 360º de clientes/fornecedores. Leitura: membros do módulo. Escrita: OWNER/ADMIN/AGENT (exclusão só OWNER/ADMIN). */
import { Router } from 'express';
import { scoresDosClientes } from './scoreDados.js';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { contem } from '../../lib/busca.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { isValidCnpj, isValidCpf, onlyDigits, normalizeCelular } from '../../lib/documento.js';
import { auditar, diferencas } from '../shared/auditoria.js';
import { forbidden } from '../../lib/http.js';
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
  // v1.33.0 — opcionais sem padrão: quem não manda (planilha/tela antiga) não apaga o que está salvo.
  inscricaoMunicipal: opt(20).optional(), condicaoPagamentoId: opt(40).optional(), tabelaPrecoId: opt(40).optional(),
  prazoEntregaDias: z.number().int().min(0, 'Prazo não pode ser negativo').max(365, 'Prazo de até 365 dias').optional(),
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
    ...(q ? { OR: [{ nome: contem(q) }, { fantasia: contem(q) }, ...(digits.length >= 3 ? [{ documento: { contains: digits } }] : []), { email: contem(q.toLowerCase()) }] } : {}),
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
  // v1.56.0: score calculado na hora pelas contas a receber e compras do cliente (a coluna antiga fica em 500 e não é usada).
  const scoreCliente = (await scoresDosClientes(orgId, [p.id])).get(p.id)!;
  res.json({
    ...fromRow(p), interacoes,
    score: scoreCliente.score, scoreFaixa: scoreCliente.faixa, scoreMotivos: scoreCliente.motivos,
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
  await validarRefs(orgId, body);
  const p = await prisma.erpParceiro.create({ data: { orgId, ...toData(body), situacaoConsultaEm: body.situacaoCadastral ? new Date() : null } });
  await auditar(req, 'parceiro.criar', 'erp_parceiro', p.id, null, { nome: p.nome, tipoPessoa: p.tipoPessoa });
  res.status(201).json(fromRow(p));
}));

/**
 * v1.33.0: o que trava a edição de um cadastro já usado. O CPF/CNPJ não muda depois de aparecer numa nota fiscal
 * (emitida ou recebida): a nota é um documento fiscal fechado e o cadastro precisa continuar batendo com ela.
 */
export async function travasParceiro(orgId: string, id: string) {
  const [nfSaida, nfEntrada, titulos, pedidos, compras] = await Promise.all([
    prisma.erpNfeSaida.findFirst({ where: { orgId, parceiroId: id, status: { in: ['AUTORIZADA', 'CANCELADA'] } }, select: { numero: true } }),
    prisma.erpNfeEntrada.findFirst({ where: { orgId, parceiroId: id }, select: { numero: true } }),
    prisma.erpTitulo.count({ where: { orgId, parceiroId: id } }),
    prisma.erpPedidoVenda.count({ where: { orgId, parceiroId: id } }),
    prisma.erpPedidoCompra.count({ where: { orgId, parceiroId: id } }),
  ]);
  const documento = nfSaida ? `O CPF/CNPJ não pode mudar: já saiu na NF-e nº ${nfSaida.numero} emitida para este cadastro. Se o número estiver errado, cadastre de novo com o certo e inative este.`
    : nfEntrada ? `O CPF/CNPJ não pode mudar: já está na NF-e nº ${nfEntrada.numero} recebida deste fornecedor. Se o número estiver errado, cadastre de novo com o certo e inative este.`
    : null;
  return { documento, usos: { pedidos, compras, titulos } };
}

parceirosRouter.get('/:id/travas', ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId }, select: { id: true } });
  if (!p) throw notFound('Cadastro');
  const gestor = req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
  res.json({ ...(await travasParceiro(orgId, p.id)), comercial: gestor ? null : 'Limite de crédito e status (bloqueado/inativo) só o Proprietário ou o Administrador mudam.' });
}));

async function validarRefs(orgId: string, b: { condicaoPagamentoId?: string | null; tabelaPrecoId?: string | null }) {
  if (b.condicaoPagamentoId && !(await prisma.erpCondicaoPagamento.findFirst({ where: { id: b.condicaoPagamentoId, orgId } }))) throw badRequest('Condição de pagamento inválida');
  if (b.tabelaPrecoId && !(await prisma.erpTabelaPreco.findFirst({ where: { id: b.tabelaPrecoId, orgId } }))) throw badRequest('Tabela de preço inválida');
}

parceirosRouter.put('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const antes = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId } });
  if (!antes) throw notFound('Cliente');
  const body = parceiroSchema.parse(req.body);
  const gestor = req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
  if (body.documento !== antes.documento) {
    const t = await travasParceiro(orgId, antes.id);
    if (t.documento) throw badRequest(t.documento);
    if (await prisma.erpParceiro.findUnique({ where: { orgId_documento: { orgId, documento: body.documento } } })) throw badRequest('Já existe um cadastro com este CPF/CNPJ');
  }
  if (!gestor && (body.limiteCreditoCents !== antes.limiteCreditoCents || body.status !== antes.status)) throw forbidden('Limite de crédito e status (bloqueado/inativo) só o Proprietário ou o Administrador mudam. Os outros dados foram mantidos como estavam: tente salvar sem mudar esses dois.');
  await validarRefs(orgId, body);
  const data = toData(body);
  const p = await prisma.erpParceiro.update({ where: { id: antes.id }, data });
  const d = diferencas(antes as unknown as Record<string, unknown>, p as unknown as Record<string, unknown>);
  if (d.campos.length) await auditar(req, 'parceiro.editar', 'erp_parceiro', p.id, d.antes, { ...d.depois, campos: d.campos });
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
const contatoSchema = z.object({ nome: z.string().trim().min(1, 'Informe o nome do contato').max(120), cargo: opt(80), email: z.string().trim().email('E-mail do contato inválido').max(200).nullish().or(z.literal('')).transform((v) => (v ? v.toLowerCase() : null)), telefone: opt(30), principal: z.boolean().default(false) });

parceirosRouter.post('/:id/contatos', ah(async (req, res) => {
  const p = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!p) throw notFound('Cliente');
  const b = contatoSchema.parse(req.body);
  if (b.principal) await prisma.erpParceiroContato.updateMany({ where: { parceiroId: p.id }, data: { principal: false } });
  const c = await prisma.erpParceiroContato.create({ data: { parceiroId: p.id, ...b } });
  await auditar(req, 'parceiro.contato_criar', 'erp_parceiro', p.id, null, { contatoId: c.id, ...b });
  res.status(201).json(c);
}));

/** v1.33.0: editar contato (nome, cargo, e-mail, telefone, principal). */
parceirosRouter.put('/:id/contatos/:contatoId', ah(async (req, res) => {
  const p = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!p) throw notFound('Cliente');
  const antes = await prisma.erpParceiroContato.findFirst({ where: { id: req.params.contatoId, parceiroId: p.id } });
  if (!antes) throw notFound('Contato');
  const b = contatoSchema.parse(req.body);
  if (b.principal) await prisma.erpParceiroContato.updateMany({ where: { parceiroId: p.id, id: { not: antes.id } }, data: { principal: false } });
  const c = await prisma.erpParceiroContato.update({ where: { id: antes.id }, data: b });
  const d = diferencas(antes as unknown as Record<string, unknown>, c as unknown as Record<string, unknown>, ['id', 'parceiroId', 'createdAt']);
  if (d.campos.length) await auditar(req, 'parceiro.contato_editar', 'erp_parceiro', p.id, { contatoId: c.id, ...d.antes }, { contatoId: c.id, ...d.depois });
  res.json(c);
}));

parceirosRouter.delete('/:id/contatos/:contatoId', ah(async (req, res) => {
  const p = await prisma.erpParceiro.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!p) throw notFound('Cliente');
  const c = await prisma.erpParceiroContato.findFirst({ where: { id: req.params.contatoId, parceiroId: p.id } });
  await prisma.erpParceiroContato.deleteMany({ where: { id: req.params.contatoId, parceiroId: p.id } });
  if (c) await auditar(req, 'parceiro.contato_excluir', 'erp_parceiro', p.id, { contatoId: c.id, nome: c.nome, email: c.email, telefone: c.telefone }, null);
  res.json({ ok: true });
}));
