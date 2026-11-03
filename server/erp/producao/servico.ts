/** Estoque da produção: reserva de componentes da OP, consumo (backflush) com genealogia de lotes e liberação. */
import type { Prisma } from '@prisma/client';
import { EstoqueErro, saldosParaSaida } from '../estoque/servico.js';
import { planejarAlocacao } from '../estoque/saldo.js';

type Tx = Prisma.TransactionClient;

/** Reserva o que falta do componente (FEFO/FIFO). Retorna a falta. */
export async function reservarComponente(tx: Tx, orgId: string, comp: { id: string; produtoId: string; qtdPrevistaMil: number; qtdReservadaMil: number; qtdConsumidaMil: number }, depositoId?: string | null) {
  const produto = await tx.erpProduto.findUniqueOrThrow({ where: { id: comp.produtoId } });
  let resta = comp.qtdPrevistaMil - comp.qtdReservadaMil - comp.qtdConsumidaMil;
  let reservado = 0;
  for (let t = 0; t < 3 && resta > 0; t++) {
    const plano = planejarAlocacao(await saldosParaSaida(tx, orgId, comp.produtoId, depositoId), resta, produto.regraSaida);
    if (!plano.alocacoes.length) break;
    for (const a of plano.alocacoes) {
      const n = await tx.$executeRaw`UPDATE "ErpSaldo" SET "reservadoMil" = "reservadoMil" + ${a.qtdMil} WHERE "id" = ${a.saldoId} AND "fisicoMil" - "reservadoMil" - "quarentenaMil" >= ${a.qtdMil}`;
      if (!n) continue;
      await tx.erpReserva.create({ data: { orgId, pedidoItemId: comp.id, origemTipo: 'op', saldoId: a.saldoId, produtoId: comp.produtoId, loteId: a.loteId, enderecoId: a.enderecoId, qtdMil: a.qtdMil } });
      resta -= a.qtdMil; reservado += a.qtdMil;
    }
  }
  await tx.erpOpComponente.update({ where: { id: comp.id }, data: { qtdReservadaMil: { increment: reservado } } });
  return Math.max(0, resta);
}

export async function liberarReservasOp(tx: Tx, compIds: string[]) {
  const rs = await tx.erpReserva.findMany({ where: { pedidoItemId: { in: compIds }, origemTipo: 'op', status: 'ATIVA' } });
  for (const r of rs) {
    await tx.$executeRaw`UPDATE "ErpSaldo" SET "reservadoMil" = "reservadoMil" - ${r.qtdMil} WHERE "id" = ${r.saldoId} AND "reservadoMil" >= ${r.qtdMil}`;
    await tx.erpReserva.update({ where: { id: r.id }, data: { status: 'LIBERADA' } });
  }
  await tx.erpOpComponente.updateMany({ where: { id: { in: compIds } }, data: { qtdReservadaMil: 0 } });
}

/**
 * Consome qtdMil do componente: primeiro das reservas da OP (FEFO por validade), depois de saldo livre (sobreconsumo).
 * Devolve os lotes usados e o custo total consumido.
 */
export async function consumirComponente(tx: Tx, e: { orgId: string; opId: string; compId: string; produtoId: string; qtdMil: number; userId?: string | null; motivo: string }) {
  const produto = await tx.erpProduto.findUniqueOrThrow({ where: { id: e.produtoId } });
  const lotes = new Set<string>();
  let resta = e.qtdMil;
  const reservas = await tx.erpReserva.findMany({ where: { pedidoItemId: e.compId, origemTipo: 'op', status: 'ATIVA' }, orderBy: { createdAt: 'asc' } });
  const mover = async (saldoId: string, loteId: string, enderecoId: string, q: number, daReserva: boolean) => {
    const n = daReserva
      ? await tx.$executeRaw`UPDATE "ErpSaldo" SET "fisicoMil" = "fisicoMil" - ${q}, "reservadoMil" = "reservadoMil" - ${q} WHERE "id" = ${saldoId} AND "reservadoMil" >= ${q} AND "fisicoMil" >= ${q}`
      : await tx.$executeRaw`UPDATE "ErpSaldo" SET "fisicoMil" = "fisicoMil" - ${q} WHERE "id" = ${saldoId} AND "fisicoMil" - "reservadoMil" - "quarentenaMil" >= ${q}`;
    if (!n) throw new EstoqueErro(`Saldo de ${produto.sku} mudou durante o apontamento: tente de novo`);
    const s = await tx.erpSaldo.findUniqueOrThrow({ where: { id: saldoId } });
    await tx.erpMovimento.create({ data: { orgId: e.orgId, produtoId: e.produtoId, loteId, enderecoId, tipo: 'CONSUMO', qtdMil: -q, custoUnitCents: produto.custoMedioCents, saldoAposMil: s.fisicoMil, docTipo: 'op', docId: e.opId, motivo: e.motivo, userId: e.userId ?? null } });
    lotes.add(loteId);
  };
  for (const r of reservas) {
    if (resta <= 0) break;
    const q = Math.min(resta, r.qtdMil);
    await mover(r.saldoId, r.loteId, r.enderecoId, q, true);
    await tx.erpReserva.update({ where: { id: r.id }, data: r.qtdMil - q > 0 ? { qtdMil: r.qtdMil - q, separadoMil: { increment: q } } : { status: 'BAIXADA', separadoMil: { increment: q } } });
    resta -= q;
  }
  const daReserva = e.qtdMil - resta;
  if (resta > 0) {
    const plano = planejarAlocacao(await saldosParaSaida(tx, e.orgId, e.produtoId), resta, produto.regraSaida);
    if (plano.faltaMil > 0) throw new EstoqueErro(`Falta ${plano.faltaMil / 1000} ${produto.unidade} de ${produto.sku} para este apontamento`);
    for (const a of plano.alocacoes) await mover(a.saldoId, a.loteId, a.enderecoId, a.qtdMil, false);
  }
  await tx.erpOpComponente.update({ where: { id: e.compId }, data: { qtdConsumidaMil: { increment: e.qtdMil }, qtdReservadaMil: { decrement: daReserva } } });
  return { lotes: [...lotes], custoCents: Math.round((e.qtdMil * produto.custoMedioCents) / 1000) };
}
