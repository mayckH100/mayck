/**
 * Rastreabilidade de lote (v1.33.0): resumo dos lotes (onde estão, quanto chegou, quanto tem), linha do tempo completa,
 * rastreio para frente (lote → clientes, inclusive via produto acabado) e para trás (pedido/produto acabado → lotes de
 * origem → fornecedor/NF). Tudo calculado do razão de estoque (ErpMovimento, só inserção), das reservas e do grafo
 * de rastreio (ErpTraceLink) — nada novo precisa ser gravado para lotes antigos.
 */
import { prisma } from '../../db.js';
import { contem } from '../../lib/busca.js';
import { numeroQtd, unidadeLegivel } from '../shared/unidade.js';
import {
  identificarBusca, textoEvento, categoriaMovimento, contaComoRecebido, iconeEvento, dataBR, dataHoraBR, numeroLoteLegivel,
  LOTE_INICIAL, LOTE_SEM_NUMERO, type CategoriaEvento, type RastreioCsv,
} from './rastreio-regras.js';

const PREFIXO_BALCAO = 'BALCAO-';
const MAX_PROFUNDIDADE = 4;

/**
 * Lotes "sem número" de antes da v1.31.0 (numero = UNICO) passam a se chamar L-INICIAL (mesmo id: saldos, movimentos,
 * reservas e etiquetas continuam ligados; nada é apagado). A migração 0060 faz o mesmo no deploy; esta rotina cobre o
 * que aparecer depois (ex.: backup restaurado). Idempotente.
 */
export async function normalizarLotesSemNumero(orgId: string): Promise<number> {
  const velhos = await prisma.erpLote.findMany({ where: { orgId, numero: LOTE_SEM_NUMERO }, take: 500 });
  let n = 0;
  for (const l of velhos) {
    for (let i = 1; i <= 50; i++) {
      const numero = i === 1 ? LOTE_INICIAL : `${LOTE_INICIAL}-${i}`;
      const ja = await prisma.erpLote.findUnique({ where: { orgId_produtoId_numero: { orgId, produtoId: l.produtoId, numero } }, select: { id: true } });
      if (ja) continue;
      const r = await prisma.erpLote.updateMany({ where: { id: l.id, numero: LOTE_SEM_NUMERO }, data: { numero, ...(l.origemTipo ? {} : { origemTipo: 'inicial' }) } });
      n += r.count;
      break;
    }
  }
  return n;
}

export interface Local { enderecoId: string; deposito: string; endereco: string; fisicoMil: number; reservadoMil: number; quarentenaMil: number; disponivelMil: number }
export interface DocRef { tipo: string; id: string | null; rotulo: string }
export interface LoteResumo {
  id: string; numero: string; loteFornecedor: string | null; status: string; validade: Date | null; fabricacao: Date | null; vencido: boolean;
  produto: { id: string; sku: string; nome: string; unidade: string; controlaValidade: boolean; regraSaida: string } | null;
  fornecedor: { id: string; nome: string } | null;
  entradaEm: Date; documentoEntrada: DocRef; lancadoPor: string | null;
  recebidoMil: number; saldoMil: number; reservadoMil: number; quarentenaMil: number; disponivelMil: number; locais: Local[];
}

const nomeParceiro = (p?: { nome: string; fantasia?: string | null } | null) => (p ? p.fantasia || p.nome : null);

async function nomesUsuarios(ids: (string | null | undefined)[]) {
  const u = [...new Set(ids.filter(Boolean) as string[])];
  if (!u.length) return new Map<string, string>();
  const us = await prisma.user.findMany({ where: { id: { in: u } }, select: { id: true, name: true } });
  return new Map(us.map((x) => [x.id, x.name]));
}

/** Rótulos dos documentos citados pelos movimentos/lotes (pedido, OP, NF-e de entrada, inventário). */
async function rotulosDocs(orgId: string, refs: { tipo: string | null; id: string | null }[]) {
  const ids = (t: string) => [...new Set(refs.filter((r) => r.tipo === t && r.id).map((r) => r.id!))];
  const pedidoIds = [...new Set([...ids('pedido_venda'), ...ids('devolucao')])];
  const [pedidos, nfsSaida, ops, nfes, invs] = await Promise.all([
    prisma.erpPedidoVenda.findMany({ where: { orgId, id: { in: pedidoIds } }, select: { id: true, numero: true, parceiroId: true, nfNumero: true, observacoes: true } }),
    prisma.erpNfeSaida.findMany({ where: { orgId, pedidoId: { in: pedidoIds }, status: 'AUTORIZADA' }, select: { pedidoId: true, numero: true, serie: true, chave: true } }),
    prisma.erpOrdemProducao.findMany({ where: { orgId, id: { in: ids('op') } }, select: { id: true, numero: true, produtoId: true } }),
    prisma.erpNfeEntrada.findMany({ where: { orgId, id: { in: ids('nfe_entrada') } }, select: { id: true, numero: true, serie: true, chave: true, parceiroId: true, emitenteNome: true, pedidoCompraId: true, lancadaPorId: true } }),
    prisma.erpInventario.findMany({ where: { orgId, id: { in: ids('inventario') } }, select: { id: true, descricao: true } }),
  ]);
  const pcIds = nfes.map((n) => n.pedidoCompraId).filter(Boolean) as string[];
  const [parceiros, pcs, prodsOp] = await Promise.all([
    prisma.erpParceiro.findMany({ where: { orgId, id: { in: [...pedidos.map((p) => p.parceiroId), ...nfes.map((n) => n.parceiroId)] } }, select: { id: true, nome: true, fantasia: true, documento: true } }),
    prisma.erpPedidoCompra.findMany({ where: { orgId, id: { in: pcIds } }, select: { id: true, numero: true } }),
    prisma.erpProduto.findMany({ where: { id: { in: ops.map((o) => o.produtoId) } }, select: { id: true, sku: true, nome: true } }),
  ]);
  const P = new Map(parceiros.map((p) => [p.id, p])); const PC = new Map(pcs.map((p) => [p.id, p.numero]));
  const PR = new Map(prodsOp.map((p) => [p.id, p]));
  const NFS = new Map(nfsSaida.map((n) => [n.pedidoId!, n]));
  const pedido = new Map(pedidos.map((p): [string, { id: string; numero: number; rotulo: string; cliente: string | null; clienteId: string; nf: string | null; chave: string | null }] => {
    const nfe = NFS.get(p.id);
    const balcao = !!p.nfNumero?.startsWith(PREFIXO_BALCAO);
    const nf = nfe ? `NF-e nº ${nfe.numero}` : p.nfNumero && !balcao ? `NF nº ${p.nfNumero}` : null;
    const cli = P.get(p.parceiroId);
    const cliente = cli?.documento === '00000000000' ? (p.observacoes?.match(/^Cliente: (.+)$/m)?.[1] ?? 'Consumidor final') : nomeParceiro(cli);
    return [p.id, { id: p.id, numero: p.numero, rotulo: balcao ? `Venda balcão nº ${p.numero}` : `Pedido de venda nº ${p.numero}`, cliente, clienteId: p.parceiroId, nf, chave: nfe?.chave ?? null }];
  }));
  const op = new Map(ops.map((o): [string, { id: string; numero: number; produtoId: string; rotulo: string }] => { const pr = PR.get(o.produtoId); return [o.id, { id: o.id, numero: o.numero, produtoId: o.produtoId, rotulo: `Ordem de produção nº ${o.numero}${pr ? ` (${pr.nome})` : ''}` }]; }));
  const nfe = new Map(nfes.map((n): [string, { id: string; rotulo: string; fornecedor: string; fornecedorId: string; chave: string; lancadaPorId: string | null }] => [n.id, { id: n.id, rotulo: `NF-e nº ${n.numero}/${n.serie}${n.pedidoCompraId && PC.get(n.pedidoCompraId) ? ` · pedido de compra nº ${PC.get(n.pedidoCompraId)}` : ''}`, fornecedor: nomeParceiro(P.get(n.parceiroId)) ?? n.emitenteNome, fornecedorId: n.parceiroId, chave: n.chave, lancadaPorId: n.lancadaPorId }]));
  const inv = new Map(invs.map((i): [string, { id: string; rotulo: string }] => [i.id, { id: i.id, rotulo: `Inventário: ${i.descricao}` }]));
  return { pedido, op, nfe, inv };
}
type Docs = Awaited<ReturnType<typeof rotulosDocs>>;

function docDoMovimento(d: Docs, docTipo: string | null, docId: string | null): { rotulo: string; cliente?: string | null; fornecedor?: string | null; nf?: string | null } | null {
  if (!docTipo) return null;
  if ((docTipo === 'pedido_venda' || docTipo === 'devolucao') && docId) { const p = d.pedido.get(docId); return p ? { rotulo: p.rotulo, cliente: p.cliente, nf: p.nf } : { rotulo: 'pedido de venda' }; }
  if (docTipo === 'op' && docId) return { rotulo: d.op.get(docId)?.rotulo ?? 'ordem de produção' };
  if (docTipo === 'nfe_entrada' && docId) { const n = d.nfe.get(docId); return n ? { rotulo: n.rotulo, fornecedor: n.fornecedor } : { rotulo: 'NF-e' }; }
  if (docTipo === 'inventario' && docId) return { rotulo: d.inv.get(docId)?.rotulo ?? 'inventário' };
  if (docTipo === 'inicial') return { rotulo: 'Saldo inicial' };
  if (docTipo === 'ajuste') return { rotulo: 'Lançamento manual' };
  if (docTipo === 'transferencia') return { rotulo: 'Mudança de lugar' };
  return null;
}

/** Resumo de vários lotes: produto, fornecedor, entrada (data, documento, quem), recebido, saldo e onde está cada parte. */
export async function resumirLotes(orgId: string, loteIds: string[]): Promise<LoteResumo[]> {
  if (!loteIds.length) return [];
  const lotes = await prisma.erpLote.findMany({ where: { orgId, id: { in: loteIds } } });
  if (!lotes.length) return [];
  const ids = lotes.map((l) => l.id);
  const [produtos, saldos, entradas] = await Promise.all([
    prisma.erpProduto.findMany({ where: { id: { in: [...new Set(lotes.map((l) => l.produtoId))] } }, select: { id: true, sku: true, nome: true, unidade: true, controlaValidade: true, regraSaida: true } }),
    prisma.erpSaldo.findMany({ where: { orgId, loteId: { in: ids } } }),
    prisma.erpMovimento.findMany({ where: { orgId, loteId: { in: ids }, qtdMil: { gt: 0 } }, orderBy: { createdAt: 'asc' }, select: { loteId: true, tipo: true, qtdMil: true, docTipo: true, docId: true, userId: true, createdAt: true } }),
  ]);
  const ends = await prisma.erpEnderecoEstoque.findMany({ where: { id: { in: [...new Set(saldos.map((s) => s.enderecoId))] } }, include: { deposito: { select: { nome: true } } } });
  const E = new Map(ends.map((e) => [e.id, e])); const PR = new Map(produtos.map((p) => [p.id, p]));
  const primeiras = new Map<string, (typeof entradas)[number]>();
  const recebido = new Map<string, number>();
  for (const m of entradas) {
    if (!contaComoRecebido(m)) continue;
    if (!primeiras.has(m.loteId)) primeiras.set(m.loteId, m);
    recebido.set(m.loteId, (recebido.get(m.loteId) ?? 0) + m.qtdMil);
  }
  const refs = lotes.map((l) => { const p = primeiras.get(l.id); return { tipo: l.origemTipo && l.origemId ? l.origemTipo : p?.docTipo ?? null, id: l.origemTipo && l.origemId ? l.origemId : p?.docId ?? null }; });
  const docs = await rotulosDocs(orgId, refs);
  const fornIds = [...new Set([...lotes.map((l) => l.fornecedorId), ...[...docs.nfe.values()].map((n) => n.fornecedorId)].filter(Boolean) as string[])];
  const forns = fornIds.length ? await prisma.erpParceiro.findMany({ where: { orgId, id: { in: fornIds } }, select: { id: true, nome: true, fantasia: true } }) : [];
  const F = new Map(forns.map((f) => [f.id, f]));
  const users = await nomesUsuarios([...primeiras.values()].map((m) => m.userId));
  const hoje = Date.now();
  return lotes.map((l, i) => {
    const prim = primeiras.get(l.id);
    const ref = refs[i];
    const nfe = ref.tipo === 'nfe_entrada' && ref.id ? docs.nfe.get(ref.id) : null;
    const documentoEntrada: DocRef = nfe ? { tipo: 'nfe_entrada', id: nfe.id, rotulo: nfe.rotulo }
      : ref.tipo === 'op' && ref.id ? { tipo: 'op', id: ref.id, rotulo: docs.op.get(ref.id)?.rotulo ?? 'Ordem de produção' }
      : ref.tipo === 'inicial' ? { tipo: 'inicial', id: null, rotulo: 'Saldo inicial (lançado à mão)' }
      : ref.tipo === 'inventario' ? { tipo: 'inventario', id: ref.id, rotulo: ref.id ? docs.inv.get(ref.id)?.rotulo ?? 'Inventário' : 'Inventário' }
      : { tipo: ref.tipo ?? 'ajuste', id: null, rotulo: l.numero === LOTE_INICIAL ? 'Saldo que já existia antes do controle de lote (sem nota)' : 'Entrada manual (sem nota)' };
    const fornecedorId = l.fornecedorId ?? nfe?.fornecedorId ?? null;
    const f = fornecedorId ? F.get(fornecedorId) : null;
    const meus = saldos.filter((s) => s.loteId === l.id);
    const locais: Local[] = meus.filter((s) => s.fisicoMil !== 0 || s.reservadoMil !== 0).map((s) => {
      const e = E.get(s.enderecoId);
      return { enderecoId: s.enderecoId, deposito: e?.deposito.nome ?? '—', endereco: e?.codigo ?? '—', fisicoMil: s.fisicoMil, reservadoMil: s.reservadoMil, quarentenaMil: s.quarentenaMil, disponivelMil: Math.max(0, s.fisicoMil - s.reservadoMil - s.quarentenaMil) };
    }).sort((a, b) => `${a.deposito} ${a.endereco}`.localeCompare(`${b.deposito} ${b.endereco}`));
    const soma = (k: 'fisicoMil' | 'reservadoMil' | 'quarentenaMil' | 'disponivelMil') => locais.reduce((a, x) => a + x[k], 0);
    return {
      id: l.id, numero: numeroLoteLegivel(l.numero), loteFornecedor: l.loteFornecedor, status: l.status, validade: l.validade, fabricacao: l.fabricacao,
      vencido: !!(l.validade && l.validade.getTime() < hoje),
      produto: PR.get(l.produtoId) ?? null, fornecedor: f ? { id: f.id, nome: f.fantasia || f.nome } : null,
      entradaEm: prim?.createdAt ?? l.createdAt, documentoEntrada, lancadoPor: (prim?.userId && users.get(prim.userId)) || (nfe?.lancadaPorId ? null : null),
      recebidoMil: recebido.get(l.id) ?? 0, saldoMil: soma('fisicoMil'), reservadoMil: soma('reservadoMil'), quarentenaMil: soma('quarentenaMil'), disponivelMil: soma('disponivelMil'), locais,
    };
  }).sort((a, b) => b.entradaEm.getTime() - a.entradaEm.getTime());
}

/** Lotes de um produto (com saldo primeiro). */
export async function lotesDoProduto(orgId: string, produtoId: string) {
  await normalizarLotesSemNumero(orgId);
  const ls = await prisma.erpLote.findMany({ where: { orgId, produtoId }, select: { id: true }, take: 500, orderBy: { createdAt: 'desc' } });
  const r = await resumirLotes(orgId, ls.map((l) => l.id));
  return r.sort((a, b) => Number(b.saldoMil > 0) - Number(a.saldoMil > 0) || b.entradaEm.getTime() - a.entradaEm.getTime());
}

/** Saldo por lote (tela Estoque): todos os lotes com saldo, opcionalmente de um depósito. */
export async function saldoPorLote(orgId: string, depositoId?: string | null) {
  await normalizarLotesSemNumero(orgId);
  const ends = depositoId ? await prisma.erpEnderecoEstoque.findMany({ where: { orgId, depositoId }, select: { id: true } }) : null;
  const saldos = await prisma.erpSaldo.findMany({ where: { orgId, fisicoMil: { gt: 0 }, ...(ends ? { enderecoId: { in: ends.map((e) => e.id) } } : {}) }, select: { loteId: true }, take: 3000 });
  const r = await resumirLotes(orgId, [...new Set(saldos.map((s) => s.loteId))].slice(0, 1000));
  return r.sort((a, b) => (a.produto?.nome ?? '').localeCompare(b.produto?.nome ?? '') || a.entradaEm.getTime() - b.entradaEm.getTime());
}

/** Contagem de lotes por produto (para a lista de Produtos): total e quantos têm saldo. */
export async function contarLotes(orgId: string, produtoIds: string[]) {
  if (!produtoIds.length) return new Map<string, { total: number; comSaldo: number }>();
  const [tot, com] = await Promise.all([
    prisma.erpLote.groupBy({ by: ['produtoId'], where: { orgId, produtoId: { in: produtoIds } }, _count: { _all: true } }),
    prisma.erpSaldo.findMany({ where: { orgId, produtoId: { in: produtoIds }, fisicoMil: { gt: 0 } }, select: { produtoId: true, loteId: true } }),
  ]);
  const m = new Map<string, { total: number; comSaldo: number }>();
  for (const t of tot) m.set(t.produtoId, { total: t._count._all, comSaldo: 0 });
  const vistos = new Set<string>();
  for (const s of com) { if (vistos.has(s.loteId)) continue; vistos.add(s.loteId); const x = m.get(s.produtoId) ?? { total: 0, comSaldo: 0 }; x.comSaldo++; m.set(s.produtoId, x); }
  return m;
}

export interface Evento { quando: Date; categoria: CategoriaEvento; icone: string; texto: string; qtdMil: number | null; saldoLoteMil: number | null; quem: string | null; doc: DocRef | null; endereco: string | null }
export interface Destino { tipo: 'cliente' | 'producao' | 'baixa' | 'inventario'; para: string; doc: DocRef | null; qtdMil: number; quando: Date; clienteId?: string | null; lotesGerados?: { id: string; numero: string; produto: string }[] }
export interface Alcance { cliente: string; clienteId: string | null; pedido: DocRef; nf: string | null; quando: Date; qtdMil: number; produto: string; unidade: string; lote: { id: string; numero: string }; via: string | null }

/** Lotes produzidos em cada OP (movimentos PRODUCAO), por OP. */
async function lotesProduzidosPorOp(orgId: string, opIds: string[]) {
  if (!opIds.length) return new Map<string, string[]>();
  const ms = await prisma.erpMovimento.findMany({ where: { orgId, tipo: 'PRODUCAO', docTipo: 'op', docId: { in: opIds } }, select: { docId: true, loteId: true } });
  const m = new Map<string, string[]>();
  for (const x of ms) m.set(x.docId!, [...new Set([...(m.get(x.docId!) ?? []), x.loteId])]);
  return m;
}

/** Lotes que compuseram um lote produzido (genealogia gravada no apontamento; sem ela, o consumo da OP). */
async function lotesDeOrigem(orgId: string, loteId: string): Promise<{ loteId: string; qtdMil: number | null; opId: string | null }[]> {
  const prod = await prisma.erpMovimento.findFirst({ where: { orgId, loteId, tipo: 'PRODUCAO', docTipo: 'op' }, select: { docId: true } });
  const links = await prisma.erpTraceLink.findMany({ where: { orgId, destinoTipo: 'lote', destinoId: loteId, origemTipo: 'lote', vinculo: 'compoe' }, select: { origemId: true } });
  const ids = new Set(links.map((l) => l.origemId));
  if (!prod?.docId) return [...ids].map((id) => ({ loteId: id, qtdMil: null, opId: null }));
  const cons = await prisma.erpMovimento.findMany({ where: { orgId, tipo: 'CONSUMO', docTipo: 'op', docId: prod.docId }, select: { loteId: true, qtdMil: true } });
  const q = new Map<string, number>();
  for (const c of cons) q.set(c.loteId, (q.get(c.loteId) ?? 0) - c.qtdMil);
  for (const id of q.keys()) ids.add(id);
  return [...ids].map((id) => ({ loteId: id, qtdMil: q.get(id) ?? null, opId: prod.docId }));
}

/** Para frente (recall): todos os clientes que receberam este lote, direto ou dentro de um produto acabado. */
export async function alcanceClientes(orgId: string, loteId: string): Promise<Alcance[]> {
  const out: Alcance[] = [];
  const vistos = new Set<string>([loteId]);
  let fronteira: { loteId: string; via: string | null }[] = [{ loteId, via: null }];
  for (let nivel = 0; nivel < MAX_PROFUNDIDADE && fronteira.length; nivel++) {
    const ids = fronteira.map((f) => f.loteId);
    const movs = await prisma.erpMovimento.findMany({ where: { orgId, loteId: { in: ids }, tipo: { in: ['SAIDA', 'CONSUMO', 'DEVOLUCAO'] } }, select: { loteId: true, tipo: true, qtdMil: true, docTipo: true, docId: true, createdAt: true, produtoId: true } });
    const docs = await rotulosDocs(orgId, movs.map((m) => ({ tipo: m.docTipo, id: m.docId })));
    const lotes = await prisma.erpLote.findMany({ where: { id: { in: ids } }, select: { id: true, numero: true, produtoId: true } });
    const prods = await prisma.erpProduto.findMany({ where: { id: { in: lotes.map((l) => l.produtoId) } }, select: { id: true, nome: true, unidade: true } });
    const L = new Map(lotes.map((l) => [l.id, l])); const P = new Map(prods.map((p) => [p.id, p]));
    const porPedido = new Map<string, Alcance>();
    for (const m of movs.filter((x) => (x.tipo === 'SAIDA' || x.tipo === 'DEVOLUCAO') && x.docId)) {
      const k = `${m.loteId}:${m.docId}`;
      const ped = docs.pedido.get(m.docId!); const l = L.get(m.loteId)!; const p = P.get(l.produtoId);
      const atual = porPedido.get(k) ?? { cliente: ped?.cliente ?? '—', clienteId: ped?.clienteId ?? null, pedido: { tipo: 'pedido_venda', id: m.docId, rotulo: ped?.rotulo ?? 'Pedido' }, nf: ped?.nf ?? null, quando: m.createdAt, qtdMil: 0, produto: p?.nome ?? '', unidade: p?.unidade ?? 'UN', lote: { id: l.id, numero: numeroLoteLegivel(l.numero) }, via: fronteira.find((f) => f.loteId === m.loteId)?.via ?? null };
      atual.qtdMil += m.tipo === 'SAIDA' ? -m.qtdMil : -m.qtdMil; // SAIDA é negativa (soma), DEVOLUCAO positiva (desconta)
      if (m.tipo === 'SAIDA' && m.createdAt < atual.quando) atual.quando = m.createdAt;
      porPedido.set(k, atual);
    }
    out.push(...[...porPedido.values()].filter((a) => a.qtdMil > 0));
    const opIds = [...new Set(movs.filter((m) => m.tipo === 'CONSUMO' && m.docId).map((m) => m.docId!))];
    const gerados = await lotesProduzidosPorOp(orgId, opIds);
    const prox: { loteId: string; via: string | null }[] = [];
    for (const m of movs.filter((x) => x.tipo === 'CONSUMO' && x.docId)) {
      const l = L.get(m.loteId)!;
      for (const g of gerados.get(m.docId!) ?? []) {
        if (vistos.has(g)) continue; vistos.add(g);
        prox.push({ loteId: g, via: `${docs.op.get(m.docId!)?.rotulo ?? 'Produção'} (usou o lote ${numeroLoteLegivel(l.numero)})` });
      }
    }
    fronteira = prox;
  }
  return out.sort((a, b) => a.quando.getTime() - b.quando.getTime());
}

export interface OrigemNo { lote: LoteResumo; qtdMil: number | null; nivel: number; via: string | null }
/** Para trás: lotes de origem (insumos) de um lote produzido, até chegar ao fornecedor/NF. */
export async function origemLotes(orgId: string, loteId: string): Promise<OrigemNo[]> {
  const out: OrigemNo[] = [];
  const vistos = new Set<string>([loteId]);
  let fronteira = [loteId];
  for (let nivel = 1; nivel <= MAX_PROFUNDIDADE && fronteira.length; nivel++) {
    const prox: string[] = [];
    for (const id of fronteira) {
      const origens = (await lotesDeOrigem(orgId, id)).filter((o) => !vistos.has(o.loteId));
      const res = await resumirLotes(orgId, origens.map((o) => o.loteId));
      const opDocs = await rotulosDocs(orgId, origens.map((o) => ({ tipo: 'op', id: o.opId })));
      for (const r of res) {
        const o = origens.find((x) => x.loteId === r.id)!;
        vistos.add(r.id); prox.push(r.id);
        out.push({ lote: r, qtdMil: o.qtdMil, nivel, via: o.opId ? opDocs.op.get(o.opId)?.rotulo ?? null : null });
      }
    }
    fronteira = prox;
  }
  return out;
}

/** Linha do tempo completa de um lote + onde está, para onde foi, de onde veio e clientes alcançados. */
export async function rastrearLote(orgId: string, loteId: string) {
  await normalizarLotesSemNumero(orgId);
  const [resumo] = await resumirLotes(orgId, [loteId]);
  if (!resumo) return null;
  const [movs, reservas] = await Promise.all([
    prisma.erpMovimento.findMany({ where: { orgId, loteId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.erpReserva.findMany({ where: { orgId, loteId }, orderBy: { createdAt: 'asc' } }),
  ]);
  // reservas → pedido (via item) ou OP (via componente)
  const itensPed = await prisma.erpPedidoItem.findMany({ where: { id: { in: reservas.filter((r) => r.origemTipo === 'pedido_venda').map((r) => r.pedidoItemId) } }, select: { id: true, pedidoId: true } });
  const comps = await prisma.erpOpComponente.findMany({ where: { id: { in: reservas.filter((r) => r.origemTipo === 'op').map((r) => r.pedidoItemId) } }, select: { id: true, opId: true } });
  const IP = new Map(itensPed.map((i) => [i.id, i.pedidoId])); const CO = new Map(comps.map((c) => [c.id, c.opId]));
  const docs = await rotulosDocs(orgId, [
    ...movs.map((m) => ({ tipo: m.docTipo, id: m.docId })),
    ...itensPed.map((i) => ({ tipo: 'pedido_venda', id: i.pedidoId })), ...comps.map((c) => ({ tipo: 'op', id: c.opId })),
  ]);
  const ends = await prisma.erpEnderecoEstoque.findMany({ where: { id: { in: [...new Set([...movs.map((m) => m.enderecoId), ...reservas.map((r) => r.enderecoId)])] } }, include: { deposito: { select: { nome: true } } } });
  const E = new Map(ends.map((e) => [e.id, `${e.deposito.nome} · ${e.codigo}`]));
  const users = await nomesUsuarios(movs.map((m) => m.userId));
  const un = resumo.produto?.unidade ?? 'UN';

  const docRef = (tipo: string | null, id: string | null): DocRef | null => {
    if (!tipo || !id) return null;
    if (tipo === 'pedido_venda' || tipo === 'devolucao') return { tipo: 'pedido_venda', id, rotulo: docs.pedido.get(id)?.rotulo ?? 'Pedido' };
    if (tipo === 'op') return { tipo: 'op', id, rotulo: docs.op.get(id)?.rotulo ?? 'OP' };
    if (tipo === 'nfe_entrada') return { tipo: 'nfe_entrada', id, rotulo: docs.nfe.get(id)?.rotulo ?? 'NF-e' };
    if (tipo === 'inventario') return { tipo: 'inventario', id, rotulo: docs.inv.get(id)?.rotulo ?? 'Inventário' };
    return null;
  };

  const eventos: Evento[] = [];
  let saldo = 0;
  for (const m of movs) {
    saldo += m.qtdMil;
    const cat = categoriaMovimento(m);
    const endereco = E.get(m.enderecoId) ?? null;
    let texto = textoEvento({ tipo: m.tipo, qtdMil: m.qtdMil, docTipo: m.docTipo, motivo: m.motivo, doc: docDoMovimento(docs, m.docTipo, m.docId), endereco });
    if (m.tipo === 'SEPARACAO' && m.motivo) texto = `${texto} — ${m.motivo}`;
    eventos.push({ quando: m.createdAt, categoria: cat, icone: iconeEvento(cat), texto, qtdMil: m.qtdMil === 0 ? null : m.qtdMil, saldoLoteMil: m.qtdMil === 0 ? null : saldo, quem: m.userId ? users.get(m.userId) ?? null : null, doc: docRef(m.docTipo, m.docId), endereco });
  }
  for (const r of reservas) {
    const pedidoId = r.origemTipo === 'pedido_venda' ? IP.get(r.pedidoItemId) : null;
    const opId = r.origemTipo === 'op' ? CO.get(r.pedidoItemId) : null;
    const ped = pedidoId ? docs.pedido.get(pedidoId) : null;
    const para = ped ? `${ped.rotulo}${ped.cliente ? ` de ${ped.cliente}` : ''}` : opId ? docs.op.get(opId)?.rotulo ?? 'produção' : 'pedido';
    const fim = r.status === 'LIBERADA' ? ' (reserva desfeita depois: pedido cancelado ou OP encerrada)' : r.status === 'BAIXADA' ? ' (já saiu do estoque)' : ' (ainda reservado)';
    eventos.push({ quando: r.createdAt, categoria: 'reserva', icone: iconeEvento('reserva'), texto: `Reservado para ${para}${fim}`, qtdMil: r.qtdMil, saldoLoteMil: null, quem: null, doc: pedidoId ? { tipo: 'pedido_venda', id: pedidoId, rotulo: ped?.rotulo ?? 'Pedido' } : opId ? { tipo: 'op', id: opId, rotulo: docs.op.get(opId)?.rotulo ?? 'OP' } : null, endereco: E.get(r.enderecoId) ?? null });
  }
  eventos.sort((a, b) => a.quando.getTime() - b.quando.getTime() || (a.categoria === 'reserva' ? -1 : 0));

  // Reservas ativas = parte do saldo de hoje que já tem dono.
  const reservadoPara = reservas.filter((r) => r.status === 'ATIVA').map((r) => {
    const pedidoId = r.origemTipo === 'pedido_venda' ? IP.get(r.pedidoItemId) : null; const opId = r.origemTipo === 'op' ? CO.get(r.pedidoItemId) : null;
    const ped = pedidoId ? docs.pedido.get(pedidoId) : null;
    return { para: ped ? `${ped.rotulo}${ped.cliente ? ` (${ped.cliente})` : ''}` : opId ? docs.op.get(opId)?.rotulo ?? 'Produção' : 'Pedido', doc: pedidoId ? { tipo: 'pedido_venda', id: pedidoId, rotulo: ped?.rotulo ?? '' } : opId ? { tipo: 'op', id: opId, rotulo: docs.op.get(opId)?.rotulo ?? '' } : null, qtdMil: r.qtdMil - r.separadoMil, separadoMil: r.separadoMil, local: E.get(r.enderecoId) ?? '—' };
  });

  // Para onde foi o que saiu (agrupado por documento).
  const destinos = new Map<string, Destino>();
  const gerados = await lotesProduzidosPorOp(orgId, [...new Set(movs.filter((m) => m.tipo === 'CONSUMO' && m.docId).map((m) => m.docId!))]);
  const lotesGer = await prisma.erpLote.findMany({ where: { id: { in: [...gerados.values()].flat() } }, select: { id: true, numero: true, produtoId: true } });
  const prodsGer = await prisma.erpProduto.findMany({ where: { id: { in: lotesGer.map((l) => l.produtoId) } }, select: { id: true, nome: true } });
  const LG = new Map(lotesGer.map((l) => [l.id, l])); const PG = new Map(prodsGer.map((p) => [p.id, p.nome]));
  for (const m of movs) {
    if (!['SAIDA', 'CONSUMO', 'AJUSTE', 'INVENTARIO', 'DEVOLUCAO'].includes(m.tipo)) continue;
    if ((m.tipo === 'AJUSTE' || m.tipo === 'INVENTARIO') && m.qtdMil >= 0) continue;
    if (m.tipo === 'SAIDA' || m.tipo === 'DEVOLUCAO') {
      const k = `cli:${m.docId}`; const ped = m.docId ? docs.pedido.get(m.docId) : null;
      const d = destinos.get(k) ?? { tipo: 'cliente' as const, para: ped?.cliente ?? 'Cliente', clienteId: ped?.clienteId ?? null, doc: { tipo: 'pedido_venda', id: m.docId, rotulo: `${ped?.rotulo ?? 'Pedido'}${ped?.nf ? ` · ${ped.nf}` : ''}` }, qtdMil: 0, quando: m.createdAt };
      d.qtdMil += -m.qtdMil; destinos.set(k, d);
    } else if (m.tipo === 'CONSUMO') {
      const k = `op:${m.docId}`;
      const d = destinos.get(k) ?? { tipo: 'producao' as const, para: docs.op.get(m.docId ?? '')?.rotulo ?? 'Produção', doc: docRef('op', m.docId), qtdMil: 0, quando: m.createdAt, lotesGerados: (gerados.get(m.docId ?? '') ?? []).map((id) => ({ id, numero: numeroLoteLegivel(LG.get(id)?.numero), produto: PG.get(LG.get(id)?.produtoId ?? '') ?? '' })) };
      d.qtdMil += -m.qtdMil; destinos.set(k, d);
    } else {
      const k = `${m.tipo}:${m.id}`;
      destinos.set(k, { tipo: m.tipo === 'INVENTARIO' ? 'inventario' : 'baixa', para: m.tipo === 'INVENTARIO' ? 'Falta no inventário' : `Baixa manual${m.motivo ? `: ${m.motivo}` : ''}`, doc: docRef(m.docTipo, m.docId), qtdMil: -m.qtdMil, quando: m.createdAt });
    }
  }

  const [origem, alcance] = await Promise.all([origemLotes(orgId, loteId), alcanceClientes(orgId, loteId)]);
  return {
    lote: resumo, unidade: un, reservadoPara, eventos,
    destinos: [...destinos.values()].filter((d) => d.qtdMil > 0).sort((a, b) => a.quando.getTime() - b.quando.getTime()),
    origem, clientesAlcancados: alcance,
  };
}
export type Rastreio = NonNullable<Awaited<ReturnType<typeof rastrearLote>>>;

/** Para trás a partir de um pedido de venda: lotes que saíram (ou estão reservados) e a origem de cada um. */
export async function rastrearPedido(orgId: string, pedidoId: string) {
  await normalizarLotesSemNumero(orgId);
  const p = await prisma.erpPedidoVenda.findFirst({ where: { id: pedidoId, orgId }, include: { itens: true } });
  if (!p) return null;
  const [movs, reservas] = await Promise.all([
    prisma.erpMovimento.findMany({ where: { orgId, docTipo: { in: ['pedido_venda', 'devolucao'] }, docId: p.id, tipo: { in: ['SAIDA', 'DEVOLUCAO'] } }, select: { loteId: true, qtdMil: true } }),
    prisma.erpReserva.findMany({ where: { orgId, pedidoItemId: { in: p.itens.map((i) => i.id) }, status: 'ATIVA' }, select: { loteId: true, qtdMil: true } }),
  ]);
  const q = new Map<string, { saiuMil: number; reservadoMil: number }>();
  for (const m of movs) { const x = q.get(m.loteId) ?? { saiuMil: 0, reservadoMil: 0 }; x.saiuMil += -m.qtdMil; q.set(m.loteId, x); }
  for (const r of reservas) { const x = q.get(r.loteId) ?? { saiuMil: 0, reservadoMil: 0 }; x.reservadoMil += r.qtdMil; q.set(r.loteId, x); }
  const lotes = await resumirLotes(orgId, [...q.keys()]);
  const docs = await rotulosDocs(orgId, [{ tipo: 'pedido_venda', id: p.id }]);
  const ped = docs.pedido.get(p.id)!;
  const itens: { lote: LoteResumo; saiuMil: number; reservadoMil: number; origem: OrigemNo[] }[] = [];
  for (const l of lotes) itens.push({ lote: l, ...q.get(l.id)!, origem: await origemLotes(orgId, l.id) });
  return { pedido: { id: p.id, numero: p.numero, rotulo: ped.rotulo, cliente: ped.cliente, nf: ped.nf, status: p.statusOperacional, criadoEm: p.createdAt }, lotes: itens };
}

export interface GrupoBusca { tipo: 'produto' | 'lote' | 'lote_fornecedor' | 'nfe_entrada' | 'nfe_saida' | 'pedido_venda' | 'pedido_compra'; rotulo: string; titulo: string; detalhe: string | null; pedidoVendaId?: string | null; lotes: LoteResumo[] }

/**
 * Busca única: identifica sozinha se o texto é produto (código, nome, código de barras), lote interno, lote do
 * fornecedor, NF-e (número ou chave, entrada ou saída) ou pedido (venda ou compra). Devolve um grupo por achado,
 * com os lotes ligados a ele.
 */
export async function buscarRastreio(orgId: string, qBruto: string) {
  await normalizarLotesSemNumero(orgId);
  const b = identificarBusca(qBruto);
  const grupos: GrupoBusca[] = [];
  if (!b.q) return { busca: b, grupos };
  const up = b.q.toUpperCase();
  const add = async (g: Omit<GrupoBusca, 'lotes'>, loteIds: string[]) => { const lotes = await resumirLotes(orgId, [...new Set(loteIds)].slice(0, 200)); grupos.push({ ...g, lotes }); };
  const lotesDeMovs = async (where: object) => (await prisma.erpMovimento.findMany({ where: { orgId, ...where }, select: { loteId: true }, take: 2000 })).map((m) => m.loteId);

  // 1) Lote interno / lote do fornecedor
  if (b.tipos.includes('texto') || b.tipos.includes('numero')) {
    const porNumero = await prisma.erpLote.findMany({ where: { orgId, numero: up === LOTE_SEM_NUMERO ? LOTE_INICIAL : contem(up) }, select: { id: true, numero: true }, take: 100 });
    if (porNumero.length) await add({ tipo: 'lote', rotulo: 'Lote interno', titulo: porNumero.length === 1 ? `Lote ${porNumero[0].numero}` : `${porNumero.length} lotes internos com "${b.q}"`, detalhe: null }, porNumero.map((l) => l.id));
    const porForn = await prisma.erpLote.findMany({ where: { orgId, loteFornecedor: contem(up) }, select: { id: true, loteFornecedor: true }, take: 100 });
    if (porForn.length) await add({ tipo: 'lote_fornecedor', rotulo: 'Lote do fornecedor', titulo: porForn.length === 1 ? `Lote do fornecedor ${porForn[0].loteFornecedor}` : `${porForn.length} lotes do fornecedor com "${b.q}"`, detalhe: null }, porForn.map((l) => l.id));
  }
  // 2) Produto: código, nome ou código de barras
  if (b.tipos.includes('texto') || b.tipos.includes('codigo_barras')) {
    const prods = await prisma.erpProduto.findMany({ where: { orgId, OR: [{ sku: up }, { codigoBarras: b.q }, ...(b.tipos.includes('texto') ? [{ nome: contem(b.q) }, { sku: contem(up) }] : [])] }, select: { id: true, sku: true, nome: true }, take: 20 });
    for (const p of prods) {
      const ls = await prisma.erpLote.findMany({ where: { orgId, produtoId: p.id }, select: { id: true }, take: 200, orderBy: { createdAt: 'desc' } });
      await add({ tipo: 'produto', rotulo: 'Produto', titulo: `${p.nome} (cód. ${p.sku})`, detalhe: `${ls.length} lote${ls.length === 1 ? '' : 's'}` }, ls.map((l) => l.id));
    }
  }
  // 3) NF-e de entrada (número ou chave)
  if (b.tipos.includes('chave_nfe') || b.numero != null) {
    const where = b.tipos.includes('chave_nfe') ? { chave: b.digitos } : { numero: { in: [String(b.numero), b.digitos] } };
    const nfes = await prisma.erpNfeEntrada.findMany({ where: { orgId, ...where }, select: { id: true, numero: true, serie: true, emitenteNome: true, status: true }, take: 20 });
    for (const n of nfes) {
      const ls = await prisma.erpLote.findMany({ where: { orgId, origemTipo: 'nfe_entrada', origemId: n.id }, select: { id: true } });
      await add({ tipo: 'nfe_entrada', rotulo: 'NF-e de entrada (compra)', titulo: `NF-e nº ${n.numero}/${n.serie} · ${n.emitenteNome}`, detalhe: n.status === 'LANCADA' ? null : 'Nota ainda não lançada no estoque' }, [...ls.map((l) => l.id), ...(await lotesDeMovs({ docTipo: 'nfe_entrada', docId: n.id }))]);
    }
  }
  // 4) NF de saída (NF-e emitida pelo ERP, nº digitado no faturamento) e pedido de venda
  if (b.tipos.includes('chave_nfe') || b.numero != null || b.tipos.includes('texto')) {
    const nfs = b.tipos.includes('chave_nfe')
      ? await prisma.erpNfeSaida.findMany({ where: { orgId, chave: b.digitos }, select: { pedidoId: true, numero: true, serie: true }, take: 20 })
      : b.numero != null ? await prisma.erpNfeSaida.findMany({ where: { orgId, numero: b.numero }, select: { pedidoId: true, numero: true, serie: true }, take: 20 }) : [];
    const pedidosNf = [
      ...nfs.filter((n) => n.pedidoId).map((n) => ({ pedidoId: n.pedidoId!, nf: `NF-e nº ${n.numero}/${n.serie}` })),
      ...(await prisma.erpPedidoVenda.findMany({ where: { orgId, nfNumero: { in: [b.q, up, b.digitos].filter(Boolean) } }, select: { id: true, nfNumero: true }, take: 20 })).filter((p) => !p.nfNumero?.startsWith(PREFIXO_BALCAO) || up.startsWith(PREFIXO_BALCAO)).map((p) => ({ pedidoId: p.id, nf: `NF nº ${p.nfNumero}` })),
    ];
    const vistos = new Set<string>();
    for (const x of pedidosNf) {
      if (vistos.has(x.pedidoId)) continue; vistos.add(x.pedidoId);
      const d = (await rotulosDocs(orgId, [{ tipo: 'pedido_venda', id: x.pedidoId }])).pedido.get(x.pedidoId);
      await add({ tipo: 'nfe_saida', rotulo: 'Nota de saída (venda)', titulo: `${x.nf}${d ? ` · ${d.rotulo} · ${d.cliente}` : ''}`, detalhe: null, pedidoVendaId: x.pedidoId }, await lotesDeMovs({ docTipo: 'pedido_venda', docId: x.pedidoId }));
    }
    if (b.numero != null) {
      const pv = await prisma.erpPedidoVenda.findFirst({ where: { orgId, numero: b.numero }, include: { itens: { select: { id: true } } } });
      if (pv) {
        const d = (await rotulosDocs(orgId, [{ tipo: 'pedido_venda', id: pv.id }])).pedido.get(pv.id);
        const res = await prisma.erpReserva.findMany({ where: { orgId, pedidoItemId: { in: pv.itens.map((i) => i.id) }, status: { in: ['ATIVA', 'BAIXADA'] } }, select: { loteId: true } });
        await add({ tipo: 'pedido_venda', rotulo: 'Pedido de venda', titulo: `${d?.rotulo ?? `Pedido nº ${pv.numero}`} · ${d?.cliente ?? ''}`, detalhe: d?.nf ?? null, pedidoVendaId: pv.id }, [...(await lotesDeMovs({ docTipo: { in: ['pedido_venda', 'devolucao'] }, docId: pv.id })), ...res.map((r) => r.loteId)]);
      }
      // 5) Pedido de compra → notas recebidas → lotes
      const pc = await prisma.erpPedidoCompra.findFirst({ where: { orgId, numero: b.numero }, select: { id: true, numero: true, parceiroId: true, status: true } });
      if (pc) {
        const forn = await prisma.erpParceiro.findFirst({ where: { id: pc.parceiroId }, select: { nome: true, fantasia: true } });
        const links = await prisma.erpTraceLink.findMany({ where: { orgId, origemTipo: 'pedido_compra', origemId: pc.id, destinoTipo: 'nfe_entrada' }, select: { destinoId: true } });
        const nfeIds = [...new Set([...links.map((l) => l.destinoId), ...(await prisma.erpNfeEntrada.findMany({ where: { orgId, pedidoCompraId: pc.id }, select: { id: true } })).map((n) => n.id)])];
        const ls = nfeIds.length ? await prisma.erpLote.findMany({ where: { orgId, origemTipo: 'nfe_entrada', origemId: { in: nfeIds } }, select: { id: true } }) : [];
        await add({ tipo: 'pedido_compra', rotulo: 'Pedido de compra', titulo: `Pedido de compra nº ${pc.numero} · ${nomeParceiro(forn) ?? ''}`, detalhe: ls.length ? `${nfeIds.length} nota${nfeIds.length === 1 ? '' : 's'} recebida${nfeIds.length === 1 ? '' : 's'}` : 'Ainda não recebido no estoque' }, ls.map((l) => l.id));
      }
    }
  }
  return { busca: b, grupos };
}

/** Monta o CSV do rastreio de um lote. */
export function rastreioParaCsv(r: Rastreio): RastreioCsv {
  const un = unidadeLegivel(r.unidade);
  const q = (m: number | null) => (m == null ? '' : numeroQtd(m));
  return {
    lote: { numero: r.lote.numero, loteFornecedor: r.lote.loteFornecedor, produto: r.lote.produto ? `${r.lote.produto.nome} (cód. ${r.lote.produto.sku})` : '', fornecedor: r.lote.fornecedor?.nome ?? null, entradaEm: dataHoraBR(r.lote.entradaEm), documentoEntrada: r.lote.documentoEntrada.rotulo, validade: dataBR(r.lote.validade), recebida: q(r.lote.recebidoMil), saldo: q(r.lote.saldoMil), unidade: un },
    locais: r.lote.locais.map((l) => ({ local: `${l.deposito} · ${l.endereco}`, fisico: q(l.fisicoMil), reservado: q(l.reservadoMil), disponivel: q(l.disponivelMil) })),
    eventos: r.eventos.map((e) => ({ quando: dataHoraBR(e.quando), evento: e.texto, quantidade: e.qtdMil == null ? '' : `${e.qtdMil > 0 && e.categoria !== 'reserva' ? '+' : ''}${q(e.qtdMil)}`, saldoApos: q(e.saldoLoteMil), quem: e.quem ?? '', documento: e.doc?.rotulo ?? '' })),
    destinos: [
      ...r.destinos.map((d) => ({ tipo: { cliente: 'Cliente', producao: 'Produção', baixa: 'Baixa', inventario: 'Inventário' }[d.tipo], para: d.para + (d.lotesGerados?.length ? ` → gerou ${d.lotesGerados.map((g) => `${g.produto} lote ${g.numero}`).join(', ')}` : ''), documento: d.doc?.rotulo ?? '', quantidade: q(d.qtdMil), quando: dataBR(d.quando) })),
      ...r.clientesAlcancados.filter((c) => c.via).map((c) => ({ tipo: 'Cliente (no produto acabado)', para: `${c.cliente} · ${c.produto} lote ${c.lote.numero}`, documento: `${c.pedido.rotulo}${c.nf ? ` · ${c.nf}` : ''}`, quantidade: q(c.qtdMil), quando: dataBR(c.quando) })),
    ],
    origens: r.origem.map((o) => ({ tipo: o.nivel === 1 ? 'Insumo' : `Insumo (nível ${o.nivel})`, de: `${o.lote.produto?.nome ?? ''} lote ${o.lote.numero}${o.lote.loteFornecedor ? ` (fornecedor ${o.lote.loteFornecedor})` : ''}${o.lote.fornecedor ? ` · ${o.lote.fornecedor.nome}` : ''}`, documento: o.lote.documentoEntrada.rotulo, quantidade: q(o.qtdMil) })),
  };
}
