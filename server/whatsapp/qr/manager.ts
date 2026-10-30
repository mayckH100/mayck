import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
  type AnyMessageContent, type WAMessage, type WAMessageUpdate, type ConnectionState, type WAVersion,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { prisma } from '../../db.js';
import { useDbAuthState, clearAuthState, hasSavedSession, flushAuthState } from './authState.js';
import { acquireLease, renewLease, releaseLease } from './lease.js';
import { saveSent, loadSent, pruneSent } from './sentStore.js';
import { describeEvent, recordDeliveryEvent } from './deliveryLog.js';
import { PAIRING_CODE_TTL_MS, formatPairingCode, maskPhone } from './pairing.js';
import { HttpError } from '../../lib/http.js';
import { parseBaileysMessage, mapBaileysStatus, buildQrContent, waIdToJid, jidToNumber } from './parse.js';
import type { OutboundPayload } from '../cloudClient.js';

export type QrStatus = 'NOT_CONNECTED' | 'CONNECTING' | 'QR_PENDING' | 'CONNECTED' | 'ERROR';

/** Subconjunto do socket do Baileys usado aqui (facilita testes com socket simulado). */
export interface QrSocket {
  sendMessage(jid: string, content: AnyMessageContent): Promise<{ key?: { id?: string | null }; message?: unknown } | undefined>;
  logout?(msg?: string): Promise<void>;
  end?(error: Error | undefined): void;
  /** Código de pareamento (Conectar com número de telefone). Só antes de registrar o aparelho. */
  requestPairingCode?(phoneNumber: string): Promise<string>;
  user?: { id: string } | null;
}

/**
 * Mensagens enviadas recentemente, por id. Quando o celular do cliente não consegue decifrar
 * uma mensagem ("Aguardando mensagem"), ele pede reenvio e o Baileys chama getMessage:
 * sem este cache o reenvio falha e a mensagem fica presa em "Aguardando mensagem".
 */
const SENT_CACHE_MAX = 5000;
const sentCache = new Map<string, unknown>();
export function rememberSent(id: string, message: unknown) {
  if (!id || !message) return;
  sentCache.delete(id);
  sentCache.set(id, message);
  while (sentCache.size > SENT_CACHE_MAX) sentCache.delete(sentCache.keys().next().value as string);
}
export function recallSent(id: string | null | undefined) { return id ? sentCache.get(id) : undefined; }
/** Contador de tentativas de reenvio compartilhado entre reconexões (evita loop de retry). */
const retryCounts = new Map<string, unknown>();
const msgRetryCounterCache = {
  get: <T>(k: string) => retryCounts.get(k) as T | undefined,
  set: <T>(k: string, v: T) => { retryCounts.set(k, v); if (retryCounts.size > 5000) retryCounts.delete(retryCounts.keys().next().value as string); },
  del: (k: string) => { retryCounts.delete(k); },
  flushAll: () => { retryCounts.clear(); },
};

interface Session {
  channelId: string;
  sock: QrSocket | null;
  status: QrStatus;
  qr: string | null;
  qrDataUrl: string | null;
  attempts: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  generation: number;
  phone: string | null;
  lastError: string | null;
  /** Pronto para enviar: conexão aberta E notificações pendentes processadas (sessões do Signal em dia). */
  ready: boolean;
  readyTimer: NodeJS.Timeout | null;
  leaseTimer: NodeJS.Timeout | null;
  waitingLease: boolean;
  orgId: string | null;
  /** Código de pareamento ativo neste socket (o código em si nunca fica guardado aqui nem vai para log). */
  pairing: { expiresAt: number; phone: string } | null;
}

const isTest = () => process.env.NODE_ENV === 'test';
/** Intervalo mínimo entre duas mensagens para o MESMO contato (evita rajadas que embaralham a criptografia). */
const sendGapMs = () => Number(process.env.QR_SEND_GAP_MS ?? (isTest() ? 0 : 800));
/** Quanto o envio espera a conexão voltar (ex.: reconectando, instância acordando) antes de falhar. */
const sendWaitMs = () => Number(process.env.QR_SEND_WAIT_MS ?? (isTest() ? 0 : 25_000));
const READY_FALLBACK_MS = 4000;
const LEASE_RETRY_MS = 5000;
const LEASE_RENEW_MS = 20_000;
/** Quanto o pedido de código espera o socket novo ficar pronto para parear. */
const pairWaitMs = () => Number(process.env.QR_PAIR_WAIT_MS ?? (isTest() ? 300 : 25_000));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, timeoutMs: number, stepMs = 200) {
  const end = Date.now() + timeoutMs;
  while (!cond() && Date.now() < end) await sleep(stepMs);
  return cond();
}

/** Logger mínimo compatível com o ILogger do Baileys: só registra erros relevantes. */
const silentLogger = {
  level: 'error',
  child() { return silentLogger; },
  trace() {}, debug() {}, info() {}, warn() {},
  error(obj: unknown, msg?: string) { if (process.env.NODE_ENV !== 'test') console.error('[whatsapp-qr]', msg ?? '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 500) : obj); },
};

/**
 * Logger por canal: além dos erros, captura os avisos do Baileys sobre reenvio (retry) e falha
 * de descriptografia e os registra na Auditoria por contato (medição do "Aguardando mensagem").
 */
export function channelLogger(channelId: string, orgId: () => string | null) {
  const watch = (obj: unknown, msg?: string) => {
    const ev = describeEvent(obj, typeof msg === 'string' ? msg : undefined);
    if (ev) recordDeliveryEvent(channelId, orgId(), ev).catch(() => undefined);
  };
  const logger = {
    level: 'debug',
    child() { return logger; },
    trace() {},
    debug: watch,
    info: watch,
    warn: watch,
    error(obj: unknown, msg?: string) {
      watch(obj, msg);
      if (msg === 'failed to decrypt message') return; // já registrado como evento (evita poluir o log)
      silentLogger.error(obj, msg);
    },
  };
  return logger;
}

const MAX_DELAY_MS = 5 * 60_000;
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, 2000 * 2 ** Math.max(0, attempt - 1));
}

let cachedVersion: WAVersion | null = null;
async function waVersion(): Promise<WAVersion | undefined> {
  if (cachedVersion) return cachedVersion;
  try {
    const r = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    cachedVersion = r.version;
    return r.version;
  } catch {
    return undefined; // usa a versão padrão embutida no Baileys
  }
}

type InboundHandler = (channelId: string, msg: WAMessage) => Promise<void>;
type StatusHandler = (channelId: string, update: WAMessageUpdate) => Promise<void>;

class QrSessionManager {
  private sessions = new Map<string, Session>();
  private onInbound: InboundHandler | null = null;
  private onStatus: StatusHandler | null = null;

  setHandlers(h: { inbound: InboundHandler; status: StatusHandler }) {
    this.onInbound = h.inbound;
    this.onStatus = h.status;
  }

  private session(channelId: string): Session {
    let s = this.sessions.get(channelId);
    if (!s) {
      s = { channelId, sock: null, status: 'NOT_CONNECTED', qr: null, qrDataUrl: null, attempts: 0, timer: null, stopped: true, generation: 0, phone: null, lastError: null, ready: false, readyTimer: null, leaseTimer: null, waitingLease: false, orgId: null, pairing: null };
      this.sessions.set(channelId, s);
    }
    return s;
  }

  private async persist(channelId: string, data: Record<string, unknown>) {
    await prisma.channel.update({ where: { id: channelId }, data }).catch(() => undefined);
  }

  /** Estado atual para a API (QR como data URL PNG). */
  info(channelId: string) {
    const s = this.sessions.get(channelId);
    const pairing = s && !s.stopped && s.status !== 'CONNECTED' && s.pairing ? { expiresAt: new Date(s.pairing.expiresAt).toISOString(), phone: s.pairing.phone } : null;
    return { live: !!s && !s.stopped, status: s?.status ?? null, qr: s?.status === 'QR_PENDING' && !pairing ? s.qrDataUrl : null, phone: s?.phone ?? null, lastError: s?.lastError ?? null, pairing };
  }

  isConnected(channelId: string) {
    const s = this.sessions.get(channelId);
    return !!s && s.status === 'CONNECTED' && !!s.sock;
  }

  /** Conectado ou reconectando (o envio espera a conexão voltar em vez de falhar na hora). */
  canSend(channelId: string) {
    const s = this.sessions.get(channelId);
    if (!s) return false;
    if (s.status === 'CONNECTED' && s.sock) return true;
    return !s.stopped && s.status === 'CONNECTING' && sendWaitMs() > 0;
  }

  /** Inicia (ou reinicia) a conexão de um canal. Idempotente se já estiver ativo. */
  async start(channelId: string, opts: { force?: boolean } = {}) {
    const s = this.session(channelId);
    // Voltando do "Código pelo número" para o QR: descarta o código pendente e abre um socket novo.
    if (s.pairing && s.status !== 'CONNECTED') { s.pairing = null; opts = { ...opts, force: true }; }
    if (!s.stopped && s.sock && !opts.force) return this.info(channelId);
    s.stopped = false;
    s.attempts = 0;
    s.lastError = null;
    await this.connect(s);
    return this.info(channelId);
  }

  private clearTimer(s: Session) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
  }

  private clearLeaseTimer(s: Session) {
    if (s.leaseTimer) clearInterval(s.leaseTimer);
    s.leaseTimer = null;
    if (s.readyTimer) clearTimeout(s.readyTimer);
    s.readyTimer = null;
  }

  /** Renova a trava enquanto a sessão estiver ativa; se outra instância assumiu, encerra este socket. */
  private startLeaseRenewal(s: Session, gen: number) {
    if (s.leaseTimer) clearInterval(s.leaseTimer);
    s.leaseTimer = setInterval(() => {
      if (gen !== s.generation || s.stopped) return;
      renewLease(s.channelId).then((ok) => {
        if (ok || gen !== s.generation || s.stopped) return;
        console.warn(`[whatsapp-qr] canal ${s.channelId}: outra instância assumiu a sessão; encerrando esta conexão`);
        const sock = s.sock;
        s.generation++;
        s.sock = null;
        s.ready = false;
        try { sock?.end?.(undefined); } catch { /* ignora */ }
        flushAuthState(s.channelId).finally(() => this.connect(s).catch((e) => this.scheduleRetry(s, (e as Error).message)));
      }).catch(() => undefined); // banco fora do ar: mantém a trava atual até expirar
    }, LEASE_RENEW_MS);
    s.leaseTimer.unref?.();
  }

  private async connect(s: Session) {
    this.clearTimer(s);
    const gen = ++s.generation;
    const old = s.sock;
    s.sock = null;
    s.ready = false;
    try { old?.end?.(undefined); } catch { /* ignora */ }

    s.status = 'CONNECTING';
    s.qr = null;
    s.qrDataUrl = null;
    s.pairing = null;

    // Trava única: nunca abrir a mesma sessão em duas instâncias (deploy do Render) ao mesmo tempo.
    let leased = false;
    try { leased = await acquireLease(s.channelId); } catch (e) { this.scheduleRetry(s, `Falha ao verificar a trava da sessão: ${(e as Error).message}`); return; }
    if (gen !== s.generation || s.stopped) return;
    if (!leased) {
      if (!s.waitingLease) console.log(`[whatsapp-qr] canal ${s.channelId}: aguardando a instância anterior liberar a sessão`);
      s.waitingLease = true;
      s.lastError = 'Aguardando a instância anterior do servidor liberar a sessão (atualização em andamento).';
      await this.persist(s.channelId, { status: 'CONNECTING', lastError: s.lastError });
      this.clearTimer(s);
      s.timer = setTimeout(() => { if (!s.stopped && gen === s.generation) this.connect(s).catch((e) => this.scheduleRetry(s, (e as Error).message)); }, LEASE_RETRY_MS);
      s.timer.unref?.();
      return;
    }
    if (s.waitingLease) { s.waitingLease = false; s.lastError = null; }
    this.startLeaseRenewal(s, gen);
    await this.persist(s.channelId, { status: 'CONNECTING' });
    if (s.orgId === null) {
      const ch = await prisma.channel.findUnique({ where: { id: s.channelId }, select: { orgId: true } }).catch(() => null);
      s.orgId = ch?.orgId ?? null;
    }
    pruneSent().catch(() => undefined);
    const logger = channelLogger(s.channelId, () => s.orgId);

    let sock: ReturnType<typeof makeWASocket>;
    try {
      // Garante que a conexão anterior terminou de gravar as chaves antes de lê-las de novo.
      await flushAuthState(s.channelId);
      const { state, saveCreds } = await useDbAuthState(s.channelId);
      const version = await waVersion();
      sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
        logger: logger as never,
        browser: Browsers.ubuntu('MCKBOT'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => {
          // Reenvio pedido pelo celular do cliente ("Aguardando mensagem"):
          // 1) cache em memória; 2) mensagem completa salva no banco (mídia, documento, menu — igual à original);
          // 3) mensagens antigas (antes desta versão): só o texto.
          const cached = recallSent(key.id);
          if (cached) return cached as never;
          if (!key.id) return undefined;
          const full = await loadSent(s.channelId, key.id).catch(() => undefined);
          if (full) return full as never;
          const m = await prisma.message.findFirst({ where: { channelId: s.channelId, waMessageId: key.id, direction: 'OUT' }, select: { body: true } }).catch(() => null);
          return (m?.body ? { conversation: m.body } : undefined) as never;
        },
        msgRetryCounterCache: msgRetryCounterCache as never,
      });
      sock.ev.on('creds.update', () => { saveCreds().catch((e) => silentLogger.error(e, 'falha ao salvar credenciais')); });
    } catch (e) {
      this.scheduleRetry(s, `Falha ao iniciar a conexão: ${(e as Error).message}`);
      return;
    }
    if (gen !== s.generation || s.stopped) { try { sock.end(undefined); } catch { /* ignora */ } return; }
    s.sock = sock;

    sock.ev.on('connection.update', (u) => { this.onConnectionUpdate(s, gen, u).catch((e) => silentLogger.error(e, 'connection.update')); });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (gen !== s.generation || type !== 'notify') return;
      for (const m of messages) {
        if (m.messageStubType === 2 /* CIPHERTEXT: não decifrada */ && !m.key?.fromMe) {
          recordDeliveryEvent(s.channelId, s.orgId, { action: 'whatsapp.decrypt_falha', jid: m.key?.remoteJid ?? null, msgId: m.key?.id ?? null }).catch(() => undefined);
        }
        this.onInbound?.(s.channelId, m).catch((e) => silentLogger.error(e, 'erro ao processar mensagem recebida'));
      }
    });
    sock.ev.on('messages.update', (updates) => {
      if (gen !== s.generation) return;
      for (const u of updates) {
        if (!u.key?.fromMe) continue;
        this.onStatus?.(s.channelId, u).catch(() => undefined);
      }
    });
  }

  private async onConnectionUpdate(s: Session, gen: number, u: Partial<ConnectionState>) {
    if (gen !== s.generation) return;
    if (u.qr) {
      s.qr = u.qr;
      s.qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
      if (s.status !== 'QR_PENDING') {
        s.status = 'QR_PENDING';
        await this.persist(s.channelId, { status: 'QR_PENDING', lastError: null });
      }
    }
    if (u.connection === 'open') {
      // Só envia depois de processar o que chegou enquanto estava desconectado (chaves/sessões novas);
      // se o aviso não vier, libera após alguns segundos.
      s.ready = false;
      if (s.readyTimer) clearTimeout(s.readyTimer);
      s.readyTimer = setTimeout(() => { if (gen === s.generation) s.ready = true; }, READY_FALLBACK_MS);
      s.readyTimer.unref?.();
      const jid = s.sock?.user?.id ?? null;
      const num = jidToNumber(jid);
      s.status = 'CONNECTED';
      s.qr = null; s.qrDataUrl = null; s.attempts = 0; s.lastError = null;
      s.phone = num ? `+${num}` : null;
      await this.persist(s.channelId, { status: 'CONNECTED', waJid: jid, displayPhone: s.phone ?? undefined, connectedAt: new Date(), lastError: null, lastCheckedAt: new Date() });
      console.log(`[whatsapp-qr] canal ${s.channelId} conectado (${s.phone ?? 'número não informado'})`);
    }
    if (u.receivedPendingNotifications && s.status === 'CONNECTED') {
      s.ready = true;
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined;
      const code = err?.output?.statusCode;
      s.sock = null;
      s.ready = false;
      if (s.stopped) return;
      if (code === DisconnectReason.loggedOut) {
        await this.handleLoggedOut(s, 'Sessão encerrada pelo celular (aparelho desconectado). Conecte de novo pelo QR code.');
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Outra instância (ex.: novo deploy) assumiu a sessão: não disputa a conexão.
        s.stopped = true;
        s.status = 'NOT_CONNECTED';
        this.clearLeaseTimer(s);
        await flushAuthState(s.channelId);
        await releaseLease(s.channelId);
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        await this.connect(s); // normal logo após escanear o QR
        return;
      }
      if (s.status === 'QR_PENDING' && code === DisconnectReason.timedOut) {
        // QR não escaneado a tempo: para e espera o usuário clicar em "Conectar" de novo.
        s.stopped = true;
        s.status = 'NOT_CONNECTED';
        s.lastError = s.pairing
          ? 'O código de pareamento expirou sem ser usado. Clique em "Gerar outro código".'
          : 'O QR code expirou sem ser escaneado. Clique em "Gerar novo QR code" ou use a aba "Código pelo número".';
        s.qr = null; s.qrDataUrl = null; s.pairing = null;
        await this.persist(s.channelId, { status: 'NOT_CONNECTED', lastError: s.lastError });
        return;
      }
      if (code === DisconnectReason.badSession && s.attempts < 3) {
        // Erro 500 costuma ser passageiro (rede/servidor do WhatsApp): tenta de novo antes de apagar a sessão.
        this.scheduleRetry(s, `Sessão instável (código ${code})`);
        return;
      }
      if (code === DisconnectReason.badSession || code === DisconnectReason.multideviceMismatch || code === DisconnectReason.forbidden) {
        await this.handleLoggedOut(s, `Sessão inválida (código ${code}). Conecte de novo pelo QR code.`);
        return;
      }
      this.scheduleRetry(s, `Conexão perdida${code ? ` (código ${code})` : ''}: ${err?.message ?? 'motivo desconhecido'}`);
    }
  }

  private async handleLoggedOut(s: Session, reason: string) {
    s.stopped = true;
    this.clearTimer(s);
    this.clearLeaseTimer(s);
    s.ready = false;
    s.status = 'NOT_CONNECTED';
    s.qr = null; s.qrDataUrl = null; s.phone = null; s.pairing = null;
    s.lastError = reason;
    await clearAuthState(s.channelId);
    await releaseLease(s.channelId);
    await this.persist(s.channelId, { status: 'NOT_CONNECTED', waJid: null, lastError: reason });
  }

  private scheduleRetry(s: Session, reason: string) {
    if (s.stopped) return;
    s.attempts++;
    s.lastError = reason;
    const delay = backoffDelay(s.attempts);
    s.status = s.attempts >= 5 ? 'ERROR' : 'CONNECTING';
    this.persist(s.channelId, { status: s.status, lastError: `${reason}. Nova tentativa em ${Math.round(delay / 1000)} s.` });
    this.clearTimer(s);
    s.timer = setTimeout(() => { if (!s.stopped) this.connect(s).catch((e) => this.scheduleRetry(s, (e as Error).message)); }, delay);
    s.timer.unref?.();
  }

  /** Desconecta. Com logout, encerra o aparelho no celular e apaga a sessão salva. */
  async stop(channelId: string, opts: { logout: boolean }) {
    const s = this.session(channelId);
    s.stopped = true;
    s.generation++;
    this.clearTimer(s);
    this.clearLeaseTimer(s);
    s.ready = false;
    const sock = s.sock;
    s.sock = null;
    if (opts.logout) {
      try { await sock?.logout?.('Desconectado pelo MCKBOT'); } catch { /* sessão pode já estar fechada */ }
      await clearAuthState(channelId);
      s.phone = null;
    } else {
      try { sock?.end?.(undefined); } catch { /* ignora */ }
    }
    s.status = 'NOT_CONNECTED';
    s.qr = null; s.qrDataUrl = null; s.lastError = null; s.pairing = null;
    await flushAuthState(channelId);
    await releaseLease(channelId);
    if (opts.logout) await this.persist(channelId, { status: 'NOT_CONNECTED', waJid: null, lastError: null });
  }

  private pairingInFlight = new Set<string>();

  /**
   * Código de pareamento ("Conectar com número de telefone"). Só para canal ainda NÃO registrado:
   * abre (ou reaproveita) um socket novo, espera o WhatsApp oferecer o pareamento (mesmo momento
   * em que o QR apareceria) e pede o código de 8 caracteres para o número informado.
   * Respeita a trava única por canal (connect() só abre o socket com a trava em mãos).
   * O código volta só para quem pediu: nunca é registrado em log nem na Auditoria.
   */
  async requestPairingCode(channelId: string, digits: string): Promise<{ code: string; expiresAt: string; phone: string }> {
    if (this.pairingInFlight.has(channelId)) throw new HttpError(409, 'Já estou gerando um código para este canal. Aguarde alguns segundos.');
    this.pairingInFlight.add(channelId);
    try {
      const s = this.session(channelId);
      if (s.status === 'CONNECTED' && s.sock) throw new HttpError(409, 'Este canal já está conectado. Desconecte antes de conectar outro número.');
      if (await hasSavedSession(channelId)) throw new HttpError(409, 'Este canal já tem uma sessão do WhatsApp salva (reconectando). Clique em "Desconectar" antes de conectar por código.');
      // Sempre um socket novo: o prazo do pareamento começa agora (o socket de um QR aberto há
      // um tempo expiraria antes do código) e um código anterior deixa de valer.
      await this.openForPairing(s);
      const ok = await waitUntil(() => s.stopped || s.waitingLease || (s.status === 'QR_PENDING' && !!s.sock), pairWaitMs());
      if (s.waitingLease) throw new HttpError(503, 'O servidor está terminando uma atualização. Tente de novo em alguns segundos.');
      const sock = s.sock;
      if (!ok || s.stopped || !sock || s.status !== 'QR_PENDING') throw new HttpError(504, 'Não consegui falar com o WhatsApp agora. Tente de novo em instantes.');
      if (!sock.requestPairingCode) throw new HttpError(501, 'Esta versão da conexão não suporta código de pareamento. Use o QR code.');
      const gen = s.generation;
      let raw: string;
      try {
        raw = await sock.requestPairingCode(digits);
      } catch (e) {
        throw new HttpError(502, `O WhatsApp recusou o pedido de código: ${(e as Error).message?.slice(0, 120) || 'erro desconhecido'}. Confira o número e tente de novo.`);
      }
      if (gen !== s.generation || s.sock !== sock) throw new HttpError(504, 'A conexão caiu enquanto o código era gerado. Tente de novo.');
      const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
      const phone = maskPhone(digits);
      s.pairing = { expiresAt, phone };
      s.lastError = null;
      return { code: formatPairingCode(raw), expiresAt: new Date(expiresAt).toISOString(), phone };
    } finally {
      this.pairingInFlight.delete(channelId);
    }
  }

  /** Abre um socket novo, sem sessão registrada, para o pareamento por código. */
  protected async openForPairing(s: Session) {
    s.stopped = false;
    s.attempts = 0;
    s.lastError = null;
    s.pairing = null;
    await this.connect(s);
  }

  /** Ao iniciar o servidor: reconecta todos os canais QR que têm sessão salva. */
  async restoreAll() {
    const channels = await prisma.channel.findMany({ where: { provider: 'whatsapp_qr' }, select: { id: true } });
    let i = 0;
    for (const c of channels) {
      if (!(await hasSavedSession(c.id))) {
        await this.persist(c.id, { status: 'NOT_CONNECTED' });
        continue;
      }
      const delay = 1500 * i++;
      setTimeout(() => { this.start(c.id).catch((e) => silentLogger.error(e, 'falha ao restaurar sessão')); }, delay).unref?.();
    }
    return i;
  }

  /**
   * Desligamento limpo (SIGTERM do Render no deploy): fecha os sockets, espera TODAS as chaves do
   * Signal serem gravadas no banco e só então libera a trava para a instância nova conectar.
   */
  async shutdown() {
    const ids: string[] = [];
    for (const s of this.sessions.values()) {
      const hadSock = !!s.sock || !s.stopped;
      s.stopped = true;
      s.generation++;
      s.ready = false;
      this.clearTimer(s);
      this.clearLeaseTimer(s);
      try { s.sock?.end?.(undefined); } catch { /* ignora */ }
      s.sock = null;
      if (hadSock) ids.push(s.channelId);
    }
    if (!ids.length) return;
    await sleep(isTest() ? 0 : 500); // últimas atualizações de credenciais emitidas no fechamento
    await flushAuthState();
    await Promise.all(ids.map((id) => releaseLease(id)));
    console.log(`[whatsapp-qr] ${ids.length} sessão(ões) encerrada(s) com chaves salvas e trava liberada`);
  }

  /** Envia pelo socket do canal. Lança erro com mensagem em pt-BR quando não é possível. */
  private sendChains = new Map<string, Promise<unknown>>();
  private lastSendAt = new Map<string, number>();

  async send(channelId: string, waId: string, payload: OutboundPayload): Promise<{ waMessageId: string }> {
    const content = buildQrContent(payload);
    const jid = waIdToJid(waId);
    // Fila por contato: uma mensagem por vez, com um pequeno intervalo entre elas.
    const chainKey = `${channelId}:${jid}`;
    const prev = this.sendChains.get(chainKey) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.sendNow(channelId, chainKey, jid, content));
    const tail = run.catch(() => undefined);
    this.sendChains.set(chainKey, tail);
    tail.then(() => { if (this.sendChains.get(chainKey) === tail) this.sendChains.delete(chainKey); });
    return run;
  }

  private async sendNow(channelId: string, chainKey: string, jid: string, content: AnyMessageContent): Promise<{ waMessageId: string }> {
    const notConnected = 'WhatsApp (QR) não conectado: abra Canais WhatsApp e conecte pelo QR code';
    const s = this.sessions.get(channelId);
    if (!s) throw new Error(notConnected);
    // Reconectando/acordando: espera a conexão abrir em vez de enviar com sessão velha ou falhar.
    if (!(s.status === 'CONNECTED' && s.sock)) {
      if (s.stopped || sendWaitMs() <= 0) throw new Error(notConnected);
      const ok = await waitUntil(() => (s.status === 'CONNECTED' && !!s.sock) || s.stopped, sendWaitMs());
      if (!ok || s.stopped || !s.sock) throw new Error(notConnected);
    }
    // Logo após conectar: espera processar as notificações pendentes (chaves/sessões novas dos contatos).
    if (!s.ready && s.readyTimer) await waitUntil(() => s.ready || !s.sock, READY_FALLBACK_MS + 1000);
    const sock = s.sock;
    if (!sock) throw new Error(notConnected);
    const gap = sendGapMs();
    const last = this.lastSendAt.get(chainKey);
    if (gap > 0 && last) { const wait = last + gap - Date.now(); if (wait > 0) await sleep(wait); }
    const r = await sock.sendMessage(jid, content);
    this.lastSendAt.set(chainKey, Date.now());
    if (this.lastSendAt.size > 5000) this.lastSendAt.delete(this.lastSendAt.keys().next().value as string);
    const id = r?.key?.id;
    if (!id) throw new Error('O WhatsApp não confirmou o envio da mensagem');
    rememberSent(id, r?.message);
    // Guarda a mensagem completa para reenvio fiel mesmo após reinício/deploy.
    if (r?.message) await saveSent(channelId, id, r.message).catch((e) => silentLogger.error(e, 'falha ao guardar mensagem enviada'));
    return { waMessageId: id };
  }

  // ---------- Somente testes ----------
  attachForTests(channelId: string, sock: QrSocket | null, status: QrStatus = 'CONNECTED') {
    const s = this.session(channelId);
    s.sock = sock; s.status = status; s.stopped = !sock;
  }
  resetForTests() {
    for (const s of this.sessions.values()) { this.clearTimer(s); this.clearLeaseTimer(s); }
    this.sessions.clear();
    this.sendChains.clear();
    this.lastSendAt.clear();
  }
  /** Somente testes: simula a conexão aberta, com ou sem notificações pendentes já processadas. */
  connectForTests(channelId: string, sock: QrSocket, ready: boolean) {
    const s = this.session(channelId);
    s.sock = sock; s.status = 'CONNECTED'; s.stopped = false; s.ready = ready;
    if (!ready) {
      s.readyTimer = setTimeout(() => { s.ready = true; }, 300);
    }
    return s;
  }
  setConnectingForTests(channelId: string) {
    const s = this.session(channelId);
    s.sock = null; s.status = 'CONNECTING'; s.stopped = false; s.ready = false;
  }
}

export const qrManager = new QrSessionManager();
export { mapBaileysStatus, parseBaileysMessage };
