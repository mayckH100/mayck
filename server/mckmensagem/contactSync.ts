import type { Contact, Lead, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';

/**
 * Contatos do MCKBOT ↔ contatos (leads) do MCK Mensagens.
 *
 * A pessoa é uma só: o Contact do MCKBOT é a fonte do nome, do telefone e do opt-out; o Lead é a "ficha de
 * marketing" dela no MCK Mensagens (status, campanha, consentimento, etiquetas de campanha, IA de qualificação),
 * ligada pelo contactId. A ligação é feita pelo telefone normalizado (E.164) dentro da organização: se já existe
 * um lead com o mesmo número, ele é vinculado e mesclado — nunca se cria um segundo.
 *
 * Contato que vem do MCKBOT entra com consentimento PENDENTE (consentSource "MCKBOT", consentAt vazio): aparece na
 * lista, pode ser colocado em campanhas, mas o disparador só envia depois que o consentimento é registrado
 * (LGPD/regras do WhatsApp). Opt-out do contato vira opt-out do lead (e vice-versa).
 *
 * Nada aqui pode derrubar o MCKBOT: as chamadas a partir das rotas do MCKBOT usam safe*(), que só registram o erro.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type ContactLite = Pick<Contact, 'id' | 'orgId' | 'waId' | 'name' | 'tags' | 'optOut'>;

/** Origem do lead criado a partir de um contato do MCKBOT (consentimento pendente). */
export const MCKBOT_CONSENT_SOURCE = 'MCKBOT';
const MAX_TAGS = 30;

/** Telefone E.164 do contato; null para grupos/LID (waId com "@" ou fora de 10–15 dígitos). */
export function leadPhoneOfWaId(waId: string): string | null {
  return /^\d{10,15}$/.test(waId) ? '+' + waId : null;
}

const tagsOf = (s: string | null | undefined) => parseJson<unknown[]>(s, []).filter((t): t is string => typeof t === 'string' && !!t.trim());

/** União sem repetir (ignorando maiúsculas), mantendo a grafia que já estava. */
function unionTags(base: string[], extra: string[]): string[] {
  const out = [...base];
  const seen = new Set(base.map((t) => t.toLowerCase()));
  for (const t of extra) if (!seen.has(t.toLowerCase())) { out.push(t); seen.add(t.toLowerCase()); }
  return out.slice(0, MAX_TAGS);
}
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

export interface SyncOptions {
  /** Consentimento declarado na origem (ex.: importação do MCKBOT com a caixa "autorizaram receber mensagens"). */
  consent?: { source: string; at: Date };
}

/**
 * Garante que cada contato tenha o seu lead no MCK Mensagens (cria ou vincula/mescla pelo telefone).
 * Idempotente. Lead existente: liga ao contato, preenche nome vazio, soma etiquetas, aplica opt-out do contato e,
 * se houver consentimento declarado e o lead ainda não tiver, registra. Nunca apaga dados do lead.
 */
export async function syncContactsToLeads(orgId: string, contacts: ContactLite[], opts: SyncOptions = {}, db: Db = prisma): Promise<{ created: number; linked: number }> {
  let created = 0, linked = 0;
  const now = new Date();
  const valid = contacts.filter((c) => c.orgId === orgId && leadPhoneOfWaId(c.waId));
  for (let i = 0; i < valid.length; i += 500) {
    const part = valid.slice(i, i + 500);
    const phones = part.map((c) => leadPhoneOfWaId(c.waId)!);
    const leads = await db.lead.findMany({ where: { orgId, OR: [{ phone: { in: phones } }, { contactId: { in: part.map((c) => c.id) } }] } });
    const byContact = new Map(leads.filter((l) => l.contactId).map((l) => [l.contactId!, l]));
    const byPhone = new Map(leads.map((l) => [l.phone, l]));
    const toCreate: Prisma.LeadCreateManyInput[] = [];
    for (const c of part) {
      const phone = leadPhoneOfWaId(c.waId)!;
      const lead = byContact.get(c.id) ?? byPhone.get(phone);
      if (lead) {
        if (await mergeIntoLead(db, lead, c, opts, now)) linked++;
        continue;
      }
      toCreate.push({
        orgId, phone, name: c.name || null, tags: JSON.stringify(unionTags([], tagsOf(c.tags))), status: 'NOVO',
        consentSource: (opts.consent && !c.optOut) ? opts.consent.source : MCKBOT_CONSENT_SOURCE, consentAt: (opts.consent && !c.optOut) ? opts.consent.at : null,
        optOutAt: c.optOut ? now : null, contactId: c.id,
      });
    }
    if (!toCreate.length) continue;
    try {
      created += (await db.lead.createMany({ data: toCreate })).count;
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      // Alguém criou um lead com o mesmo número no meio do caminho: um a um, mesclando o que já existir.
      for (const d of toCreate) {
        try { await db.lead.create({ data: d }); created++; } catch (err: any) {
          if (err?.code !== 'P2002') throw err;
          const ex = await db.lead.findUnique({ where: { orgId_phone: { orgId, phone: d.phone } } });
          const c = part.find((x) => x.id === d.contactId)!;
          if (ex && (await mergeIntoLead(db, ex, c, opts, now))) linked++;
        }
      }
    }
  }
  return { created, linked };
}

async function mergeIntoLead(db: Db, lead: Lead, c: ContactLite, opts: SyncOptions, now: Date): Promise<boolean> {
  const data: Prisma.LeadUpdateInput = {};
  if (lead.contactId !== c.id) data.contactId = c.id;
  if (!lead.name && c.name) data.name = c.name;
  const cur = tagsOf(lead.tags);
  const merged = unionTags(cur, tagsOf(c.tags));
  if (!sameList(cur, merged)) data.tags = JSON.stringify(merged);
  if (c.optOut && !lead.optOutAt) data.optOutAt = now;
  if (opts.consent && !lead.consentAt && !c.optOut && !lead.optOutAt) { data.consentAt = opts.consent.at; data.consentSource = opts.consent.source; }
  if (!Object.keys(data).length) return false;
  await db.lead.update({ where: { id: lead.id }, data });
  return true;
}

/** Backfill de uma organização (ou de todas): o mesmo que a migração 0026 faz uma única vez no deploy. */
export async function backfillContactsToLeads(orgId?: string, db: Db = prisma): Promise<{ created: number; linked: number }> {
  const orgs = orgId ? [orgId] : (await db.contact.findMany({ distinct: ['orgId'], select: { orgId: true } })).map((o) => o.orgId);
  let created = 0, linked = 0;
  for (const o of orgs) {
    let cursor: string | undefined;
    for (;;) {
      const batch = await db.contact.findMany({ where: { orgId: o }, orderBy: { id: 'asc' }, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, orgId: true, waId: true, name: true, tags: true, optOut: true } });
      if (!batch.length) break;
      const r = await syncContactsToLeads(o, batch, {}, db);
      created += r.created; linked += r.linked;
      cursor = batch[batch.length - 1].id;
    }
  }
  return { created, linked };
}

/**
 * Contato editado no MCKBOT → atualiza o lead vinculado: nome, telefone (se o novo número não for de outro lead),
 * etiquetas adicionadas/removidas e opt-out. Não recria um lead que foi excluído no MCK Mensagens — exceto quando o
 * contato acabou de ganhar um telefone (antes era só LID).
 */
export async function onContactUpdated(before: ContactLite, after: ContactLite, db: Db = prisma): Promise<void> {
  const orgId = after.orgId;
  const oldPhone = leadPhoneOfWaId(before.waId);
  const newPhone = leadPhoneOfWaId(after.waId);
  const or: Prisma.LeadWhereInput[] = [{ contactId: after.id }];
  if (oldPhone) or.push({ phone: oldPhone, contactId: null });
  const leads = await db.lead.findMany({ where: { orgId, OR: or } });
  if (!leads.length) {
    if (!oldPhone && newPhone) await syncContactsToLeads(orgId, [after], {}, db);
    return;
  }
  const beforeTags = tagsOf(before.tags), afterTags = tagsOf(after.tags);
  const low = (a: string[]) => new Set(a.map((t) => t.toLowerCase()));
  const added = afterTags.filter((t) => !low(beforeTags).has(t.toLowerCase()));
  const removed = low(beforeTags.filter((t) => !low(afterTags).has(t.toLowerCase())));
  for (const lead of leads) {
    const data: Prisma.LeadUpdateInput = {};
    if (lead.contactId !== after.id) data.contactId = after.id;
    if ((after.name || null) !== (before.name || null)) data.name = after.name || null;
    if (newPhone && newPhone !== lead.phone && newPhone !== oldPhone) {
      const taken = await db.lead.findUnique({ where: { orgId_phone: { orgId, phone: newPhone } } });
      if (!taken) data.phone = newPhone;
    }
    if (added.length || removed.size) {
      const cur = tagsOf(lead.tags);
      const next = unionTags(cur.filter((t) => !removed.has(t.toLowerCase())), added);
      if (!sameList(cur, next)) data.tags = JSON.stringify(next);
    }
    if (after.optOut !== before.optOut) data.optOutAt = after.optOut ? (lead.optOutAt ?? new Date()) : null;
    else if (after.optOut && !lead.optOutAt) data.optOutAt = new Date();
    if (Object.keys(data).length) await db.lead.update({ where: { id: lead.id }, data });
  }
}

/**
 * Exclusão LGPD do contato no MCKBOT: apaga também o lead dele no MCK Mensagens (e o histórico de envio) e desfaz o
 * vínculo com clientes de Automações/Cobranças (o cadastro financeiro do cliente continua). Para usar na transação.
 */
export function contactDeletionOps(c: Pick<Contact, 'id' | 'orgId' | 'waId'>, leadIds: string[]) {
  return [
    prisma.campaignRecipient.deleteMany({ where: { leadId: { in: leadIds } } }),
    prisma.lead.deleteMany({ where: { orgId: c.orgId, id: { in: leadIds } } }),
    prisma.cliente.updateMany({ where: { orgId: c.orgId, contactId: c.id }, data: { contactId: null } }),
  ];
}

/** Leads (da organização) que são a mesma pessoa do contato: vinculados ou com o mesmo telefone. */
export async function leadIdsOfContact(c: Pick<Contact, 'id' | 'orgId' | 'waId'>, db: Db = prisma): Promise<string[]> {
  const phone = leadPhoneOfWaId(c.waId);
  const or: Prisma.LeadWhereInput[] = [{ contactId: c.id }];
  if (phone) or.push({ phone });
  return (await db.lead.findMany({ where: { orgId: c.orgId, OR: or }, select: { id: true } })).map((l) => l.id);
}

/** Lead criado/importado no MCK Mensagens: liga ao contato do MCKBOT de mesmo telefone, se existir. */
export async function contactIdForPhone(orgId: string, phone: string, db: Db = prisma): Promise<string | null> {
  const waId = phone.replace(/\D/g, '');
  const c = await db.contact.findUnique({ where: { orgId_waId: { orgId, waId } }, select: { id: true } });
  return c?.id ?? null;
}

/** Opt-out / nome alterados no MCK Mensagens valem também para o contato do MCKBOT (mesma pessoa). */
export async function mirrorLeadsToContacts(orgId: string, contactIds: (string | null)[], data: { optOut?: boolean; name?: string | null }, db: Db = prisma): Promise<void> {
  const ids = [...new Set(contactIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  const upd: Prisma.ContactUpdateManyMutationInput = {};
  if (data.optOut !== undefined) upd.optOut = data.optOut;
  if (data.name !== undefined) upd.name = data.name;
  if (!Object.keys(upd).length) return;
  for (let i = 0; i < ids.length; i += 500) await db.contact.updateMany({ where: { orgId, id: { in: ids.slice(i, i + 500) } }, data: upd });
}

/** Versões que nunca lançam erro (chamadas pelo MCKBOT: a sincronização não pode derrubar o atendimento). */
export async function safeSyncContactsToLeads(orgId: string, contacts: ContactLite[], opts: SyncOptions = {}) {
  try { return await syncContactsToLeads(orgId, contacts, opts); } catch (e) { console.error('[contatos→mck mensagens] falha ao sincronizar', e); return { created: 0, linked: 0 }; }
}
export async function safeOnContactUpdated(before: ContactLite, after: ContactLite) {
  try { await onContactUpdated(before, after); } catch (e) { console.error('[contatos→mck mensagens] falha ao atualizar lead', e); }
}
