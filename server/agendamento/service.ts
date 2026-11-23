/**
 * v1.46.0 — Página pública de agendamento: configuração (dono), consulta de horários e criação do compromisso (cliente).
 * O compromisso nasce pela Agenda (createAppointment): confirma pelo WhatsApp conectado, move o contato para
 * "Reunião agendada" no Kanban, registra nota na conversa e avisa os números de aviso — igual aos outros compromissos.
 */
import QRCode from 'qrcode';
import type { BookingPage, BookingService } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError, notFound } from '../lib/http.js';
import { appUrl } from '../lib/mailer.js';
import { normalizePhone } from '../routes/contacts.js';
import { isProductActive } from '../billing/service.js';
import { busyIntervals, createAppointment, getSettings, orgTz, ConflictError } from '../agenda/service.js';
import { resolveChannel } from '../whatsapp/messaging.js';
import { openConversationFor } from '../whatsapp/multiCanal.js';
import { diasDeAtendimento, horaLocal, horariosDoDia, lerDia, precoBr, slugify, validarNome, validarSlug } from './core.js';
import { parseLocal } from '../agenda/time.js';

export const MAX_SERVICOS = 30;
export const MAX_FUTUROS_POR_TELEFONE = 3;

/** Página da empresa (criada na primeira consulta, desligada, com endereço livre a partir do nome). */
export async function paginaDa(orgId: string): Promise<BookingPage> {
  const ex = await prisma.bookingPage.findUnique({ where: { orgId } });
  if (ex) return ex;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  const base = slugify(org?.name ?? 'empresa');
  for (let i = 0; i < 8; i++) {
    const slug = i === 0 && 'slug' in validarSlug(base) ? base : `${base.slice(0, 33)}-${Math.random().toString(36).slice(2, 7)}`;
    if (await prisma.bookingPage.findUnique({ where: { slug } })) continue;
    try {
      return await prisma.bookingPage.create({ data: { orgId, slug, title: org?.name ?? '' } });
    } catch {
      const again = await prisma.bookingPage.findUnique({ where: { orgId } });
      if (again) return again;
    }
  }
  throw new HttpError(500, 'Não foi possível criar o endereço da página. Tente de novo.');
}

export const urlDaPagina = (slug: string, req?: import('express').Request) => `${appUrl(req)}/agendar/${slug}`;

const servicoView = (s: BookingService) => ({ id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents, price: precoBr(s.priceCents), description: s.description, active: s.active, position: s.position });

/** Tela da Agenda: configuração + serviços + link + QR code. */
export async function configView(orgId: string, req?: import('express').Request) {
  const p = await paginaDa(orgId);
  const servicos = await prisma.bookingService.findMany({ where: { orgId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  const url = urlDaPagina(p.slug, req);
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  const exp = await getSettings(orgId);
  return { enabled: p.enabled, slug: p.slug, title: p.title, intro: p.intro, maxDaysAhead: p.maxDaysAhead, url, qr, services: servicos.map(servicoView), expediente: { workStart: exp.workStart, workEnd: exp.workEnd, workDays: exp.workDays, minNoticeMin: exp.minNoticeMin } };
}

export async function salvarPagina(orgId: string, b: { enabled?: boolean; slug?: string; title?: string; intro?: string; maxDaysAhead?: number }) {
  const p = await paginaDa(orgId);
  const data: Partial<BookingPage> = {};
  if (b.slug !== undefined && b.slug !== p.slug) {
    const v = validarSlug(b.slug);
    if ('erro' in v) throw new HttpError(400, v.erro);
    const dono = await prisma.bookingPage.findUnique({ where: { slug: v.slug } });
    if (dono && dono.orgId !== orgId) throw new HttpError(409, 'Esse endereço já está em uso. Escolha outro.');
    data.slug = v.slug;
  }
  if (b.title !== undefined) data.title = b.title.trim().slice(0, 100);
  if (b.intro !== undefined) data.intro = b.intro.trim().slice(0, 500);
  if (b.maxDaysAhead !== undefined) data.maxDaysAhead = Math.max(1, Math.min(90, Math.round(b.maxDaysAhead)));
  if (b.enabled !== undefined) {
    if (b.enabled && !(await prisma.bookingService.count({ where: { orgId, active: true } }))) throw new HttpError(400, 'Cadastre pelo menos um serviço ativo antes de ligar a página.');
    data.enabled = b.enabled;
  }
  return prisma.bookingPage.update({ where: { orgId }, data });
}

export interface ServicoInput { name: string; durationMin: number; priceCents?: number | null; description?: string; active?: boolean; position?: number }

export async function criarServico(orgId: string, s: ServicoInput) {
  if ((await prisma.bookingService.count({ where: { orgId } })) >= MAX_SERVICOS) throw new HttpError(400, `No máximo ${MAX_SERVICOS} serviços.`);
  await paginaDa(orgId);
  const n = await prisma.bookingService.count({ where: { orgId } });
  return servicoView(await prisma.bookingService.create({ data: { orgId, name: s.name.trim(), durationMin: s.durationMin, priceCents: s.priceCents ?? null, description: (s.description ?? '').trim(), active: s.active ?? true, position: s.position ?? n } }));
}

export async function editarServico(orgId: string, id: string, s: Partial<ServicoInput>) {
  const ex = await prisma.bookingService.findFirst({ where: { id, orgId } });
  if (!ex) throw notFound('Serviço');
  const data: Record<string, unknown> = {};
  if (s.name !== undefined) data.name = s.name.trim();
  if (s.durationMin !== undefined) data.durationMin = s.durationMin;
  if (s.priceCents !== undefined) data.priceCents = s.priceCents;
  if (s.description !== undefined) data.description = s.description.trim();
  if (s.active !== undefined) data.active = s.active;
  if (s.position !== undefined) data.position = s.position;
  const r = servicoView(await prisma.bookingService.update({ where: { id }, data }));
  // Sem serviço ativo, a página sai do ar (o cliente não teria o que escolher).
  if (!(await prisma.bookingService.count({ where: { orgId, active: true } }))) await prisma.bookingPage.updateMany({ where: { orgId }, data: { enabled: false } });
  return r;
}

export async function excluirServico(orgId: string, id: string) {
  const r = await prisma.bookingService.deleteMany({ where: { id, orgId } });
  if (!r.count) throw notFound('Serviço');
  if (!(await prisma.bookingService.count({ where: { orgId, active: true } }))) await prisma.bookingPage.updateMany({ where: { orgId }, data: { enabled: false } });
}

// ---------------- Lado público ----------------

const INDISPONIVEL = 'Página de agendamento indisponível.';

/** Página pública ligada (e empresa com assinatura ativa). */
export async function paginaPublica(slug: string): Promise<BookingPage> {
  const p = /^[a-z0-9-]{3,40}$/.test(slug) ? await prisma.bookingPage.findUnique({ where: { slug } }) : null;
  if (!p || !p.enabled) throw new HttpError(404, INDISPONIVEL);
  if (!(await isProductActive(p.orgId, 'MCKBOT'))) throw new HttpError(404, INDISPONIVEL);
  return p;
}

export async function infoPublica(slug: string, agora = new Date()) {
  const p = await paginaPublica(slug);
  const [org, servicos, exp, tz] = await Promise.all([
    prisma.organization.findUnique({ where: { id: p.orgId }, select: { name: true } }),
    prisma.bookingService.findMany({ where: { orgId: p.orgId, active: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
    getSettings(p.orgId), orgTz(p.orgId),
  ]);
  return {
    empresa: org?.name ?? '', titulo: p.title || org?.name || 'Agendamento', intro: p.intro,
    servicos: servicos.map((s) => ({ id: s.id, nome: s.name, duracaoMin: s.durationMin, preco: precoBr(s.priceCents), descricao: s.description })),
    dias: diasDeAtendimento(exp, tz, agora, p.maxDaysAhead), fuso: tz,
  };
}

async function servicoAtivo(orgId: string, id: string) {
  const s = await prisma.bookingService.findFirst({ where: { id, orgId, active: true } });
  if (!s) throw new HttpError(400, 'Serviço indisponível. Escolha outro.');
  return s;
}

async function livresDoDia(p: BookingPage, dia: string, duracao: number, agora: Date) {
  const d = lerDia(dia);
  if (!d) throw new HttpError(400, 'Dia inválido.');
  const [exp, tz] = await Promise.all([getSettings(p.orgId), orgTz(p.orgId)]);
  const de = parseLocal(`${dia}T00:00`, tz)!;
  const ate = new Date(de.getTime() + 26 * 3600e3);
  const ocupados = await busyIntervals(p.orgId, de, ate);
  return { tz, horarios: horariosDoDia(dia, duracao, exp, ocupados, tz, agora, p.maxDaysAhead) };
}

export async function horariosPublicos(slug: string, servicoId: string, dia: string, agora = new Date()) {
  const p = await paginaPublica(slug);
  const s = await servicoAtivo(p.orgId, servicoId);
  const { tz, horarios } = await livresDoDia(p, dia, s.durationMin, agora);
  return { dia, horarios: horarios.map((h) => horaLocal(h, tz)) };
}

export interface PedidoAgendamento { servicoId: string; dia: string; hora: string; nome: string; whatsapp: string; observacao?: string | null }

export async function agendarPublico(slug: string, b: PedidoAgendamento, agora = new Date()) {
  const p = await paginaPublica(slug);
  const orgId = p.orgId;
  const s = await servicoAtivo(orgId, b.servicoId);
  const nome = validarNome(b.nome);
  if (!nome) throw new HttpError(400, 'Informe seu nome (2 a 80 letras).');
  const phone = normalizePhone(b.whatsapp ?? '');
  if (!phone || !/^55\d{10,11}$/.test(phone)) throw new HttpError(400, 'Informe um WhatsApp válido com DDD (ex.: 11 91234-5678).');
  if (!/^\d{2}:\d{2}$/.test(b.hora ?? '')) throw new HttpError(400, 'Horário inválido.');
  const { tz, horarios } = await livresDoDia(p, b.dia, s.durationMin, agora);
  const inicio = horarios.find((h) => horaLocal(h, tz) === b.hora);
  if (!inicio) throw new HttpError(409, 'Esse horário não está mais livre. Escolha outro.');

  // Contato: o mesmo número com ou sem o 9 é a mesma pessoa.
  const sem9 = phone.length === 13 ? phone.slice(0, 4) + phone.slice(5) : null;
  const com9 = phone.length === 12 ? phone.slice(0, 4) + '9' + phone.slice(4) : null;
  const ids = [phone, sem9, com9].filter(Boolean) as string[];
  let contact = await prisma.contact.findFirst({ where: { orgId, OR: [{ waId: { in: ids } }, { phone: { in: ids } }] } });
  if (contact) {
    const futuros = await prisma.appointment.count({ where: { orgId, contactId: contact.id, source: 'LINK', status: 'SCHEDULED', startAt: { gt: agora } } });
    if (futuros >= MAX_FUTUROS_POR_TELEFONE) throw new HttpError(429, 'Este WhatsApp já tem agendamentos em aberto. Fale com a empresa para marcar mais.');
    const data: Record<string, unknown> = {};
    if (!contact.name) data.name = nome;
    if (!contact.origem) { data.origem = 'agendamento'; data.origemEm = agora; }
    if (Object.keys(data).length) contact = await prisma.contact.update({ where: { id: contact.id }, data });
  } else {
    contact = await prisma.contact.create({ data: { orgId, waId: phone, phone, name: nome, origem: 'agendamento', origemEm: agora } });
  }
  const channel = await resolveChannel({ orgId, channelId: null });
  let conv = channel ? await openConversationFor(orgId, contact.id, channel.id) : await prisma.conversation.findFirst({ where: { orgId, contactId: contact.id, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'desc' } });
  conv ??= await prisma.conversation.create({ data: { orgId, contactId: contact.id, channelId: null } });
  // Cai no Inbox como conversa nova (não lida), com a origem "agendamento".
  await prisma.conversation.update({ where: { id: conv.id }, data: { status: 'OPEN', lastMessageAt: agora, unreadCount: { increment: 1 }, ...(conv.origem ? {} : { origem: 'agendamento' }) } });
  const obs = String(b.observacao ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  try {
    const a = await createAppointment({
      kind: 'MEETING', title: `${s.name} — ${nome}`, description: obs ? `Observação do cliente: ${obs}` : null,
      startAt: inicio, durationMin: s.durationMin, contactId: contact.id, conversationId: conv.id, channelId: channel?.id ?? null, notifyContact: true,
    }, { orgId, source: 'LINK', bookingServiceId: s.id });
    // A confirmação saiu pelo WhatsApp? (API oficial fora da janela de 24 h ou número desconectado = não saiu)
    const aviso = await prisma.message.findFirst({ where: { orgId, conversationId: conv.id, direction: 'OUT', createdAt: { gte: agora } }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    return { ok: true, id: a.id, servico: s.name, dia: b.dia, hora: b.hora, confirmacaoWhatsApp: !!aviso && aviso.status !== 'FAILED' };
  } catch (e) {
    if (e instanceof ConflictError) throw new HttpError(409, 'Esse horário acabou de ser ocupado. Escolha outro.');
    throw e;
  }
}
