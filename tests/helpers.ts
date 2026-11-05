import request from 'supertest';
import { createApp } from '../server/app.js';
import { prisma } from '../server/db.js';
import { encrypt, hmacSha256Hex, randomToken } from '../server/lib/crypto.js';
import { setFetch } from '../server/lib/fetcher.js';
import { setResolver } from '../server/lib/ssrf.js';
import { setDnsResolver } from '../server/lib/emailCheck.js';
import { outbox } from '../server/lib/mailer.js';

export const app = createApp();
let seq = 0;
export const uniq = (p = 'u') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export type Agent = ReturnType<typeof request.agent>;

/** Cliente HTTP com cookie de sessão + cabeçalhos CSRF. */
export class Client {
  agent: Agent = request.agent(app);
  csrf = '';
  me: any;
  h() { return { 'x-requested-with': 'mckbot', 'x-csrf-token': this.csrf }; }
  get(url: string) { return this.agent.get(url); }
  post(url: string, body?: unknown) { return this.agent.post(url).set(this.h()).send(body as object); }
  put(url: string, body?: unknown) { return this.agent.put(url).set(this.h()).send(body as object); }
  patch(url: string, body?: unknown) { return this.agent.patch(url).set(this.h()).send(body as object); }
  del(url: string) { return this.agent.delete(url).set(this.h()); }
}

// DNS simulado para o cadastro (nunca consulta a rede nos testes):
//  "*.semmx.dev"/"*.invalid" → domínio não existe; "*.dnsfalho.dev" → falha transitória; demais → MX válido.
export function installDnsMock() {
  const nx = () => Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' });
  const fail = () => Object.assign(new Error('queryMx ESERVFAIL'), { code: 'ESERVFAIL' });
  const pick = async <T>(d: string, ok: T): Promise<T> => {
    if (d.endsWith('semmx.dev') || d.endsWith('.invalid')) throw nx();
    if (d.endsWith('dnsfalho.dev')) throw fail();
    return ok;
  };
  setDnsResolver({ mx: (d) => pick(d, [{ exchange: `mx.${d}`, priority: 10 }]), a: (d) => pick(d, ['93.184.216.34']), aaaa: (d) => pick(d, []) });
}
installDnsMock();

let docSeq = Math.floor(Math.random() * 1e8);
/** CPF válido e único por execução (dígitos verificadores calculados). */
export function fakeCpf(): string {
  const base = String(100000000 + (docSeq++ * 7919) % 899999999).split('').map(Number);
  const dv = (arr: number[]) => { const len = arr.length; const sum = arr.reduce((a, n, i) => a + n * (len + 1 - i), 0); const r = (sum * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(base); const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}
/** CNPJ válido e único. */
export function fakeCnpj(): string {
  const base = (String(10000000 + (docSeq++ * 104729) % 89999999) + '0001').split('').map(Number);
  const dv = (arr: number[]) => { const w = arr.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const r = arr.reduce((a, n, i) => a + n * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(base); const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}
/** CNPJ alfanumérico válido e único (12 caracteres A-Z/0-9 + 2 DVs; valor = ASCII − 48). */
export function fakeCnpjAlfa(): string {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const n = docSeq++;
  const base = `${L[n % 24]}${L[Math.floor(n / 24) % 24]}${String(100000 + (n * 7919) % 899999)}${L[Math.floor(n / 576) % 24]}${L[(n * 7) % 24]}01`;
  const dv = (s: string) => { const w = s.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const r = [...s].reduce((a, ch, i) => a + (ch.charCodeAt(0) - 48) * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(base); const d2 = dv(base + d1);
  return `${base}${d1}${d2}`;
}
let celSeq = Math.floor(Math.random() * 9e7);
/** Celular brasileiro único (só dígitos com DDD, ex.: 11987654321). */
export function fakeCelular(): string {
  return `119${String(10000000 + (celSeq++ % 89999999))}`;
}

/** Código de 6 dígitos do último e-mail de cadastro enviado para o endereço. */
export function signupCodeFor(email: string): string | null {
  for (let i = outbox.length - 1; i >= 0; i--) {
    const m = outbox[i];
    if (m.to === email && m.kind === 'signup_code') return /(\d{6})/.exec(m.subject)?.[1] ?? null;
  }
  return null;
}

export interface SignupData { name?: string; email?: string; password?: string; orgName?: string; documento?: string; celular?: string; app?: string; indica?: string }
export function signupData(opts: SignupData = {}) {
  return {
    name: opts.name ?? 'Usuário Teste', email: opts.email ?? `${uniq()}@teste.dev`, password: opts.password ?? 'senhaSegura123',
    orgName: opts.orgName ?? uniq('Org '), documento: opts.documento ?? fakeCpf(), celular: opts.celular ?? fakeCelular(), ...(opts.app ? { app: opts.app } : {}), ...(opts.indica ? { indica: opts.indica } : {}),
  };
}

/** Cadastro completo (dados → código do e-mail → conta ativa). Devolve o cliente já logado. */
export async function registerClient(opts: SignupData = {}) {
  const c = new Client();
  const data = signupData(opts);
  const r1 = await c.agent.post('/api/auth/register').set('x-requested-with', 'mckbot').send(data);
  if (r1.status !== 202) throw new Error('cadastro falhou: ' + JSON.stringify(r1.body));
  const code = signupCodeFor(data.email);
  if (!code) throw new Error('código do cadastro não chegou na caixa de saída');
  const res = await c.agent.post('/api/auth/register/confirm').set('x-requested-with', 'mckbot').send({ signupToken: r1.body.signupToken, code });
  if (res.status !== 201) throw new Error('confirmação falhou: ' + JSON.stringify(res.body));
  c.csrf = res.body.csrfToken;
  c.me = res.body;
  (c as Client & { signup: typeof data }).signup = data;
  return c as Client & { signup: typeof data };
}

export async function loginClient(email: string, password: string) {
  const c = new Client();
  const res = await c.agent.post('/api/auth/login').set('x-requested-with', 'mckbot').send({ email, password });
  c.csrf = res.body.csrfToken;
  c.me = res.body;
  return { c, res };
}

// ---------- Graph API simulada (somente testes) ----------
export interface GraphCall { url: string; body: any; headers: any }
export const graph = {
  calls: [] as GraphCall[],
  failNext: [] as number[], // status HTTP a devolver nas próximas chamadas (ex.: [500, 500])
  other: null as null | ((url: string, init?: RequestInit) => Promise<Response> | null),
  n: 0,
  reset() { this.calls = []; this.failNext = []; this.other = null; },
};

export function installGraphMock() {
  // DNS simulado: domínios de teste resolvem para um IP público de documentação; "interno.test" para IP privado.
  setResolver(async (host) => (host.endsWith('interno.test') ? ['10.0.0.5'] : ['93.184.216.34']));
  setFetch(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://graph.facebook.com/')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body instanceof FormData ? { formData: Object.fromEntries([...init.body.keys()].map((k) => [k, true])) } : null;
      graph.calls.push({ url, body, headers: init?.headers });
      const fail = graph.failNext.shift();
      if (fail) return new Response(JSON.stringify({ error: { message: `Erro simulado ${fail}` } }), { status: fail });
      if (init?.method === 'POST' && url.endsWith('/media')) return new Response(JSON.stringify({ id: `media-${++graph.n}` }), { status: 200 });
      if (init?.method === 'POST') return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${++graph.n}` }] }), { status: 200 });
      return new Response(JSON.stringify({ display_phone_number: '+55 11 90000-0000', verified_name: 'Teste' }), { status: 200 });
    }
    if (graph.other) {
      const r = await graph.other(url, init);
      if (r) return r;
    }
    throw new Error('Rede bloqueada nos testes: ' + url);
  });
}

export const sentTexts = () => graph.calls.filter((c) => c.body).map((c) => c.body.text?.body ?? c.body.interactive?.body?.text ?? c.body.type);

/** Cria um canal já "conectado" direto no banco — SOMENTE em teste, simulando credenciais verificadas. */
export async function createTestChannel(orgId: string) {
  const appSecret = 'segredo-app-' + randomToken(8);
  const phoneNumberId = String(100000000 + Math.floor(Math.random() * 899999999));
  const ch = await prisma.channel.create({
    data: { orgId, name: 'Teste', phoneNumberId, accessTokenEnc: encrypt('EAAtokenDeTeste1234567890'), appSecretEnc: encrypt(appSecret), verifyToken: 'verif-' + randomToken(8), status: 'CONNECTED' },
  });
  return { ch, appSecret, phoneNumberId };
}

let wamid = 0;
export function inboundPayload(phoneNumberId: string, from: string, text: string, opts: { id?: string; name?: string; replyId?: string } = {}) {
  const id = opts.id ?? `wamid.IN${Date.now()}${wamid++}`;
  const message: any = opts.replyId
    ? { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: opts.replyId, title: text } } }
    : { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } };
  return {
    id,
    body: {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '5511900000000', phone_number_id: phoneNumberId }, contacts: [{ profile: { name: opts.name ?? 'Cliente Teste' }, wa_id: from }], messages: [message] } }] }],
    },
  };
}

export function statusPayload(phoneNumberId: string, waMessageId: string, status: string) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, statuses: [{ id: waMessageId, status, timestamp: '1700000000', recipient_id: '5511' }] } }] }] };
}

export async function postWebhook(channelId: string, appSecret: string, body: unknown, badSig = false) {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + hmacSha256Hex(badSig ? 'errado' : appSecret, raw);
  return request(app).post(`/api/webhooks/whatsapp/${channelId}`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw);
}

export async function sendInbound(ctx: { ch: { id: string }; appSecret: string; phoneNumberId: string }, from: string, text: string, opts: { id?: string; replyId?: string } = {}) {
  const p = inboundPayload(ctx.phoneNumberId, from, text, opts);
  const res = await postWebhook(ctx.ch.id, ctx.appSecret, p.body);
  return { res, id: p.id };
}

export { prisma };
