import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
  type AnyMessageContent, type WAMessage, type WAMessageUpdate, type ConnectionState, type WAVersion,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { prisma } from '../../db.js';
import { useDbAuthState, clearAuthState, hasSavedSession } from './authState.js';
import { parseBaileysMessage, mapBaileysStatus, buildQrContent, waIdToJid, jidToNumber } from './parse.js';
import type { OutboundPayload } from '../cloudClient.js';

export type QrStatus = 'NOT_CONNECTED' | 'CONNECTING' | 'QR_PENDING' | 'CONNECTED' | 'ERROR';

/** Subconjunto do socket do Baileys usado aqui (facilita testes com socket simulado). */
export interface QrSocket {
  sendMessage(jid: string, content: AnyMessageContent): Promise<{ key?: { id?: string | null } } | undefined>;
  logout?(msg?: string): Promise<void>;
  end?(error: Error | undefined): void;
  user?: { id: string } | null;
}

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
}

/** Logger mínimo compatível com o ILogger do Baileys: só registra erros relevantes. */
const silentLogger = {
  level: 'error',
  child() { return silentLogger; },
  trace() {}, debug() {}, info() {}, warn() {},
  error(obj: unknown, msg?: string) { if (process.env.NODE_ENV !== 'test') console.error('[whatsapp-qr]', msg ?? '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 500) : obj); },
};

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
      s = { channelId, sock: null, status: 'NOT_CONNECTED', qr: null, qrDataUrl: null, attempts: 0, timer: null, stopped: true, generation: 0, phone: null, lastError: null };
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
    return { live: !!s && !s.stopped, status: s?.status ?? null, qr: s?.status === 'QR_PENDING' ? s.qrDataUrl : null, phone: s?.phone ?? null, lastError: s?.lastError ?? null };
  }

  isConnected(channelId: string) {
    const s = this.sessions.get(channelId);
    return !!s && s.status === 'CONNECTED' && !!s.sock;
  }

  /** Inicia (ou reinicia) a conexão de um canal. Idempotente se já estiver ativo. */
  async start(channelId: string, opts: { force?: boolean } = {}) {
    const s = this.session(channelId);
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

  private async connect(s: Session) {
    this.clearTimer(s);
    const gen = ++s.generation;
    const old = s.sock;
    s.sock = null;
    try { old?.end?.(undefined); } catch { /* ignora */ }

    s.status = 'CONNECTING';
    s.qr = null;
    s.qrDataUrl = null;
    await this.persist(s.channelId, { status: 'CONNECTING' });

    let sock: ReturnType<typeof makeWASocket>;
    try {
      const { state, saveCreds } = await useDbAuthState(s.channelId);
      const version = await waVersion();
      sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
        logger: silentLogger,
        browser: Browsers.ubuntu('MCKBOT'),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
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
      const jid = s.sock?.user?.id ?? null;
      const num = jidToNumber(jid);
      s.status = 'CONNECTED';
      s.qr = null; s.qrDataUrl = null; s.attempts = 0; s.lastError = null;
      s.phone = num ? `+${num}` : null;
      await this.persist(s.channelId, { status: 'CONNECTED', waJid: jid, displayPhone: s.phone ?? undefined, connectedAt: new Date(), lastError: null, lastCheckedAt: new Date() });
      console.log(`[whatsapp-qr] canal ${s.channelId} conectado (${s.phone ?? 'número não informado'})`);
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined;
      const code = err?.output?.statusCode;
      s.sock = null;
      if (s.stopped) return;
      if (code === DisconnectReason.loggedOut) {
        await this.handleLoggedOut(s, 'Sessão encerrada pelo celular (aparelho desconectado). Conecte de novo pelo QR code.');
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Outra instância (ex.: novo deploy) assumiu a sessão: não disputa a conexão.
        s.stopped = true;
        s.status = 'NOT_CONNECTED';
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
        s.qr = null; s.qrDataUrl = null;
        s.lastError = 'O QR code expirou sem ser escaneado. Clique em "Conectar por QR code" para gerar outro.';
        await this.persist(s.channelId, { status: 'NOT_CONNECTED', lastError: s.lastError });
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
    s.status = 'NOT_CONNECTED';
    s.qr = null; s.qrDataUrl = null; s.phone = null;
    s.lastError = reason;
    await clearAuthState(s.channelId);
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
    s.qr = null; s.qrDataUrl = null; s.lastError = null;
    if (opts.logout) await this.persist(channelId, { status: 'NOT_CONNECTED', waJid: null, lastError: null });
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

  async shutdown() {
    for (const s of this.sessions.values()) {
      s.stopped = true;
      this.clearTimer(s);
      try { s.sock?.end?.(undefined); } catch { /* ignora */ }
      s.sock = null;
    }
  }

  /** Envia pelo socket do canal. Lança erro com mensagem em pt-BR quando não é possível. */
  async send(channelId: string, waId: string, payload: OutboundPayload): Promise<{ waMessageId: string }> {
    const s = this.sessions.get(channelId);
    if (!s || !s.sock || s.status !== 'CONNECTED') throw new Error('WhatsApp (QR) não conectado: abra Canais WhatsApp e conecte pelo QR code');
    const content = buildQrContent(payload);
    const r = await s.sock.sendMessage(waIdToJid(waId), content);
    const id = r?.key?.id;
    if (!id) throw new Error('O WhatsApp não confirmou o envio da mensagem');
    return { waMessageId: id };
  }

  // ---------- Somente testes ----------
  attachForTests(channelId: string, sock: QrSocket | null, status: QrStatus = 'CONNECTED') {
    const s = this.session(channelId);
    s.sock = sock; s.status = status; s.stopped = !sock;
  }
  resetForTests() {
    for (const s of this.sessions.values()) this.clearTimer(s);
    this.sessions.clear();
  }
}

export const qrManager = new QrSessionManager();
export { mapBaileysStatus, parseBaileysMessage };
