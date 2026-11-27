/** v1.56.0: busca no banco (sempre da mesma empresa) o que o score e a inadimplência precisam. */
import { prisma } from '../../db.js';
import { calcularScore, PEDIDO_NAO_CONTA, type ScoreCliente, type TituloScore } from './score.js';

/** Score de cada cliente pedido (ou de todos os clientes da empresa, sem `ids`). */
export async function scoresDosClientes(orgId: string, ids?: string[], agora = new Date()): Promise<Map<string, ScoreCliente>> {
  const filtroParceiro = ids ? { in: ids } : { not: null };
  const [titulos, pedidos] = await Promise.all([
    prisma.erpTitulo.findMany({
      where: { orgId, tipo: 'RECEBER', status: { not: 'CANCELADO' }, parceiroId: filtroParceiro as any },
      select: { parceiroId: true, valorCents: true, pagoCents: true, status: true, vencimento: true, baixas: { where: { estornada: false }, select: { data: true } } },
    }),
    prisma.erpPedidoVenda.findMany({
      where: { orgId, statusOperacional: { notIn: PEDIDO_NAO_CONTA }, ...(ids ? { parceiroId: { in: ids } } : {}) },
      select: { parceiroId: true, createdAt: true },
    }),
  ]);
  const T = new Map<string, TituloScore[]>(); const C = new Map<string, Date[]>();
  for (const t of titulos) { if (!t.parceiroId) continue; const l = T.get(t.parceiroId) ?? []; l.push({ ...t, baixas: t.baixas.map((b) => b.data) }); T.set(t.parceiroId, l); }
  for (const p of pedidos) { const l = C.get(p.parceiroId) ?? []; l.push(p.createdAt); C.set(p.parceiroId, l); }
  const todos = ids ?? [...new Set([...T.keys(), ...C.keys()])];
  return new Map(todos.map((id) => [id, calcularScore(T.get(id) ?? [], C.get(id) ?? [], agora)]));
}
