import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, prisma, createTestChannel } from '../helpers.js';
import { applyExtraction } from '../../server/sdr/ai.js';
import { getSdrSettings } from '../../server/sdr/service.js';
import { getIntelConfig } from '../../server/sdr/intelConfig.js';

/** SDR fase 2 (v1.21.0): inteligência do SDR. */
const ALL_DAY = { workStart: '00:00', workEnd: '23:59', workDays: '0,1,2,3,4,5,6' };
const phone = () => `55119${Math.floor(10000000 + Math.random() * 89999999)}`;
const lead = (id: string) => prisma.sdrLead.findUniqueOrThrow({ where: { id } });

describe('SDR inteligência', () => {
  let a: Client;
  const orgA = () => a.me.org.id;
  beforeAll(async () => {
    a = await registerClient();
    expect((await a.put('/api/sdr/config', { enabled: true, ...ALL_DAY })).status).toBe(200);
  });

  it('1) método BANT/SPIN e explicação da pontuação', async () => {
    // Empresa que ainda não ligou o SDR: nada salvo, método Padrão (quem já usa não muda nada).
    const b = await registerClient();
    expect(await getIntelConfig(b.me.org.id)).toMatchObject({ salvo: false, metodo: 'PADRAO' });
    // Ligar o SDR pela 1ª vez grava os padrões de configuração nova.
    expect((await getIntelConfig(orgA())).salvo).toBe(true);
    const g = await a.get('/api/sdr/inteligencia');
    expect(g.status).toBe(200);
    expect(g.body.metodo).toBe('PADRAO');
    expect(g.body.metodos.map((m: any) => m.id)).toEqual(['PADRAO', 'BANT', 'SPIN']);
    expect((await a.put('/api/sdr/inteligencia', { metodo: 'BANT' })).body.metodo).toBe('BANT');
    const r = await a.post('/api/sdr/leads', { name: 'Bia', phone: phone(), consent: true });
    const s = await getSdrSettings(orgA());
    await applyExtraction(await lead(r.body.id), s, { respostas: { decisor: { resposta: 'eu e meu sócio', nota: 60, motivo: 'decide com o sócio' }, necessidade: { resposta: 'responder clientes rápido', nota: 90 } }, resumo: 'quer agilidade' });
    const d = await a.get(`/api/sdr/inteligencia/leads/${r.body.id}`);
    expect(d.status).toBe(200);
    expect(d.body.metodo).toBe('BANT');
    expect(d.body.explicacao.fatores.find((f: any) => f.id === 'decisor')).toMatchObject({ resposta: 'eu e meu sócio', motivo: 'decide com o sócio', nivel: 'medio' });
    expect(d.body.explicacao.faltam).toEqual(['orçamento', 'prazo']);
    expect((await a.get(`/api/sdr/leads/${r.body.id}`)).body.questions.map((q: any) => q.id)).toContain('decisor');
    // Vendedor (não admin) não muda a configuração; outra empresa não lê o lead.
    expect((await b.get(`/api/sdr/inteligencia/leads/${r.body.id}`)).status).not.toBe(200);
    expect((await a.put('/api/sdr/inteligencia', { metodo: 'PADRAO' })).body.metodo).toBe('PADRAO');
  });

  it('2) biblioteca de objeções: desligada por padrão, editável e usada no prompt da IA', async () => {
    const g = await a.get('/api/sdr/inteligencia');
    expect(g.body.objecoes.enabled).toBe(false);
    expect(g.body.objecoes.itens.length).toBeGreaterThanOrEqual(5);
    const itens = [...g.body.objecoes.itens, { titulo: 'Prazo de entrega', gatilhos: 'demora muito, prazo longo', resposta: 'Diga o prazo real e ofereça acompanhar o pedido.' }];
    const p = await a.put('/api/sdr/inteligencia', { objecoes: { enabled: true, itens } });
    expect(p.status).toBe(200);
    expect(p.body.objecoes.itens.at(-1)).toMatchObject({ id: 'prazo_de_entrega', gatilhos: ['demora muito', 'prazo longo'] });
    // Prompt da IA para um lead do WhatsApp que acabou de dizer "demora muito".
    const { sdrPromptSection } = await import('../../server/sdr/ai.js');
    const { ch } = await createTestChannel(orgA());
    const waId = phone();
    const contact = await prisma.contact.create({ data: { orgId: orgA(), waId, phone: '+' + waId, name: 'Rui' } as any });
    const conv = await prisma.conversation.create({ data: { orgId: orgA(), contactId: contact.id, channelId: ch.id } as any });
    await prisma.sdrLead.create({ data: { orgId: orgA(), name: 'Rui', phone: '+' + waId, source: 'WHATSAPP', contactId: contact.id, unsubToken: 'tok' + waId } });
    await prisma.message.create({ data: { orgId: orgA(), conversationId: conv.id, direction: 'IN', sender: 'contact', type: 'text', body: 'Gostei, mas demora muito?', status: 'RECEIVED' } as any });
    const prompt = await sdrPromptSection(orgA(), conv.id);
    expect(prompt).toContain('OBJEÇÕES');
    expect(prompt).toContain('A última mensagem do cliente é a objeção "Prazo de entrega"');
    expect((await a.put('/api/sdr/inteligencia', { objecoes: { enabled: false } })).body.objecoes.itens.at(-1).titulo).toBe('Prazo de entrega');
    expect(await sdrPromptSection(orgA(), conv.id)).not.toContain('OBJEÇÕES');
  });
});
