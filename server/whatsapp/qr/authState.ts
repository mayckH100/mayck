import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { prisma } from '../../db.js';
import { encrypt, decrypt } from '../../lib/crypto.js';

/**
 * Estado de autenticação do Baileys guardado no banco (tabela WaAuthState),
 * cifrado com AES-256-GCM (MASTER_KEY). Substitui o useMultiFileAuthState,
 * que grava em disco — o disco do Render Free é efêmero.
 */

const CREDS = 'creds';

/** Serializa gravações por canal para evitar corrida de upsert na mesma chave. */
const chains = new Map<string, Promise<unknown>>();
function serialize<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(channelId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(channelId, next.catch(() => undefined));
  return next;
}

const seal = (value: unknown) => encrypt(JSON.stringify(value, BufferJSON.replacer));
const open = (enc: string) => JSON.parse(decrypt(enc), BufferJSON.reviver);

async function upsert(channelId: string, type: string, keyId: string, value: unknown) {
  const dataEnc = seal(value);
  await prisma.waAuthState.upsert({
    where: { channelId_type_keyId: { channelId, type, keyId } },
    create: { channelId, type, keyId, dataEnc },
    update: { dataEnc },
  });
}

export async function hasSavedSession(channelId: string): Promise<boolean> {
  const row = await prisma.waAuthState.findUnique({ where: { channelId_type_keyId: { channelId, type: CREDS, keyId: '' } } });
  if (!row) return false;
  try {
    const creds = open(row.dataEnc) as AuthenticationCreds;
    return !!creds.me?.id;
  } catch {
    return false;
  }
}

export async function clearAuthState(channelId: string) {
  await serialize(channelId, () => prisma.waAuthState.deleteMany({ where: { channelId } }));
}

export async function useDbAuthState(channelId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  // Espera gravações pendentes (ex.: credenciais salvas logo após ler o QR, antes do restart 515).
  await (chains.get(channelId) ?? Promise.resolve());
  const row = await prisma.waAuthState.findUnique({ where: { channelId_type_keyId: { channelId, type: CREDS, keyId: '' } } });
  let creds: AuthenticationCreds;
  try {
    creds = row ? (open(row.dataEnc) as AuthenticationCreds) : initAuthCreds();
  } catch {
    // Dado ilegível (ex.: MASTER_KEY trocada): recomeça com um novo pareamento.
    await clearAuthState(channelId);
    creds = initAuthCreds();
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (!ids.length) return out;
        const rows = await prisma.waAuthState.findMany({ where: { channelId, type, keyId: { in: ids } } });
        for (const r of rows) {
          try {
            let v = open(r.dataEnc);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[r.keyId] = v;
          } catch {
            /* chave ilegível é tratada como ausente */
          }
        }
        return out;
      },
      set: async (data) =>
        serialize(channelId, async () => {
          for (const [type, entries] of Object.entries(data)) {
            for (const [keyId, value] of Object.entries(entries ?? {})) {
              if (value) await upsert(channelId, type, keyId, value);
              else await prisma.waAuthState.deleteMany({ where: { channelId, type, keyId } });
            }
          }
        }),
      clear: async () => clearAuthState(channelId),
    },
  };

  return {
    state,
    saveCreds: () => serialize(channelId, () => upsert(channelId, CREDS, '', state.creds)),
  };
}
