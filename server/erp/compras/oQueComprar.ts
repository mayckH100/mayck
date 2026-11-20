/**
 * "O que comprar" (v1.32.0) — junta do banco o que a regra pura (sugestao.ts) precisa e devolve a lista pronta para a
 * tela Compras › O que comprar e para o alerta diário do WhatsApp (mesma lista, mesma ordem, mesma quantidade).
 *
 * Saídas que contam como consumo: SAIDA (venda/separação/balcão), CONSUMO (produção) e AJUSTE negativo (baixa
 * manual: perda, quebra, uso interno). Não contam: inventário, transferência entre endereços e quarentena.
 * Já pedido = itens de pedidos de compra em aberto (rascunho até recebido em parte) ainda não recebidos.
 */
import { prisma } from '../../db.js';
import { unidadeLegivel } from '../shared/unidade.js';
import { fatorDe, linhaCompra, precoPorEmbalagem, temEmbalagem, unidadeCompraDe, descricaoEmbalagem } from '../shared/embalagem.js';
import { calcularCompra, compararUrgencia, escolherJanela, motivoCurto, precisaComprar, JANELA_CURTA, JANELA_LONGA, COBERTURA_PADRAO, type ResultadoCompra } from './sugestao.js';

const DIA = 86_400_000;
export const TIPOS_SAIDA = ['SAIDA', 'CONSUMO', 'AJUSTE'];
export const STATUS_PC_ABERTO = ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'];

export type OrigemCusto = 'entrada' | 'compra' | 'medio' | null;

export type ProdutoBase = {
  id: string; sku: string; nome: string; unidade: string; estoqueMinimoMil: number; custoMedioCents: number; createdAt: Date;
  fornecedorPadraoId: string | null; leadTimeDias: number; loteMinimoMil: number; unidadeCompra?: string | null; fatorCompraMil?: number | null;
};

export const SELECT_PRODUTO = { id: true, sku: true, nome: true, unidade: true, estoqueMinimoMil: true, custoMedioCents: true, createdAt: true, fornecedorPadraoId: true, leadTimeDias: true, loteMinimoMil: true, unidadeCompra: true, fatorCompraMil: true } as const;

/**
 * Fornecedor e custo de referência por produto (por unidade base).
 * Fornecedor: cadastro do produto → último pedido de compra → fornecedor do lote da última entrada.
 * Custo: última entrada no estoque com custo → último pedido de compra → custo do cadastro (custo médio).
 * Também devolve a quantidade da última entrada (quantidade usual de compra).
 */
export async function fornecedorECusto(orgId: string, produtos: ProdutoBase[]) {
  const ids = produtos.map((p) => p.id);
  const [itensPc, entradas] = await Promise.all([
    prisma.erpPedidoCompraItem.findMany({ where: { produtoId: { in: ids }, pedido: { orgId, status: { not: 'CANCELADO' } } }, orderBy: { pedido: { createdAt: 'desc' } }, take: 2000, select: { produtoId: true, precoUnitCents: true, pedido: { select: { parceiroId: true } } } }),
    prisma.erpMovimento.findMany({ where: { orgId, produtoId: { in: ids }, tipo: 'ENTRADA', qtdMil: { gt: 0 } }, orderBy: { createdAt: 'desc' }, take: 2000, select: { produtoId: true, loteId: true, custoUnitCents: true, qtdMil: true, createdAt: true } }),
  ]);
  const ultPc = new Map<string, (typeof itensPc)[number]>();
  for (const i of itensPc) if (!ultPc.has(i.produtoId)) ultPc.set(i.produtoId, i);
  const ultEnt = new Map<string, (typeof entradas)[number]>();
  const ultEntCusto = new Map<string, (typeof entradas)[number]>();
  for (const m of entradas) {
    if (!ultEnt.has(m.produtoId)) ultEnt.set(m.produtoId, m);
    if (m.custoUnitCents > 0 && !ultEntCusto.has(m.produtoId)) ultEntCusto.set(m.produtoId, m);
  }
  const lotes = await prisma.erpLote.findMany({ where: { orgId, id: { in: [...ultEnt.values()].map((m) => m.loteId) }, fornecedorId: { not: null } }, select: { id: true, fornecedorId: true } });
  const L = new Map(lotes.map((l) => [l.id, l.fornecedorId!]));
  const fornId = new Map<string, string | null>();
  for (const p of produtos) {
    const e = ultEnt.get(p.id);
    fornId.set(p.id, p.fornecedorPadraoId || ultPc.get(p.id)?.pedido.parceiroId || (e ? L.get(e.loteId) ?? null : null));
  }
  const parceiros = await prisma.erpParceiro.findMany({ where: { orgId, id: { in: [...new Set([...fornId.values()].filter((x): x is string => !!x))] } }, select: { id: true, nome: true, fantasia: true } });
  const N = new Map(parceiros.map((p) => [p.id, p.fantasia || p.nome]));
  const out = new Map<string, { fornecedorId: string | null; fornecedorNome: string | null; custoUnitCents: number; custoOrigem: OrigemCusto; ultimaCompraMil: number | null; ultimaCompraEm: Date | null }>();
  for (const p of produtos) {
    const f = fornId.get(p.id) ?? null;
    const pc = ultPc.get(p.id); const ec = ultEntCusto.get(p.id); const e = ultEnt.get(p.id);
    const [custo, origem]: [number, OrigemCusto] = ec ? [ec.custoUnitCents, 'entrada'] : pc && pc.precoUnitCents > 0 ? [pc.precoUnitCents, 'compra'] : p.custoMedioCents > 0 ? [p.custoMedioCents, 'medio'] : [0, null];
    out.set(p.id, { fornecedorId: f && N.has(f) ? f : null, fornecedorNome: f ? N.get(f) ?? null : null, custoUnitCents: custo, custoOrigem: origem, ultimaCompraMil: e?.qtdMil ?? null, ultimaCompraEm: e?.createdAt ?? null });
  }
  return out;
}

export interface ItemComprar {
  produtoId: string; sku: string; nome: string;
  /** Unidade base (estoque), já legível (unidade numérica antiga vira UN). */
  unidade: string;
  unidadeCompra: string; fatorCompraMil: number; embalagem: string; temEmbalagem: boolean;
  saldoMil: number; minimoMil: number; aCaminhoMil: number;
  calculo: ResultadoCompra; motivo: string;
  sugeridaMil: number;
  custoUnitCents: number; custoEmbalagemCents: number | null; custoOrigem: OrigemCusto;
  totalCents: number;
  fornecedorId: string | null; fornecedorNome: string | null;
  ultimaCompraMil: number | null; ultimaCompraEm: Date | null;
  leadTimeDias: number; loteMinimoMil: number;
}

export interface OpcoesComprar { coberturaDias?: number; janelaCurta?: number; janelaLonga?: number; now?: Date }

/** Lista "o que comprar" da empresa: só zerados ou abaixo do mínimo, zerados primeiro e depois por urgência. */
export async function listarOQueComprar(orgId: string, o: OpcoesComprar = {}): Promise<ItemComprar[]> {
  const now = o.now ?? new Date();
  const curta = o.janelaCurta ?? JANELA_CURTA;
  const longa = Math.max(curta, o.janelaLonga ?? JANELA_LONGA);
  const cobertura = o.coberturaDias ?? COBERTURA_PADRAO;
  const produtos = await prisma.erpProduto.findMany({ where: { orgId, ativo: true, tipo: { not: 'SERVICO' } }, select: SELECT_PRODUTO });
  if (!produtos.length) return [];
  const saldos = await prisma.erpSaldo.groupBy({ by: ['produtoId'], where: { orgId }, _sum: { fisicoMil: true } });
  const fis = new Map(saldos.map((s) => [s.produtoId, s._sum.fisicoMil ?? 0]));
  // Candidatos: abaixo do mínimo ou zerados (o zerado sem mínimo só entra se teve saída nos 90 dias).
  const candidatos = produtos.filter((p) => { const s = fis.get(p.id) ?? 0; return s <= 0 || (p.estoqueMinimoMil > 0 && s < p.estoqueMinimoMil); });
  if (!candidatos.length) return [];
  const ids = candidatos.map((p) => p.id);
  const desdeLonga = new Date(now.getTime() - longa * DIA);
  const desdeCurta = new Date(now.getTime() - curta * DIA);
  const [movs, abertos] = await Promise.all([
    prisma.erpMovimento.findMany({ where: { orgId, produtoId: { in: ids }, tipo: { in: TIPOS_SAIDA }, qtdMil: { lt: 0 }, createdAt: { gte: desdeLonga } }, select: { produtoId: true, qtdMil: true, createdAt: true } }),
    prisma.erpPedidoCompraItem.findMany({ where: { produtoId: { in: ids }, pedido: { orgId, status: { in: STATUS_PC_ABERTO } } }, select: { produtoId: true, qtdMil: true, recebidoMil: true } }),
  ]);
  const curtaM = new Map<string, number>(); const longaM = new Map<string, number>();
  // Idade do histórico: desde o cadastro ou desde a 1ª saída da janela, o que for mais antigo (produto importado com histórico).
  const primeira = new Map<string, number>();
  for (const m of movs) {
    const t = m.createdAt.getTime(); if (t < (primeira.get(m.produtoId) ?? Infinity)) primeira.set(m.produtoId, t);
    const q = Math.abs(m.qtdMil);
    longaM.set(m.produtoId, (longaM.get(m.produtoId) ?? 0) + q);
    if (m.createdAt >= desdeCurta) curtaM.set(m.produtoId, (curtaM.get(m.produtoId) ?? 0) + q);
  }
  const aCaminho = new Map<string, number>();
  for (const i of abertos) aCaminho.set(i.produtoId, (aCaminho.get(i.produtoId) ?? 0) + Math.max(0, i.qtdMil - i.recebidoMil));

  const lista = candidatos.filter((p) => precisaComprar(fis.get(p.id) ?? 0, p.estoqueMinimoMil, longaM.get(p.id) ?? 0));
  if (!lista.length) return [];
  const FC = await fornecedorECusto(orgId, lista);
  // v1.33.0: produto sem prazo próprio usa o prazo de entrega do cadastro do fornecedor.
  const fornIds = [...new Set([...FC.values()].map((f) => f.fornecedorId).filter(Boolean) as string[])];
  const prazoForn = new Map((await prisma.erpParceiro.findMany({ where: { orgId, id: { in: fornIds } }, select: { id: true, prazoEntregaDias: true } })).map((f) => [f.id, f.prazoEntregaDias]));
  return lista.map((p0): ItemComprar => {
    const fc0 = FC.get(p0.id)!;
    const p = { ...p0, leadTimeDias: p0.leadTimeDias || (fc0.fornecedorId ? prazoForn.get(fc0.fornecedorId) ?? 0 : 0) };
    const saldoMil = fis.get(p.id) ?? 0;
    const unidade = unidadeLegivel(p.unidade);
    const emb = { unidade, unidadeCompra: p.unidadeCompra, fatorCompraMil: p.fatorCompraMil };
    const j = escolherJanela({ saidasCurtaMil: curtaM.get(p.id) ?? 0, saidasLongaMil: longaM.get(p.id) ?? 0, idadeDias: (now.getTime() - Math.min(p.createdAt.getTime(), primeira.get(p.id) ?? Infinity)) / DIA, janelaCurta: curta, janelaLonga: longa });
    const calculo = calcularCompra({ ...emb, saldoMil, minimoMil: p.estoqueMinimoMil, consumoMil: j.consumoMil, janelaDias: j.janelaDias, base: j.base, coberturaDias: cobertura, leadTimeDias: p.leadTimeDias, loteMinimoMil: p.loteMinimoMil, aCaminhoMil: aCaminho.get(p.id) ?? 0 });
    const fc = FC.get(p.id)!;
    const f = fatorDe(emb);
    return {
      produtoId: p.id, sku: p.sku, nome: p.nome, unidade, unidadeCompra: unidadeCompraDe(emb), fatorCompraMil: f, embalagem: descricaoEmbalagem(emb), temEmbalagem: temEmbalagem(emb),
      saldoMil, minimoMil: p.estoqueMinimoMil, aCaminhoMil: calculo.aCaminhoMil,
      calculo, motivo: motivoCurto(calculo, unidade, { loteMinimoMil: p.loteMinimoMil, leadTimeDias: p.leadTimeDias }),
      sugeridaMil: calculo.sugeridaMil,
      custoUnitCents: fc.custoUnitCents, custoEmbalagemCents: temEmbalagem(emb) ? precoPorEmbalagem(fc.custoUnitCents, f) : null, custoOrigem: fc.custoOrigem,
      totalCents: linhaCompra(calculo.sugeridaMil, fc.custoUnitCents, emb).totalCents,
      fornecedorId: fc.fornecedorId, fornecedorNome: fc.fornecedorNome, ultimaCompraMil: fc.ultimaCompraMil, ultimaCompraEm: fc.ultimaCompraEm,
      leadTimeDias: p.leadTimeDias, loteMinimoMil: p.loteMinimoMil,
    };
  }).sort((a, b) => compararUrgencia({ saldoMil: a.saldoMil, minimoMil: a.minimoMil, duraDias: a.calculo.duraDias, nome: a.nome }, { saldoMil: b.saldoMil, minimoMil: b.minimoMil, duraDias: b.calculo.duraDias, nome: b.nome }));
}
