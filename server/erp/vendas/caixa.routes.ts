/**
 * Caixa do PDV (venda balcão): abrir com o dinheiro inicial, sangria/suprimento, fechar com o dinheiro contado.
 * Venda balcão só sai com caixa aberto (409 "Abra o caixa antes de vender"); orçamentos não dependem do caixa.
 * Uma sessão aberta por conta do tipo CAIXA (`contaAberta` única). Venda e recebimento guardam `caixaSessaoId`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { ah, badRequest, HttpError, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import { janelaDoDia } from '../relatorios/relatorio.js';
import { diferencaCaixa, resumoCaixa, validarFechamento, type ResumoCaixa } from './caixa.calculo.js';

type Db = Prisma.TransactionClient | typeof prisma;
type Sessao = Prisma.ErpCaixaSessaoGetPayload<object>;

export const caixaRouter = Router();
export const MSG_ABRA_CAIXA = 'Abra o caixa antes de vender';
const conflito = (msg: string) => new HttpError(409, msg);
const centsSchema = z.number().int().min(0).max(2_000_000_000);

/** Contas do tipo CAIXA ativas; cria "Caixa" quando a empresa ainda não tem nenhuma (só ao abrir). */
async function contasCaixa(orgId: string, criar = false) {
  const contas = await prisma.erpContaFinanceira.findMany({ where: { orgId, ativa: true, tipo: 'CAIXA' }, orderBy: { nome: 'asc' } });
  if (!contas.length && criar) return [await prisma.erpContaFinanceira.create({ data: { orgId, nome: 'Caixa', tipo: 'CAIXA' } })];
  return contas;
}

/** Resumo ao vivo (sessão aberta) a partir dos recebimentos e movimentos ligados à sessão. */
export async function resumoDaSessao(db: Db, s: Sessao): Promise<ResumoCaixa> {
  const [baixas, movs] = await Promise.all([
    db.erpBaixa.findMany({ where: { caixaSessaoId: s.id, estornada: false }, select: { forma: true, valorCents: true } }),
    db.erpCaixaMovimento.findMany({ where: { sessaoId: s.id }, select: { tipo: true, valorCents: true } }),
  ]);
  return resumoCaixa({ aberturaCents: s.valorAberturaCents, recebimentos: baixas, movimentos: movs });
}

/** Resumo congelado no fechamento (o que foi conferido), sem recalcular. */
function resumoFechado(s: Sessao): ResumoCaixa {
  const porForma = s.totaisPorForma ? JSON.parse(s.totaisPorForma) : {};
  const dinheiro = porForma.DINHEIRO?.valorCents ?? 0;
  return {
    aberturaCents: s.valorAberturaCents, porForma,
    qtdVendas: Object.values(porForma as Record<string, { qtd: number }>).reduce((a, f) => a + f.qtd, 0),
    totalVendasCents: s.totalVendasCents ?? 0, vendasDinheiroCents: dinheiro,
    sangriasCents: s.totalSangriasCents ?? 0, suprimentosCents: s.totalSuprimentosCents ?? 0,
    esperadoDinheiroCents: s.valorEsperadoCents ?? 0,
  };
}

async function nomes(ids: (string | null | undefined)[]) {
  const unicos = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unicos.length) return new Map<string, string>();
  const us = await prisma.user.findMany({ where: { id: { in: unicos } }, select: { id: true, name: true } });
  return new Map(us.map((u) => [u.id, u.name]));
}

async function dto(sessoes: Sessao[], comResumo = true) {
  const [n, contas] = await Promise.all([
    nomes(sessoes.flatMap((s) => [s.abertoPorUserId, s.fechadoPorUserId])),
    prisma.erpContaFinanceira.findMany({ where: { id: { in: [...new Set(sessoes.map((s) => s.contaFinanceiraId))] } }, select: { id: true, nome: true } }),
  ]);
  const cn = new Map(contas.map((c) => [c.id, c.nome]));
  return Promise.all(sessoes.map(async (s) => ({
    id: s.id, status: s.status, contaFinanceiraId: s.contaFinanceiraId, contaNome: cn.get(s.contaFinanceiraId) ?? 'Caixa',
    abertoEm: s.abertoEm, abertoPor: s.abertoPorUserId ? { id: s.abertoPorUserId, nome: n.get(s.abertoPorUserId) ?? '—' } : null,
    valorAberturaCents: s.valorAberturaCents, observacaoAbertura: s.observacaoAbertura, qtdVendas: s.qtdVendas,
    fechadoEm: s.fechadoEm, fechadoPor: s.fechadoPorUserId ? { id: s.fechadoPorUserId, nome: n.get(s.fechadoPorUserId) ?? '—' } : null,
    valorContadoCents: s.valorContadoCents, valorEsperadoCents: s.valorEsperadoCents, diferencaCents: s.diferencaCents,
    observacaoFechamento: s.observacaoFechamento,
    resumo: comResumo ? (s.status === 'ABERTO' ? await resumoDaSessao(prisma, s) : resumoFechado(s)) : null,
  })));
}

/**
 * Sessão em que a venda balcão entra. Com `caixaSessaoId`, só ela (aberta, da empresa). Sem ele: a única aberta;
 * com várias abertas, a aberta pelo próprio usuário. Sem caixa aberto: 409.
 */
export async function sessaoParaVenda(orgId: string, userId: string | null, caixaSessaoId?: string | null) {
  const abertas = await prisma.erpCaixaSessao.findMany({ where: { orgId, status: 'ABERTO' }, orderBy: { abertoEm: 'asc' } });
  if (caixaSessaoId) {
    const s = abertas.find((x) => x.id === caixaSessaoId);
    if (!s) throw conflito(`Este caixa está fechado. ${MSG_ABRA_CAIXA}`);
    return s;
  }
  if (!abertas.length) throw conflito(MSG_ABRA_CAIXA);
  if (abertas.length === 1) return abertas[0];
  const minhas = abertas.filter((s) => s.abertoPorUserId && s.abertoPorUserId === userId);
  if (minhas.length === 1) return minhas[0];
  throw conflito('Há mais de um caixa aberto: escolha em qual caixa a venda entra');
}

/**
 * Dentro da transação da venda: confirma que a sessão segue aberta e trava a linha (no Postgres o fechamento espera
 * a venda terminar; venda que chega depois do fechamento é recusada).
 */
export async function travarSessaoParaVenda(tx: Prisma.TransactionClient, sessaoId: string) {
  const r = await tx.erpCaixaSessao.updateMany({ where: { id: sessaoId, status: 'ABERTO' }, data: { qtdVendas: { increment: 1 } } });
  if (!r.count) throw conflito(`O caixa foi fechado. ${MSG_ABRA_CAIXA}`);
}

async function sessaoDaOrg(orgId: string, id: string) {
  const s = await prisma.erpCaixaSessao.findFirst({ where: { id, orgId } });
  if (!s) throw notFound('Caixa');
  return s;
}

/** Estado do caixa para a tela do PDV: contas CAIXA, sessões abertas e qual é a do usuário. */
caixaRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const userId = req.auth?.userId ?? null;
  const [contas, abertas] = await Promise.all([
    contasCaixa(orgId),
    prisma.erpCaixaSessao.findMany({ where: { orgId, status: 'ABERTO' }, orderBy: { abertoEm: 'asc' } }),
  ]);
  const lista = await dto(abertas);
  const minha = abertas.length === 1 ? abertas[0].id : abertas.filter((s) => s.abertoPorUserId === userId).length === 1 ? abertas.find((s) => s.abertoPorUserId === userId)!.id : null;
  res.json({ contas: contas.map((c) => ({ id: c.id, nome: c.nome, aberta: abertas.some((s) => s.contaFinanceiraId === c.id) })), abertas: lista, sessaoPadraoId: minha });
}));

caixaRouter.post('/abrir', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ contaId: z.string().nullish(), valorAberturaCents: centsSchema, observacao: z.string().trim().max(500).nullish() }).parse(req.body);
  const contas = await contasCaixa(orgId, true);
  let conta = b.contaId ? contas.find((c) => c.id === b.contaId) : undefined;
  if (b.contaId && !conta) throw badRequest('Caixa não encontrado (escolha uma conta do tipo Caixa)');
  if (!conta) {
    if (contas.length > 1) throw badRequest('Escolha qual caixa abrir');
    conta = contas[0];
  }
  let s: Sessao;
  try {
    s = await prisma.erpCaixaSessao.create({ data: { orgId, contaFinanceiraId: conta.id, contaAberta: conta.id, abertoPorUserId: req.auth?.userId ?? null, valorAberturaCents: b.valorAberturaCents, observacaoAbertura: b.observacao || null } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflito(`O caixa "${conta.nome}" já está aberto`);
    throw e;
  }
  await auditar(req, 'caixa.abrir', 'erp_caixa_sessao', s.id, null, { conta: conta.nome, valorAberturaCents: s.valorAberturaCents });
  res.status(201).json((await dto([s]))[0]);
}));

/** Histórico de sessões, filtro por data de abertura (fuso da empresa), conta e status. */
caixaRouter.get('/sessoes', ah(async (req, res) => {
  const orgId = orgOf(req);
  const q = z.object({ de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), contaId: z.string().optional(), status: z.enum(['ABERTO', 'FECHADO']).optional() }).parse(req.query);
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const tz = org?.timezone || 'America/Sao_Paulo';
  const abertoEm: Prisma.DateTimeFilter = {};
  if (q.de) abertoEm.gte = janelaDoDia(q.de, tz).ini;
  if (q.ate) abertoEm.lt = janelaDoDia(q.ate, tz).fim;
  const sessoes = await prisma.erpCaixaSessao.findMany({
    where: { orgId, ...(q.de || q.ate ? { abertoEm } : {}), ...(q.contaId ? { contaFinanceiraId: q.contaId } : {}), ...(q.status ? { status: q.status } : {}) },
    orderBy: { abertoEm: 'desc' }, take: 200,
  });
  res.json(await dto(sessoes));
}));

/** Detalhe/relatório da sessão: resumo, sangrias/suprimentos e vendas. */
caixaRouter.get('/sessoes/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const s = await sessaoDaOrg(orgId, req.params.id);
  const [d, movs, vendas, baixas, org] = await Promise.all([
    dto([s]),
    prisma.erpCaixaMovimento.findMany({ where: { sessaoId: s.id, orgId }, orderBy: { em: 'asc' } }),
    prisma.erpPedidoVenda.findMany({ where: { caixaSessaoId: s.id, orgId }, orderBy: { numero: 'asc' }, select: { id: true, numero: true, totalCents: true, createdAt: true, statusOperacional: true } }),
    prisma.erpBaixa.findMany({ where: { caixaSessaoId: s.id }, select: { forma: true, titulo: { select: { docId: true } } } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, timezone: true } }),
  ]);
  const formaDe = new Map(baixas.map((b) => [b.titulo.docId, b.forma]));
  const n = await nomes(movs.map((m) => m.userId));
  res.json({
    ...d[0], empresa: org?.name ?? '', timezone: org?.timezone || 'America/Sao_Paulo',
    movimentos: movs.map((m) => ({ id: m.id, tipo: m.tipo, valorCents: m.valorCents, motivo: m.motivo, em: m.em, usuario: m.userId ? n.get(m.userId) ?? '—' : '—' })),
    vendas: vendas.map((v) => ({ ...v, forma: formaDe.get(v.id) ?? null })),
  });
}));

caixaRouter.post('/sessoes/:id/movimentos', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ tipo: z.enum(['SANGRIA', 'SUPRIMENTO']), valorCents: z.number().int().min(1, 'Informe o valor').max(2_000_000_000), motivo: z.string().trim().min(2, 'Informe o motivo').max(300), contaOutraId: z.string().nullish() }).parse(req.body);
  const s = await sessaoDaOrg(orgId, req.params.id);
  if (s.status !== 'ABERTO') throw conflito('Este caixa está fechado');
  const outra = b.contaOutraId ? await prisma.erpContaFinanceira.findFirst({ where: { id: b.contaOutraId, orgId, ativa: true } }) : null;
  if (b.contaOutraId && (!outra || outra.id === s.contaFinanceiraId)) throw badRequest('Conta de destino/origem inválida');
  const userId = req.auth?.userId ?? null;
  const mov = await prisma.$transaction(async (tx) => {
    const t = await tx.erpCaixaSessao.updateMany({ where: { id: s.id, status: 'ABERTO' }, data: { updatedAt: new Date() } });
    if (!t.count) throw conflito('Este caixa está fechado');
    if (b.tipo === 'SANGRIA') {
      const r = await resumoDaSessao(tx, s);
      if (b.valorCents > r.esperadoDinheiroCents) throw badRequest(`Sangria maior que o dinheiro no caixa (${(r.esperadoDinheiroCents / 100).toFixed(2).replace('.', ',')})`);
    }
    const m = await tx.erpCaixaMovimento.create({ data: { orgId, sessaoId: s.id, tipo: b.tipo, valorCents: b.valorCents, motivo: b.motivo, contaOutraId: outra?.id ?? null, userId } });
    const sinal = b.tipo === 'SANGRIA' ? -1 : 1;
    const desc = `${b.tipo === 'SANGRIA' ? 'Sangria' : 'Suprimento'} do caixa: ${b.motivo}`;
    const origemTipo = b.tipo === 'SANGRIA' ? 'caixa_sangria' : 'caixa_suprimento';
    await tx.erpLancamento.create({ data: { orgId, contaId: s.contaFinanceiraId, data: m.em, valorCents: sinal * b.valorCents, descricao: desc, origemTipo, origemId: m.id } });
    if (outra) await tx.erpLancamento.create({ data: { orgId, contaId: outra.id, data: m.em, valorCents: -sinal * b.valorCents, descricao: desc, origemTipo, origemId: m.id } });
    return m;
  });
  await auditar(req, b.tipo === 'SANGRIA' ? 'caixa.sangria' : 'caixa.suprimento', 'erp_caixa_sessao', s.id, null, { valorCents: mov.valorCents, motivo: mov.motivo, contaOutraId: mov.contaOutraId });
  res.status(201).json(mov);
}));

caixaRouter.post('/sessoes/:id/fechar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ valorContadoCents: centsSchema, observacao: z.string().trim().max(1000).nullish() }).parse(req.body);
  const s0 = await sessaoDaOrg(orgId, req.params.id);
  if (s0.status !== 'ABERTO') throw conflito('Este caixa já foi fechado');
  const userId = req.auth?.userId ?? null;
  const s = await prisma.$transaction(async (tx) => {
    // Marca como fechado primeiro (trava a linha): venda que chegar agora é recusada; a que estava em curso já entrou.
    const t = await tx.erpCaixaSessao.updateMany({ where: { id: s0.id, orgId, status: 'ABERTO' }, data: { status: 'FECHADO', contaAberta: null, fechadoEm: new Date(), fechadoPorUserId: userId } });
    if (!t.count) throw conflito('Este caixa já foi fechado');
    const r = await resumoDaSessao(tx, s0);
    const erro = validarFechamento(b.valorContadoCents, r.esperadoDinheiroCents, b.observacao);
    if (erro) throw badRequest(erro, { esperadoDinheiroCents: r.esperadoDinheiroCents });
    const { diferencaCents } = diferencaCaixa(b.valorContadoCents, r.esperadoDinheiroCents);
    return tx.erpCaixaSessao.update({ where: { id: s0.id }, data: {
      valorContadoCents: b.valorContadoCents, valorEsperadoCents: r.esperadoDinheiroCents, diferencaCents,
      totalVendasCents: r.totalVendasCents, totalSangriasCents: r.sangriasCents, totalSuprimentosCents: r.suprimentosCents,
      totaisPorForma: JSON.stringify(r.porForma), observacaoFechamento: b.observacao || null,
    } });
  });
  await auditar(req, 'caixa.fechar', 'erp_caixa_sessao', s.id, null, { valorContadoCents: s.valorContadoCents, valorEsperadoCents: s.valorEsperadoCents, diferencaCents: s.diferencaCents });
  res.json((await dto([s]))[0]);
}));
