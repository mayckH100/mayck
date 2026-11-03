/** Serviços do Financeiro usados por rotas e consumidores de eventos (dentro da transação). */
import type { Prisma } from '@prisma/client';
import { parcelar, statusTitulo, PLANO_PADRAO } from './calculo.js';
import { vincular } from '../shared/trace.js';
import { lerNfe } from '../estoque/nfe-xml.js';

type Tx = Prisma.TransactionClient;
const js = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };

export async function garantirPlano(tx: Tx, orgId: string) {
  if (await tx.erpCategoriaFinanceira.count({ where: { orgId } })) return;
  await tx.erpCategoriaFinanceira.createMany({ data: PLANO_PADRAO.map((c) => ({ orgId, ...c })) });
}
async function categoria(tx: Tx, orgId: string, codigo: string) {
  await garantirPlano(tx, orgId);
  return (await tx.erpCategoriaFinanceira.findUnique({ where: { orgId_codigo: { orgId, codigo } } }))?.id ?? null;
}

/** Pedido faturado → títulos a receber pela condição de pagamento (idempotente por pedido + parcela). */
export async function titulosDoPedido(tx: Tx, orgId: string, pedidoId: string) {
  const p = await tx.erpPedidoVenda.findFirst({ where: { id: pedidoId, orgId } });
  if (!p || p.totalCents <= 0) return 0;
  if (await tx.erpTitulo.count({ where: { orgId, docTipo: 'pedido_venda', docId: p.id } })) return 0;
  const cond = p.condicaoPagamentoId ? await tx.erpCondicaoPagamento.findFirst({ where: { id: p.condicaoPagamentoId, orgId } }) : null;
  const cat = await categoria(tx, orgId, '1.01');
  const ps = parcelar(p.totalCents, js<number[]>(cond?.prazos ?? '[0]', [0]), new Date());
  for (const x of ps) {
    const t = await tx.erpTitulo.create({ data: { orgId, tipo: 'RECEBER', parceiroId: p.parceiroId, descricao: `Pedido ${p.numero}${p.nfNumero ? ` · NF ${p.nfNumero}` : ''} (${x.parcela}/${x.parcelas})`, docTipo: 'pedido_venda', docId: p.id, parcela: x.parcela, parcelas: x.parcelas, valorCents: x.valorCents, vencimento: x.vencimento, categoriaId: cat, centroCustoId: p.centroCustoId ?? null } });
    if (x.parcela === 1) await vincular(tx, orgId, { tipo: 'pedido_venda', id: p.id }, { tipo: 'titulo', id: t.id }, 'gerou');
  }
  return ps.length;
}

/** NF-e de entrada lançada → títulos a pagar pelas duplicatas da nota (sem duplicata: uma parcela na emissão). */
export async function titulosDaNfe(tx: Tx, orgId: string, nfeId: string) {
  const n = await tx.erpNfeEntrada.findFirst({ where: { id: nfeId, orgId } });
  if (!n || n.valorTotalCents <= 0) return 0;
  if (await tx.erpTitulo.count({ where: { orgId, docTipo: 'nfe_entrada', docId: n.id } })) return 0;
  let dups: { numero: string; vencimento: Date | null; valorCents: number }[] = [];
  try { dups = lerNfe(n.xml).duplicatas; } catch { dups = []; }
  const lista = dups.length ? dups : [{ numero: '1', vencimento: n.dataEmissao ?? new Date(), valorCents: n.valorTotalCents }];
  const cat = await categoria(tx, orgId, '3.01');
  for (const [i, d] of lista.entries()) {
    const t = await tx.erpTitulo.create({ data: { orgId, tipo: 'PAGAR', parceiroId: n.parceiroId, descricao: `NF ${n.numero}/${n.serie} · ${n.emitenteNome} (${i + 1}/${lista.length})`, docTipo: 'nfe_entrada', docId: n.id, parcela: i + 1, parcelas: lista.length, valorCents: d.valorCents, vencimento: d.vencimento ?? n.dataEmissao ?? new Date(), emissao: n.dataEmissao ?? new Date(), competencia: n.dataEmissao ?? new Date(), categoriaId: cat } });
    if (i === 0) await vincular(tx, orgId, { tipo: 'nfe_entrada', id: n.id }, { tipo: 'titulo', id: t.id }, 'gerou');
  }
  return lista.length;
}

/** Cancela títulos sem baixa do documento (pedido cancelado/devolvido). */
export async function cancelarTitulosDoDoc(tx: Tx, orgId: string, docTipo: string, docId: string) {
  return (await tx.erpTitulo.updateMany({ where: { orgId, docTipo, docId, status: 'EM_ABERTO' } , data: { status: 'CANCELADO' } })).count;
}

/** Recalcula pago e status do título pelas baixas válidas; reflete no status financeiro do pedido de venda. */
export async function recalcularTitulo(tx: Tx, tituloId: string) {
  const t = await tx.erpTitulo.findUniqueOrThrow({ where: { id: tituloId }, include: { baixas: true } });
  const val = t.baixas.filter((b) => !b.estornada);
  const pago = val.reduce((a, b) => a + b.valorCents, 0);
  const novo = await tx.erpTitulo.update({ where: { id: t.id }, data: { pagoCents: pago, jurosCents: val.reduce((a, b) => a + b.jurosCents, 0), descontoCents: val.reduce((a, b) => a + b.descontoCents, 0), status: t.status === 'CANCELADO' ? 'CANCELADO' : statusTitulo(t.valorCents, pago) } });
  if (t.docTipo === 'pedido_venda' && t.docId) {
    const ts = await tx.erpTitulo.findMany({ where: { docTipo: 'pedido_venda', docId: t.docId, orgId: t.orgId, status: { not: 'CANCELADO' } } });
    const st = ts.every((x) => x.status === 'PAGO') ? 'LIQUIDADO' : ts.some((x) => x.pagoCents > 0) ? 'PARCIAL' : 'EM_ABERTO';
    await tx.erpPedidoVenda.updateMany({ where: { id: t.docId, orgId: t.orgId }, data: { statusFinanceiro: st } });
  }
  return novo;
}
