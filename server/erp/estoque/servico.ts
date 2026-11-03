/**
 * Serviço de estoque (com banco). Regras:
 *  - todo movimento físico grava ErpMovimento na mesma transação;
 *  - reserva e saída usam UPDATE atômico condicionado ao disponível, então dois pedidos simultâneos
 *    nunca reservam o mesmo saldo (no Postgres há ainda CHECK >= 0 na migração).
 */
import type { Prisma } from '@prisma/client';
import { HttpError } from '../../lib/http.js';
import { planejarAlocacao, novoCustoMedio, type SaldoLinha } from './saldo.js';

type Tx = Prisma.TransactionClient;
export class EstoqueErro extends HttpError { constructor(msg: string) { super(400, msg); } }

export const LOTE_UNICO = 'UNICO';

export async function garantirLote(tx: Tx, orgId: string, produtoId: string, l: { numero?: string | null; validade?: Date | null; fabricacao?: Date | null; status?: string; origemTipo?: string; origemId?: string | null }) {
  const numero = (l.numero || LOTE_UNICO).trim().toUpperCase();
  const existente = await tx.erpLote.findUnique({ where: { orgId_produtoId_numero: { orgId, produtoId, numero } } });
  if (existente) return existente;
  return tx.erpLote.create({ data: { orgId, produtoId, numero, validade: l.validade ?? null, fabricacao: l.fabricacao ?? null, status: l.status ?? 'LIBERADO', origemTipo: l.origemTipo ?? null, origemId: l.origemId ?? null } });
}

async function produtoDa(tx: Tx, orgId: string, produtoId: string) {
  const p = await tx.erpProduto.findFirst({ where: { id: produtoId, orgId } });
  if (!p) throw new EstoqueErro('Produto não encontrado');
  if (p.tipo === 'SERVICO') throw new EstoqueErro('Serviço não controla estoque');
  return p;
}

export interface MovBase { orgId: string; docTipo?: string | null; docId?: string | null; motivo?: string | null; userId?: string | null; correlationId?: string | null }

/** Entrada (compra, produção, ajuste positivo, saldo inicial). Atualiza o custo médio. */
export async function entrada(tx: Tx, e: MovBase & { produtoId: string; enderecoId: string; qtdMil: number; custoUnitCents?: number; tipo?: string;
  lote?: { numero?: string | null; validade?: Date | null; fabricacao?: Date | null; status?: string } }) {
  if (e.qtdMil <= 0) throw new EstoqueErro('Quantidade deve ser maior que zero');
  const produto = await produtoDa(tx, e.orgId, e.produtoId);
  if (produto.controlaLote && !e.lote?.numero) throw new EstoqueErro('Este produto controla lote: informe o número do lote');
  if (produto.controlaValidade && !e.lote?.validade) throw new EstoqueErro('Este produto controla validade: informe a data');
  const end = await tx.erpEnderecoEstoque.findFirst({ where: { id: e.enderecoId, orgId: e.orgId, ativo: true } });
  if (!end) throw new EstoqueErro('Endereço de estoque inválido');
  const lote = await garantirLote(tx, e.orgId, e.produtoId, { ...e.lote, origemTipo: e.docTipo ?? 'ajuste', origemId: e.docId });
  const quarentena = lote.status !== 'LIBERADO';

  const totalAntes = await tx.erpSaldo.aggregate({ where: { orgId: e.orgId, produtoId: e.produtoId }, _sum: { fisicoMil: true } });
  const custo = e.custoUnitCents ?? produto.custoMedioCents;
  await tx.erpProduto.update({ where: { id: produto.id }, data: { custoMedioCents: novoCustoMedio(totalAntes._sum.fisicoMil ?? 0, produto.custoMedioCents, e.qtdMil, custo) } });

  const saldo = await tx.erpSaldo.upsert({
    where: { produtoId_loteId_enderecoId: { produtoId: e.produtoId, loteId: lote.id, enderecoId: e.enderecoId } },
    create: { orgId: e.orgId, produtoId: e.produtoId, loteId: lote.id, enderecoId: e.enderecoId, fisicoMil: e.qtdMil, quarentenaMil: quarentena ? e.qtdMil : 0 },
    update: { fisicoMil: { increment: e.qtdMil }, ...(quarentena ? { quarentenaMil: { increment: e.qtdMil } } : {}) },
  });
  await tx.erpMovimento.create({ data: { orgId: e.orgId, produtoId: e.produtoId, loteId: lote.id, enderecoId: e.enderecoId, tipo: e.tipo ?? 'ENTRADA', qtdMil: e.qtdMil, custoUnitCents: custo, saldoAposMil: saldo.fisicoMil, docTipo: e.docTipo ?? null, docId: e.docId ?? null, motivo: e.motivo ?? null, userId: e.userId ?? null, correlationId: e.correlationId ?? null } });
  return { saldo, lote };
}

/** Saída física direta de um saldo (ajuste negativo, transferência). Nunca consome o que está reservado ou em quarentena. */
export async function saidaDoSaldo(tx: Tx, e: MovBase & { saldoId: string; qtdMil: number; tipo: string }) {
  if (e.qtdMil <= 0) throw new EstoqueErro('Quantidade deve ser maior que zero');
  const n = await tx.$executeRaw`UPDATE "ErpSaldo" SET "fisicoMil" = "fisicoMil" - ${e.qtdMil} WHERE "id" = ${e.saldoId} AND "orgId" = ${e.orgId} AND "fisicoMil" - "reservadoMil" - "quarentenaMil" >= ${e.qtdMil}`;
  if (!n) throw new EstoqueErro('Saldo disponível insuficiente (parte pode estar reservada ou em quarentena)');
  const s = await tx.erpSaldo.findUniqueOrThrow({ where: { id: e.saldoId } });
  const p = await tx.erpProduto.findUniqueOrThrow({ where: { id: s.produtoId } });
  await tx.erpMovimento.create({ data: { orgId: e.orgId, produtoId: s.produtoId, loteId: s.loteId, enderecoId: s.enderecoId, tipo: e.tipo, qtdMil: -e.qtdMil, custoUnitCents: p.custoMedioCents, saldoAposMil: s.fisicoMil, docTipo: e.docTipo ?? null, docId: e.docId ?? null, motivo: e.motivo ?? null, userId: e.userId ?? null, correlationId: e.correlationId ?? null } });
  return s;
}

export async function transferir(tx: Tx, e: MovBase & { saldoId: string; enderecoDestinoId: string; qtdMil: number }) {
  const origem = await saidaDoSaldo(tx, { ...e, tipo: 'TRANSFERENCIA_SAIDA' });
  const lote = await tx.erpLote.findUniqueOrThrow({ where: { id: origem.loteId } });
  const p = await tx.erpProduto.findUniqueOrThrow({ where: { id: origem.produtoId } });
  return entrada(tx, { ...e, produtoId: origem.produtoId, enderecoId: e.enderecoDestinoId, qtdMil: e.qtdMil, custoUnitCents: p.custoMedioCents, tipo: 'TRANSFERENCIA_ENTRADA', lote: { numero: lote.numero, validade: lote.validade, status: lote.status } });
}

/** Coloca/retira um lote da quarentena (inspeção de qualidade). */
export async function mudarStatusLote(tx: Tx, orgId: string, loteId: string, status: 'LIBERADO' | 'QUARENTENA' | 'BLOQUEADO', userId?: string | null) {
  const lote = await tx.erpLote.findFirst({ where: { id: loteId, orgId } });
  if (!lote) throw new EstoqueErro('Lote não encontrado');
  if (lote.status === status) return lote;
  const saldos = await tx.erpSaldo.findMany({ where: { orgId, loteId } });
  if (status !== 'LIBERADO' && saldos.some((s) => s.reservadoMil > 0)) throw new EstoqueErro('Lote tem reservas de pedidos: libere as reservas antes de bloquear');
  for (const s of saldos) {
    const q = status === 'LIBERADO' ? 0 : s.fisicoMil;
    if (q === s.quarentenaMil) continue;
    await tx.erpSaldo.update({ where: { id: s.id }, data: { quarentenaMil: q } });
    await tx.erpMovimento.create({ data: { orgId, produtoId: s.produtoId, loteId, enderecoId: s.enderecoId, tipo: status === 'LIBERADO' ? 'LIBERACAO' : 'QUARENTENA', qtdMil: 0, saldoAposMil: s.fisicoMil, docTipo: 'lote', docId: loteId, motivo: `Lote ${lote.numero}: ${lote.status} → ${status}`, userId: userId ?? null } });
  }
  return tx.erpLote.update({ where: { id: loteId }, data: { status } });
}

export async function saldosParaSaida(tx: Tx, orgId: string, produtoId: string, depositoId?: string | null): Promise<SaldoLinha[]> {
  const rows = await tx.erpSaldo.findMany({ where: { orgId, produtoId, fisicoMil: { gt: 0 } } });
  if (!rows.length) return [];
  const [lotes, ends] = await Promise.all([
    tx.erpLote.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.loteId))] } } }),
    depositoId ? tx.erpEnderecoEstoque.findMany({ where: { depositoId, orgId } }) : Promise.resolve(null),
  ]);
  const lMap = new Map(lotes.map((l) => [l.id, l]));
  const permitidos = ends ? new Set(ends.map((e) => e.id)) : null;
  return rows.filter((r) => !permitidos || permitidos.has(r.enderecoId)).map((r) => ({ ...r, lote: lMap.get(r.loteId)! }));
}

/**
 * Reserva a quantidade que ainda falta em cada item do pedido (FEFO/FIFO do produto).
 * Retorna quanto faltou por item; 0 em todos = pedido totalmente reservado.
 */
export async function reservarPedido(tx: Tx, orgId: string, pedidoId: string, depositoId?: string | null) {
  const itens = await tx.erpPedidoItem.findMany({ where: { pedidoId } });
  const faltas: { itemId: string; produtoId: string; faltaMil: number }[] = [];
  for (const item of itens) {
    const produto = await tx.erpProduto.findUniqueOrThrow({ where: { id: item.produtoId } });
    if (produto.tipo === 'SERVICO') continue;
    let resta = item.qtdMil - item.reservadoMil;
    for (let tentativa = 0; tentativa < 3 && resta > 0; tentativa++) {
      const plano = planejarAlocacao(await saldosParaSaida(tx, orgId, item.produtoId, depositoId), resta, produto.regraSaida);
      if (!plano.alocacoes.length) break;
      for (const a of plano.alocacoes) {
        const n = await tx.$executeRaw`UPDATE "ErpSaldo" SET "reservadoMil" = "reservadoMil" + ${a.qtdMil} WHERE "id" = ${a.saldoId} AND "fisicoMil" - "reservadoMil" - "quarentenaMil" >= ${a.qtdMil}`;
        if (!n) continue; // outro pedido pegou antes: replaneja na próxima volta
        await tx.erpReserva.create({ data: { orgId, pedidoItemId: item.id, saldoId: a.saldoId, produtoId: item.produtoId, loteId: a.loteId, enderecoId: a.enderecoId, qtdMil: a.qtdMil } });
        resta -= a.qtdMil;
      }
    }
    await tx.erpPedidoItem.update({ where: { id: item.id }, data: { reservadoMil: item.qtdMil - resta } });
    if (resta > 0) faltas.push({ itemId: item.id, produtoId: item.produtoId, faltaMil: resta });
  }
  return faltas;
}

/** Libera as reservas ativas do pedido (cancelamento). */
export async function liberarReservas(tx: Tx, pedidoId: string) {
  const itens = await tx.erpPedidoItem.findMany({ where: { pedidoId }, select: { id: true } });
  const reservas = await tx.erpReserva.findMany({ where: { pedidoItemId: { in: itens.map((i) => i.id) }, status: 'ATIVA' } });
  for (const r of reservas) {
    await tx.$executeRaw`UPDATE "ErpSaldo" SET "reservadoMil" = "reservadoMil" - ${r.qtdMil} WHERE "id" = ${r.saldoId} AND "reservadoMil" >= ${r.qtdMil}`;
    await tx.erpReserva.update({ where: { id: r.id }, data: { status: 'LIBERADA' } });
  }
  await tx.erpPedidoItem.updateMany({ where: { pedidoId }, data: { reservadoMil: 0, separadoMil: 0 } });
  return reservas.length;
}

/** Faturamento: baixa física do que foi reservado e separado (saída com movimento por lote). */
export async function baixarReservas(tx: Tx, e: MovBase & { pedidoId: string }) {
  const itens = await tx.erpPedidoItem.findMany({ where: { pedidoId: e.pedidoId }, select: { id: true } });
  const reservas = await tx.erpReserva.findMany({ where: { pedidoItemId: { in: itens.map((i) => i.id) }, status: 'ATIVA' } });
  for (const r of reservas) {
    const n = await tx.$executeRaw`UPDATE "ErpSaldo" SET "fisicoMil" = "fisicoMil" - ${r.qtdMil}, "reservadoMil" = "reservadoMil" - ${r.qtdMil} WHERE "id" = ${r.saldoId} AND "reservadoMil" >= ${r.qtdMil} AND "fisicoMil" >= ${r.qtdMil}`;
    if (!n) throw new EstoqueErro('Saldo reservado inconsistente: confira o inventário antes de faturar');
    const s = await tx.erpSaldo.findUniqueOrThrow({ where: { id: r.saldoId } });
    const p = await tx.erpProduto.findUniqueOrThrow({ where: { id: r.produtoId } });
    await tx.erpMovimento.create({ data: { orgId: e.orgId, produtoId: r.produtoId, loteId: r.loteId, enderecoId: r.enderecoId, tipo: 'SAIDA', qtdMil: -r.qtdMil, custoUnitCents: p.custoMedioCents, saldoAposMil: s.fisicoMil, docTipo: 'pedido_venda', docId: e.pedidoId, motivo: e.motivo ?? null, userId: e.userId ?? null, correlationId: e.correlationId ?? null } });
    await tx.erpReserva.update({ where: { id: r.id }, data: { status: 'BAIXADA' } });
  }
  return reservas.length;
}

/**
 * Conferência por leitura do QR/código: o código lido é o número do lote (ou SKU/código de barras para produto sem lote).
 * Só aceita o lote que o FEFO/FIFO reservou, para o picking não furar a regra.
 */
export async function conferir(tx: Tx, orgId: string, pedidoId: string, codigo: string, qtdMil: number) {
  const cod = codigo.trim().toUpperCase();
  if (qtdMil <= 0) throw new EstoqueErro('Quantidade deve ser maior que zero');
  const itens = await tx.erpPedidoItem.findMany({ where: { pedidoId } });
  const produtos = await tx.erpProduto.findMany({ where: { id: { in: itens.map((i) => i.produtoId) } } });
  const reservas = await tx.erpReserva.findMany({ where: { pedidoItemId: { in: itens.map((i) => i.id) }, status: 'ATIVA' } });
  const lotes = await tx.erpLote.findMany({ where: { id: { in: reservas.map((r) => r.loteId) } } });
  const loteDe = new Map(lotes.map((l) => [l.id, l]));
  const prodDe = new Map(produtos.map((p) => [p.id, p]));
  const casa = reservas.filter((r) => {
    const l = loteDe.get(r.loteId)!; const p = prodDe.get(r.produtoId)!;
    return l.numero === cod || (l.numero === LOTE_UNICO && (p.sku.toUpperCase() === cod || p.codigoBarras === codigo.trim()));
  });
  if (!casa.length) {
    const lotesEsperados = reservas.filter((r) => r.separadoMil < r.qtdMil).map((r) => loteDe.get(r.loteId)!.numero).filter((n) => n !== LOTE_UNICO);
    throw new EstoqueErro(`Código ${codigo} não pertence a este pedido${lotesEsperados.length ? `. Separe o(s) lote(s): ${[...new Set(lotesEsperados)].join(', ')}` : ''}`);
  }
  let resta = qtdMil;
  for (const r of casa) {
    const livre = r.qtdMil - r.separadoMil;
    if (livre <= 0 || resta <= 0) continue;
    const q = Math.min(livre, resta);
    await tx.erpReserva.update({ where: { id: r.id }, data: { separadoMil: { increment: q } } });
    await tx.erpPedidoItem.update({ where: { id: r.pedidoItemId }, data: { separadoMil: { increment: q } } });
    resta -= q;
  }
  if (resta === qtdMil) throw new EstoqueErro('Este lote já foi todo conferido');
  if (resta > 0) throw new EstoqueErro('Quantidade lida maior que a reservada para este lote');
  const atual = await tx.erpPedidoItem.findMany({ where: { pedidoId } });
  const servicos = new Set(produtos.filter((p) => p.tipo === 'SERVICO').map((p) => p.id));
  return { tudoSeparado: atual.every((i) => servicos.has(i.produtoId) || i.separadoMil >= i.qtdMil) };
}
