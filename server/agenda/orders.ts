import { createHash, randomInt } from 'node:crypto';
import type { Order } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { HttpError, notFound } from '../lib/http.js';
import { channelLabels, type ChannelLabelInfo } from '../whatsapp/channelLabel.js';
import { findJsonMarkers, isAffirmative, stripSystemLinks, TIPO_ALL_RE } from './ai.js';
import { getSettings, handlesMeetings, handlesOrders, ownerPhones, sendToPhone, viaOf, type AgendaSettingsView } from './service.js';

// ---------------- Tipos e rótulos ----------------

export type OrderStatus = 'NOVO' | 'EM_ANDAMENTO' | 'CONCLUIDO' | 'CANCELADO';
export const ORDER_STATUSES: OrderStatus[] = ['NOVO', 'EM_ANDAMENTO', 'CONCLUIDO', 'CANCELADO'];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = { NOVO: 'Novo', EM_ANDAMENTO: 'Em andamento', CONCLUIDO: 'Concluído', CANCELADO: 'Cancelado' };
export type Intent = 'REUNIAO' | 'PEDIDO' | 'AMBOS';
export const INTENT_LABEL: Record<Intent, string> = { REUNIAO: 'Reunião', PEDIDO: 'Pedido', AMBOS: 'Reunião + Pedido' };

export interface OrderItem { nome: string; quantidade: number; obs: string | null }
export interface Delivery { nome: string; endereco: string; cep: string; numero: string; complemento: string | null; telefone: string }
/** Campos de entrega obrigatórios (complemento é opcional). */
const DELIVERY_REQUIRED: [keyof Delivery, string][] = [['nome', 'nome de quem recebe'], ['endereco', 'endereço (rua e bairro/cidade)'], ['cep', 'CEP'], ['numero', 'número'], ['telefone', 'telefone']];

const norm = (s: string) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const str = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Pedido online, físico ou definido pela IA (modo "Os dois"). */
export function orderTypeFor(s: Pick<AgendaSettingsView, 'orderType'>, tipo: unknown): 'FISICO' | 'ONLINE' {
  if (s.orderType === 'FISICO' || s.orderType === 'ONLINE') return s.orderType;
  return /online|digital|virtual/.test(norm(String(tipo ?? ''))) ? 'ONLINE' : 'FISICO';
}

/** Precisa dos dados de entrega? Físico: sempre. Online: só com "Solicitar dados de entrega" marcado. */
export function needsDelivery(s: Pick<AgendaSettingsView, 'orderAskDelivery'>, type: 'FISICO' | 'ONLINE') {
  return type === 'FISICO' || s.orderAskDelivery;
}

export function normalizeItems(raw: unknown): OrderItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: OrderItem[] = [];
  for (const it of arr.slice(0, 30)) {
    const nome = str(typeof it === 'string' ? it : it?.nome ?? it?.name ?? it?.item, 120);
    if (!nome) continue;
    const q = Math.floor(Number(typeof it === 'object' ? it?.quantidade ?? it?.qtd ?? 1 : 1));
    const obs = typeof it === 'object' ? str(it?.obs ?? it?.observacao, 200) : '';
    out.push({ nome, quantidade: q >= 1 && q <= 9999 ? q : 1, obs: obs || null });
  }
  return out;
}

export function normalizeDelivery(raw: any): { delivery: Delivery; missing: string[] } {
  const d: Delivery = {
    nome: str(raw?.nome, 100), endereco: str(raw?.endereco ?? raw?.rua, 200), cep: str(raw?.cep, 12).replace(/\D/g, ''),
    numero: str(raw?.numero, 20), complemento: str(raw?.complemento, 100) || null, telefone: str(raw?.telefone, 30).replace(/\D/g, ''),
  };
  const missing = DELIVERY_REQUIRED.filter(([k]) => !d[k]).map(([, l]) => l);
  if (d.cep && d.cep.length !== 8 && !missing.includes('CEP')) missing.push('CEP válido (8 números)');
  if (d.telefone && (d.telefone.length < 10 || d.telefone.length > 13) && !missing.includes('telefone')) missing.push('telefone com DDD');
  return { delivery: d, missing };
}

/** Assinatura do pedido (tipo + itens): o mesmo pedido confirmado duas vezes não vira dois. */
export function orderFingerprint(type: string, items: OrderItem[]) {
  const key = `${type}|${items.map((i) => `${norm(i.nome)}x${i.quantidade}`).sort().join(';')}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => `P-${Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('')}`;

export const itemsText = (items: OrderItem[]) => items.map((i) => `${i.quantidade}x ${i.nome}${i.obs ? ` (${i.obs})` : ''}`).join(', ');
export const deliveryText = (d: Delivery) => `${d.nome} — ${d.endereco}, nº ${d.numero}${d.complemento ? `, ${d.complemento}` : ''} — CEP ${d.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2')} — Tel. ${d.telefone}`;

// ---------------- Classificação da conversa ----------------

export function parseIntent(raw: string): Intent | null {
  const t = norm(raw);
  if (/ambos|os dois|reuniao\s*\+\s*pedido|pedido\s*\+\s*reuniao/.test(t)) return 'AMBOS';
  if (/pedido|compra|encomenda/.test(t)) return 'PEDIDO';
  if (/reuniao|agendamento|horario/.test(t)) return 'REUNIAO';
  return null;
}

/** Junta a classificação nova com a anterior (reunião + pedido = os dois). */
export function mergeIntent(prev: string | null | undefined, next: Intent | null): Intent | null {
  if (!next) return (prev as Intent) ?? null;
  if (!prev || prev === next) return next;
  return 'AMBOS';
}

/** Lê o marcador [TIPO:...] da resposta da IA (o último vale). */
export function intentFromText(text: string): Intent | null {
  const all = String(text ?? '').match(TIPO_ALL_RE);
  if (!all?.length) return null;
  return parseIntent(all[all.length - 1].replace(/^\[TIPO:/i, '').replace(/\]$/, ''));
}

/** Grava a classificação na conversa (sempre dentro da organização). */
export async function tagConversation(orgId: string, conversationId: string, intent: Intent | null) {
  if (!intent || !conversationId) return null;
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, orgId }, select: { aiIntent: true } });
  if (!conv) return null;
  const merged = mergeIntent(conv.aiIntent, intent);
  if (merged !== conv.aiIntent) await prisma.conversation.updateMany({ where: { id: conversationId, orgId }, data: { aiIntent: merged } });
  return merged;
}

// ---------------- Prompt ----------------

/** Trecho do prompt: o que a IA atende (Reunião / Pedido / Os dois), regras de pedido e de classificação. */
export async function ordersPromptSection(orgId: string): Promise<string> {
  const s = await getSettings(orgId);
  const meetings = s.aiBooking && handlesMeetings(s);
  const orders = handlesOrders(s);
  const lines: string[] = [];
  if (!orders) {
    // Modo Reunião: igual a antes; só deixa claro que pedidos não são registrados pela IA.
    if (meetings) lines.push('PEDIDOS:', '- Esta empresa não registra pedidos pelo WhatsApp com a IA. Se o cliente quiser fazer um pedido ou compra, não confirme nem registre pedido: tire dúvidas e ofereça marcar uma reunião ou diga que a equipe vai atendê-lo.');
  } else {
    if (s.aiHandles === 'PEDIDO') lines.push('ATENDIMENTO: esta empresa atende PEDIDOS pelo WhatsApp. Não agende reuniões nem ofereça horários; se o cliente pedir reunião, diga que a equipe vai entrar em contato.');
    const tipo = s.orderType === 'FISICO' ? 'produtos físicos (com entrega)' : s.orderType === 'ONLINE' ? 'produtos online/digitais (sem entrega física)' : 'produtos físicos (com entrega) e online/digitais';
    const askDeliv = s.orderType === 'FISICO'
      ? 'Sempre peça os dados de entrega.'
      : s.orderType === 'ONLINE'
        ? (s.orderAskDelivery ? 'Mesmo sendo online, peça os dados de entrega.' : 'Não peça dados de entrega (não há envio físico).')
        : (s.orderAskDelivery ? 'Peça os dados de entrega em todos os pedidos (físicos e online).' : 'Peça os dados de entrega só quando o item for físico; para item online/digital não peça.');
    lines.push(
      'PEDIDOS:',
      `- A empresa vende ${tipo}. ${askDeliv}`,
      '- Dados de entrega: nome de quem recebe, endereço (rua, bairro e cidade), CEP, número, complemento (opcional) e telefone com DDD.',
      '- Nunca invente produtos, preços, frete ou prazos: use só o que está nas Instruções da empresa e no CONTEXTO. Se não souber o valor, diga que a equipe confirma.',
      '- Antes de registrar, resuma o pedido (itens e quantidades e, se houver, os dados de entrega) e pergunte "Posso registrar o seu pedido?". Só depois que o cliente responder SIM a esse resumo, escreva a confirmação e termine a resposta com o marcador, numa linha própria:',
      '  [PEDIDO:{"itens":[{"nome":"<produto>","quantidade":1,"obs":"<opcional>"}],"tipo":"fisico|online","descricao":"<resumo curto>","entrega":{"nome":"","endereco":"","cep":"","numero":"","complemento":"","telefone":""}}]',
      '- Sem dados de entrega, omita "entrega". Use o marcador no máximo UMA vez por resposta e nunca repita o de um pedido já registrado.',
    );
  }
  if (meetings || orders) {
    lines.push('CLASSIFICAÇÃO:', '- Quando ficar claro o que o cliente quer, termine a resposta com [TIPO:reuniao], [TIPO:pedido] ou [TIPO:ambos] (reunião e pedido). O cliente não vê esse marcador.');
  }
  return lines.join('\n');
}

// ---------------- Visualização ----------------

export function viewOrder(o: Order, maps: { contacts?: Map<string, { id: string; name: string | null; phone: string }>; channels?: Map<string, ChannelLabelInfo>; intents?: Map<string, string | null> } = {}) {
  const c = o.contactId ? maps.contacts?.get(o.contactId) : undefined;
  const ch = o.channelId ? maps.channels?.get(o.channelId) : undefined;
  const intent = (o.conversationId ? maps.intents?.get(o.conversationId) : null) ?? 'PEDIDO';
  return {
    id: o.id, code: o.code, type: o.type, status: o.status, source: o.source, description: o.description, notes: o.notes,
    items: parseJson<OrderItem[]>(o.items, []), delivery: o.delivery ? parseJson<Delivery | null>(o.delivery, null) : null,
    contactId: o.contactId, contact: c ? { id: c.id, name: c.name, phone: c.phone } : null,
    conversationId: o.conversationId, intent, intentLabel: INTENT_LABEL[intent as Intent] ?? 'Pedido',
    channelId: o.channelId ?? null, channel: ch ? { id: ch.id, label: ch.label, phone: ch.phone, via: ch.via } : null,
    createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
}

export async function viewOrders(orgId: string, list: Order[]) {
  const cIds = [...new Set(list.map((o) => o.contactId).filter(Boolean))] as string[];
  const vIds = [...new Set(list.map((o) => o.conversationId).filter(Boolean))] as string[];
  const contacts = cIds.length ? await prisma.contact.findMany({ where: { orgId, id: { in: cIds } }, select: { id: true, name: true, phone: true } }) : [];
  const convs = vIds.length ? await prisma.conversation.findMany({ where: { orgId, id: { in: vIds } }, select: { id: true, aiIntent: true } }) : [];
  const channels = list.some((o) => o.channelId) ? await channelLabels(orgId) : new Map<string, ChannelLabelInfo>();
  const maps = { contacts: new Map(contacts.map((c) => [c.id, c] as const)), channels, intents: new Map(convs.map((c) => [c.id, c.aiIntent] as const)) };
  return list.map((o) => viewOrder(o, maps));
}

// ---------------- Avisos internos ----------------

async function noteOrderInConversation(o: Order) {
  if (!o.conversationId) return;
  try {
    const via = await viaOf(o);
    const items = parseJson<OrderItem[]>(o.items, []);
    const d = o.delivery ? parseJson<Delivery | null>(o.delivery, null) : null;
    const body = `🛒 Pedido ${o.code} registrado${o.source === 'AI' ? ' pela IA' : ''}: ${itemsText(items)} (${o.type === 'ONLINE' ? 'online' : 'físico'})${d ? `\n🚚 Entrega: ${deliveryText(d)}` : ''}${via ? `\n${via}` : ''}`;
    await prisma.message.create({ data: { orgId: o.orgId, conversationId: o.conversationId, direction: 'INTERNAL', sender: 'system', type: 'note', body, status: 'NOTE' } });
  } catch (e) {
    console.error('[pedidos] falha ao registrar nota na conversa', (e as Error).message);
  }
}

export function orderTeamMessage(o: Order, clientName: string | null, via: string | null) {
  const items = parseJson<OrderItem[]>(o.items, []);
  const d = o.delivery ? parseJson<Delivery | null>(o.delivery, null) : null;
  const lines = [`🛒 Novo pedido${clientName ? ` de ${clientName}` : ''}: *${o.code}*`, `📦 ${itemsText(items)}`, `🏷 ${o.type === 'ONLINE' ? 'Online' : 'Físico'}`];
  if (o.description) lines.push(`📝 ${o.description}`);
  if (d) lines.push(`🚚 Entrega: ${deliveryText(d)}`);
  lines.push(`👤 Registrado por: ${o.source === 'AI' ? 'IA (WhatsApp)' : 'equipe'}`);
  if (via) lines.push(via);
  return lines.join('\n');
}

/** Avisa o(s) dono(s) e a equipe ativa pelo WhatsApp da empresa (mesmos destinatários dos avisos de reunião). */
async function notifyOrderTeam(o: Order) {
  try {
    const s = await getSettings(o.orgId);
    const to: { phone: string; target: string }[] = [];
    if (s.notifyOwner) for (const ow of await ownerPhones(o.orgId)) if (ow.phone) to.push({ phone: ow.phone, target: 'dono' });
    for (const m of s.teamContacts) if (m.active) to.push({ phone: m.phone, target: 'equipe' });
    if (!to.length) return;
    const contact = o.contactId ? await prisma.contact.findFirst({ where: { id: o.contactId, orgId: o.orgId }, select: { name: true, phone: true } }) : null;
    const clientPhone = contact?.phone.replace(/\D/g, '');
    const text = orderTeamMessage(o, contact ? contact.name ?? contact.phone : null, await viaOf(o));
    const seen = new Set<string>(clientPhone ? [clientPhone] : []);
    for (const r of to) {
      if (seen.has(r.phone)) continue;
      seen.add(r.phone);
      try { await sendToPhone(o, r.phone, text); } catch (e) {
        await audit(null, 'pedido.aviso_falha', { orgId: o.orgId, entity: 'order', entityId: o.id, meta: { target: r.target, error: (e as Error).message } }).catch(() => undefined);
      }
    }
  } catch (e) {
    console.error('[pedidos] aviso à equipe falhou', (e as Error).message);
  }
}

// ---------------- Criação ----------------

export interface OrderInput {
  type: 'FISICO' | 'ONLINE'; items: OrderItem[]; description?: string | null; delivery?: Delivery | null;
  contactId?: string | null; conversationId?: string | null; channelId?: string | null; notes?: string | null;
}

export async function createOrder(input: OrderInput, ctx: { orgId: string; userId?: string | null; req?: Request | null; source?: 'AI' | 'MANUAL' }): Promise<Order> {
  if (!input.items.length) throw new HttpError(400, 'Informe ao menos um item');
  if (input.contactId && !(await prisma.contact.findFirst({ where: { id: input.contactId, orgId: ctx.orgId }, select: { id: true } }))) throw notFound('Contato');
  let channelId = input.channelId ?? null;
  if (input.conversationId) {
    const c = await prisma.conversation.findFirst({ where: { id: input.conversationId, orgId: ctx.orgId }, select: { channelId: true } });
    if (!c) throw notFound('Conversa');
    channelId = channelId ?? c.channelId ?? null;
  }
  if (channelId && !(await prisma.channel.findFirst({ where: { id: channelId, orgId: ctx.orgId }, select: { id: true } }))) throw notFound('Canal WhatsApp');
  let o: Order | null = null;
  for (let i = 0; i < 3 && !o; i++) {
    try {
      o = await prisma.order.create({
        data: {
          orgId: ctx.orgId, code: newCode(), type: input.type, items: JSON.stringify(input.items), description: input.description || null,
          delivery: input.delivery ? JSON.stringify(input.delivery) : null, source: ctx.source ?? 'MANUAL', notes: input.notes || null,
          fingerprint: orderFingerprint(input.type, input.items), contactId: input.contactId || null, conversationId: input.conversationId || null, channelId,
        },
      });
    } catch (e) { if (i === 2) throw e; }
  }
  await audit(ctx.req ?? null, ctx.source === 'AI' ? 'pedido.ai_create' : 'pedido.create', { orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'order', entityId: o!.id, meta: { code: o!.code, type: o!.type, items: input.items.length, delivery: !!input.delivery } });
  if (o!.conversationId) await tagConversation(ctx.orgId, o!.conversationId, 'PEDIDO');
  await noteOrderInConversation(o!);
  await notifyOrderTeam(o!);
  return o!;
}

export async function updateOrderStatus(id: string, status: OrderStatus, ctx: { orgId: string; userId?: string | null; req?: Request | null }, notes?: string | null) {
  const cur = await prisma.order.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!cur) throw notFound('Pedido');
  const data: any = { status };
  if (notes !== undefined) data.notes = notes ? String(notes).slice(0, 1000) : null;
  await prisma.order.updateMany({ where: { id, orgId: ctx.orgId }, data });
  await audit(ctx.req ?? null, 'pedido.status', { orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'order', entityId: id, meta: { from: cur.status, to: status } });
  return (await prisma.order.findFirst({ where: { id, orgId: ctx.orgId } }))!;
}

// ---------------- Marcador [PEDIDO:{...}] da IA ----------------

/** Fila por contato: dois pedidos simultâneos do mesmo cliente não passam juntos pela checagem de duplicata. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try { return await run; } finally { if (locks.get(key) === tail) locks.delete(key); }
}

/**
 * Confirmação explícita: o cliente respondeu "sim" a uma mensagem anterior da IA/sistema que resumiu
 * o pedido (cita "pedido" e todos os itens). Sem isso o sistema pergunta antes de registrar.
 */
export function isOrderConfirmed(args: { clientText: string; lastAssistant: string | null; items: OrderItem[] }) {
  if (!args.lastAssistant || !isAffirmative(args.clientText)) return false;
  const last = norm(stripSystemLinks(args.lastAssistant));
  if (!/pedido/.test(last)) return false;
  // Palavra inteira ("osso" não casa com "posso").
  const lastWords = new Set(last.split(/[^a-z0-9]+/).filter(Boolean));
  return args.items.every((i) => {
    const words = norm(i.nome).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return words.length ? words.some((w) => lastWords.has(w)) : last.includes(norm(i.nome));
  });
}

const confirmQuestion = (type: 'FISICO' | 'ONLINE', items: OrderItem[], d: Delivery | null) =>
  `Só para confirmar, posso registrar o seu pedido?\n📦 ${itemsText(items)} (${type === 'ONLINE' ? 'online' : 'físico'})${d ? `\n🚚 Entrega: ${deliveryText(d)}` : ''}\nResponda *sim* para confirmar.`;

export interface OrderTagResult { text: string; orderId?: string; reused?: boolean; needsConfirmation?: boolean; missingDelivery?: string[]; ignored?: boolean }

/**
 * Processa o marcador [PEDIDO:{...}] (já com o texto da resposta): só quando a empresa atende pedidos,
 * exige os dados de entrega conforme a configuração (Físico / Online / "Solicitar dados de entrega"),
 * exige a confirmação do cliente, reaproveita pedido igual recente (sem duplicar) e registra o pedido.
 * `text` deve vir já sem os outros marcadores; o resultado troca o marcador pela confirmação do código.
 */
export async function applyOrderTag(args: { orgId: string; conversationId: string; text: string; cleanText: string; clientText?: string }): Promise<OrderTagResult> {
  const mk = findJsonMarkers(args.text, 'PEDIDO')[0];
  if (!mk) return { text: args.cleanText };
  const s = await getSettings(args.orgId);
  if (!handlesOrders(s) || !args.conversationId) return { text: args.cleanText, ignored: true };
  const conv = await prisma.conversation.findFirst({ where: { id: args.conversationId, orgId: args.orgId } });
  if (!conv) return { text: args.cleanText, ignored: true };
  let data: any;
  try { data = JSON.parse(mk.json); } catch { return { text: args.cleanText, ignored: true }; }
  const items = normalizeItems(data?.itens ?? data?.items);
  if (!items.length) return { text: args.cleanText, ignored: true };
  const type = orderTypeFor(s, data?.tipo);
  const wantDelivery = needsDelivery(s, type);
  let delivery: Delivery | null = null;
  if (wantDelivery) {
    const nd = normalizeDelivery(data?.entrega ?? {});
    if (nd.missing.length) {
      return { text: `Para registrar o pedido, preciso dos dados de entrega: ${nd.missing.join(', ')}. Pode me enviar?`, missingDelivery: nd.missing };
    }
    delivery = nd.delivery;
  }
  const fingerprint = orderFingerprint(type, items);
  return withLock(`${args.orgId}:${conv.contactId}`, async () => {
    // Idempotência: mesmo cliente, mesmos itens nas últimas 24 h (não cancelado) → reaproveita.
    const same = await prisma.order.findFirst({ where: { orgId: args.orgId, contactId: conv.contactId, fingerprint, status: { not: 'CANCELADO' }, createdAt: { gte: new Date(Date.now() - 24 * 3600e3) } }, orderBy: { createdAt: 'desc' } });
    if (same) return { text: `${args.cleanText || 'Seu pedido já está registrado.'}\n\n🧾 Pedido *${same.code}* registrado.`.trim(), orderId: same.id, reused: true };
    const lastOut = await prisma.message.findFirst({ where: { orgId: args.orgId, conversationId: conv.id, direction: 'OUT', status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, select: { body: true } });
    const lastIn = args.clientText ?? (await prisma.message.findFirst({ where: { orgId: args.orgId, conversationId: conv.id, direction: 'IN' }, orderBy: { createdAt: 'desc' }, select: { body: true } }))?.body ?? '';
    if (!isOrderConfirmed({ clientText: lastIn, lastAssistant: lastOut?.body ?? null, items })) {
      return { text: confirmQuestion(type, items, delivery), needsConfirmation: true };
    }
    const o = await createOrder({ type, items, description: data?.descricao ? str(data.descricao, 500) : null, delivery, contactId: conv.contactId, conversationId: conv.id }, { orgId: args.orgId, source: 'AI' });
    return { text: `${args.cleanText || 'Pedido registrado!'}\n\n🧾 Pedido *${o.code}* registrado. A equipe já foi avisada.`.trim(), orderId: o.id };
  });
}
