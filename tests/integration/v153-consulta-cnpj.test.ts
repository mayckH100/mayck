import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, prisma, type Client } from '../helpers.js';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';
import { resetConsultaCnpjState } from '../../server/mckmensagem/cnpjConsulta.js';
import { block, unblock } from '../../server/billing/service.js';
import { brasilApi, cnpjWs, CNPJ_OK, CNPJ_BAIXADA } from '../fixtures/cnpj.js';

/**
 * v1.53.0 — Consulta CNPJ / Prospecção (MCK Mensagens). Rede simulada: nenhuma chamada sai para as fontes reais.
 */
describe('v1.53.0 — Consulta CNPJ / Prospecção', () => {
  let owner: Client;
  let other: Client;
  const chamadas: string[] = [];
  let brasilApiStatus = 200;

  beforeAll(async () => {
    owner = await registerClient();
    other = await registerClient();
    setFetch(async (input) => {
      const url = String(input);
      chamadas.push(url);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      const c = url.split('/').pop()!;
      if (url.startsWith('https://brasilapi.com.br/')) {
        if (brasilApiStatus !== 200) return json({ message: 'erro' }, brasilApiStatus);
        if (c === CNPJ_OK) return json(brasilApi(CNPJ_OK));
        if (c === CNPJ_BAIXADA) return json(brasilApi(CNPJ_BAIXADA, { descricao_situacao_cadastral: 'BAIXADA', ddd_telefone_1: '11912345678', ddd_telefone_2: '' }));
        return json({ message: 'CNPJ não encontrado' }, 404);
      }
      if (url.startsWith('https://minhareceita.org/')) return json({ message: 'fora' }, 503);
      if (url.startsWith('https://publica.cnpj.ws/')) return c === CNPJ_OK ? json(cnpjWs(CNPJ_OK)) : json({}, 404);
      if (url.startsWith('https://receitaws.com.br/')) return json({ status: 'ERROR', message: 'CNPJ inválido' });
      throw new Error('rede bloqueada no teste: ' + url);
    });
  });
  afterAll(() => resetFetch());
  beforeEach(async () => {
    chamadas.length = 0; brasilApiStatus = 200; resetConsultaCnpjState();
    await prisma.cnpjCache.deleteMany({});
  });

  it('consulta com máscara, mostra a ficha, guarda no cache e não consulta de novo', async () => {
    const r = await owner.post('/api/mckmensagem/cnpj/consultar', { cnpj: '11.222.333/0001-81' });
    expect(r.status).toBe(200);
    expect(r.body.razaoSocial).toBe('PADARIA EXEMPLO LTDA');
    expect(r.body.fonte).toBe('BrasilAPI');
    expect(r.body.doCache).toBe(false);
    expect(r.body.telefones[0].whatsapp).toBe('https://wa.me/5511987654321');
    expect(JSON.stringify(r.body)).not.toContain('***');
    const r2 = await owner.post('/api/mckmensagem/cnpj/consultar', { cnpj: CNPJ_OK });
    expect(r2.body.doCache).toBe(true);
    expect(chamadas.filter((u) => u.includes(CNPJ_OK))).toHaveLength(1);
    const uso = await owner.get('/api/mckmensagem/cnpj/uso');
    expect(uso.body).toMatchObject({ naFonte: 1, consultas: 2, buscaPorNome: false });
  });

  it('BrasilAPI fora → usa a próxima fonte; inválido = 400; inexistente = 404', async () => {
    brasilApiStatus = 429;
    const r = await owner.post('/api/mckmensagem/cnpj/consultar', { cnpj: CNPJ_OK });
    expect(r.status).toBe(200);
    expect(r.body.fonte).toBe('CNPJ.ws');
    expect((await owner.post('/api/mckmensagem/cnpj/consultar', { cnpj: '11.222.333/0001-00' })).status).toBe(400);
    brasilApiStatus = 200;
    expect((await owner.post('/api/mckmensagem/cnpj/consultar', { cnpj: '11444777000242' })).status).toBe(404);
  });

  it('lote: vários CNPJs, um com erro não derruba os outros', async () => {
    const ex = await owner.post('/api/mckmensagem/cnpj/extrair', { texto: `cnpj\n11.222.333/0001-81\n${CNPJ_BAIXADA}\n11444777000242\n` });
    expect(ex.body.cnpjs).toEqual([CNPJ_OK, CNPJ_BAIXADA, '11444777000242']);
    const r = await owner.post('/api/mckmensagem/cnpj/lote', { cnpjs: ex.body.cnpjs });
    expect(r.status).toBe(200);
    expect(r.body.itens.map((x: any) => x.ok)).toEqual([true, true, false]);
    expect(r.body.itens[1].ficha.ativa).toBe(false);
  });

  it('importa como contato com etiqueta, origem, empresa e dono; respeita SAIR; isolado por empresa', async () => {
    await owner.post('/api/mckmensagem/cnpj/lote', { cnpjs: [CNPJ_OK, CNPJ_BAIXADA] });
    const orgId = owner.me.org.id;
    // telefone da empresa baixada já pediu para sair
    await prisma.lead.create({ data: { orgId, phone: '+5511912345678', name: 'Saiu', consentSource: 'MANUAL', consentAt: new Date(), optOutAt: new Date() } });
    const camp = await prisma.campaign.create({ data: { orgId, name: 'Prospecção lojas', message: 'Oi {dono}! Responda SAIR para não receber mais.', channelId: 'x', status: 'PAUSADA' } });
    const r = await owner.post('/api/mckmensagem/cnpj/importar', { itens: [{ cnpj: CNPJ_OK }, { cnpj: CNPJ_BAIXADA }, { cnpj: '11444777000242' }], tags: ['prospeccao-lojas'], campaignId: camp.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ criados: 1, bloqueados: 1, naoConsultados: 1, naFila: 1 });
    const lead = await prisma.lead.findUnique({ where: { orgId_phone: { orgId, phone: '+5511987654321' } } });
    expect(lead).toMatchObject({ cnpj: CNPJ_OK, empresa: 'PADARIA PAO BOM', dono: 'Maria da Silva Exemplo', campaignId: camp.id, consentSource: 'IMPORTACAO' });
    expect(lead!.origemDado).toMatch(/^Cadastro CNPJ – BrasilAPI – \d{2}\/\d{2}\/\d{4}$/);
    expect(JSON.parse(lead!.tags)).toEqual(['prospeccao-lojas']);
    const saiu = await prisma.lead.findUnique({ where: { orgId_phone: { orgId, phone: '+5511912345678' } } });
    expect(saiu!.optOutAt).not.toBeNull();
    expect(saiu!.cnpj).toBeNull();
    // telefone que não é do cadastro da empresa não entra
    const fora = await owner.post('/api/mckmensagem/cnpj/importar', { itens: [{ cnpj: CNPJ_OK, telefone: '+5511999990000' }] });
    expect(fora.body).toMatchObject({ criados: 0, semTelefone: 1 });
    // campanha de outra empresa
    expect((await other.post('/api/mckmensagem/cnpj/importar', { itens: [{ cnpj: CNPJ_OK }], campaignId: camp.id })).status).toBe(400);
    // busca de contatos acha pelo CNPJ
    const busca = await owner.get(`/api/mckmensagem/leads?q=${CNPJ_OK}`);
    expect(busca.body.items.map((l: any) => l.phone)).toContain('+5511987654321');
  });

  it('limite diário por empresa e MCK Mensagens inativo = 402', async () => {
    const prev = process.env.CNPJ_LIMITE_DIA;
    process.env.CNPJ_LIMITE_DIA = '1';
    try {
      const r1 = await other.post('/api/mckmensagem/cnpj/consultar', { cnpj: CNPJ_OK });
      expect(r1.status).toBe(200);
      const r2 = await other.post('/api/mckmensagem/cnpj/consultar', { cnpj: CNPJ_BAIXADA });
      expect(r2.status).toBe(429);
      // o que já está no cache continua abrindo
      expect((await other.post('/api/mckmensagem/cnpj/consultar', { cnpj: CNPJ_OK })).status).toBe(200);
    } finally { if (prev === undefined) delete process.env.CNPJ_LIMITE_DIA; else process.env.CNPJ_LIMITE_DIA = prev; }
    await block(other.me.org.id, 'MCKMENSAGEM');
    try {
      expect((await other.get('/api/mckmensagem/cnpj/uso')).status).toBe(402);
      expect((await other.post('/api/mckmensagem/cnpj/consultar', { cnpj: CNPJ_OK })).status).toBe(402);
    } finally { await unblock(other.me.org.id, 'MCKMENSAGEM'); }
  });
});
