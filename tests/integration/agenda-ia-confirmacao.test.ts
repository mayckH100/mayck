import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, prisma, createTestChannel, installGraphMock, graph, sendInbound } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';
import { applyAgendaTag, isAffirmative, isConfirmed, mentionsTime, stripSystemLinks } from '../../server/agenda/ai.js';
import { publicEventUrl } from '../../server/agenda/service.js';
import { toLocalIso } from '../../server/agenda/time.js';

const TZ = 'America/Sao_Paulo';
const TEAM = '5511955550010';
/** Data local de amanhã (AAAA-MM-DD) no fuso da empresa. */
const tomorrow = () => toLocalIso(new Date(Date.now() + 24 * 3600e3), TZ).slice(0, 10);
const tag = (hhmm: string, titulo = 'Reunião com cliente') => `[AGENDAR:{"inicio":"${tomorrow()}T${hhmm}","duracao":30,"titulo":"${titulo}"}]`;
const LINK_RE = /\/api\/public\/agenda\/e\/([a-z0-9]+)\./gi;

const sent = () => graph.calls.filter((c) => c.body?.to).map((c) => ({ to: String(c.body.to), text: String(c.body.text?.body ?? '') }));
const linksIn = (t: string) => [...t.matchAll(LINK_RE)].map((m) => m[1]);

describe('Agenda pela IA: confirmação, idempotência e um único link (teste real de 31/10)', () => {
  let owner: Client;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let orgId: string;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    orgId = owner.me.org.id;
    ctx = await createTestChannel(orgId);
    await owner.put('/api/ai/settings', { provider: 'fake', model: 'fake-1', enabled: true, autoReply: true });
    const s = await owner.put('/api/agenda/settings', {
      aiBooking: true, workStart: '00:00', workEnd: '23:30', workDays: [0, 1, 2, 3, 4, 5, 6], defaultDurationMin: 30, minNoticeMin: 0, notifyContact: true, reminderMin: 60,
      notifyOwner: false, teamContacts: [{ name: 'Equipe', phone: TEAM, active: true }],
    });
    expect(s.status).toBe(200);
  });
  beforeEach(() => { graph.reset(); fakeAi.script.length = 0; fakeAi.calls.length = 0; });

  /** Envia a mensagem do cliente com a resposta roteirizada da IA e devolve o que foi enviado ao cliente. */
  async function turn(phone: string, clientText: string, aiText: string) {
    graph.reset();
    fakeAi.script.push(aiText);
    await sendInbound(ctx, phone, clientText);
    return sent().filter((m) => m.to === phone).map((m) => m.text);
  }
  const apptsOf = async (phone: string) => {
    const c = await prisma.contact.findFirst({ where: { orgId, waId: phone } });
    return prisma.appointment.findMany({ where: { orgId, contactId: c!.id, status: 'SCHEDULED' }, orderBy: { startAt: 'asc' } });
  };

  it('reproduz a conversa: "45" não agenda, "Sim" agenda 14:30 com UM link (o da reunião nova), sem copiar o link antigo', async () => {
    const P = '5511955550001';
    let out = await turn(P, 'quero marcar amanhã às 13:30', `Combinado! Reunião agendada para amanhã às 13:30.\n${tag('13:30')}`);
    expect(out).toHaveLength(1);
    expect(linksIn(out[0])).toHaveLength(1);
    out = await turn(P, 'marca outra às 14:00', `Reunião agendada para amanhã às 14:00.\n${tag('14:00')}`);
    expect(linksIn(out[0])).toHaveLength(1);
    let appts = await apptsOf(P);
    expect(appts.map((a) => toLocalIso(a.startAt, TZ).slice(11))).toEqual(['13:30', '14:00']);
    const reuniao14 = appts[1];

    // Pedido ambíguo: a IA só propõe.
    out = await turn(P, 'Ola marca outra reunião 15 min depois dessa', 'A duração padrão é 30 min, não consigo com 15 min de diferença. Temos o horário livre às 14:30, pode ser?');
    expect(linksIn(out[0])).toHaveLength(0);

    // "45" é ambíguo: mesmo que a IA mande o marcador, nada é criado e o cliente é perguntado.
    out = await turn(P, '45', `Perfeito! Posso agendar para as 14:30?\n${tag('14:30')}`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/Só para confirmar: posso agendar a reunião para .* 14:30/);
    expect(linksIn(out[0])).toHaveLength(0);
    expect(await apptsOf(P)).toHaveLength(2);

    // "Sim": a IA (como no teste real) copia o link da reunião anterior do histórico + marcador.
    const teamBefore = sent().filter((m) => m.to === TEAM).length;
    out = await turn(P, 'Sim', `Reunião agendada para amanhã às 14:30.\n\n📅 Adicione à agenda do seu celular: ${publicEventUrl(reuniao14.id)}\n${tag('14:30')}`);
    appts = await apptsOf(P);
    expect(appts.map((a) => toLocalIso(a.startAt, TZ).slice(11))).toEqual(['13:30', '14:00', '14:30']);
    expect(out).toHaveLength(1);
    expect(linksIn(out[0])).toEqual([appts[2].id]);
    expect(out[0].match(/Adicione à agenda/g)).toHaveLength(1);
    expect(out[0]).toContain('14:30');
    // A equipe recebe um único aviso da reunião nova.
    expect(sent().filter((m) => m.to === TEAM).length - teamBefore).toBe(1);
    // O histórico mandado à IA não traz mais os links da agenda (ela não tem o que copiar).
    const lastCall = fakeAi.calls.at(-1)!;
    expect(lastCall.filter((m) => m.role === 'assistant').some((m) => m.content.includes('/api/public/agenda/'))).toBe(false);

    // "Sim" repetido / marcador repetido: reaproveita, não cria outra nem avisa a equipe de novo.
    out = await turn(P, 'sim, confirmado', `Reunião agendada para amanhã às 14:30.\n${tag('14:30')}`);
    expect(await apptsOf(P)).toHaveLength(3);
    expect(linksIn(out[0])).toEqual([appts[2].id]);
    expect(sent().filter((m) => m.to === TEAM)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { orgId, action: 'agenda.ai_create' } })).toBe(3);
  });

  it('"45" com marcador para 14:45 (horário que o cliente não confirmou) não é agendado', async () => {
    const P = '5511955550002';
    await turn(P, 'quero uma reunião amanhã', 'Temos o horário livre às 16:00, pode ser?');
    const out = await turn(P, '45', `Reunião agendada para as 16:45.\n${tag('16:45')}`);
    expect(out[0]).toMatch(/Só para confirmar/);
    expect(linksIn(out[0])).toHaveLength(0);
    expect(await apptsOf(P)).toHaveLength(0);
    // Confirmando a pergunta do sistema, agenda uma vez só.
    const ok = await turn(P, 'sim', `Agendado!\n${tag('16:45')}`);
    expect(await apptsOf(P)).toHaveLength(1);
    expect(linksIn(ok[0])).toHaveLength(1);
  });

  it('dois marcadores na mesma resposta → um compromisso e um link', async () => {
    const P = '5511955550003';
    const out = await turn(P, 'pode ser às 17:30', `Agendado!\n${tag('17:30')}\n${tag('18:00')}`);
    expect(await apptsOf(P)).toHaveLength(1);
    expect(linksIn(out[0])).toHaveLength(1);
    expect(out[0]).not.toContain('[AGENDAR');
  });

  it('dois pedidos simultâneos para o mesmo horário e cliente → um compromisso só', async () => {
    const P = '5511955550004';
    await turn(P, 'oi', 'Olá! Como posso ajudar?');
    const c = await prisma.contact.findFirst({ where: { orgId, waId: P } });
    const conv = await prisma.conversation.findFirst({ where: { orgId, contactId: c!.id } });
    const text = `Agendado!\n${tag('19:00')}`;
    const [a, b] = await Promise.all([
      applyAgendaTag({ orgId, conversationId: conv!.id, text, clientText: 'quero às 19:00' }),
      applyAgendaTag({ orgId, conversationId: conv!.id, text, clientText: 'quero às 19:00' }),
    ]);
    expect(await apptsOf(P)).toHaveLength(1);
    expect(a.appointmentId).toBe(b.appointmentId);
    expect([a.reused, b.reused].filter(Boolean)).toHaveLength(1);
    // Reunião sobreposta do mesmo cliente (19:15) é recusada, não duplicada.
    const r = await applyAgendaTag({ orgId, conversationId: conv!.id, text: `Agendado!\n${tag('19:15')}`, clientText: 'pode ser 19:15' });
    expect(r.conflict).toBe(true);
    expect(await apptsOf(P)).toHaveLength(1);
  });
});

describe('Agenda pela IA: regras da confirmação (unidade)', () => {
  it('reconhece o horário citado', () => {
    expect(mentionsTime('Temos o horário livre às 14:30, pode ser?', 14, 30)).toBe(true);
    expect(mentionsTime('pode ser 14h30', 14, 30)).toBe(true);
    expect(mentionsTime('14 e meia', 14, 30)).toBe(true);
    expect(mentionsTime('às 15h', 15, 0)).toBe(true);
    expect(mentionsTime('as 15', 15, 0)).toBe(true);
    expect(mentionsTime('45', 14, 45)).toBe(false);
    expect(mentionsTime('às 14:30', 14, 45)).toBe(false);
    expect(mentionsTime('114:30', 14, 30)).toBe(false);
  });
  it('"sim" confirma o horário proposto; "45" e "não" não confirmam', () => {
    const last = 'Perfeito! Posso agendar para as 14:30?';
    expect(isConfirmed({ clientText: 'Sim', lastAssistant: last, hour: 14, minute: 30 })).toBe(true);
    expect(isConfirmed({ clientText: '45', lastAssistant: last, hour: 14, minute: 30 })).toBe(false);
    expect(isConfirmed({ clientText: '45', lastAssistant: last, hour: 14, minute: 45 })).toBe(false);
    expect(isConfirmed({ clientText: 'Sim', lastAssistant: last, hour: 14, minute: 45 })).toBe(false);
    expect(isConfirmed({ clientText: 'não, outro horário', lastAssistant: last, hour: 14, minute: 30 })).toBe(false);
    expect(isConfirmed({ clientText: 'quero às 14:45', lastAssistant: null, hour: 14, minute: 45 })).toBe(true);
    expect(isAffirmative('pode sim 👍')).toBe(true);
    expect(isAffirmative('não')).toBe(false);
  });
  it('remove links da agenda/Meet copiados pela IA', () => {
    const t = 'Reunião agendada.\n\n🎥 Link da reunião (Google Meet): https://meet.google.com/abc-defg-hij\n\n📅 Adicione à agenda do seu celular: https://x.dev/api/public/agenda/e/cabc.sig';
    expect(stripSystemLinks(t)).toBe('Reunião agendada.');
  });
});
