/**
 * Busca por texto sem diferenciar maiúsculas/minúsculas nos dois bancos.
 * SQLite (testes/dev): `contains` já ignora caixa (LIKE). PostgreSQL (produção): `contains` diferencia caixa,
 * então "caneta" não achava "Canetack" — precisa de `mode: 'insensitive'` (que o SQLite não aceita).
 */
import { prisma } from '../db.js';

export function bancoPostgres(): boolean {
  const p = (prisma as unknown as { _activeProvider?: string; _engineConfig?: { activeProvider?: string } });
  return (p._activeProvider ?? p._engineConfig?.activeProvider) === 'postgresql';
}

/** Filtro "contém" que ignora maiúsculas/minúsculas (use em `where: { nome: contem(q) }`). */
export function contem(q: string, postgres = bancoPostgres()): { contains: string } {
  return (postgres ? { contains: q, mode: 'insensitive' } : { contains: q }) as { contains: string };
}
