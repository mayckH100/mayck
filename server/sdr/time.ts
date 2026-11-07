import { safeTz, zonedParts, zonedToUtc } from '../agenda/time.js';

/** Início do dia (00:00) no fuso da empresa, em UTC. */
export function startOfDayIn(now: Date, tz?: string | null): Date {
  const z = safeTz(tz ?? undefined);
  const p = zonedParts(now, z);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, z);
}
