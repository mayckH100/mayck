import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { registerClient, Client, uniq, prisma } from '../helpers.js';
import {
  tickAutomacoes, setAutomacaoSender, resetEngineState, gerarOcorrencias, processarOcorrencia, recuperarTravadas, estenderHorizontes, chaveDe,
} from '../../server/mckmensagem/automacoes/engine.js';
import { zonedToUtc, localDate, localTime } from '../../server/mckmensagem/automacoes/rules.js';
import { onLeadOptOut } from '../../server/mckmensagem/hooks.js';

const TZ = 'America/Sao_Paulo';
/** Data local (AAAA-MM-DD) daqui a n dias. */
const dia = (n: number) => localDate(new Date(Date.now() + n * 86400e3), TZ);
const at = (n: number, hhmm: string) => zonedToUtc(dia(n), hhmm, TZ);
const plus = (d: Date, sec: number) => new Date(d.getTime() + sec * 1000);

type Call = { canal: string; to: string; texto: string; assunto?: string | null };
const calls: Call[] = [];
const falhar = { WHATSAPP: false, EMAIL: false };

const API = '/api/mckmensagem/automacoes';

describe('Automações e Cobranças (fase 1)', () => {
  let owner: Client, agent: Client, admin: Client, other: Client;
  let seq = 0;
  const novoCliente = async (extra: Record<string, unknown> = {}) => {
    seq++;
    const r = await owner.post(`${API}/clientes`, {
      nome: `João da Silva ${seq}`, whatsapp: `1198888${String(1000 + seq).slice(-4)}`, email: `joao${seq}.${uniq()}@cliente.dev`,
      plano: 'Plano Ouro', consentimento: true, ...extra,
    });
    expect(r.status).toBe(201);
    return r.body;
  };
  const criar = async (body: Record<string, unknown>, c: Client = owner) => c.post(`${API}/automacoes`, {
    nome: 'Automação ' + uniq(), categoria: 'LEMBRETE', canais: ['WHATSAPP'], mensagem: 'Olá, {{primeiro_nome}}! Lembrete do {{nome_plano}}.', ativar: true, ...body,
  });
  const ocorr = (automacaoId: string) => prisma.ocorrencia.findMany({ where: { automacaoId }, orderBy: [{ agendadoPara: 'asc' }, { canal: 'asc' }] });

  beforeAll(async () => {
    for (const canal of ['WHATSAPP', 'EMAIL'] as const) {
      setAutomacaoSender(canal, async (a) => {
        calls.push({ canal, to: canal === 'EMAIL' ? a.cliente.email! : a.cliente.whatsapp!, texto: a.texto, assunto: a.assunto });
        if (falhar[canal]) return { ok: false, error: canal === 'WHATSAPP' ? 'WhatsApp (QR) não conectado' : 'SMTP recusou a conexão' };
        return { ok: true, provedorId: `${canal}-${calls.length}` };
      });
    }
    owner = await registerClient();
    other = await registerClient();
    const mk = async (role: 'AGENT' | 'ADMIN') => {
      const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
      const token = inv.body.link.split('/convite/')[1];
      const c = new Client();
      const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Membro', password: 'senhaMembro123' });
      c.csrf = r.body.csrfToken; c.me = r.body;
      return c;
    };
    agent = await mk('AGENT');
    admin = await mk('ADMIN');
  });
  afterAll(() => { setAutomacaoSender('WHATSAPP', null); setAutomacaoSender('EMAIL', null); });
  beforeEach(async () => {
    calls.length = 0;
    falhar.WHATSAPP = false; falhar.EMAIL = false;
    resetEngineState();
    // Isola os testes: só as automações criadas no teste corrente ficam ativas.
    await prisma.automacao.updateMany({ where: { status: 'ATIVA' }, data: { status: 'PAUSADA' } });
    await prisma.automacaoConfig.deleteMany({});
  });

  it('cria cliente, evita duplicidade, busca e importa/exporta CSV', async () => {
    const c = await novoCliente({ documento: '123.456.789-09', dataVencimento: '2026-12-10', valor: 300, parcelas: 3 });
    expect(c.whatsapp).toMatch(/^\+5511988/);
    expect(c.documento).toBe('12345678909');
    expect(c.consentimento).toBe(true);
    // Duplicado por telefone, e-mail e CPF.
    expect((await owner.post(`${API}/clientes`, { nome: 'Outro', telefone: c.whatsapp })).status).toBe(409);
    expect((await owner.post(`${API}/clientes`, { nome: 'Outro', email: c.email.toUpperCase() })).status).toBe(409);
    expect((await owner.post(`${API}/clientes`, { nome: 'Outro', documento: '12345678909' })).status).toBe(409);
    expect((await owner.post(`${API}/clientes`, { nome: 'Doc ruim', documento: '123' })).status).toBe(400);
    // Busca por nome, telefone, e-mail, CPF e id.
    for (const q of [c.nome, c.whatsapp.slice(-8), c.email, '12345678909', c.id]) {
      const r = await owner.get(`${API}/clientes?q=${encodeURIComponent(q)}`);
      expect(r.body.items.map((x: any) => x.id)).toContain(c.id);
    }
    // Outra organização não enxerga.
    expect((await other.get(`${API}/clientes/${c.id}`)).status).toBe(404);

    const csv = `nome;whatsapp;email;plano;consentimento\nMaria Souza;11977770001;maria.${uniq()}@x.dev;Prata;sim\nRepetido;${c.whatsapp};;Bronze;sim\n;11977770002;;;`;
    const imp = await owner.post(`${API}/clientes/import`, { text: csv });
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ criados: 1, atualizados: 1 });
    expect(imp.body.erros[0]).toMatch(/Linha 4/);
    const maria = await prisma.cliente.findFirstOrThrow({ where: { orgId: owner.me.org.id, nome: 'Maria Souza' } });
    expect(maria.consentimentoOrigem).toBe('IMPORTACAO');
    const exp = await owner.get(`${API}/clientes/export`);
    expect(exp.status).toBe(200);
    expect(exp.text.split('\n')[0]).toContain('nome,documento,telefone,whatsapp,email');
    expect(exp.text).toContain('Maria Souza');
  });

  it('variáveis: prévia com dados reais e bloqueio quando falta variável obrigatória', async () => {
    const c = await novoCliente({ dataVencimento: '2026-12-10', valor: 300, parcelas: 3 });
    const p = await owner.post(`${API}/preview`, { clienteId: c.id, mensagem: 'Oi {{nome_cliente}}, parcela de {{valor_parcela}} ({{total_parcelas}}x) vence em {{data_vencimento}}.' });
    expect(p.body.bloqueado).toBe(false);
    expect(p.body.texto).toBe(`Oi ${c.nome}, parcela de R$ 100,00 (3x) vence em 10/12/2026.`);
    const falta = await owner.post(`${API}/preview`, { clienteId: c.id, mensagem: 'Empresa: {{nome_empresa}}' });
    expect(falta.body).toMatchObject({ bloqueado: true, faltando: ['nome_empresa'] });
    const f2 = await owner.post(`${API}/preview`, { clienteId: c.id, mensagem: 'Pague: {{link_pagamento}}' });
    expect(f2.body.problema).toMatch(/financeiro/);
    // Ativação bloqueada; fica como rascunho sem ocorrências.
    const r = await criar({ clienteIds: [c.id], mensagem: 'Olá {{nome_empresa}}', regra: { tipo: 'UNICO', data: dia(1), horario: '10:00' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/nome_empresa/);
    const a = await prisma.automacao.findFirstOrThrow({ where: { orgId: owner.me.org.id, mensagem: 'Olá {{nome_empresa}}' } });
    expect(a.status).toBe('RASCUNHO');
    expect(await prisma.ocorrencia.count({ where: { automacaoId: a.id } })).toBe(0);
    // Modelos por categoria.
    expect((await owner.post(`${API}/modelos`, { categoria: 'LEMBRETE', nome: 'Renovação', corpo: 'Olá {{primeiro_nome}}, seu plano vence em {{data_vencimento}}.' })).status).toBe(201);
    expect((await owner.post(`${API}/modelos`, { categoria: 'MARKETING', nome: 'Oferta', corpo: 'Novidade para você!' })).status).toBe(201);
    const lem = await owner.get(`${API}/modelos?categoria=LEMBRETE`);
    expect(lem.body.every((m: any) => m.categoria === 'LEMBRETE')).toBe(true);
  });

  it('mensagem única: envia no horário exato, uma vez só, e registra no histórico', async () => {
    const c = await novoCliente();
    const r = await criar({ clienteIds: [c.id], canais: ['WHATSAPP', 'EMAIL'], assunto: 'Lembrete, {{primeiro_nome}}', regra: { tipo: 'UNICO', data: dia(1), horario: '10:00' } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('ATIVA');
    const os = await ocorr(r.body.id);
    expect(os).toHaveLength(2); // uma por canal
    expect(os.every((o) => o.agendadoPara.getTime() === at(1, '10:00').getTime())).toBe(true);

    expect(await tickAutomacoes(at(1, '09:59'))).toHaveLength(0);
    const t = await tickAutomacoes(at(1, '10:00'));
    expect(t.map((x) => x.acao).sort()).toEqual(['enviada', 'enviada']);
    expect(calls.map((x) => x.canal).sort()).toEqual(['EMAIL', 'WHATSAPP']);
    expect(calls.find((x) => x.canal === 'WHATSAPP')!.texto).toBe(`Olá, João! Lembrete do Plano Ouro.`);
    expect(calls.find((x) => x.canal === 'EMAIL')!.assunto).toBe('Lembrete, João');
    expect(await tickAutomacoes(plus(at(1, '10:00'), 120))).toHaveLength(0);
    expect(calls).toHaveLength(2);
    const h = await owner.get(`${API}/historico?automacaoId=${r.body.id}`);
    expect(h.body.items).toHaveLength(2);
    expect(h.body.items.every((x: any) => x.status === 'ENVIADA' && x.provedorId && x.tentativas === 1)).toBe(true);
    await estenderHorizontes(plus(at(1, '10:00'), 300));
    expect((await prisma.automacao.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('CONCLUIDA');
  });

  it('três envios por dia nos horários exatos (09h, 13h, 18h)', async () => {
    const c = await novoCliente();
    const r = await criar({ clienteIds: [c.id], inicio: dia(1), fim: dia(2), regra: { tipo: 'DIARIO', horarios: ['18:00', '09:00', '13:00'] } });
    expect(r.status).toBe(201);
    const os = await ocorr(r.body.id);
    expect(os.map((o) => `${localDate(o.agendadoPara, TZ)} ${localTime(o.agendadoPara, TZ)}`)).toEqual([
      `${dia(1)} 09:00`, `${dia(1)} 13:00`, `${dia(1)} 18:00`, `${dia(2)} 09:00`, `${dia(2)} 13:00`, `${dia(2)} 18:00`,
    ]);
    await tickAutomacoes(at(1, '09:00'));
    await tickAutomacoes(at(1, '12:59'));
    expect(calls).toHaveLength(1);
    await tickAutomacoes(at(1, '13:00'));
    await tickAutomacoes(at(1, '18:01'));
    expect(calls).toHaveLength(3);
  });

  it('dez envios em datas específicas com horários individuais, visíveis no calendário', async () => {
    const c = await novoCliente();
    const datas = Array.from({ length: 10 }, (_, i) => ({ data: dia(i * 2 + 1), horario: `${String(8 + i).padStart(2, '0')}:30` }));
    const r = await criar({ clienteIds: [c.id], regra: { tipo: 'DATAS', datas } });
    expect(r.status).toBe(201);
    const os = await ocorr(r.body.id);
    expect(os).toHaveLength(10);
    expect(os.map((o) => localTime(o.agendadoPara, TZ))).toEqual(datas.map((d) => d.horario));
    const cal = await owner.get(`${API}/calendario?de=${at(0, '00:00').toISOString()}&ate=${at(25, '00:00').toISOString()}`);
    expect(cal.status).toBe(200);
    const meus = cal.body.eventos.filter((e: any) => e.automacaoId === r.body.id);
    expect(meus).toHaveLength(10);
    expect(meus[0]).toMatchObject({ cliente: c.nome, categoria: 'LEMBRETE', status: 'PENDENTE', canal: 'WHATSAPP' });
  });

  it('recorrência mensal gera os próximos meses conforme o horizonte avança', async () => {
    const c = await novoCliente();
    const d = Number(dia(3).slice(8, 10));
    const r = await criar({ clienteIds: [c.id], regra: { tipo: 'MENSAL', diasMes: [d], horarios: ['10:00'] } });
    expect(r.status).toBe(201);
    const antes = await ocorr(r.body.id);
    expect(antes.length).toBeGreaterThanOrEqual(2);
    expect(antes.every((o) => localTime(o.agendadoPara, TZ) === '10:00')).toBe(true);
    // Dia 29/30/31 em mês mais curto vira o último dia do mês (ex.: dia 31 em novembro → 30/11).
    const esperado = (ymd: string) => { const [y, m] = ymd.split('-').map(Number); return Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate()); };
    expect(antes.every((o) => { const s = localDate(o.agendadoPara, TZ); return Number(s.slice(8)) === esperado(s); })).toBe(true);
    await estenderHorizontes(new Date(Date.now() + 70 * 86400e3));
    const depois = await ocorr(r.body.id);
    expect(depois.length).toBeGreaterThan(antes.length);
    expect(new Set(depois.map((o) => o.chave)).size).toBe(depois.length);
  });

  it('editar automação ativa não reenvia o que já foi processado nem duplica', async () => {
    const c = await novoCliente();
    const r = await criar({ clienteIds: [c.id], inicio: dia(1), regra: { tipo: 'DIARIO', horarios: ['09:00'] } });
    await tickAutomacoes(at(1, '09:00'));
    expect(calls).toHaveLength(1);
    const ed = await owner.patch(`${API}/automacoes/${r.body.id}`, { mensagem: 'Novo texto, {{primeiro_nome}}.', regra: { tipo: 'DIARIO', horarios: ['09:00', '15:00'] }, escopo: 'PROXIMOS' });
    expect(ed.status).toBe(200);
    const os = await ocorr(r.body.id);
    expect(os.filter((o) => o.status === 'ENVIADA')).toHaveLength(1);
    expect(new Set(os.map((o) => o.chave)).size).toBe(os.length);
    // O horário de 09:00 do dia 1 continua único (não foi recriado).
    expect(os.filter((o) => o.agendadoPara.getTime() === at(1, '09:00').getTime())).toHaveLength(1);
    await tickAutomacoes(plus(at(1, '09:00'), 30));
    expect(calls).toHaveLength(1);
    await tickAutomacoes(at(1, '15:00'));
    expect(calls).toHaveLength(2);
    expect(calls[1].texto).toBe('Novo texto, João.');

    // "Só esta ocorrência": altera texto e horário de um envio pendente.
    const alvo = (await ocorr(r.body.id)).find((o) => o.status === 'PENDENTE' && o.agendadoPara.getTime() === at(2, '09:00').getTime())!;
    const po = await owner.patch(`${API}/ocorrencias/${alvo.id}`, { mensagem: 'Só esta: {{primeiro_nome}}', horario: '10:15' });
    expect(po.status).toBe(200);
    await owner.patch(`${API}/automacoes/${r.body.id}`, { mensagem: 'Texto da sequência' }); // reprograma, mas preserva a editada
    await tickAutomacoes(at(2, '10:15'));
    expect(calls.at(-1)!.texto).toBe('Só esta: João');
    const enviada = await owner.patch(`${API}/ocorrencias/${alvo.id}`, { mensagem: 'de novo' });
    expect(enviada.status).toBe(400);
  });

  it('pausar e retomar: nada sai em pausa; o que venceu na pausa é cancelado, o resto segue', async () => {
    const c = await novoCliente();
    const r = await criar({ clienteIds: [c.id], inicio: dia(1), fim: dia(3), regra: { tipo: 'DIARIO', horarios: ['11:00'] } });
    expect((await owner.post(`${API}/automacoes/${r.body.id}/pausar`)).body.status).toBe('PAUSADA');
    await tickAutomacoes(at(1, '11:00'));
    expect(calls).toHaveLength(0);
    // Simula que o primeiro horário passou durante a pausa.
    const [primeira] = await ocorr(r.body.id);
    await prisma.ocorrencia.update({ where: { id: primeira.id }, data: { executarEm: new Date(Date.now() - 3600e3) } });
    const ret = await owner.post(`${API}/automacoes/${r.body.id}/retomar`);
    expect(ret.status).toBe(200);
    expect(ret.body.canceladasNaPausa).toBe(1);
    await tickAutomacoes(at(2, '11:00'));
    expect(calls).toHaveLength(1);
    const dup = await owner.post(`${API}/automacoes/${r.body.id}/duplicar`);
    expect(dup.body).toMatchObject({ status: 'RASCUNHO' });
    expect(await prisma.ocorrencia.count({ where: { automacaoId: dup.body.id } })).toBe(0);
    const can = await owner.post(`${API}/automacoes/${r.body.id}/cancelar`);
    expect(can.body.status).toBe('CANCELADA');
    expect(await prisma.ocorrencia.count({ where: { automacaoId: r.body.id, status: 'PENDENTE' } })).toBe(0);
  });

  it('falha do WhatsApp e do e-mail registradas separadamente, com novas tentativas', async () => {
    await owner.put(`${API}/config`, { maxTentativas: 2, backoffSeg: 60, janelaInicio: '00:00', janelaFim: '00:00' });
    const c = await novoCliente();
    const r = await criar({ clienteIds: [c.id], canais: ['WHATSAPP', 'EMAIL'], regra: { tipo: 'UNICO', data: dia(1), horario: '10:00' } });
    falhar.WHATSAPP = true;
    const t1 = await tickAutomacoes(at(1, '10:00'));
    expect(t1.map((x) => x.acao).sort()).toEqual(['enviada', 'nova_tentativa']);
    expect(await tickAutomacoes(plus(at(1, '10:00'), 30))).toHaveLength(0); // backoff
    const t2 = await tickAutomacoes(plus(at(1, '10:00'), 60));
    expect(t2.map((x) => x.acao)).toEqual(['falhou']);
    const os = await ocorr(r.body.id);
    const wa = os.find((o) => o.canal === 'WHATSAPP')!, em = os.find((o) => o.canal === 'EMAIL')!;
    expect(wa).toMatchObject({ status: 'FALHOU', tentativas: 2, erro: 'WhatsApp (QR) não conectado' });
    expect(em).toMatchObject({ status: 'ENVIADA', tentativas: 1, erro: null });
    expect(em.provedorId).toBeTruthy();
    const hist = await prisma.mensagemHistorico.findMany({ where: { automacaoId: r.body.id } });
    expect(hist.find((h) => h.canal === 'WHATSAPP')).toMatchObject({ status: 'FALHOU', erro: 'WhatsApp (QR) não conectado' });
    expect(hist.find((h) => h.canal === 'EMAIL')).toMatchObject({ status: 'ENVIADA' });

    // Agora o contrário: e-mail falha, WhatsApp funciona.
    falhar.WHATSAPP = false; falhar.EMAIL = true;
    const r2 = await criar({ clienteIds: [c.id], canais: ['WHATSAPP', 'EMAIL'], regra: { tipo: 'UNICO', data: dia(1), horario: '11:00' } });
    await tickAutomacoes(at(1, '11:00'));
    await tickAutomacoes(plus(at(1, '11:00'), 61));
    const os2 = await ocorr(r2.body.id);
    expect(os2.find((o) => o.canal === 'EMAIL')).toMatchObject({ status: 'FALHOU', erro: 'SMTP recusou a conexão' });
    expect(os2.find((o) => o.canal === 'WHATSAPP')).toMatchObject({ status: 'ENVIADA' });
    // Reprocessamento seguro só para o que falhou.
    falhar.EMAIL = false;
    const fal = os2.find((o) => o.canal === 'EMAIL')!;
    expect((await owner.post(`${API}/ocorrencias/${os2.find((o) => o.canal === 'WHATSAPP')!.id}/reprocessar`)).status).toBe(400);
    expect((await owner.post(`${API}/ocorrencias/${fal.id}/reprocessar`)).status).toBe(200);
    await tickAutomacoes(new Date(Date.now() + 5000));
    expect((await prisma.ocorrencia.findUniqueOrThrow({ where: { id: fal.id } })).status).toBe('ENVIADA');
    const dash = await owner.get(`${API}/dashboard`);
    expect(dash.body.falhas).toBeGreaterThanOrEqual(1);
    expect(dash.body.clientes).toBeGreaterThan(0);
  });

  it('janela de horário: fora dela o envio é adiado para a abertura da janela', async () => {
    await owner.put(`${API}/config`, { janelaInicio: '08:00', janelaFim: '20:00' });
    const c = await novoCliente();
    const r = await criar({ clienteIds: [c.id], regra: { tipo: 'UNICO', data: dia(1), horario: '21:00' } });
    expect((await tickAutomacoes(at(1, '21:00')))[0].acao).toBe('adiada');
    const [o] = await ocorr(r.body.id);
    expect(o.executarEm.getTime()).toBe(at(2, '08:00').getTime());
    expect(o.status).toBe('PENDENTE');
    await tickAutomacoes(at(2, '08:00'));
    expect(calls).toHaveLength(1);
  });

  it('recupera envios depois de um restart (travados em PROCESSANDO e vencidos)', async () => {
    const c = await novoCliente();
    const r = await criar({ clienteIds: [c.id], inicio: dia(1), fim: dia(1), regra: { tipo: 'DIARIO', horarios: ['09:00', '10:00'] } });
    const [o1, o2] = await ocorr(r.body.id);
    // Processo caiu no meio do envio do 1º (ficou PROCESSANDO) e ficou fora do ar até depois do 2º.
    await prisma.ocorrencia.update({ where: { id: o1.id }, data: { status: 'PROCESSANDO', lockedAt: at(1, '09:00') } });
    resetEngineState();
    const t = await tickAutomacoes(at(1, '10:30'));
    expect(t.map((x) => x.acao)).toEqual(['enviada', 'enviada']);
    expect((await prisma.ocorrencia.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe('ENVIADA');
    expect(calls).toHaveLength(2);
    // Lock recente não é roubado (outro processo ainda pode estar enviando).
    const r2 = await criar({ clienteIds: [c.id], regra: { tipo: 'UNICO', data: dia(1), horario: '12:00' } });
    const [o3] = await ocorr(r2.body.id);
    await prisma.ocorrencia.update({ where: { id: o3.id }, data: { status: 'PROCESSANDO', lockedAt: at(1, '12:00') } });
    expect(await recuperarTravadas(at(1, '12:02'))).toBe(0);
    expect(await recuperarTravadas(at(1, '12:06'))).toBe(1);
  });

  it('idempotência: regerar não duplica e dois processadores não enviam duas vezes', async () => {
    const c = await novoCliente();
    const r = await criar({ clienteIds: [c.id], inicio: dia(1), fim: dia(5), regra: { tipo: 'DIARIO', horarios: ['09:00'] } });
    const a = await prisma.automacao.findUniqueOrThrow({ where: { id: r.body.id } });
    const n = (await ocorr(a.id)).length;
    expect(n).toBe(5);
    expect(await gerarOcorrencias(a, new Date(), new Date(Date.now() + 30 * 86400e3))).toBe(0);
    expect((await ocorr(a.id)).length).toBe(n);
    const [o] = await ocorr(a.id);
    const res = await Promise.all([processarOcorrencia(o.id, at(1, '09:00')), processarOcorrencia(o.id, at(1, '09:00')), processarOcorrencia(o.id, at(1, '09:00'))]);
    expect(res.filter((x) => x === 'enviada')).toHaveLength(1);
    expect(res.filter((x) => x === 'ocupada')).toHaveLength(2);
    expect(calls).toHaveLength(1);
    await expect(prisma.ocorrencia.create({ data: { orgId: a.orgId, automacaoId: a.id, clienteId: c.id, canal: 'WHATSAPP', chave: chaveDe(a.id, c.id, 'WHATSAPP', at(1, '09:00')), agendadoPara: new Date(), executarEm: new Date() } })).rejects.toThrow();
    expect(await prisma.mensagemHistorico.count({ where: { ocorrenciaId: o.id } })).toBe(1);
  });

  it('marketing respeita opt-out e consentimento; lembrete não é afetado pelo opt-out de marketing', async () => {
    const ok = await novoCliente();
    const sair = await novoCliente();
    const semConsent = await novoCliente({ consentimento: false });
    await owner.patch(`${API}/clientes/${sair.id}`, { marketingOptOut: true });
    const mk = await criar({ categoria: 'MARKETING', clienteIds: [ok.id, sair.id, semConsent.id], mensagem: 'Oferta para {{primeiro_nome}}!', regra: { tipo: 'UNICO', data: dia(1), horario: '10:00' } });
    expect(mk.status).toBe(201);
    expect(mk.body.avisos.join(' ')).toMatch(/opt-out/);
    await tickAutomacoes(at(1, '10:00'));
    expect(calls.map((x) => x.to)).toEqual([ok.whatsapp]);
    const os = await ocorr(mk.body.id);
    expect(os.find((o) => o.clienteId === sair.id)).toMatchObject({ status: 'IGNORADA' });
    expect(os.find((o) => o.clienteId === sair.id)!.erro).toMatch(/opt-out/);
    expect(os.find((o) => o.clienteId === semConsent.id)!.erro).toMatch(/consentimento/);

    calls.length = 0;
    await criar({ categoria: 'LEMBRETE', clienteIds: [sair.id], regra: { tipo: 'UNICO', data: dia(1), horario: '11:00' } });
    await tickAutomacoes(at(1, '11:00'));
    expect(calls.map((x) => x.to)).toEqual([sair.whatsapp]);

    // Opt-out recebido pelo WhatsApp ("SAIR") também vale para o marketing do cliente.
    const contact = await prisma.contact.create({ data: { orgId: owner.me.org.id, waId: ok.whatsapp.replace(/\D/g, ''), phone: ok.whatsapp } });
    await onLeadOptOut(owner.me.org.id, contact);
    expect((await prisma.cliente.findUniqueOrThrow({ where: { id: ok.id } })).marketingOptOutAt).toBeTruthy();
  });

  it('permissões: atendente (AGENT) só lê; admin altera; dono exclui', async () => {
    const c = await novoCliente();
    expect((await agent.get(`${API}/clientes`)).status).toBe(200);
    expect((await agent.get(`${API}/dashboard`)).status).toBe(200);
    expect((await agent.get(`${API}/calendario?de=${at(0, '00:00').toISOString()}&ate=${at(7, '00:00').toISOString()}`)).status).toBe(200);
    expect((await agent.post(`${API}/preview`, { clienteId: c.id, mensagem: 'Oi {{primeiro_nome}}' })).status).toBe(200);
    expect((await agent.post(`${API}/clientes`, { nome: 'X' })).status).toBe(403);
    expect((await agent.patch(`${API}/clientes/${c.id}`, { nome: 'Y' })).status).toBe(403);
    expect((await agent.put(`${API}/config`, { limiteDiario: 1 })).status).toBe(403);
    expect((await agent.get(`${API}/clientes/export`)).status).toBe(403);
    expect((await criar({ clienteIds: [c.id], regra: { tipo: 'UNICO', data: dia(1), horario: '10:00' } }, agent)).status).toBe(403);
    const ad = await criar({ clienteIds: [c.id], regra: { tipo: 'UNICO', data: dia(1), horario: '10:00' } }, admin);
    expect(ad.status).toBe(201);
    expect((await agent.post(`${API}/automacoes/${ad.body.id}/pausar`)).status).toBe(403);
    expect((await admin.del(`${API}/clientes/${c.id}`)).status).toBe(403);
    expect((await other.post(`${API}/automacoes/${ad.body.id}/pausar`)).status).toBe(404);
    expect((await owner.del(`${API}/clientes/${c.id}`)).status).toBe(200);
    expect(await prisma.ocorrencia.count({ where: { automacaoId: ad.body.id, status: 'PENDENTE' } })).toBe(0);
    const integ = await owner.get(`${API}/integracoes`);
    expect(integ.body.email).toHaveProperty('configurado');
    expect(Array.isArray(integ.body.whatsapp)).toBe(true);
  });
});
