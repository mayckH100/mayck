import { jidDecode } from '@whiskeysockets/baileys';
import { prisma } from '../../db.js';

/**
 * Agenda do celular conectado (modo QR).
 *
 * O WhatsApp sincroniza com o aparelho vinculado os contatos salvos na agenda do celular
 * (app-state "contactAction": nome completo salvo, número e LID). O Baileys entrega isso no
 * evento `contacts.upsert` — que só vem dessa sincronização (o nome que a pessoa colocou no
 * próprio perfil, pushName/notify, chega por `contacts.update` e NÃO conta como "salvo").
 *
 * Guardamos só o fato "está salvo" por canal, para o número (dígitos) e para o LID — nunca o nome.
 * Assim um contato que escreve por LID e outro que escreve pelo número caem no mesmo registro.
 */

export interface PhoneContactUpdate {
  id: string;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
}

/** Chave de um JID de usuário: número → só dígitos; LID → "lid:<id>". Grupos e outros → null. */
export function phoneContactKey(jid: string | null | undefined): string | null {
  if (!jid) return null;
  if (/^\d{6,20}$/.test(jid)) return jid;
  const d = jidDecode(jid);
  if (!d?.user) return null;
  if (d.server === 's.whatsapp.net' || d.server === 'c.us' || d.server === 'hosted') return /^\d{6,20}$/.test(d.user) ? d.user : null;
  if (d.server === 'lid' || d.server === 'hosted.lid') return /^\d{1,30}$/.test(d.user) ? `lid:${d.user}` : null;
  return null;
}

/** waId do contato (dígitos ou JID @lid) → chave da agenda. */
export function contactWaIdKey(waId: string): string | null {
  return phoneContactKey(waId.includes('@') ? waId : waId.replace(/\D/g, ''));
}

/** waId correspondente a uma chave (para marcar o Contact): dígitos ou "<id>@lid". */
function keyToWaId(key: string): string {
  return key.startsWith('lid:') ? `${key.slice(4)}@lid` : key;
}

/**
 * Converte um lote de contatos sincronizados em (chave → salvo?).
 * Só entra o que trouxe o campo `name` (sincronização da agenda): com nome = salvo; sem nome
 * (contato apagado da agenda) = não salvo. Atualizações só com pushName/notify são ignoradas.
 */
export function phoneContactEntries(contacts: Partial<PhoneContactUpdate>[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const c of contacts) {
    if (!c || !('name' in c)) continue;
    const saved = typeof c.name === 'string' && c.name.trim() !== '';
    for (const jid of [c.id, c.lid, c.phoneNumber]) {
      const k = phoneContactKey(jid ?? null);
      if (k) out.set(k, saved);
    }
  }
  return out;
}

const CHUNK = 200;

/**
 * Grava a agenda sincronizada do canal e atualiza o indicador `savedInPhone` dos contatos da empresa.
 * Retorna quantas chaves foram gravadas.
 */
export async function applyPhoneContacts(channelId: string, orgId: string | null, contacts: Partial<PhoneContactUpdate>[]): Promise<number> {
  const entries = [...phoneContactEntries(contacts)];
  if (!entries.length) return 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const part = entries.slice(i, i + CHUNK);
    await prisma.$transaction(part.map(([jidKey, saved]) => prisma.waPhoneContact.upsert({
      where: { channelId_jidKey: { channelId, jidKey } },
      create: { channelId, jidKey, saved },
      update: { saved },
    })));
    if (orgId) {
      const savedIds = part.filter(([, s]) => s).map(([k]) => keyToWaId(k));
      const unsavedIds = part.filter(([, s]) => !s).map(([k]) => keyToWaId(k));
      if (savedIds.length) await prisma.contact.updateMany({ where: { orgId, waId: { in: savedIds }, savedInPhone: false }, data: { savedInPhone: true } });
      if (unsavedIds.length) await prisma.contact.updateMany({ where: { orgId, waId: { in: unsavedIds }, savedInPhone: true }, data: { savedInPhone: false } });
    }
  }
  return entries.length;
}

/**
 * O contato está salvo na agenda do celular deste canal? Confere todas as identidades conhecidas
 * (número e LID). O gerenciador completa o par número↔LID (lidMapping) antes de gravar, então
 * apagar o contato da agenda desmarca as duas chaves.
 */
export async function isSavedInPhone(channelId: string, jids: (string | null | undefined)[]): Promise<boolean> {
  const keys = [...new Set(jids.map((j) => (j ? (j.includes('@') ? phoneContactKey(j) : contactWaIdKey(j)) : null)).filter((k): k is string => !!k))];
  if (!keys.length) return false;
  const rows = await prisma.waPhoneContact.findMany({ where: { channelId, jidKey: { in: keys } }, select: { saved: true } });
  return rows.some((r) => r.saved);
}

export async function countSavedPhoneContacts(channelId: string): Promise<number> {
  return prisma.waPhoneContact.count({ where: { channelId, saved: true, NOT: { jidKey: { startsWith: 'lid:' } } } });
}
