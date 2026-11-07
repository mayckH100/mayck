import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, prisma, createTestChannel, fakeCnpj } from '../helpers.js';
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

  it('3) enriquecimento por CNPJ: cache, falha silenciosa, nunca bloqueia', async () => {
    const { setFetch, resetFetch } = await import('../../server/lib/fetcher.js');
    const { flushCnpj, clearCnpjCache } = await import('../../server/sdr/cnpj.js');
    clearCnpjCache();
    const cnpj = fakeCnpj();
    let calls = 0, fail = false;
    setFetch(async (input) => {
      const url = String(input);
      if (!url.startsWith('https://brasilapi.com.br/api/cnpj/v1/')) throw new Error('rede bloqueada: ' + url);
      calls++;
      if (fail) throw new Error('timeout simulado');
      return new Response(JSON.stringify({ cnpj, razao_social: 'PADARIA EXEMPLO LTDA', nome_fantasia: 'Padaria Exemplo', descricao_situacao_cadastral: 'ATIVA', cnae_fiscal_descricao: 'Padaria e confeitaria', opcao_pelo_simples: true, municipio: 'SAO PAULO', uf: 'SP', email: 'dono@exemplo.com', ddd_telefone_1: '1133334444' }), { status: 200 });
    });
    try {
      expect((await a.put('/api/sdr/inteligencia', { cnpj: true })).body.cnpj).toBe(true);
      const r = await a.post('/api/sdr/leads', { name: 'Ana', company: cnpj, email: `ana${Date.now()}@exemplo.com`, consent: true });
      expect(r.status).toBe(201);
      await flushCnpj();
      expect((await lead(r.body.id)).company).toBe(cnpj); // empresa já preenchida (com o CNPJ) não é trocada
      const d = await a.get(`/api/sdr/inteligencia/leads/${r.body.id}`);
      expect(d.body.empresa).toMatchObject({ cnpj, razaoSocial: 'PADARIA EXEMPLO LTDA', fantasia: 'Padaria Exemplo', regime: 'SIMPLES', cidade: 'SAO PAULO' });
      expect(JSON.stringify(d.body.empresa)).not.toContain('exemplo.com'); // e-mail/telefone da Receita não são guardados
      // Outro lead, mesmo CNPJ: cache (sem nova chamada) e empresa vazia é preenchida.
      const r2 = await a.post('/api/sdr/leads', { name: 'Bruno', email: `b${Date.now()}@exemplo.com` });
      const e2 = await a.post(`/api/sdr/inteligencia/leads/${r2.body.id}/cnpj`, { cnpj });
      expect(e2.body.empresa.fantasia).toBe('Padaria Exemplo');
      expect(calls).toBe(1);
      expect((await lead(r2.body.id)).company).toBe('Padaria Exemplo');
      // API fora: 200 com aviso, lead intacto.
      fail = true;
      const r3 = await a.post('/api/sdr/leads', { name: 'Caio', email: `c${Date.now()}@exemplo.com` });
      const e3 = await a.post(`/api/sdr/inteligencia/leads/${r3.body.id}/cnpj`, { cnpj: fakeCnpj() });
      expect(e3.status).toBe(200);
      expect(e3.body.empresa).toBeNull();
      expect((await a.post(`/api/sdr/inteligencia/leads/${r3.body.id}/cnpj`, { cnpj: '123' })).body.aviso).toBe('CNPJ inválido');
      expect((await lead(r3.body.id)).company).toBeNull();
    } finally { resetFetch(); }
  });
});
