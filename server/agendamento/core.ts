/**
 * v1.46.0 — Página pública de agendamento (/agendar/:slug): funções puras (sem banco).
 * Horários livres de um dia a partir do horário de atendimento da Agenda, da duração do serviço e dos compromissos já marcados.
 */
import { hhmmToMin, zonedParts, zonedToUtc } from '../agenda/time.js';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const SLUGS_RESERVADOS = new Set(['admin', 'api', 'mck', 'mckbot', 'login', 'cadastro', 'empresa', 'agenda', 'teste', 'novo']);

/** "Clínica São José & Cia" → "clinica-sao-jose-cia" (3–40 caracteres). */
export function slugify(nome: string): string {
  const s = String(nome ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s.length >= 3 ? s : `empresa-${s || 'mck'}`.slice(0, 40);
}

export function validarSlug(raw: string): { slug: string } | { erro: string } {
  const slug = String(raw ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return { erro: 'Endereço inválido: use de 3 a 40 letras minúsculas, números e hífen (sem acento nem espaço).' };
  if (SLUGS_RESERVADOS.has(slug)) return { erro: 'Esse endereço é reservado. Escolha outro.' };
  return { slug };
}

export interface Expediente { workStart: string; workEnd: string; workDays: number[]; minNoticeMin: number }
export interface Ocupado { start: Date; end: Date }

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-24" → partes; nulo se inválido. */
export function lerDia(dia: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dia ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Passo entre horários: 15 min para serviços curtos, senão 30. */
export const passoMin = (duracao: number) => (duracao < 30 ? 15 : 30);

/** Horários livres (instantes UTC) de um dia local, para um serviço de `duracao` minutos. */
export function horariosDoDia(dia: string, duracao: number, exp: Expediente, ocupados: Ocupado[], tz: string, agora: Date, maxDiasFrente: number): Date[] {
  const p = lerDia(dia);
  if (!p || duracao < 5) return [];
  const meioDia = zonedToUtc(p.y, p.m, p.d, 12, 0, tz);
  const semana = zonedParts(meioDia, tz).weekday;
  if (!exp.workDays.includes(semana)) return [];
  const limite = new Date(agora.getTime() + maxDiasFrente * 24 * 3600e3);
  const cedo = new Date(agora.getTime() + exp.minNoticeMin * 60_000);
  const ini = hhmmToMin(exp.workStart);
  const fim = hhmmToMin(exp.workEnd);
  const out: Date[] = [];
  for (let m = ini; m + duracao <= fim; m += passoMin(duracao)) {
    const t = zonedToUtc(p.y, p.m, p.d, Math.floor(m / 60), m % 60, tz);
    if (t < cedo || t > limite) continue;
    const e = new Date(t.getTime() + duracao * 60_000);
    if (ocupados.some((b) => b.start < e && t < b.end)) continue;
    out.push(t);
  }
  return out;
}

/** Próximos dias (YYYY-MM-DD no fuso) em que a empresa atende, até `maxDias` à frente. */
export function diasDeAtendimento(exp: Pick<Expediente, 'workDays'>, tz: string, agora: Date, maxDias: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= maxDias; i++) {
    const z = zonedParts(new Date(agora.getTime() + i * 24 * 3600e3), tz);
    const iso = `${z.year}-${pad(z.month)}-${pad(z.day)}`;
    if (exp.workDays.includes(z.weekday) && !out.includes(iso)) out.push(iso);
  }
  return out;
}

/** "14:30" no fuso. */
export function horaLocal(d: Date, tz: string): string {
  const z = zonedParts(d, tz);
  return `${pad(z.hour)}:${pad(z.minute)}`;
}

/** Preço em centavos → "R$ 45,00" (nulo = sem preço). */
export function precoBr(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/** Nome do cliente: 2–80 caracteres, sem links. */
export function validarNome(raw: string): string | null {
  const n = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 80 || /https?:|www\.|<|>/i.test(n)) return null;
  return n;
}

/** Robô? Campo escondido preenchido ou formulário enviado rápido demais (menos de 3 s). */
export function pareceRobo(honeypot: unknown, msDesdeAbrir: unknown): boolean {
  if (typeof honeypot === 'string' && honeypot.trim()) return true;
  const ms = Number(msDesdeAbrir);
  return Number.isFinite(ms) && ms >= 0 && ms < 3000;
}
