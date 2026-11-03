/**
 * Barramento de eventos do ERP (Transactional Outbox), sem serviço pago:
 * 1) emitir() grava o evento na MESMA transação da mudança;
 * 2) o despachante lê os pendentes, entrega a cada consumidor registrado e marca processado;
 * 3) ErpEventoConsumo (eventoId+consumidor único) garante idempotência;
 * 4) falha → retentativa com backoff; após MAX_TENTATIVAS vai para FALHOU (fila morta), reprocessável.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';

type Tx = Prisma.TransactionClient | PrismaClient;
export interface EventoDominio { id: string; orgId: string; tipo: string; agregado: string; agregadoId: string; correlationId: string | null; payload: Record<string, unknown> }
export type Consumidor = (ev: EventoDominio, tx: Prisma.TransactionClient) => Promise<void>;

export const MAX_TENTATIVAS = 6;
const consumidores = new Map<string, { nome: string; fn: Consumidor }[]>();

/** Registra um consumidor para um tipo de evento ('*' = todos). Nome único = chave de idempotência. */
export function consumir(tipo: string, nome: string, fn: Consumidor) {
  const lista = consumidores.get(tipo) ?? [];
  if (!lista.some((c) => c.nome === nome)) lista.push({ nome, fn });
  consumidores.set(tipo, lista);
}

export async function emitir(tx: Tx, e: { orgId: string; tipo: string; agregado: string; agregadoId: string; correlationId?: string | null; payload?: Record<string, unknown> }) {
  return tx.erpEvento.create({
    data: { orgId: e.orgId, tipo: e.tipo, agregado: e.agregado, agregadoId: e.agregadoId, correlationId: e.correlationId ?? null, payload: JSON.stringify(e.payload ?? {}) },
  });
}

export const backoffMs = (tentativa: number) => Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, tentativa - 1));

/** Processa um lote de eventos pendentes. Retorna quantos foram processados com sucesso. */
export async function despachar(limite = 50, agora = new Date()): Promise<number> {
  const pendentes = await prisma.erpEvento.findMany({ where: { status: 'PENDENTE', proximaTentativa: { lte: agora } }, orderBy: { createdAt: 'asc' }, take: limite });
  let ok = 0;
  for (const row of pendentes) {
    // Claim otimista: só um despachante pega o evento (funciona em Postgres e SQLite).
    const claim = await prisma.erpEvento.updateMany({ where: { id: row.id, status: 'PENDENTE', tentativas: row.tentativas }, data: { tentativas: { increment: 1 } } });
    if (claim.count === 0) continue;
    const ev: EventoDominio = { ...row, payload: safeJson(row.payload) };
    const lista = [...(consumidores.get(row.tipo) ?? []), ...(consumidores.get('*') ?? [])];
    try {
      for (const c of lista) {
        await prisma.$transaction(async (tx) => {
          const ja = await tx.erpEventoConsumo.findUnique({ where: { eventoId_consumidor: { eventoId: row.id, consumidor: c.nome } } });
          if (ja) return;
          await c.fn(ev, tx);
          await tx.erpEventoConsumo.create({ data: { eventoId: row.id, consumidor: c.nome } });
        });
      }
      await prisma.erpEvento.update({ where: { id: row.id }, data: { status: 'PROCESSADO', processadoEm: new Date(), ultimoErro: null } });
      ok++;
    } catch (err) {
      const tentativas = row.tentativas + 1;
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await prisma.erpEvento.update({
        where: { id: row.id },
        data: tentativas >= MAX_TENTATIVAS
          ? { status: 'FALHOU', ultimoErro: msg }
          : { proximaTentativa: new Date(agora.getTime() + backoffMs(tentativas)), ultimoErro: msg },
      });
    }
  }
  return ok;
}

/** Reenvia um evento da fila morta. */
export async function reprocessar(orgId: string, id: string) {
  return prisma.erpEvento.updateMany({ where: { id, orgId, status: 'FALHOU' }, data: { status: 'PENDENTE', tentativas: 0, proximaTentativa: new Date() } });
}

/** Dispara o despachante logo depois da resposta (sem esperar o intervalo). */
export function despacharEmBreve() {
  if (process.env.NODE_ENV === 'test') return;
  setImmediate(() => { despachar().catch((e) => console.error('[erp] despachante', e instanceof Error ? e.message : e)); });
}

let timer: NodeJS.Timeout | null = null;
export function iniciarDespachante(intervaloMs = 30_000) {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => { despachar().catch((e) => console.error('[erp] despachante', e instanceof Error ? e.message : e)); }, intervaloMs);
  timer.unref?.();
}

function safeJson(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
