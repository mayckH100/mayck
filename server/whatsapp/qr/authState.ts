import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import type { Prisma } from '@prisma/client';
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

function upsertOp(channelId: string, type: string, keyId: string, value: unknown) {
  const dataEnc = seal(value);
  return prisma.waAuthState.upsert({
    where: { channelId_type_keyId: { channelId, type, keyId } },
    create: { channelId, type, keyId, dataEnc },
    update: { dataEnc },
  });
}

async function upsert(channelId: string, type: string, keyId: string, value: unknown) {
  await upsertOp(channelId, type, keyId, value);
}

/**
 * Aguarda todas as gravações pendentes de chaves/credenciais do canal (ou de todos os canais).
 * Usado antes de reconectar e no desligamento (SIGTERM) para nunca perder uma chave do Signal:
 * chave perdida = o celular do cliente não consegue decifrar = "Aguardando mensagem".
 */
export async function flushAuthState(channelId?: string): Promise<void> {
  const pending = channelId ? [chains.get(channelId)] : [...chains.values()];
  await Promise.all(pending.map((p) => (p ?? Promise.resolve()).catch(() => undefined)));
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
      // Lote atômico: ou todas as chaves do lote são gravadas, ou nenhuma (transação no banco).
      // O Baileys aguarda esta promessa antes de considerar a chave salva.
      set: async (data) =>
        serialize(channelId, async () => {
          const build = () => {
            const ops: Prisma.PrismaPromise<unknown>[] = [];
            for (const [type, entries] of Object.entries(data)) {
              for (const [keyId, value] of Object.entries(entries ?? {})) {
                ops.push(value ? upsertOp(channelId, type, keyId, value) : prisma.waAuthState.deleteMany({ where: { channelId, type, keyId } }));
              }
            }
            return ops;
          };
          if (!Object.values(data).some((e) => e && Object.keys(e).length)) return;
          let lastErr: unknown;
          for (let tentativa = 0; tentativa < 3; tentativa++) {
            try {
              await prisma.$transaction(build());
              return;
            } catch (e) {
              lastErr = e;
              await new Promise((r) => setTimeout(r, 200 * (tentativa + 1)));
            }
          }
          throw lastErr;
        }),
      clear: async () => clearAuthState(channelId),
    },
  };

  return {
    state,
    saveCreds: () => serialize(channelId, () => upsert(channelId, CREDS, '', state.creds)),
  };
}
