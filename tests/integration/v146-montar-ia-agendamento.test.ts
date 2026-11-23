import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { app, registerClient, Client, createTestChannel, installGraphMock, graph, sendInbound, sentTexts, prisma, uniq } from '../helpers.js';
import { fakeAi } from '../../server/ai/providers.js';
import { resetAiCache } from '../../server/ai/core.js';
import { resetLimitesMontar } from '../../server/ai/montar/routes.js';
import { resetLimitesAgendar } from '../../server/agendamento/routes.js';
import { PREFIXO_DOC, NOME_FLUXO, MARCA_INI } from '../../server/ai/montar/core.js';

async function invite(owner: Client, role: 'AGENT' | 'ADMIN') {
  const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role });
  const token = inv.body.link.split('/convite/')[1];
  const c = new Client();
  const r = await c.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: `Membro ${uniq()}`, password: 'senhaMembro123' });
  c.csrf = r.body.csrfToken;
  c.me = r.body;
  return c;
}

const PROPOSTA_IA = JSON.stringify({
  empresa: 'Pet Feliz', segmento: 'pet shop', resumo: 'Banho e tosa em Osasco.',
  produtos: [{ nome: 'Banho pequeno porte', preco: 'R$ 45,00', descricao: '' }, { nome: 'Tosa', preco: 'R$ 80', descricao: '' }, { nome: 'Hidratação', preco: 'R$ 99', descricao: '' }],
  horarios: [1, 2, 3, 4, 5].map((dia) => ({ dia, inicio: '09:00', fim: '18:00' })), horarioTexto: '',
  endereco: 'Rua das Flores, 10 - Osasco', contato: '', pagamento: 'Pix, cartão e dinheiro', entrega: '', regras: ['Não buscamos o pet em casa'],
  nuncaPrometer: ['desconto', 'horário sem confirmar'], perguntas: [{ pergunta: 'Vocês buscam em casa?', resposta: 'Não, o tutor traz o pet.' }],
  setores: ['Ver preços', 'Agendar banho'], boasVindas: 'Olá! Bem-vindo à Pet Feliz 🐶', foraDoHorario: '',
});
const TEXTO = 'Somos a Pet Feliz, banho e tosa em Osasco. Banho pequeno porte R$ 45,00, tosa R$ 80. Seg a sex 9h às 18h. Pix, cartão e dinheiro.';

describe('v1.46.0 — Monte sua IA conversando', () => {
  let owner: Client; let ctx: Awaited<ReturnType<typeof createTestChannel>>; let org: string;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    org = owner.me.org.id;
    ctx = await createTestChannel(org);
    await prisma.aiSettings.update({ where: { orgId: org }, data: { provider: 'fake', model: 'fake-1', enabled: false, autoReply: false, instructions: '' } });
  });
  beforeEach(() => { graph.reset(); fakeAi.script = []; fakeAi.calls = []; resetAiCache(); resetLimitesMontar(); });

  it('sem IA nem MCK IA: indisponível com motivo claro', async () => {
    const o2 = await registerClient();
    const r = await o2.get('/api/ai/montar');
    expect(r.status).toBe(200);
    expect(r.body.disponivel).toBe(false);
    expect(r.body.motivo).toMatch(/Configure a IA/);
    expect((await o2.post('/api/ai/montar/gerar', { texto: 'x' })).status).toBe(400);
  });

  it('gera a prévia a partir do texto sem gravar nada; preço que não está nas fontes vem marcado', async () => {
    const s = await owner.get('/api/ai/montar');
    expect(s.body).toMatchObject({ disponivel: true, temInstrucoes: false, totalDocs: 0, aplicadoEm: null });
    fakeAi.script = ['```json\n' + PROPOSTA_IA + '\n```'];
    const r = await owner.post('/api/ai/montar/gerar', { texto: TEXTO });
    expect(r.status).toBe(200);
    expect(r.body.proposta.empresa).toBe('Pet Feliz');
    expect(r.body.proposta.produtos.find((p: any) => p.nome === 'Hidratação').precoConferido).toBe(false);
    expect(r.body.proposta.produtos.find((p: any) => p.nome === 'Tosa').precoConferido).toBe(true);
    expect(fakeAi.calls[0][1].content).toContain('### TEXTO DO DONO');
    expect(await prisma.knowledgeDoc.count({ where: { orgId: org } })).toBe(0);
    expect((await prisma.aiSettings.findUniqueOrThrow({ where: { orgId: org } })).instructions).toBe('');
    expect(await prisma.aiUsage.count({ where: { orgId: org, purpose: 'montar-ia' } })).toBe(1);
  });

  it('IA devolve lixo ou nada útil: erro amigável; sem fonte: pede uma', async () => {
    fakeAi.script = ['não sei'];
    expect((await owner.post('/api/ai/montar/gerar', { texto: TEXTO })).body.error).toMatch(/resultado legível/);
    fakeAi.script = ['{}'];
    expect((await owner.post('/api/ai/montar/gerar', { texto: TEXTO })).body.error).toMatch(/Não encontrei informações/);
    expect((await owner.post('/api/ai/montar/gerar', {})).body.error).toMatch(/pelo menos uma fonte/);
  });

  it('link do site (só endereço público) e PDF de preços viram fonte', async () => {
    graph.other = async (url) => (url.startsWith('https://petfeliz.test') ? new Response('<html><title>Pet Feliz</title><body><p>Banho pequeno porte R$ 45,00</p><p>Atendemos de segunda a sexta, das 9h às 18h, em Osasco.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) : null);
    fakeAi.script = [PROPOSTA_IA];
    const r = await owner.post('/api/ai/montar/gerar', { link: 'petfeliz.test' });
    expect(r.body.error ?? '').toBe('');
    expect(r.status).toBe(200);
    expect(r.body.fontes).toEqual(['https://petfeliz.test/']);
    expect(fakeAi.calls[0][1].content).toContain('Banho pequeno porte R$ 45,00');
    // Endereço interno é recusado (proteção SSRF), com mensagem simples.
    const bloq = await owner.post('/api/ai/montar/gerar', { link: 'http://servidor.interno.test/' });
    expect(bloq.status).toBe(400);
    expect(bloq.body.error).toMatch(/Não consegui abrir esse link/);

    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.drawText('Tabela de precos: Banho R$ 45,00 - Tosa R$ 80,00', { x: 40, y: 700, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    const up = await owner.agent.post('/api/ai/montar/arquivo').set({ ...owner.h(), 'content-type': 'application/octet-stream', 'x-file-name': 'precos.pdf' }).send(bytes);
    expect(up.status).toBe(200);
    expect(up.body.tipo).toBe('arquivo');
    expect(up.body.texto).toContain('Tosa R$ 80,00');
    const ruim = await owner.agent.post('/api/ai/montar/arquivo').set({ ...owner.h(), 'content-type': 'application/octet-stream', 'x-file-name': 'foto.exe' }).send(Buffer.from('MZ...'));
    expect(ruim.status).toBe(400);
    expect(ruim.body.error).toMatch(/Tipo de arquivo não aceito/);
  });

  it('atendente não monta; aplicar exige confirmação', async () => {
    const agent = await invite(owner, 'AGENT');
    expect((await agent.post('/api/ai/montar/gerar', { texto: TEXTO })).status).toBe(403);
    expect((await owner.post('/api/ai/montar/aplicar', { proposta: JSON.parse(PROPOSTA_IA), opcoes: {} })).status).toBe(400);
  });

  it('Aplicar: base, instruções (sem apagar as do dono), fluxo ativo, horário e IA ligada → primeira resposta automática', async () => {
    await prisma.aiSettings.update({ where: { orgId: org }, data: { instructions: 'Trate o cliente por você.' } });
    await prisma.knowledgeDoc.create({ data: { orgId: org, title: 'Meu documento', content: 'texto do dono' } });
    const proposta = { ...JSON.parse(PROPOSTA_IA), produtos: [{ nome: 'Banho pequeno porte', preco: 'R$ 45,00' }] };
    const r = await owner.post('/api/ai/montar/aplicar', { confirmar: true, proposta, opcoes: { substituirInstrucoes: false, criarFluxo: true, ativarFluxo: true, horario: true, ligarIa: true } });
    expect(r.status).toBe(200);
    expect(r.body.fluxoAviso).toBeNull();
    const docs = await prisma.knowledgeDoc.findMany({ where: { orgId: org }, orderBy: { title: 'asc' } });
    expect(docs.map((d) => d.title)).toContain('Meu documento');
    expect(docs.filter((d) => d.title.startsWith(PREFIXO_DOC))).toHaveLength(5);
    expect(await prisma.knowledgeChunk.count({ where: { orgId: org } })).toBeGreaterThanOrEqual(5);
    const ai = await prisma.aiSettings.findUniqueOrThrow({ where: { orgId: org } });
    expect(ai.instructions.startsWith('Trate o cliente por você.')).toBe(true);
    expect(ai.instructions).toContain(MARCA_INI);
    expect(ai).toMatchObject({ enabled: true, autoReply: true, provider: 'fake' });
    expect(ai.assistenteAplicadoEm).not.toBeNull();
    const flow = await prisma.flow.findFirstOrThrow({ where: { orgId: org, name: NOME_FLUXO } });
    expect(flow.status).toBe('ACTIVE');
    const inbox = await prisma.inboxSettings.findUniqueOrThrow({ where: { orgId: org } });
    expect(inbox.hoursEnabled).toBe(true);
    expect(JSON.parse(inbox.hours)).toHaveLength(5);
    expect(inbox.awayMessage).toContain('{horario}');

    // Primeira mensagem de um cliente novo: boas-vindas + menu na hora.
    await sendInbound(ctx, '5511733000001', 'oi');
    const textos = sentTexts().join('\n');
    expect(textos).toContain('Olá! Bem-vindo à Pet Feliz');
    expect(textos).toContain('Agendar banho');
    expect(textos).toContain('Falar com um atendente');

    // Aplicar de novo: atualiza (não duplica) documentos e cria nova versão do fluxo.
    const r2 = await owner.post('/api/ai/montar/aplicar', { confirmar: true, proposta: { ...proposta, empresa: 'Pet Feliz Osasco' }, opcoes: { criarFluxo: true, ativarFluxo: true, horario: false, ligarIa: true } });
    expect(r2.status).toBe(200);
    expect(await prisma.knowledgeDoc.count({ where: { orgId: org, title: { startsWith: PREFIXO_DOC } } })).toBe(5);
    expect((await prisma.flow.findUniqueOrThrow({ where: { id: flow.id } })).currentVersion).toBe(2);
    expect(await prisma.flow.count({ where: { orgId: org, name: NOME_FLUXO } })).toBe(1);
    const ai2 = await prisma.aiSettings.findUniqueOrThrow({ where: { orgId: org } });
    expect(ai2.instructions.split(MARCA_INI)).toHaveLength(2);
    expect(ai2.instructions).toContain('Pet Feliz Osasco');
  });

  it('outro fluxo já responde à primeira mensagem: o de boas-vindas fica como rascunho, com aviso', async () => {
    const o3 = await registerClient();
    const org3 = o3.me.org.id;
    await prisma.aiSettings.update({ where: { orgId: org3 }, data: { provider: 'fake', model: 'fake-1' } });
    await prisma.flow.create({ data: { orgId: org3, name: 'Meu fluxo', status: 'ACTIVE', versions: { create: { version: 1, graph: JSON.stringify({ nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'message' }] } }], edges: [] }) } } } });
    expect((await o3.get('/api/ai/montar')).body.outroFluxoAtivo).toBe('Meu fluxo');
    const r = await o3.post('/api/ai/montar/aplicar', { confirmar: true, proposta: JSON.parse(PROPOSTA_IA), opcoes: { criarFluxo: true, ativarFluxo: true, horario: false, ligarIa: false } });
    expect(r.status).toBe(200);
    expect(r.body.fluxoAviso).toMatch(/Meu fluxo/);
    expect((await prisma.flow.findFirstOrThrow({ where: { orgId: org3, name: NOME_FLUXO } })).status).toBe('DRAFT');
    // ligarIa desligado: a IA continua como estava.
    expect((await prisma.aiSettings.findUniqueOrThrow({ where: { orgId: org3 } })).enabled).toBe(false);
  });

  it('erros de validação chegam em português com o nome do campo', async () => {
    const r = await owner.put('/api/ai/settings', { dailyLimit: -5 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Confira os dados — Limite diário: o mínimo é 0/);
  });
});

// ---------------------------------------------------------------------------

describe('v1.46.0 — página pública de agendamento', () => {
  let owner: Client; let org: string; let slug: string; let servicoId: string;
  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    org = owner.me.org.id;
    await createTestChannel(org);
    // Atende todos os dias, 08:00–20:00, sem antecedência mínima grande (testes não dependem do dia da semana).
    await prisma.agendaSettings.upsert({ where: { orgId: org }, create: { orgId: org, workStart: '08:00', workEnd: '20:00', workDays: '0,1,2,3,4,5,6', minNoticeMin: 30 }, update: { workStart: '08:00', workEnd: '20:00', workDays: '0,1,2,3,4,5,6', minNoticeMin: 30 } });
  });
  beforeEach(() => { graph.reset(); resetLimitesAgendar(); });

  const pub = () => request(app);

  it('dono: endereço criado sozinho, QR code, não liga sem serviço; atendente só lê', async () => {
    const r = await owner.get('/api/agenda/link');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(r.body.slug).toMatch(/^[a-z0-9-]{3,40}$/);
    expect(r.body.url).toContain(`/agendar/${r.body.slug}`);
    expect(r.body.qr).toMatch(/^data:image\/png;base64,/);
    slug = r.body.slug;
    const sem = await owner.put('/api/agenda/link', { enabled: true });
    expect(sem.status).toBe(400);
    expect(sem.body.error).toMatch(/pelo menos um serviço/);
    const s = await owner.post('/api/agenda/link/servicos', { name: 'Banho pequeno porte', durationMin: 60, priceCents: 4500 });
    expect(s.status).toBe(201);
    expect(s.body.price).toBe('R$ 45,00');
    servicoId = s.body.id;
    const invalido = await owner.post('/api/agenda/link/servicos', { name: 'X', durationMin: 2 });
    expect(invalido.status).toBe(400);
    expect(invalido.body.error).toMatch(/Nome do serviço muito curto|Duração mínima/);
    const novoSlug = `pet-${uniq().slice(-6)}`;
    const on = await owner.put('/api/agenda/link', { enabled: true, slug: novoSlug, title: 'Pet Feliz', intro: 'Escolha o melhor horário.' });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    slug = novoSlug;
    expect((await owner.put('/api/agenda/link', { slug: 'admin' })).status).toBe(400);
    const agent = await invite(owner, 'AGENT');
    expect((await agent.get('/api/agenda/link')).status).toBe(200);
    expect((await agent.put('/api/agenda/link', { enabled: false })).status).toBe(403);
  });

  it('página e API públicas: serviços, dias e horários livres', async () => {
    const page = await pub().get(`/agendar/${slug}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('/agendar.js');
    expect(page.headers['x-robots-tag']).toBe('noindex');
    expect((await pub().get('/agendar.js')).text).toContain('Confirmar agendamento');
    const info = await pub().get(`/api/public/agendar/${slug}`);
    expect(info.status).toBe(200);
    expect(info.body.titulo).toBe('Pet Feliz');
    expect(info.body.servicos).toEqual([{ id: servicoId, nome: 'Banho pequeno porte', duracaoMin: 60, preco: 'R$ 45,00', descricao: '' }]);
    expect(info.body.dias.length).toBeGreaterThan(20);
    expect((await pub().get('/api/public/agendar/nao-existe-xyz')).status).toBe(404);
  });

  it('agendar: cria compromisso, contato e conversa no Inbox, confirma no WhatsApp e move no Kanban; horário some', async () => {
    const dia = (await pub().get(`/api/public/agendar/${slug}`)).body.dias[2];
    const h = await pub().get(`/api/public/agendar/${slug}/horarios?servico=${servicoId}&dia=${dia}`);
    expect(h.status).toBe(200);
    expect(h.body.horarios[0]).toBe('08:00');
    const r = await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia, hora: '08:00', nome: 'Ana Souza', whatsapp: '(11) 97330-0002', observacao: 'Cachorro bravo', t: 9000 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, servico: 'Banho pequeno porte', hora: '08:00' });
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(a).toMatchObject({ source: 'LINK', durationMin: 60, bookingServiceId: servicoId, title: 'Banho pequeno porte — Ana Souza', status: 'SCHEDULED' });
    expect(a.description).toContain('Cachorro bravo');
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: a.contactId! } });
    expect(contact).toMatchObject({ name: 'Ana Souza', phone: '5511973300002', origem: 'agendamento' });
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: a.conversationId! } });
    expect(conv).toMatchObject({ status: 'OPEN', origem: 'agendamento' });
    expect(conv.unreadCount).toBeGreaterThan(0);
    const nota = await prisma.message.findFirst({ where: { conversationId: conv.id, direction: 'INTERNAL' } });
    expect(nota?.body).toContain('pelo cliente no link de agendamento');
    // Confirmação ao cliente registrada na conversa (na API oficial de teste ela fica "falhou" por estar fora da janela de 24 h; no QR sai normal).
    const conf = await prisma.message.findFirst({ where: { conversationId: conv.id, direction: 'OUT' } });
    expect(conf?.body).toContain('Banho pequeno porte — Ana Souza');
    expect(r.body.confirmacaoWhatsApp).toBe(conf?.status !== 'FAILED');
    const stage = contact.stageId ? await prisma.kanbanStage.findUnique({ where: { id: contact.stageId } }) : null;
    expect(stage?.name).toBe('Reunião agendada');
    const depois = await pub().get(`/api/public/agendar/${slug}/horarios?servico=${servicoId}&dia=${dia}`);
    expect(depois.body.horarios).not.toContain('08:00');
    expect(depois.body.horarios).not.toContain('08:30'); // 08:30–09:30 bateria no 08:00–09:00
    // Mesmo horário de novo: recusado.
    const dup = await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia, hora: '08:00', nome: 'Bruno', whatsapp: '11973300003', t: 9000 });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/não está mais livre/);
    // Aparece na Agenda do dono com a origem.
    const lista = await owner.get(`/api/agenda?from=${dia}&to=${dia}`);
    expect(lista.body.items.some((x: any) => x.id === a.id && x.source === 'LINK')).toBe(true);
  });

  it('anti-spam: honeypot e envio instantâneo não gravam; dados inválidos; limite por IP; por telefone', async () => {
    const dias = (await pub().get(`/api/public/agendar/${slug}`)).body.dias;
    const antes = await prisma.appointment.count({ where: { orgId: org } });
    const robo1 = await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia: dias[3], hora: '10:00', nome: 'Robo', whatsapp: '11973300009', site: 'http://spam', t: 9000 });
    expect(robo1.status).toBe(201);
    const robo2 = await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia: dias[3], hora: '10:00', nome: 'Robo', whatsapp: '11973300009', t: 200 });
    expect(robo2.status).toBe(201);
    expect(await prisma.appointment.count({ where: { orgId: org } })).toBe(antes);
    expect((await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia: dias[3], hora: '10:00', nome: 'Ana', whatsapp: '123', t: 9000 })).body.error).toMatch(/WhatsApp válido/);
    expect((await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia: dias[3], hora: '10:00', nome: 'x', whatsapp: '11973300009', t: 9000 })).body.error).toMatch(/seu nome/);
    expect((await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia: dias[3], hora: '03:00', nome: 'Ana', whatsapp: '11973300009', t: 9000 })).status).toBe(409); // fora do expediente
    const sexta = await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia: dias[3], hora: '10:00', nome: 'Ana', whatsapp: '11973300009', t: 9000 });
    expect(sexta.status).toBe(429); // 6ª tentativa do mesmo IP em 10 min

    resetLimitesAgendar();
    // O mesmo WhatsApp (com ou sem o 9) não marca mais de 3 horários futuros pelo link.
    for (const [i, hora] of ['12:00', '14:00', '16:00'].entries()) {
      const ok = await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia: dias[4], hora, nome: 'Carla', whatsapp: i % 2 ? '1173300010' : '11973300010', t: 9000 });
      expect(ok.status).toBe(201);
    }
    resetLimitesAgendar();
    const quarto = await pub().post(`/api/public/agendar/${slug}`).send({ servicoId, dia: dias[5], hora: '12:00', nome: 'Carla', whatsapp: '11973300010', t: 9000 });
    expect(quarto.status).toBe(429);
    expect(quarto.body.error).toMatch(/agendamentos em aberto/);
    expect(await prisma.contact.count({ where: { orgId: org, name: 'Carla' } })).toBe(1);
  });

  it('página desligada ou sem serviço ativo: indisponível', async () => {
    await owner.patch(`/api/agenda/link/servicos/${servicoId}`, { active: false });
    expect((await owner.get('/api/agenda/link')).body.enabled).toBe(false);
    expect((await pub().get(`/api/public/agendar/${slug}`)).status).toBe(404);
  });
});
