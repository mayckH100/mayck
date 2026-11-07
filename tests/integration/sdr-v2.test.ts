import { describe, it, expect, beforeAll } from 'vitest';
import { app, registerClient, Client, prisma, uniq } from '../helpers.js';
import { syncSdrStageToKanban } from '../../server/sdr/kanbanSync.js';

/** SDR v2 (v1.19.0): Kanban, rodízio, relatórios, resposta por e-mail e formulário incorporável. */
const ALL_DAY = { workStart: '00:00', workEnd: '23:59', workDays: '0,1,2,3,4,5,6' };
const phone = () => `55119${Math.floor(10000000 + Math.random() * 89999999)}`;
const lead = (id: string) => prisma.sdrLead.findUniqueOrThrow({ where: { id } });
void app;

describe('SDR v2', () => {
  let a: Client;
  const orgA = () => a.me.org.id;
  const stageId = async (name: string) => (await prisma.kanbanStage.findFirstOrThrow({ where: { orgId: orgA(), name } })).id;
  const contactStage = async (contactId: string) => {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    return c.stageId ? (await prisma.kanbanStage.findUniqueOrThrow({ where: { id: c.stageId } })).name : null;
  };

  beforeAll(async () => {
    a = await registerClient();
    const r = await a.put('/api/sdr/config', { enabled: true, ...ALL_DAY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kanbanSync: true, rodizio: { enabled: false, members: [] }, embedDomains: [] });
  });

  it('1) etapa do SDR ↔ Kanban do MCKBOT (contato ligado)', async () => {
    const r = await a.post('/api/sdr/leads', { name: 'Kátia', phone: phone(), consent: true });
    expect(r.status).toBe(201);
    const l0 = await lead(r.body.id);
    expect(l0.contactId).toBeTruthy();
    const cid = l0.contactId!;
    // SDR → Kanban (manual na tela do SDR).
    expect((await a.patch(`/api/sdr/leads/${l0.id}`, { stage: 'QUALIFICADO' })).status).toBe(200);
    expect(await contactStage(cid)).toBe('Qualificado');
    expect(await prisma.sdrEvent.count({ where: { leadId: l0.id, type: 'KANBAN' } })).toBe(1);
    // Kanban → SDR (equipe arrasta para Ganho): lead vira GANHO e a cadência para.
    expect((await a.post('/api/kanban/move', { contactId: cid, stageId: await stageId('Ganho') })).status).toBe(200);
    const l1 = await lead(l0.id);
    expect(l1).toMatchObject({ stage: 'GANHO', cadenceStatus: 'PARADA', stopReason: 'GANHO' });
    expect(await contactStage(cid)).toBe('Ganho');
    // Automação não tira o contato de Ganho no Kanban.
    expect(await syncSdrStageToKanban(l1, 'QUALIFICADO')).toBeNull();
    expect(await contactStage(cid)).toBe('Ganho');
    // Etapa sem nome correspondente no Kanban ("Em atendimento") não mexe no SDR.
    expect((await a.patch(`/api/contacts/${cid}`, { stageId: await stageId('Em atendimento') })).status).toBe(200);
    expect((await lead(l0.id)).stage).toBe('GANHO');
    // Reunião sem etapa no Kanban: usa "Reunião agendada" (a mesma da Agenda).
    expect((await a.patch(`/api/sdr/leads/${l0.id}`, { stage: 'REUNIAO' })).status).toBe(200);
    expect(await contactStage(cid)).toBe('Reunião agendada');
    // Desligado: nada sincroniza.
    expect((await a.put('/api/sdr/config', { kanbanSync: false })).body.kanbanSync).toBe(false);
    expect((await a.patch(`/api/sdr/leads/${l0.id}`, { stage: 'PERDIDO' })).status).toBe(200);
    expect(await contactStage(cid)).toBe('Reunião agendada');
    await a.post('/api/kanban/move', { contactId: cid, stageId: await stageId('Qualificado') });
    expect((await lead(l0.id)).stage).toBe('PERDIDO');
    expect((await a.put('/api/sdr/config', { kanbanSync: true })).body.kanbanSync).toBe(true);
    void uniq;
  });
});
