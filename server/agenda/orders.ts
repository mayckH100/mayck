import { createHash, randomInt } from 'node:crypto';
import type { Order } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { HttpError, notFound } from '../lib/http.js';
import { channelLabels, type ChannelLabelInfo } from '../whatsapp/channelLabel.js';
import { sendOutbound } from '../whatsapp/messaging.js';
import { normalizePhone } from '../routes/contacts.js';
import { findJsonMarkers, isAffirmative, stripSystemLinks, TIPO_ALL_RE } from './ai.js';
import { contactLabel, linkFor, notifyStaffEventInBackground, orderAlertText, userName } from '../whatsapp/staffAlerts.js';
import { getSettings, handlesMeetings, handlesOrders, ownerPhones, sendToPhone, viaOf, type AgendaSettingsView } from './service.js';

// ---------------- Tipos e rótulos ----------------

export type OrderStatus =
  | 'NOVO' | 'CONFIRMADO' | 'EM_SEPARACAO' | 'PRONTO_RETIRADA' | 'EM_TRANSPORTE' | 'SAIU_ENTREGA' | 'ENTREGUE' | 'FINALIZADO'
  | 'CANCELADO' | 'SUSPENSO' | 'ATRASADO' | 'DEVOLVIDO';
/** Fluxo normal (pedido online pode pular as etapas de envio, ex.: Confirmado → Entregue/Finalizado). */
export const ORDER_FLOW: OrderStatus[] = ['NOVO', 'CONFIRMADO', 'EM_SEPARACAO', 'PRONTO_RETIRADA', 'EM_TRANSPORTE', 'SAIU_ENTREGA', 'ENTREGUE', 'FINALIZADO'];
/** Exceções. */
export const ORDER_EXCEPTIONS: OrderStatus[] = ['CANCELADO', 'SUSPENSO', 'ATRASADO', 'DEVOLVIDO'];
export const ORDER_STATUSES: OrderStatus[] = [...ORDER_FLOW, ...ORDER_EXCEPTIONS];
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  NOVO: 'Novo', CONFIRMADO: 'Confirmado', EM_SEPARACAO: 'Em separação (preparando)', PRONTO_RETIRADA: 'Pronto para retirada', EM_TRANSPORTE: 'Em transporte',
  SAIU_ENTREGA: 'Saiu para entrega', ENTREGUE: 'Entregue', FINALIZADO: 'Finalizado', CANCELADO: 'Cancelado', SUSPENSO: 'Suspenso', ATRASADO: 'Atrasado', DEVOLVIDO: 'Devolvido',
};
/** Grupos para filtro no painel. */
export const ORDER_GROUPS: Record<string, OrderStatus[]> = {
  abertos: ['NOVO', 'CONFIRMADO'],
  preparo: ['EM_SEPARACAO', 'PRONTO_RETIRADA'],
  entrega: ['EM_TRANSPORTE', 'SAIU_ENTREGA'],
  concluidos: ['ENTREGUE', 'FINALIZADO'],
  excecoes: ['SUSPENSO', 'ATRASADO', 'DEVOLVIDO'],
  cancelados: ['CANCELADO'],
};
/** Valores antigos (antes da 0029) aceitos na API por compatibilidade. */
export const LEGACY_STATUS: Record<string, OrderStatus> = { EM_ANDAMENTO: 'EM_SEPARACAO', CONCLUIDO: 'FINALIZADO' };

export type PaymentStatus = 'AGUARDANDO' | 'PAGO' | 'PARCIAL' | 'ESTORNADO' | 'NAO_SE_APLICA';
export const PAYMENT_STATUSES: PaymentStatus[] = ['AGUARDANDO', 'PAGO', 'PARCIAL', 'ESTORNADO', 'NAO_SE_APLICA'];
export const PAYMENT_LABEL: Record<PaymentStatus, string> = { AGUARDANDO: 'Aguardando pagamento', PAGO: 'Pago', PARCIAL: 'Parcial', ESTORNADO: 'Estornado/Reembolsado', NAO_SE_APLICA: 'Não se aplica' };

/**
 * Regras de transição (mudança pelo seletor de status):
 * - Cancelar só pela ação "Cancelar pedido" (com motivo).
 * - Cancelado é final; só Dono/Admin reabre (→ Novo).
 * - Finalizado é final; só pode virar Devolvido.
 * - Entre os demais vale qualquer mudança (permite pular etapas e voltar uma etapa).
 */
export function transitionError(from: string, to: OrderStatus, opts: { admin: boolean }): string | null {
  if (from === to) return 'O pedido já está nesse status';
  if (to === 'CANCELADO') return 'Para cancelar, use "Cancelar pedido" e informe o motivo';
  if (from === 'CANCELADO') return to === 'NOVO' ? (opts.admin ? null : 'Só donos e administradores reabrem pedido cancelado') : 'Pedido cancelado: reabra como "Novo" antes de mudar o status';
  if (from === 'FINALIZADO' && to !== 'DEVOLVIDO') return 'Pedido finalizado só pode ser marcado como Devolvido';
  return null;
}

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
    id: o.id, code: o.code, type: o.type, status: o.status, statusLabel: ORDER_STATUS_LABEL[o.status as OrderStatus] ?? o.status,
    paymentStatus: o.paymentStatus, paymentLabel: PAYMENT_LABEL[o.paymentStatus as PaymentStatus] ?? o.paymentStatus,
    extraContacts: orderExtrasOf(o), cancelReason: o.cancelReason ?? null,
    source: o.source, description: o.description, notes: o.notes,
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
async function notifyOrderTeam(o: Order, build?: (clientName: string | null, via: string | null) => string): Promise<string[]> {
  const delivered: string[] = [];
  try {
    const s = await getSettings(o.orgId);
    const to: { phone: string; target: string }[] = [];
    if (s.notifyOwner) for (const ow of await ownerPhones(o.orgId)) if (ow.phone) to.push({ phone: ow.phone, target: 'dono' });
    for (const m of s.teamContacts) if (m.active) to.push({ phone: m.phone, target: 'equipe' });
    if (!to.length) return delivered;
    const contact = o.contactId ? await prisma.contact.findFirst({ where: { id: o.contactId, orgId: o.orgId }, select: { name: true, phone: true } }) : null;
    const clientPhone = contact?.phone.replace(/\D/g, '');
    const clientName = contact ? contact.name ?? contact.phone : null;
    const text = (build ?? ((n, v) => orderTeamMessage(o, n, v)))(clientName, await viaOf(o));
    const seen = new Set<string>(clientPhone ? [clientPhone] : []);
    for (const r of to) {
      if (seen.has(r.phone)) continue;
      seen.add(r.phone);
      try { await sendToPhone(o, r.phone, text); delivered.push(r.phone); } catch (e) {
        await audit(null, 'pedido.aviso_falha', { orgId: o.orgId, entity: 'order', entityId: o.id, meta: { target: r.target, error: (e as Error).message } }).catch(() => undefined);
      }
    }
  } catch (e) {
    console.error('[pedidos] aviso à equipe falhou', (e as Error).message);
  }
  return delivered;
}

// ---------------- Criação ----------------

export interface OrderInput {
  type: 'FISICO' | 'ONLINE'; items: OrderItem[]; description?: string | null; delivery?: Delivery | null;
  contactId?: string | null; conversationId?: string | null; channelId?: string | null; notes?: string | null;
  extraContacts?: { name?: string | null; phone: string }[];
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
  const extras = JSON.stringify(normalizeOrderExtras(input.extraContacts));
  let o: Order | null = null;
  for (let i = 0; i < 3 && !o; i++) {
    try {
      o = await prisma.order.create({
        data: {
          orgId: ctx.orgId, code: newCode(), type: input.type, items: JSON.stringify(input.items), description: input.description || null,
          delivery: input.delivery ? JSON.stringify(input.delivery) : null, source: ctx.source ?? 'MANUAL', notes: input.notes || null,
          fingerprint: orderFingerprint(input.type, input.items), contactId: input.contactId || null, conversationId: input.conversationId || null, channelId,
          extraContacts: extras,
        },
      });
    } catch (e) { if (i === 2) throw e; }
  }
  await audit(ctx.req ?? null, ctx.source === 'AI' ? 'pedido.ai_create' : 'pedido.create', { orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'order', entityId: o!.id, meta: { code: o!.code, type: o!.type, items: input.items.length, delivery: !!input.delivery } });
  await addHistory(o!, 'STATUS', null, 'NOVO', ctx.source === 'AI' ? 'Pedido registrado pela IA (WhatsApp)' : 'Pedido registrado', ctx.userId);
  if (o!.conversationId) await tagConversation(ctx.orgId, o!.conversationId, 'PEDIDO');
  await noteOrderInConversation(o!);
  const delivered = await notifyOrderTeam(o!);
  // Aviso para os "Números de aviso (WhatsApp)" do Perfil (em segundo plano; quem já recebeu acima não recebe de novo).
  const ord = o!;
  notifyStaffEventInBackground({
    orgId: ord.orgId, event: 'order', key: ord.id, channelId: ord.channelId, createdByUserId: ctx.userId ?? null, manual: ord.source !== 'AI',
    skipPhones: delivered, emailUrl: linkFor(ord.conversationId, '/agenda'),
    text: async () => orderAlertText({
      title: `🛒 Novo pedido ${ord.code}`, who: await contactLabel(ord.orgId, ord.contactId), items: itemsText(parseJson<OrderItem[]>(ord.items, [])),
      extra: `Tipo: ${ord.type === 'ONLINE' ? 'Online' : 'Físico'}`,
      by: ord.source === 'AI' ? 'IA (WhatsApp)' : (await userName(ctx.userId)) ?? 'equipe',
      via: (await viaOf(ord).catch(() => '')).replace(/^📲 Via: /, ''), url: linkFor(ord.conversationId, '/agenda'),
    }),
  });
  return ord;
}

// ---------------- Contatos adicionais, histórico e avisos ao cliente ----------------

export const MAX_ORDER_EXTRAS = 5;
export interface OrderExtraContact { name: string | null; phone: string }

export const orderExtrasOf = (o: Pick<Order, 'extraContacts'>): OrderExtraContact[] =>
  parseJson<OrderExtraContact[]>(o.extraContacts, []).filter((c) => c && typeof c.phone === 'string');

/** Valida e normaliza os contatos adicionais do pedido (telefone obrigatório e válido, sem repetidos, máx. 5). */
export function normalizeOrderExtras(list: { name?: string | null; phone: string }[] | undefined | null): OrderExtraContact[] {
  const arr = list ?? [];
  if (arr.length > MAX_ORDER_EXTRAS) throw new HttpError(400, `No máximo ${MAX_ORDER_EXTRAS} contatos adicionais por pedido`);
  const out: OrderExtraContact[] = [];
  for (const [i, c] of arr.entries()) {
    const phone = normalizePhone(String(c?.phone ?? ''));
    if (!phone) throw new HttpError(400, `Contato adicional ${i + 1}: telefone inválido`);
    if (out.some((o) => o.phone === phone)) throw new HttpError(400, `Contato adicional ${i + 1}: telefone repetido`);
    const name = str(c?.name, 80);
    out.push({ name: name || null, phone });
  }
  return out;
}

/** Chaves de comparação de um telefone BR (com e sem o 9º dígito), para o opt-out valer nas duas grafias. */
export function phoneKeys(raw: string | null | undefined): string[] {
  const d = normalizePhone(String(raw ?? '')) ?? String(raw ?? '').replace(/\D/g, '');
  if (!d) return [];
  const keys = [d];
  if (/^55\d{2}9\d{8}$/.test(d)) keys.push(d.slice(0, 4) + d.slice(5));
  else if (/^55\d{2}\d{8}$/.test(d)) keys.push(d.slice(0, 4) + '9' + d.slice(4));
  return keys;
}

/** Telefones de contatos da organização que pediram para não receber mensagens (opt-out). */
async function optOutKeys(orgId: string) {
  const list = await prisma.contact.findMany({ where: { orgId, optOut: true }, select: { phone: true, waId: true } });
  const set = new Set<string>();
  for (const c of list) for (const k of [...phoneKeys(c.waId), ...phoneKeys(c.phone)]) set.add(k);
  return set;
}

export interface OrderNotifyResult { target: 'cliente' | 'adicional'; ok: boolean; skipped?: 'opt-out' | 'sem-telefone'; error?: string }

export type OrderCtx = { orgId: string; userId?: string | null; req?: Request | null };

async function conversationForOrder(o: Order) {
  if (!o.contactId) return null;
  if (o.conversationId) {
    const c = await prisma.conversation.findFirst({ where: { id: o.conversationId, orgId: o.orgId } });
    if (c) return c;
  }
  const last = await prisma.conversation.findFirst({ where: { orgId: o.orgId, contactId: o.contactId }, orderBy: { createdAt: 'desc' } });
  return last ?? prisma.conversation.create({ data: { orgId: o.orgId, contactId: o.contactId, channelId: o.channelId, status: 'CLOSED', closedAt: new Date() } });
}

/**
 * Avisa por WhatsApp o cliente e os contatos adicionais do pedido, pelo MESMO WhatsApp que recebeu o pedido
 * (sem canal: o padrão da organização). Quem pediu opt-out nunca recebe. Telefones repetidos recebem uma vez.
 * Cada envio é independente: a falha de um não impede os demais.
 */
export async function notifyOrderParties(o: Order, text: (forClient: boolean) => string, ctx: OrderCtx): Promise<OrderNotifyResult[]> {
  const results: OrderNotifyResult[] = [];
  const blocked = await optOutKeys(o.orgId);
  const seen = new Set<string>();
  const org = await prisma.organization.findUnique({ where: { id: o.orgId }, select: { name: true } });
  const sign = (t: string) => (org?.name ? `${t}\n\n— ${org.name}` : t);
  if (o.contactId) {
    const contact = await prisma.contact.findFirst({ where: { id: o.contactId, orgId: o.orgId } });
    if (contact) {
      const keys = [...phoneKeys(contact.waId), ...phoneKeys(contact.phone)];
      keys.forEach((k) => seen.add(k));
      if (contact.optOut || keys.some((k) => blocked.has(k))) results.push({ target: 'cliente', ok: false, skipped: 'opt-out' });
      else {
        try {
          const conv = await conversationForOrder(o);
          // Mesmo WhatsApp que recebeu o pedido (o envio resolve o canal pela conversa).
          const m = await sendOutbound({ conversation: { ...conv!, channelId: o.channelId ?? conv!.channelId }, contact, payload: { type: 'text', text: sign(text(true)) }, sender: 'system', authorUserId: ctx.userId ?? undefined });
          results.push(m.status === 'FAILED' ? { target: 'cliente', ok: false, error: m.error ?? 'Falha no envio' } : { target: 'cliente', ok: true });
        } catch (e) {
          results.push({ target: 'cliente', ok: false, error: (e as Error).message });
        }
      }
    }
  }
  const extras = orderExtrasOf(o);
  if (extras.length) {
    const body = sign(text(false));
    for (const c of extras) {
      const keys = phoneKeys(c.phone);
      if (!keys.length) { results.push({ target: 'adicional', ok: false, skipped: 'sem-telefone' }); continue; }
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      if (keys.some((k) => blocked.has(k))) { results.push({ target: 'adicional', ok: false, skipped: 'opt-out' }); continue; }
      try {
        await sendToPhone({ orgId: o.orgId, conversationId: null, channelId: o.channelId }, keys[0], body);
        results.push({ target: 'adicional', ok: true });
      } catch (e) {
        const error = (e as Error).message;
        await audit(null, 'pedido.aviso_falha', { orgId: o.orgId, entity: 'order', entityId: o.id, meta: { target: 'adicional', error } }).catch(() => undefined);
        results.push({ target: 'adicional', ok: false, error });
      }
    }
  }
  return results;
}

const notifyStats = (r: OrderNotifyResult[]) => ({ sent: r.filter((x) => x.ok).length, skipped: r.filter((x) => x.skipped).length, failed: r.filter((x) => !x.ok && !x.skipped).length });

async function addHistory(o: Pick<Order, 'id' | 'orgId'>, kind: 'STATUS' | 'PAGAMENTO' | 'EDICAO' | 'CANCELAMENTO', fromValue: string | null, toValue: string | null, note: string | null, userId: string | null | undefined, notified = 0) {
  await prisma.orderStatusHistory.create({ data: { orgId: o.orgId, orderId: o.id, kind, fromValue, toValue, note: note ? note.slice(0, 1000) : null, userId: userId ?? null, notified } });
}

async function noteInOrderConversation(o: Order, body: string) {
  if (!o.conversationId) return;
  try {
    await prisma.message.create({ data: { orgId: o.orgId, conversationId: o.conversationId, direction: 'INTERNAL', sender: 'system', type: 'note', body, status: 'NOTE' } });
  } catch (e) {
    console.error('[pedidos] falha ao registrar nota na conversa', (e as Error).message);
  }
}

const statusLabel = (s: string) => ORDER_STATUS_LABEL[s as OrderStatus] ?? s;
const paymentLabel = (s: string) => PAYMENT_LABEL[s as PaymentStatus] ?? s;

export function statusMessage(o: Pick<Order, 'code'>, status: string, forClient: boolean, note?: string | null, payment?: string | null) {
  const lines = [`📦 Atualização ${forClient ? 'do seu pedido' : 'do pedido'} *${o.code}*`, `Novo status: *${statusLabel(status)}*`];
  if (payment) lines.push(`💳 Pagamento: *${paymentLabel(payment)}*`);
  if (note) lines.push(`📝 Observação da loja: ${note}`);
  return lines.join('\n');
}

export function paymentMessage(o: Pick<Order, 'code'>, payment: string, forClient: boolean, note?: string | null) {
  const lines = [`💳 Pagamento ${forClient ? 'do seu pedido' : 'do pedido'} *${o.code}*: *${paymentLabel(payment)}*`];
  if (note) lines.push(`📝 Observação da loja: ${note}`);
  return lines.join('\n');
}

export function cancelMessage(o: Pick<Order, 'code'>, reason: string, forClient: boolean) {
  return `❌ ${forClient ? 'Seu pedido' : 'O pedido'} *${o.code}* foi cancelado pela loja.\nMotivo: ${reason}`;
}

export function editMessage(o: Pick<Order, 'code'>, changes: string[], forClient: boolean, note?: string | null) {
  const lines = [`✏️ ${forClient ? 'Seu pedido' : 'O pedido'} *${o.code}* foi alterado pela loja:`, ...changes.map((c) => `• ${c}`)];
  if (note) lines.push(`📝 Observação da loja: ${note}`);
  return lines.join('\n');
}

const cleanNote = (n: unknown) => (n == null ? null : str(n, 500) || null);

/** Muda o status e/ou o pagamento do pedido (independentes), grava o histórico e avisa cliente + contatos adicionais. */
export async function changeOrder(id: string, input: { status?: string; paymentStatus?: string; note?: string | null; notify?: boolean }, ctx: OrderCtx & { admin: boolean }) {
  const cur = await prisma.order.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!cur) throw notFound('Pedido');
  const status = input.status ? (LEGACY_STATUS[input.status] ?? input.status) as OrderStatus : undefined;
  if (status && !ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Status inválido');
  if (input.paymentStatus && !PAYMENT_STATUSES.includes(input.paymentStatus as PaymentStatus)) throw new HttpError(400, 'Status de pagamento inválido');
  const statusChange = !!status && status !== cur.status;
  const payChange = !!input.paymentStatus && input.paymentStatus !== cur.paymentStatus;
  if (status && !statusChange && !payChange) throw new HttpError(400, 'O pedido já está nesse status');
  if (!statusChange && !payChange) throw new HttpError(400, 'Nada para alterar');
  if (statusChange) {
    const err = transitionError(cur.status, status!, { admin: ctx.admin });
    if (err) throw new HttpError(cur.status === 'CANCELADO' && status === 'NOVO' ? 403 : 400, err);
  }
  const note = cleanNote(input.note);
  const data: any = {};
  if (statusChange) { data.status = status; if (cur.status === 'CANCELADO') data.cancelReason = null; }
  if (payChange) data.paymentStatus = input.paymentStatus;
  await prisma.order.updateMany({ where: { id, orgId: ctx.orgId }, data });
  const o = (await prisma.order.findFirst({ where: { id, orgId: ctx.orgId } }))!;
  // Padrão: mudança de status avisa; mudança só de pagamento não avisa (a não ser que peçam).
  const notify = input.notify ?? statusChange;
  const results = notify
    ? await notifyOrderParties(o, (fc) => (statusChange ? statusMessage(o, o.status, fc, note, payChange ? o.paymentStatus : null) : paymentMessage(o, o.paymentStatus, fc, note)), ctx)
    : [];
  const st = notifyStats(results);
  if (statusChange) await addHistory(o, 'STATUS', cur.status, o.status, note, ctx.userId, st.sent);
  if (payChange) await addHistory(o, 'PAGAMENTO', cur.paymentStatus, o.paymentStatus, statusChange ? null : note, ctx.userId, statusChange ? 0 : st.sent);
  await audit(ctx.req ?? null, 'pedido.status', {
    orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'order', entityId: o.id,
    meta: { code: o.code, ...(statusChange ? { from: cur.status, to: o.status } : {}), ...(payChange ? { paymentFrom: cur.paymentStatus, paymentTo: o.paymentStatus } : {}), notify, ...st },
  });
  const parts = [statusChange ? `status ${statusLabel(cur.status)} → ${statusLabel(o.status)}` : '', payChange ? `pagamento ${paymentLabel(cur.paymentStatus)} → ${paymentLabel(o.paymentStatus)}` : ''].filter(Boolean);
  await noteInOrderConversation(o, `🔄 Pedido ${o.code}: ${parts.join('; ')}${note ? `\n📝 ${note}` : ''}${notify ? `\n📣 Avisos enviados: ${st.sent}` : ''}`);
  return { order: o, notifications: results };
}

export interface OrderEditInput {
  type?: 'FISICO' | 'ONLINE'; items?: unknown[]; description?: string | null; delivery?: Record<string, unknown> | null;
  extraContacts?: { name?: string | null; phone: string }[]; notify?: boolean; note?: string | null;
}

/** Loja edita o pedido (itens, tipo, descrição, entrega, contatos adicionais); opcionalmente avisa o cliente com o resumo. */
export async function editOrder(id: string, input: OrderEditInput, ctx: OrderCtx) {
  const cur = await prisma.order.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!cur) throw notFound('Pedido');
  if (cur.status === 'CANCELADO' || cur.status === 'FINALIZADO') throw new HttpError(400, `Pedido ${cur.status === 'CANCELADO' ? 'cancelado' : 'finalizado'} não pode ser editado`);
  const data: any = {};
  const fields: string[] = [];
  const changes: string[] = [];
  let type = cur.type as 'FISICO' | 'ONLINE';
  let items = parseJson<OrderItem[]>(cur.items, []);
  if (input.type && input.type !== cur.type) {
    type = input.type; data.type = type; fields.push('tipo'); changes.push(`Tipo: ${type === 'ONLINE' ? 'Online' : 'Físico'}`);
  }
  if (input.items !== undefined) {
    const next = normalizeItems(input.items);
    if (!next.length) throw new HttpError(400, 'Informe ao menos um item');
    if (JSON.stringify(next) !== JSON.stringify(items)) { items = next; data.items = JSON.stringify(next); fields.push('itens'); changes.push(`Itens: ${itemsText(next)}`); }
  }
  if (data.type || data.items) data.fingerprint = orderFingerprint(type, items);
  if (input.description !== undefined) {
    const d = input.description ? str(input.description, 500) : '';
    if ((d || null) !== (cur.description || null)) { data.description = d || null; fields.push('descrição'); changes.push(d ? `Descrição: ${d}` : 'Descrição removida'); }
  }
  if (input.delivery !== undefined) {
    if (input.delivery === null) {
      if (cur.delivery) { data.delivery = null; fields.push('entrega'); changes.push('Dados de entrega removidos'); }
    } else {
      const nd = normalizeDelivery(input.delivery);
      if (nd.missing.length) throw new HttpError(400, `Dados de entrega incompletos: ${nd.missing.join(', ')}`);
      const j = JSON.stringify(nd.delivery);
      if (j !== cur.delivery) { data.delivery = j; fields.push('entrega'); changes.push(`Entrega: ${deliveryText(nd.delivery)}`); }
    }
  }
  if (input.extraContacts !== undefined) {
    const ex = normalizeOrderExtras(input.extraContacts);
    if (JSON.stringify(ex) !== JSON.stringify(orderExtrasOf(cur))) { data.extraContacts = JSON.stringify(ex); fields.push('contatos adicionais'); changes.push('Contatos que recebem os avisos do pedido atualizados'); }
  }
  if (!fields.length) throw new HttpError(400, 'Nenhuma alteração no pedido');
  await prisma.order.updateMany({ where: { id, orgId: ctx.orgId }, data });
  const o = (await prisma.order.findFirst({ where: { id, orgId: ctx.orgId } }))!;
  const note = cleanNote(input.note);
  const notify = input.notify ?? false; // edição: padrão desligado
  const results = notify ? await notifyOrderParties(o, (fc) => editMessage(o, changes, fc, note), ctx) : [];
  const st = notifyStats(results);
  const label = fields.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join(', ');
  await addHistory(o, 'EDICAO', null, null, `Alterado: ${label}${note ? ` — ${note}` : ''}`, ctx.userId, st.sent);
  await audit(ctx.req ?? null, 'pedido.edit', { orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'order', entityId: o.id, meta: { code: o.code, fields, notify, ...st } });
  await noteInOrderConversation(o, `✏️ Pedido ${o.code} alterado: ${label}${notify ? `\n📣 Avisos enviados: ${st.sent}` : ''}`);
  return { order: o, notifications: results, fields };
}

/** Cancela o pedido (qualquer status exceto Finalizado) com motivo; sempre avisa cliente + adicionais e a equipe. */
export async function cancelOrder(id: string, reasonRaw: string, ctx: OrderCtx) {
  const cur = await prisma.order.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!cur) throw notFound('Pedido');
  if (cur.status === 'CANCELADO') throw new HttpError(400, 'O pedido já está cancelado');
  if (cur.status === 'FINALIZADO') throw new HttpError(400, 'Pedido finalizado não pode ser cancelado');
  const reason = str(reasonRaw, 500);
  if (reason.length < 3) throw new HttpError(400, 'Informe o motivo do cancelamento');
  await prisma.order.updateMany({ where: { id, orgId: ctx.orgId }, data: { status: 'CANCELADO', cancelReason: reason } });
  const o = (await prisma.order.findFirst({ where: { id, orgId: ctx.orgId } }))!;
  const results = await notifyOrderParties(o, (fc) => cancelMessage(o, reason, fc), ctx);
  const st = notifyStats(results);
  const by = ctx.userId ? (await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name ?? null : null;
  await notifyOrderTeam(o, (clientName, via) => [`❌ Pedido *${o.code}* cancelado${clientName ? ` (cliente: ${clientName})` : ''}`, `Motivo: ${reason}`, ...(by ? [`👤 Cancelado por: ${by}`] : []), ...(via ? [via] : [])].join('\n'));
  await addHistory(o, 'CANCELAMENTO', cur.status, 'CANCELADO', reason, ctx.userId, st.sent);
  await audit(ctx.req ?? null, 'pedido.cancel', { orgId: ctx.orgId, userId: ctx.userId ?? null, entity: 'order', entityId: o.id, meta: { code: o.code, from: cur.status, ...st } });
  await noteInOrderConversation(o, `❌ Pedido ${o.code} cancelado (${statusLabel(cur.status)} → Cancelado)\nMotivo: ${reason}\n📣 Avisos enviados: ${st.sent}`);
  return { order: o, notifications: results };
}

/** Linha do tempo do pedido (mais antigo primeiro), com o nome de quem mudou. */
export async function orderHistory(id: string, orgId: string) {
  const o = await prisma.order.findFirst({ where: { id, orgId }, select: { id: true } });
  if (!o) throw notFound('Pedido');
  const rows = await prisma.orderStatusHistory.findMany({ where: { orgId, orderId: id }, orderBy: { createdAt: 'asc' }, take: 500 });
  const uIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))] as string[];
  const users = uIds.length ? await prisma.user.findMany({ where: { id: { in: uIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name] as const));
  const label = (kind: string, v: string | null) => (v == null ? null : kind === 'PAGAMENTO' ? paymentLabel(v) : statusLabel(v));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, from: r.fromValue, to: r.toValue, fromLabel: label(r.kind, r.fromValue), toLabel: label(r.kind, r.toValue),
    note: r.note, notified: r.notified, by: r.userId ? names.get(r.userId) ?? 'Usuário' : 'IA / sistema', createdAt: r.createdAt,
  }));
}

/** Compatibilidade: mudança simples de status (usada por chamadas antigas). */
export async function updateOrderStatus(id: string, status: OrderStatus, ctx: OrderCtx, notes?: string | null) {
  return (await changeOrder(id, { status, note: notes, notify: false }, { ...ctx, admin: true })).order;
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
