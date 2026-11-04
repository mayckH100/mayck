/**
 * Financeiro: contas (banco/caixa), plano de contas (DRE), contas a receber e a pagar (parcelas, baixa parcial com
 * juros/multa/desconto, estorno), transferências, Pix copia-e-cola, extrato OFX com conciliação, aging, fluxo de caixa e DRE.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound, forbidden } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import { configDa } from '../produtos/produtos.routes.js';
import { parcelar, encargos, pixCopiaECola, lerOfx, sugerirConciliacao, aging, fluxoProjetado, dre } from './calculo.js';
import { garantirPlano, recalcularTitulo } from './servico.js';

export const financeiroRouter = Router();
const gestor = (req: { auth?: { role?: string | null } }) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
const cents = z.number().int().min(0).max(2_000_000_000);
const DIA = 86_400_000;
/** Natureza da conta a pagar: fornecedor (padrão) ou conta da empresa (água, luz, internet...). */
export const NATUREZAS = ['FORNECEDOR', 'AGUA', 'LUZ', 'INTERNET', 'TELEFONE', 'ALUGUEL', 'IMPOSTO', 'OUTRA_CONTA'] as const;
const naturezaSchema = z.enum(NATUREZAS).nullish();
/** Categoria padrão do plano de contas para cada conta da empresa (quando o usuário não escolhe). */
const CATEGORIA_DA_NATUREZA: Record<string, string> = { AGUA: '4.03', LUZ: '4.03', INTERNET: '4.03', TELEFONE: '4.03', ALUGUEL: '4.02', IMPOSTO: '6.01', FORNECEDOR: '3.01' };

async function saldosContas(orgId: string) {
  const [contas, g] = await Promise.all([
    prisma.erpContaFinanceira.findMany({ where: { orgId }, orderBy: { nome: 'asc' } }),
    prisma.erpLancamento.groupBy({ by: ['contaId'], where: { orgId }, _sum: { valorCents: true } }),
  ]);
  const M = new Map(g.map((x) => [x.contaId, x._sum.valorCents ?? 0]));
  return contas.map((c) => ({ ...c, saldoCents: c.saldoInicialCents + (M.get(c.id) ?? 0) }));
}

// ---------------- Contas ----------------
const contaSchema = z.object({ nome: z.string().trim().min(2).max(80), tipo: z.enum(['BANCO', 'CAIXA', 'CARTAO']).default('BANCO'), banco: z.string().trim().max(60).nullish(), agencia: z.string().trim().max(10).nullish(), conta: z.string().trim().max(20).nullish(), chavePix: z.string().trim().max(77).nullish(), saldoInicialCents: z.number().int().min(-2_000_000_000).max(2_000_000_000).default(0), ativa: z.boolean().default(true) });
financeiroRouter.get('/contas', ah(async (req, res) => res.json(await saldosContas(orgOf(req)))));
financeiroRouter.post('/contas', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const c = await prisma.erpContaFinanceira.create({ data: { orgId: orgOf(req), ...contaSchema.parse(req.body) } });
  await auditar(req, 'conta_financeira.criar', 'erp_conta_financeira', c.id, null, { nome: c.nome });
  res.status(201).json(c);
}));
financeiroRouter.put('/contas/:id', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req);
  const antes = await prisma.erpContaFinanceira.findFirst({ where: { id: req.params.id, orgId } });
  if (!antes) throw notFound('Conta');
  const c = await prisma.erpContaFinanceira.update({ where: { id: antes.id }, data: contaSchema.parse(req.body) });
  await auditar(req, 'conta_financeira.editar', 'erp_conta_financeira', c.id, { saldoInicialCents: antes.saldoInicialCents }, { saldoInicialCents: c.saldoInicialCents });
  res.json(c);
}));

// ---------------- Plano de contas ----------------
financeiroRouter.get('/categorias', ah(async (req, res) => {
  const orgId = orgOf(req);
  await prisma.$transaction((tx) => garantirPlano(tx, orgId));
  res.json(await prisma.erpCategoriaFinanceira.findMany({ where: { orgId }, orderBy: { codigo: 'asc' } }));
}));
const catSchema = z.object({ codigo: z.string().trim().regex(/^\d+(\.\d+)*$/, 'Código no formato 4.06'), nome: z.string().trim().min(2).max(80), tipo: z.enum(['RECEITA', 'DESPESA']), grupo: z.enum(['RECEITA_BRUTA', 'DEDUCAO', 'CUSTO', 'OPERACIONAL', 'FINANCEIRA', 'IMPOSTO']), ativa: z.boolean().default(true) });
financeiroRouter.post('/categorias', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req); const b = catSchema.parse(req.body);
  if (await prisma.erpCategoriaFinanceira.findUnique({ where: { orgId_codigo: { orgId, codigo: b.codigo } } })) throw badRequest('Código já existe');
  res.status(201).json(await prisma.erpCategoriaFinanceira.create({ data: { orgId, ...b } }));
}));
financeiroRouter.put('/categorias/:id', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req);
  const c = await prisma.erpCategoriaFinanceira.findFirst({ where: { id: req.params.id, orgId } });
  if (!c) throw notFound('Categoria');
  res.json(await prisma.erpCategoriaFinanceira.update({ where: { id: c.id }, data: catSchema.parse(req.body) }));
}));

// ---------------- Títulos ----------------
financeiroRouter.get('/titulos', ah(async (req, res) => {
  const orgId = orgOf(req);
  const q = req.query as Record<string, string | undefined>;
  const hoje = new Date(new Date().toISOString().slice(0, 10));
  const l = await prisma.erpTitulo.findMany({
    where: { orgId, ...(q.tipo ? { tipo: q.tipo } : {}), ...(q.parceiroId ? { parceiroId: q.parceiroId } : {}),
      ...(q.status === 'ABERTOS' ? { status: { in: ['EM_ABERTO', 'PARCIAL'] } } : q.status ? { status: q.status } : {}),
      ...(q.natureza === 'FORNECEDOR' ? { OR: [{ natureza: null }, { natureza: 'FORNECEDOR' }] } : q.natureza === 'CONTAS' ? { natureza: { notIn: ['FORNECEDOR'] }, NOT: { natureza: null } } : {}),
      ...(q.vencidos === '1' ? { vencimento: { lt: hoje }, status: { in: ['EM_ABERTO', 'PARCIAL'] } } : {}),
      ...(q.de || q.ate ? { vencimento: { ...(q.de ? { gte: new Date(q.de) } : {}), ...(q.ate ? { lte: new Date(`${q.ate}T23:59:59Z`) } : {}) } } : {}) },
    orderBy: [{ vencimento: 'asc' }], take: 500,
  });
  const ps = await prisma.erpParceiro.findMany({ where: { orgId, id: { in: l.map((t) => t.parceiroId).filter(Boolean) as string[] } }, select: { id: true, nome: true, fantasia: true } });
  const P = new Map(ps.map((p) => [p.id, p.fantasia || p.nome]));
  res.json(l.map((t) => ({ ...t, parceiro: t.parceiroId ? P.get(t.parceiroId) ?? null : null, saldoCents: t.status === 'CANCELADO' ? 0 : t.valorCents - t.pagoCents, vencido: ['EM_ABERTO', 'PARCIAL'].includes(t.status) && t.vencimento < hoje })));
}));

financeiroRouter.get('/titulos/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const t = await prisma.erpTitulo.findFirst({ where: { id: req.params.id, orgId }, include: { baixas: { orderBy: { data: 'desc' } } } });
  if (!t) throw notFound('Título');
  const cfg = await configDa(orgId);
  const saldo = t.valorCents - t.pagoCents;
  res.json({ ...t, saldoCents: saldo, encargosHoje: t.tipo === 'RECEBER' && t.status !== 'CANCELADO' ? encargos(saldo, t.vencimento, new Date(), cfg.multaAtrasoBp, cfg.jurosMesBp) : null });
}));

financeiroRouter.post('/titulos', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ tipo: z.enum(['RECEBER', 'PAGAR']), parceiroId: z.string().nullish(), descricao: z.string().trim().min(2).max(200), valorCents: cents.min(1), primeiroVencimento: z.coerce.date(), prazos: z.array(z.number().int().min(0).max(3650)).max(120).default([0]), competencia: z.coerce.date().nullish(), categoriaId: z.string().nullish(), centroCustoId: z.string().nullish(), observacoes: z.string().trim().max(1000).nullish(), natureza: naturezaSchema }).parse(req.body);
  const natureza = b.tipo === 'PAGAR' ? (b.natureza ?? 'FORNECEDOR') : null;
  if (natureza && !b.categoriaId && CATEGORIA_DA_NATUREZA[natureza]) { await garantirPlano(prisma, orgId); b.categoriaId = (await prisma.erpCategoriaFinanceira.findUnique({ where: { orgId_codigo: { orgId, codigo: CATEGORIA_DA_NATUREZA[natureza] } } }))?.id ?? null; }
  if (b.parceiroId && !(await prisma.erpParceiro.findFirst({ where: { id: b.parceiroId, orgId } }))) throw badRequest('Parceiro inválido');
  if (b.categoriaId && !(await prisma.erpCategoriaFinanceira.findFirst({ where: { id: b.categoriaId, orgId } }))) throw badRequest('Categoria inválida');
  const ps = parcelar(b.valorCents, b.prazos, b.primeiroVencimento);
  const docId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const criados = await prisma.$transaction(ps.map((x) => prisma.erpTitulo.create({ data: { orgId, tipo: b.tipo, parceiroId: b.parceiroId ?? null, descricao: ps.length > 1 ? `${b.descricao} (${x.parcela}/${x.parcelas})` : b.descricao, docTipo: 'manual', docId, parcela: x.parcela, parcelas: x.parcelas, valorCents: x.valorCents, vencimento: x.vencimento, competencia: b.competencia ?? b.primeiroVencimento, categoriaId: b.categoriaId ?? null, centroCustoId: b.centroCustoId ?? null, observacoes: b.observacoes ?? null, natureza } })));
  await auditar(req, 'titulo.criar', 'erp_titulo', criados[0].id, null, { tipo: b.tipo, valorCents: b.valorCents, parcelas: ps.length });
  res.status(201).json(criados);
}));

financeiroRouter.put('/titulos/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ descricao: z.string().trim().min(2).max(200).optional(), vencimento: z.coerce.date().optional(), categoriaId: z.string().nullish(), centroCustoId: z.string().nullish(), observacoes: z.string().trim().max(1000).nullish() }).extend({ natureza: naturezaSchema }).parse(req.body);
  const t = await prisma.erpTitulo.findFirst({ where: { id: req.params.id, orgId } });
  if (!t) throw notFound('Título');
  if (!['EM_ABERTO', 'PARCIAL'].includes(t.status)) throw badRequest('Só título em aberto pode ser alterado');
  const n = await prisma.erpTitulo.update({ where: { id: t.id }, data: { ...(b.descricao ? { descricao: b.descricao } : {}), ...(b.vencimento ? { vencimento: b.vencimento } : {}), ...(b.categoriaId !== undefined ? { categoriaId: b.categoriaId } : {}), ...(b.centroCustoId !== undefined ? { centroCustoId: b.centroCustoId } : {}), ...(b.observacoes !== undefined ? { observacoes: b.observacoes } : {}), ...(b.natureza !== undefined && t.tipo === 'PAGAR' ? { natureza: b.natureza ?? 'FORNECEDOR' } : {}) } });
  await auditar(req, 'titulo.editar', 'erp_titulo', t.id, { vencimento: t.vencimento }, { vencimento: n.vencimento });
  res.json(n);
}));

financeiroRouter.post('/titulos/:id/cancelar', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden('Só proprietário ou administrador cancela título');
  const orgId = orgOf(req);
  const { motivo } = z.object({ motivo: z.string().trim().min(3).max(300) }).parse(req.body);
  const t = await prisma.erpTitulo.findFirst({ where: { id: req.params.id, orgId } });
  if (!t) throw notFound('Título');
  if (t.pagoCents > 0) throw badRequest('Título com baixa: estorne as baixas antes');
  if (t.status === 'CANCELADO') throw badRequest('Título já cancelado');
  const n = await prisma.erpTitulo.update({ where: { id: t.id }, data: { status: 'CANCELADO', observacoes: `${t.observacoes ? `${t.observacoes}\n` : ''}Cancelado: ${motivo}` } });
  await auditar(req, 'titulo.cancelar', 'erp_titulo', t.id, { status: t.status }, { status: 'CANCELADO', motivo });
  res.json(n);
}));

/** Baixa (total ou parcial). Juros/multa e desconto não abatem o principal; o lançamento na conta é o valor efetivo. */
financeiroRouter.post('/titulos/:id/baixar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ contaId: z.string(), valorCents: cents.min(1), data: z.coerce.date().default(() => new Date()), jurosCents: cents.default(0), descontoCents: cents.default(0), forma: z.enum(['PIX', 'BOLETO', 'TED', 'DINHEIRO', 'CARTAO', 'CHEQUE']).default('PIX') }).parse(req.body);
  const t = await prisma.erpTitulo.findFirst({ where: { id: req.params.id, orgId } });
  if (!t) throw notFound('Título');
  if (!['EM_ABERTO', 'PARCIAL'].includes(t.status)) throw badRequest('Título não está em aberto');
  if (b.valorCents > t.valorCents - t.pagoCents) throw badRequest('Valor maior que o saldo do título');
  if (b.descontoCents > b.valorCents) throw badRequest('Desconto maior que o valor');
  const conta = await prisma.erpContaFinanceira.findFirst({ where: { id: b.contaId, orgId, ativa: true } });
  if (!conta) throw badRequest('Conta inválida');
  const efetivo = b.valorCents + b.jurosCents - b.descontoCents;
  const novo = await prisma.$transaction(async (tx) => {
    const baixa = await tx.erpBaixa.create({ data: { tituloId: t.id, contaId: conta.id, data: b.data, valorCents: b.valorCents, jurosCents: b.jurosCents, descontoCents: b.descontoCents, forma: b.forma, userId: req.auth?.userId ?? null } });
    await tx.erpLancamento.create({ data: { orgId, contaId: conta.id, data: b.data, valorCents: t.tipo === 'RECEBER' ? efetivo : -efetivo, descricao: t.descricao, origemTipo: 'baixa', origemId: baixa.id, categoriaId: t.categoriaId } });
    return recalcularTitulo(tx, t.id);
  });
  await auditar(req, 'titulo.baixar', 'erp_titulo', t.id, { pagoCents: t.pagoCents }, { pagoCents: novo.pagoCents, efetivo });
  res.json(novo);
}));

financeiroRouter.post('/baixas/:id/estornar', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden('Só proprietário ou administrador estorna baixa');
  const orgId = orgOf(req);
  const bx = await prisma.erpBaixa.findFirst({ where: { id: req.params.id, titulo: { orgId } }, include: { titulo: true } });
  if (!bx) throw notFound('Baixa');
  if (bx.estornada) throw badRequest('Baixa já estornada');
  const lanc = await prisma.erpLancamento.findFirst({ where: { orgId, origemTipo: 'baixa', origemId: bx.id } });
  const novo = await prisma.$transaction(async (tx) => {
    await tx.erpBaixa.update({ where: { id: bx.id }, data: { estornada: true } });
    if (lanc) await tx.erpLancamento.create({ data: { orgId, contaId: lanc.contaId, data: new Date(), valorCents: -lanc.valorCents, descricao: `Estorno: ${lanc.descricao}`, origemTipo: 'estorno', origemId: bx.id, categoriaId: lanc.categoriaId } });
    return recalcularTitulo(tx, bx.tituloId);
  });
  await auditar(req, 'baixa.estornar', 'erp_titulo', bx.tituloId, null, { baixaId: bx.id });
  res.json(novo);
}));

financeiroRouter.get('/titulos/:id/pix', ah(async (req, res) => {
  const orgId = orgOf(req);
  const t = await prisma.erpTitulo.findFirst({ where: { id: req.params.id, orgId } });
  if (!t || t.tipo !== 'RECEBER') throw notFound('Título a receber');
  const conta = typeof req.query.contaId === 'string' ? await prisma.erpContaFinanceira.findFirst({ where: { id: req.query.contaId, orgId } }) : await prisma.erpContaFinanceira.findFirst({ where: { orgId, ativa: true, chavePix: { not: null } } });
  if (!conta?.chavePix) throw badRequest('Cadastre a chave Pix em uma conta financeira');
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  const filial = await prisma.erpFilial.findFirst({ where: { orgId }, select: { nome: true } });
  const codigo = pixCopiaECola({ chave: conta.chavePix, nome: org?.name ?? 'EMPRESA', cidade: filial?.nome ?? 'SAO PAULO', valorCents: t.valorCents - t.pagoCents, txid: `T${t.id.slice(-20)}` });
  res.json({ codigo, valorCents: t.valorCents - t.pagoCents, conta: conta.nome });
}));

// ---------------- Movimentos de conta ----------------
financeiroRouter.get('/contas/:id/extrato', ah(async (req, res) => {
  const orgId = orgOf(req);
  const conta = await prisma.erpContaFinanceira.findFirst({ where: { id: req.params.id, orgId } });
  if (!conta) throw notFound('Conta');
  res.json(await prisma.erpLancamento.findMany({ where: { orgId, contaId: conta.id }, orderBy: { data: 'desc' }, take: 300 }));
}));

financeiroRouter.post('/transferencias', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ deContaId: z.string(), paraContaId: z.string(), valorCents: cents.min(1), data: z.coerce.date().default(() => new Date()) }).parse(req.body);
  if (b.deContaId === b.paraContaId) throw badRequest('Escolha contas diferentes');
  const n = await prisma.erpContaFinanceira.count({ where: { orgId, id: { in: [b.deContaId, b.paraContaId] } } });
  if (n !== 2) throw badRequest('Conta inválida');
  const id = `tr-${Date.now()}`;
  await prisma.$transaction([
    prisma.erpLancamento.create({ data: { orgId, contaId: b.deContaId, data: b.data, valorCents: -b.valorCents, descricao: 'Transferência enviada', origemTipo: 'transferencia', origemId: id } }),
    prisma.erpLancamento.create({ data: { orgId, contaId: b.paraContaId, data: b.data, valorCents: b.valorCents, descricao: 'Transferência recebida', origemTipo: 'transferencia', origemId: id } }),
  ]);
  await auditar(req, 'conta_financeira.transferir', 'erp_conta_financeira', b.deContaId, null, { para: b.paraContaId, valorCents: b.valorCents });
  res.status(201).json({ ok: true });
}));

financeiroRouter.post('/lancamentos', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ contaId: z.string(), valorCents: z.number().int().min(-2_000_000_000).max(2_000_000_000).refine((v) => v !== 0, 'Valor não pode ser zero'), data: z.coerce.date().default(() => new Date()), descricao: z.string().trim().min(2).max(200), categoriaId: z.string().nullish() }).parse(req.body);
  if (!(await prisma.erpContaFinanceira.findFirst({ where: { id: b.contaId, orgId } }))) throw badRequest('Conta inválida');
  const l = await prisma.erpLancamento.create({ data: { orgId, contaId: b.contaId, data: b.data, valorCents: b.valorCents, descricao: b.descricao, origemTipo: 'avulso', categoriaId: b.categoriaId ?? null } });
  await auditar(req, 'lancamento.criar', 'erp_lancamento', l.id, null, { valorCents: l.valorCents });
  res.status(201).json(l);
}));

// ---------------- Conciliação bancária (OFX) ----------------
financeiroRouter.post('/contas/:id/ofx', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { ofx } = z.object({ ofx: z.string().min(20).max(5_000_000) }).parse(req.body);
  const conta = await prisma.erpContaFinanceira.findFirst({ where: { id: req.params.id, orgId } });
  if (!conta) throw notFound('Conta');
  const linhas = lerOfx(ofx);
  if (!linhas.length) throw badRequest('Nenhum lançamento encontrado no arquivo OFX');
  let novas = 0;
  for (const l of linhas) {
    const r = await prisma.erpExtratoLinha.upsert({ where: { contaId_fitId: { contaId: conta.id, fitId: l.fitId } }, create: { orgId, contaId: conta.id, ...l }, update: {} });
    if (r.createdAt.getTime() > Date.now() - 60_000) novas++;
  }
  res.json({ lidas: linhas.length, novas });
}));

financeiroRouter.get('/contas/:id/conciliacao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const conta = await prisma.erpContaFinanceira.findFirst({ where: { id: req.params.id, orgId } });
  if (!conta) throw notFound('Conta');
  const [extrato, lancs] = await Promise.all([
    prisma.erpExtratoLinha.findMany({ where: { orgId, contaId: conta.id, lancamentoId: null }, orderBy: { data: 'asc' }, take: 500 }),
    prisma.erpLancamento.findMany({ where: { orgId, contaId: conta.id, conciliado: false }, orderBy: { data: 'asc' }, take: 1000 }),
  ]);
  res.json({ extrato, lancamentos: lancs, sugestoes: sugerirConciliacao(extrato, lancs) });
}));

financeiroRouter.post('/conciliar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ pares: z.array(z.object({ extratoId: z.string(), lancamentoId: z.string().nullish(), criar: z.object({ descricao: z.string().trim().min(2).max(200), categoriaId: z.string().nullish() }).optional() })).min(1).max(500) }).parse(req.body);
  let feitos = 0;
  await prisma.$transaction(async (tx) => {
    for (const p of b.pares) {
      const e = await tx.erpExtratoLinha.findFirst({ where: { id: p.extratoId, orgId, lancamentoId: null } });
      if (!e) continue;
      let lancId = p.lancamentoId ?? null;
      if (!lancId && p.criar) lancId = (await tx.erpLancamento.create({ data: { orgId, contaId: e.contaId, data: e.data, valorCents: e.valorCents, descricao: p.criar.descricao, origemTipo: 'avulso', categoriaId: p.criar.categoriaId ?? null } })).id;
      if (!lancId) continue;
      const l = await tx.erpLancamento.findFirst({ where: { id: lancId, orgId, contaId: e.contaId, conciliado: false } });
      if (!l) throw badRequest('Lançamento inválido ou já conciliado');
      if (l.valorCents !== e.valorCents) throw badRequest('Valores diferentes entre extrato e lançamento');
      await tx.erpLancamento.update({ where: { id: l.id }, data: { conciliado: true, extratoId: e.id } });
      await tx.erpExtratoLinha.update({ where: { id: e.id }, data: { lancamentoId: l.id } });
      feitos++;
    }
  });
  await auditar(req, 'conciliacao.conciliar', 'erp_conta_financeira', orgId, null, { pares: feitos });
  res.json({ conciliados: feitos });
}));

// ---------------- Painel, fluxo e DRE ----------------
financeiroRouter.get('/painel', ah(async (req, res) => {
  const orgId = orgOf(req);
  const dias = Math.min(180, Math.max(7, Number(req.query.dias) || 30));
  const [contas, abertos] = await Promise.all([saldosContas(orgId), prisma.erpTitulo.findMany({ where: { orgId, status: { in: ['EM_ABERTO', 'PARCIAL'] } } })]);
  const saldo = contas.filter((c) => c.ativa).reduce((a, c) => a + c.saldoCents, 0);
  res.json({
    contas, saldoCents: saldo,
    receber: aging(abertos.filter((t) => t.tipo === 'RECEBER')), pagar: aging(abertos.filter((t) => t.tipo === 'PAGAR')),
    fluxo: fluxoProjetado(saldo, abertos, dias),
  });
}));

financeiroRouter.get('/dre', ah(async (req, res) => {
  const orgId = orgOf(req);
  const hoje = new Date();
  const de = typeof req.query.de === 'string' ? new Date(req.query.de) : new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
  const ate = typeof req.query.ate === 'string' ? new Date(`${req.query.ate}T23:59:59Z`) : new Date(de.getTime() + 31 * DIA);
  const regime = req.query.regime === 'caixa' ? 'caixa' : 'competencia';
  const cats = new Map((await prisma.erpCategoriaFinanceira.findMany({ where: { orgId } })).map((c) => [c.id, c.grupo]));
  let linhas: { tipo: string; valorCents: number; grupo: string | null }[];
  if (regime === 'competencia') {
    const ts = await prisma.erpTitulo.findMany({ where: { orgId, status: { not: 'CANCELADO' }, competencia: { gte: de, lte: ate } } });
    linhas = ts.map((t) => ({ tipo: t.tipo, valorCents: t.valorCents, grupo: t.categoriaId ? cats.get(t.categoriaId) ?? null : null }));
  } else {
    const ls = await prisma.erpLancamento.findMany({ where: { orgId, data: { gte: de, lte: ate }, origemTipo: { in: ['baixa', 'avulso', 'estorno'] } } });
    linhas = ls.map((l) => ({ tipo: l.valorCents >= 0 ? 'RECEBER' : 'PAGAR', valorCents: Math.abs(l.valorCents), grupo: l.categoriaId ? cats.get(l.categoriaId) ?? null : null }));
  }
  res.json({ de, ate, regime, ...dre(linhas) });
}));
