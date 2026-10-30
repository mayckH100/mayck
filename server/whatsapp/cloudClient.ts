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
  | { type: 'template'; name: string; language: string }
  /** Arquivo em memória (anexos do MCK Mensagens): QR envia o buffer; a Cloud API faz upload e envia pelo id. */
  | { type: 'file'; data: Buffer; filename: string; mime: string; caption?: string }
  /** Mídia já enviada à Meta (upload em /media). */
  | { type: 'media_id'; kind: 'image' | 'document'; id: string; caption?: string; filename?: string };

export const isImageMime = (mime: string) => /^image\/(jpeg|png|webp)$/.test(mime);

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
    case 'media_id': {
      const media: Record<string, string> = { id: p.id };
      if (p.caption) media.caption = p.caption;
      if (p.filename && p.kind === 'document') media.filename = p.filename;
      return { ...base, type: p.kind, [p.kind]: media };
    }
    case 'file':
      throw new Error('Arquivo precisa ser enviado à Meta (upload) antes da mensagem');
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

/** Upload de mídia na Cloud API (POST /{phone-number-id}/media). Devolve o id para enviar o documento/imagem. */
export async function uploadCloudMedia(creds: CloudCredentials, data: Buffer, mime: string, filename: string): Promise<string> {
  const url = `${config.GRAPH_API_BASE}/${config.GRAPH_API_VERSION}/${creds.phoneNumberId}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), filename);
  const res = await httpFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${creds.accessToken}` }, body: form, signal: AbortSignal.timeout(60000) });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new GraphApiError(`Falha no upload do anexo para o WhatsApp: ${json.error?.message ?? `HTTP ${res.status}`}`, res.status, false);
  return json.id;
}

/** Baixa uma mídia recebida (GET /{media-id} → url temporária → bytes, sempre com o token do canal). */
export async function downloadCloudMedia(accessToken: string, mediaId: string): Promise<{ dados: Buffer; mime: string }> {
  const meta = await httpFetch(`${config.GRAPH_API_BASE}/${config.GRAPH_API_VERSION}/${mediaId}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
  const j = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; error?: { message?: string } };
  if (!meta.ok || !j.url) throw new Error(`Não foi possível obter a mídia: ${j.error?.message ?? `HTTP ${meta.status}`}`);
  const res = await httpFetch(j.url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Falha ao baixar a mídia: HTTP ${res.status}`);
  return { dados: Buffer.from(await res.arrayBuffer()), mime: j.mime_type ?? 'application/octet-stream' };
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
  fileName?: string;
  /** Modo QR: LID do remetente (ex.: "123456@lid"), quando conhecido, para não duplicar o contato. */
  lid?: string;
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
        let fileName: string | undefined;
        switch (m.type) {
          case 'text': text = m.text?.body ?? ''; break;
          case 'interactive': {
            const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
            text = r?.title ?? ''; replyId = r?.id; break;
          }
          case 'button': text = m.button?.text ?? ''; replyId = m.button?.payload; break;
          case 'image': case 'video': case 'document': case 'audio': case 'sticker':
            mediaId = m[m.type]?.id; text = m[m.type]?.caption ?? ''; fileName = m[m.type]?.filename; break;
          case 'location': text = `[localização] ${m.location?.latitude},${m.location?.longitude}`; break;
          default: text = '';
        }
        messages.push({
          phoneNumberId, waMessageId: String(m.id), from: String(m.from), profileName: names.get(String(m.from)),
          timestamp: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000), type: String(m.type), text, replyId, mediaId, fileName,
        });
      }
      for (const s of v.statuses ?? []) {
        statuses.push({ phoneNumberId, waMessageId: String(s.id), status: s.status, error: s.errors?.[0]?.title ?? s.errors?.[0]?.message });
      }
    }
  }
  return { messages, statuses };
}
