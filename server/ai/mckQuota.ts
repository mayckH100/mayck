/**
 * MCK IA: cota diária de respostas por organização, conforme o plano.
 *
 * Conta as respostas com sucesso da MCK IA (AiUsage com provider 'mck') desde a meia-noite de Brasília.
 * Ao atingir a cota, a IA não chama nenhum provedor: segue a política de falha (texto de falha ao cliente,
 * sem transferir) e o Proprietário vê "limite diário da MCK IA atingido".
 *
 * Plano (pelas assinaturas):
 *  - teste: sem produto pago ativo (período de teste, vencido etc.)  → MCK_IA_DAILY_TRIAL  (padrão 30)
 *  - pago:  um produto pago ativo (MCKBOT ou MCK Mensagens)            → MCK_IA_DAILY_PAID   (padrão 300)
 *  - completo: os dois produtos pagos ativos (Plano Completo)          → MCK_IA_DAILY_COMBO  (padrão 600)
 * Valor 0 = sem limite para aquele plano.
 */
import { prisma } from '../db.js';
import { effectiveStatus } from '../billing/service.js';

export type MckTier = 'teste' | 'pago' | 'completo';
export const MCK_TIER_LABEL: Record<MckTier, string> = { teste: 'Teste', pago: 'Plano pago', completo: 'Plano Completo' };

/** Mensagem simples para o Proprietário (nunca vai para o cliente final). */
export const MCK_QUOTA_REASON = 'Limite diário da MCK IA atingido; volta amanhã ou use sua própria chave';

type Env = Record<string, string | undefined>;
const DEFAULTS: Record<MckTier, number> = { teste: 30, pago: 300, completo: 600 };
const ENV_KEY: Record<MckTier, string> = { teste: 'MCK_IA_DAILY_TRIAL', pago: 'MCK_IA_DAILY_PAID', completo: 'MCK_IA_DAILY_COMBO' };

/** Respostas por dia para o plano (0 = sem limite). */
export function mckDailyLimit(tier: MckTier, env: Env = process.env): number {
  const raw = env[ENV_KEY[tier]];
  const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : DEFAULTS[tier];
}

/** Puro: plano a partir das assinaturas. */
export function tierFromSubscriptions(subs: { product: string; status: string; validUntil: Date }[], now = new Date()): MckTier {
  const paid = new Set(subs.filter((s) => effectiveStatus(s, now) === 'ATIVA').map((s) => s.product));
  if (paid.has('MCKBOT') && paid.has('MCKMENSAGEM')) return 'completo';
  return paid.size > 0 ? 'pago' : 'teste';
}

export async function mckTierOf(orgId: string, now = new Date()): Promise<MckTier> {
  const subs = await prisma.subscription.findMany({ where: { orgId }, select: { product: true, status: true, validUntil: true } });
  return tierFromSubscriptions(subs, now);
}

/** Meia-noite (America/Sao_Paulo) do dia de `now`, em UTC. */
export function spDayStart(now = new Date()): Date {
  const day = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const base = new Date(`${day}T12:00:00Z`);
  const local = new Date(base.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  return new Date(new Date(`${day}T00:00:00Z`).getTime() - (local.getTime() - base.getTime()));
}

export interface MckQuota { tier: MckTier; tierLabel: string; limit: number; used: number; remaining: number | null; reached: boolean; percent: number | null }

/** Puro: monta a situação da cota. */
export function quotaView(tier: MckTier, used: number, limit: number): MckQuota {
  const unlimited = limit === 0;
  return {
    tier, tierLabel: MCK_TIER_LABEL[tier], limit, used,
    remaining: unlimited ? null : Math.max(0, limit - used),
    reached: !unlimited && used >= limit,
    percent: unlimited ? null : Math.min(100, Math.round((used / limit) * 100)),
  };
}

/** v1.27.2: organizações sem cota da MCK IA (env MCK_IA_UNLIMITED_ORGS, ids separados por vírgula). */
export function mckUnlimitedOrg(orgId: string, env: Env = process.env): boolean {
  return (env.MCK_IA_UNLIMITED_ORGS ?? '').split(/[\s,;]+/).filter(Boolean).includes(orgId);
}

export async function mckQuotaStatus(orgId: string, now = new Date()): Promise<MckQuota> {
  if (mckUnlimitedOrg(orgId)) {
    const tier = await mckTierOf(orgId, now);
    return quotaView(tier, 0, 0);
  }
  const [tier, used] = await Promise.all([
    mckTierOf(orgId, now),
    prisma.aiUsage.count({ where: { orgId, provider: 'mck', success: true, createdAt: { gte: spDayStart(now) } } }),
  ]);
  return quotaView(tier, used, mckDailyLimit(tier));
}

/** Já houve bloqueio por cota hoje nesta organização? (o aviso ao Proprietário sai só no primeiro). */
export async function mckQuotaHitToday(orgId: string, now = new Date()): Promise<boolean> {
  const n = await prisma.aiUsage.count({ where: { orgId, provider: 'mck', success: false, error: MCK_QUOTA_REASON, createdAt: { gte: spDayStart(now) } } });
  return n > 0;
}

/** Linha de uso vista pelo cliente: na MCK IA, nunca mostra qual provedor/modelo respondeu. */
export function clientUsageRow<T extends { provider: string; model: string; error?: string | null }>(r: T): T {
  if (r.provider !== 'mck') return r;
  const leaks = !!r.error && /gemini|groq|openrouter|llama|google|openai|meta-/i.test(r.error);
  return { ...r, provider: 'MCK IA', model: '', error: leaks ? 'MCK IA indisponível no momento' : r.error ?? null };
}

/** Provedor que respondeu, a partir do modelo gravado ("mck-ia/gemini:modelo" → "gemini"). Só para o Master. */
export function providerOfModel(model: string): string {
  const i = model.indexOf('/');
  if (i < 0) return 'não registrado';
  return model.slice(i + 1).split(':')[0] || 'não registrado';
}

export interface MckUsageRow {
  orgId: string; orgName: string; usesMckIa: boolean; tier: MckTier; tierLabel: string; limit: number;
  today: { responses: number; failures: number; quotaBlocks: number; percent: number | null };
  week: { responses: number; failures: number; quotaBlocks: number };
  providers: Record<string, number>; lastError: string | null; lastAt: string | null;
}

/**
 * Painel Master: uso da MCK IA por empresa (hoje e últimos 7 dias). Inclui quem está com a MCK IA
 * selecionada mesmo sem uso. Detalhe de provedor só aqui (rota do superadmin).
 */
export async function mckUsageReport(now = new Date()) {
  const today = spDayStart(now);
  const weekStart = new Date(today.getTime() - 6 * 86_400_000);
  const [rows, selected] = await Promise.all([
    prisma.aiUsage.findMany({ where: { provider: 'mck', createdAt: { gte: weekStart } }, select: { orgId: true, success: true, error: true, model: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
    prisma.aiSettings.findMany({ where: { provider: 'mck' }, select: { orgId: true } }),
  ]);
  const ids = [...new Set([...rows.map((r) => r.orgId), ...selected.map((s) => s.orgId)])];
  const [orgs, subs] = await Promise.all([
    prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.subscription.findMany({ where: { orgId: { in: ids } }, select: { orgId: true, product: true, status: true, validUntil: true } }),
  ]);
  const sel = new Set(selected.map((s) => s.orgId));
  const names = new Map(orgs.map((o) => [o.id, o.name]));
  const out = new Map<string, MckUsageRow>();
  for (const id of ids) {
    const tier = tierFromSubscriptions(subs.filter((s) => s.orgId === id), now);
    out.set(id, {
      orgId: id, orgName: names.get(id) ?? '(empresa excluída)', usesMckIa: sel.has(id), tier, tierLabel: MCK_TIER_LABEL[tier], limit: mckDailyLimit(tier),
      today: { responses: 0, failures: 0, quotaBlocks: 0, percent: null }, week: { responses: 0, failures: 0, quotaBlocks: 0 },
      providers: {}, lastError: null, lastAt: null,
    });
  }
  for (const r of rows) {
    const o = out.get(r.orgId)!;
    const isToday = r.createdAt >= today;
    const quota = !r.success && r.error === MCK_QUOTA_REASON;
    const k = r.success ? 'responses' : quota ? 'quotaBlocks' : 'failures';
    o.week[k]++;
    if (isToday) o.today[k]++;
    if (r.success) { const p = providerOfModel(r.model); o.providers[p] = (o.providers[p] ?? 0) + 1; }
    else o.lastError = (r.error ?? '').slice(0, 300) || null;
    o.lastAt = r.createdAt.toISOString();
  }
  const items = [...out.values()].map((o) => ({ ...o, today: { ...o.today, percent: quotaView(o.tier, o.today.responses, o.limit).percent } }))
    .sort((a, b) => b.today.responses - a.today.responses || b.week.responses - a.week.responses || a.orgName.localeCompare(b.orgName));
  const sum = (f: (o: MckUsageRow) => number) => items.reduce((a, o) => a + f(o), 0);
  return {
    limits: { teste: mckDailyLimit('teste'), pago: mckDailyLimit('pago'), completo: mckDailyLimit('completo') },
    totals: { today: sum((o) => o.today.responses), todayFailures: sum((o) => o.today.failures), week: sum((o) => o.week.responses), weekFailures: sum((o) => o.week.failures), atLimit: items.filter((o) => o.limit > 0 && o.today.responses >= o.limit).length },
    items,
  };
}
