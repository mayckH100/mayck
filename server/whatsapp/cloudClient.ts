import { config } from '../config.js';
import { httpFetch } from '../lib/fetcher.js';

export interface CloudCredentials {
  phoneNumberId: string;
  accessToken: string;
}

export type OutboundPayload =
  | { type: 'text'; text: string; previewUrl?: boolean }
  | { type: 'image' | 'video' | 'document' | 'audio'; link: string; caption?: string; filename?: string }
  | { type: 'buttons'; text: string; buttons: { id: string; title: string }[] }
  | { type: 'template'; name: string; language: string };

export function buildGraphBody(to: string, p: OutboundPayload): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  switch (p.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: p.text, preview_url: !!p.previewUrl } };
    case 'buttons':
      return {
        ...base, type: 'interactive',
        interactive: { type: 'button', body: { text: p.text }, action: { buttons: p.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) } },
      };
    case 'template':
      return { ...base, type: 'template', template: { name: p.name, language: { code: p.language } } };
    default: {
      const media: Record<string, string> = { link: p.link };
      if (p.caption && p.type !== 'audio') media.caption = p.caption;
      if (p.filename && p.type === 'document') media.filename = p.filename;
      return { ...base, type: p.type, [p.type]: media };
    }
  }
}

export class GraphApiError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) {
    super(message);
  }
}

export interface SendResult { waMessageId: string; attempts: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Envia uma mensagem pela WhatsApp Cloud API com novas tentativas
 * (backoff exponencial) para erros de rede, 429 e 5xx.
 */
export async function sendCloudMessage(creds: CloudCredentials, to: string, payload: OutboundPayload, opts: { maxAttempts?: number; baseDelayMs?: number } = {}): Promise<SendResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? (process.env.NODE_ENV === 'test' ? 1 : 500);
  const url = `${config.GRAPH_API_BASE}/${config.GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`;
  let lastErr: GraphApiError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await httpFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildGraphBody(to, payload)),
        signal: AbortSignal.timeout(15000),
      });
      const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
      if (res.ok && json.messages?.[0]?.id) return { waMessageId: json.messages[0].id, attempts: attempt };
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new GraphApiError(json.error?.message ?? `Erro HTTP ${res.status} da Graph API`, res.status, retryable);
      if (!retryable) throw lastErr;
    } catch (e) {
      if (e instanceof GraphApiError && !e.retryable) { (e as GraphApiError & { attempts?: number }).attempts = attempt; throw e; }
      if (!(e instanceof GraphApiError)) lastErr = new GraphApiError(`Falha de rede: ${(e as Error).message}`, 0, true);
    }
    if (attempt < maxAttempts) await sleep(baseDelay * 2 ** (attempt - 1));
  }
  (lastErr as GraphApiError & { attempts?: number }).attempts = maxAttempts;
  throw lastErr!;
}

/** Consulta o número na Graph API para confirmar que as credenciais são válidas. */
export async function checkPhoneNumber(creds: CloudCredentials): Promise<{ displayPhone?: string; verifiedName?: string }> {
  const url = `${config.GRAPH_API_BASE}/${config.GRAPH_API_VERSION}/${creds.phoneNumberId}?fields=display_phone_number,verified_name`;
  const res = await httpFetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` }, signal: AbortSignal.timeout(15000) });
  const json = (await res.json().catch(() => ({}))) as { display_phone_number?: string; verified_name?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Erro HTTP ${res.status}`);
  return { displayPhone: json.display_phone_number, verifiedName: json.verified_name };
}

// ---------- Parsing do webhook ----------
export interface InboundMessage {
  phoneNumberId: string;
  waMessageId: string;
  from: string;
  profileName?: string;
  timestamp: Date;
  type: string;
  text: string;
  replyId?: string;
  mediaId?: string;
}
export interface StatusUpdate {
  phoneNumberId: string;
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseWebhook(body: any): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (body?.object !== 'whatsapp_business_account') return { messages, statuses };
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const v = change.value ?? {};
      const phoneNumberId = String(v.metadata?.phone_number_id ?? '');
      const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [String(c.wa_id), c.profile?.name]));
      for (const m of v.messages ?? []) {
        let text = '';
        let replyId: string | undefined;
        let mediaId: string | undefined;
        switch (m.type) {
          case 'text': text = m.text?.body ?? ''; break;
          case 'interactive': {
            const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
            text = r?.title ?? ''; replyId = r?.id; break;
          }
          case 'button': text = m.button?.text ?? ''; replyId = m.button?.payload; break;
          case 'image': case 'video': case 'document': case 'audio': case 'sticker':
            mediaId = m[m.type]?.id; text = m[m.type]?.caption ?? ''; break;
          case 'location': text = `[localização] ${m.location?.latitude},${m.location?.longitude}`; break;
          default: text = '';
        }
        messages.push({
          phoneNumberId, waMessageId: String(m.id), from: String(m.from), profileName: names.get(String(m.from)),
          timestamp: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000), type: String(m.type), text, replyId, mediaId,
        });
      }
      for (const s of v.statuses ?? []) {
        statuses.push({ phoneNumberId, waMessageId: String(s.id), status: s.status, error: s.errors?.[0]?.title ?? s.errors?.[0]?.message });
      }
    }
  }
  return { messages, statuses };
}
