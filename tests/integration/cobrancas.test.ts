import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { deflateSync } from 'node:zlib';
import { registerClient, Client, uniq, prisma, createTestChannel, installGraphMock, graph } from '../helpers.js';
import { tickAutomacoes, setAutomacaoSender, resetEngineState, type SendArgs } from '../../server/mckmensagem/automacoes/engine.js';
import { atualizarVencidos } from '../../server/mckmensagem/automacoes/financeiro.js';
import { receberMidiaWhatsApp } from '../../server/mckmensagem/automacoes/comprovantes.js';
import { handleInboundMessage } from '../../server/whatsapp/inbound.js';
import { zonedToUtc, localDate } from '../../server/mckmensagem/automacoes/rules.js';
import { qrManager } from '../../server/whatsapp/qr/manager.js';
import { outbox } from '../../server/lib/mailer.js';
import { block, unblock } from '../../server/billing/service.js';

const TZ = 'America/Sao_Paulo';
const dia = (n: number) => localDate(new Date(Date.now() + n * 86400e3), TZ);
const at = (n: number, hhmm: string) => zonedToUtc(dia(n), hhmm, TZ);
const API = '/api/mckmensagem/automacoes';

const pdf = (texto = 'Boleto', comprimido = false) => {
  const conteudo = `BT /F1 12 Tf 72 712 Td (${texto}) Tj ET`;
  const stream = comprimido ? deflateSync(Buffer.from(conteudo, 'latin1')) : Buffer.from(conteudo, 'latin1');
  return Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${stream.length} ${comprimido ? '/Filter /FlateDecode ' : ''}>>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream\nendobj\ntrailer << >>\n%%EOF\n', 'latin1')]);
};
const png = (seed = 'x') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`IHDR${seed}${Math.random()}`)]);

type Call = { canal: string; texto: string; anexos: string[]; assunto?: string | null };
const calls: Call[] = [];
const falhar = { WHATSAPP: false, EMAIL: false };
const mockSender = (canal: 'WHATSAPP' | 'EMAIL') => async (a: SendArgs) => {
  calls.push({ canal, texto: a.texto, anexos: (a.anexos ?? []).map((x) => x.nome), assunto: a.assunto });
  if (falhar[canal]) return { ok: false, error: canal === 'WHATSAPP' ? 'WhatsApp (QR) não conectado' : 'SMTP recusou a conexão' };
  return { ok: true, provedorId: `${canal}-${calls.length}` };
};

describe('Automações e Cobranças (fase 2): boletos, anexos, comprovantes e pagamentos', () => {
  let owner: Client, agent: Client, admin: Client, other: Client;
  let seq = 0;
  const upload = (c: Client, nome: string, dados: Buffer, query = '') =>
    c.agent.post(`${API}/arquivos${query}`).set(c.h()).set('content-type', 'application/octet-stream').set('x-file-name', encodeURIComponent(nome)).send(dados);
  const novoCliente = async (extra: Record<string, unknown> = {}) => {
    seq++;
    const r = await owner.post(`${API}/clientes`, { nome: `Maria Souza ${seq}`, whatsapp: `1197777${String(1000 + seq).slice(-4)}`, email: `maria${seq}.${uniq()}@cliente.dev`, consentimento: true, ...extra });
    expect(r.status).toBe(201);
    return r.body;
  };
  const novoBoleto = async (clienteId: string, extra: Record<string, unknown> = {}) => {
    const r = await owner.post(`${API}/boletos`, { clienteId, descricao: 'Mensalidade', valor: 100, vencimento: dia(5), ...extra });
    expect(r.status).toBe(201);
    return r.body;
  };
  const boletoComPdf = async (clienteId: string, parcela: number, venc: string) => {
    const up = await upload(owner, `boleto-parcela-${parcela}.pdf`, pdf(`Parcela ${parcela}`), `?clienteId=${clienteId}`);
    expect(up.status).toBe(201);
    return novoBoleto(clienteId, { parcela, totalParcelas: 3, vencimento: venc, arquivoId: up.body.id, linhaDigitavel: `2379000000${parcela}0000000000000000000000000000000000000`.slice(0, 47) });
  };
  const boleto = (id: string) => prisma.boleto.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    installGraphMock();
    setAutomacaoSender('WHATSAPP', mockSender('WHATSAPP'));
    setAutomacaoSender('EMAIL', mockSender('EMAIL'));
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
  afterAll(() => { setAutomacaoSender('WHATSAPP', null); setAutomacaoSender('EMAIL', null); qrManager.resetForTests(); });
  beforeEach(async () => {
    calls.length = 0;
    falhar.WHATSAPP = false; falhar.EMAIL = false;
    resetEngineState();
    graph.reset();
    await prisma.automacao.updateMany({ where: { status: 'ATIVA' }, data: { status: 'PAUSADA' } });
    await prisma.automacaoConfig.deleteMany({});
  });

  it('arquivos: valida tipo real, tamanho e segurança; download só autenticado/admin e isolado por organização', async () => {
    const c = await novoCliente();
    const ok = await upload(owner, 'fatura.pdf', pdf('Fatura'), `?clienteId=${c.id}`);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ nome: 'fatura.pdf', mime: 'application/pdf', clienteId: c.id });
    expect((await upload(owner, 'virus.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]))).status).toBe(400);
    const ext = await upload(owner, 'imagem.png', pdf());
    expect(ext.status).toBe(400);
    expect(ext.body.error).toMatch(/não corresponde/);
    const js = await upload(owner, 'ativo.pdf', Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF'));
    expect(js.status).toBe(400);
    expect(js.body.error).toMatch(/conteúdo ativo/);
    expect((await upload(owner, 'planilha.docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]))).body.error).toMatch(/permitidos/);
    expect((await owner.put(`${API}/config`, { tamanhoMaxMb: 1 })).status).toBe(200);
    const grande = await upload(owner, 'grande.pdf', Buffer.concat([pdf(), Buffer.alloc(1.2 * 1024 * 1024)]));
    expect(grande.status).toBe(413);
    // Download: bytes idênticos, sem cache, só para admin da mesma organização.
    const dl = await owner.agent.get(`${API}/arquivos/${ok.body.id}/download`).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(dl.status).toBe(200);
    expect(dl.headers['cache-control']).toMatch(/no-store/);
    expect(Buffer.compare(dl.body, pdf('Fatura'))).toBe(0);
    expect((await agent.get(`${API}/arquivos/${ok.body.id}/download`)).status).toBe(403);
    expect((await other.get(`${API}/arquivos/${ok.body.id}/download`)).status).toBe(404);
    expect((await new Client().get(`${API}/arquivos/${ok.body.id}/download`)).status).toBe(401);
    expect((await agent.get(`${API}/arquivos`)).status).toBe(200); // lista: somente leitura liberada
    expect((await upload(agent, 'x.pdf', pdf())).status).toBe(403);
    // Remoção: só o dono e só se não estiver vinculado.
    await novoBoleto(c.id, { arquivoId: ok.body.id });
    expect((await admin.del(`${API}/arquivos/${ok.body.id}`)).status).toBe(403);
    expect((await owner.del(`${API}/arquivos/${ok.body.id}`)).status).toBe(409);
    const solto = await upload(owner, 'solto.png', png());
    expect((await owner.del(`${API}/arquivos/${solto.body.id}`)).status).toBe(200);
  });

  it('boletos: cadastro, parcelas em lote, status vencido automático e status de envio separado do financeiro', async () => {
    const c = await novoCliente();
    expect((await owner.post(`${API}/boletos`, { clienteId: c.id, descricao: 'X', valor: 0, vencimento: dia(1) })).status).toBe(400);
    expect((await other.post(`${API}/boletos`, { clienteId: c.id, descricao: 'X', valor: 10, vencimento: dia(1) })).status).toBe(404);
    const lote = await owner.post(`${API}/boletos/parcelas`, { clienteId: c.id, descricao: 'Plano anual', valorParcela: 250, parcelas: 3, primeiroVencimento: '2030-01-31', numeroDocumentoBase: 'NF77' });
    expect(lote.status).toBe(201);
    expect(lote.body.map((b: any) => [b.parcela, b.totalParcelas, b.vencimentoData, b.numeroDocumento])).toEqual([[1, 3, '2030-01-31', 'NF77-1'], [2, 3, '2030-02-28', 'NF77-2'], [3, 3, '2030-03-31', 'NF77-3']]);
    const b = await novoBoleto(c.id, { vencimento: dia(1), juros: 2.5, multa: 2, desconto: 1 });
    expect(b).toMatchObject({ status: 'PENDENTE', statusEnvio: 'NAO_ENVIADO', devido: 103.5, saldo: 103.5 });
    expect(await atualizarVencidos(at(1, '23:00'))).toBe(0);
    expect(await atualizarVencidos(at(2, '00:01'))).toBeGreaterThanOrEqual(1);
    expect((await boleto(b.id)).status).toBe('VENCIDO');
    const det = await owner.get(`${API}/boletos/${b.id}`);
    expect(det.body.eventos.map((e: any) => e.tipo)).toContain('VENCIDO');
    expect(det.body.statusEnvio).toBe('NAO_ENVIADO');
    // Edição auditada; boleto pago não muda valor.
    const ed = await owner.patch(`${API}/boletos/${b.id}`, { linhaDigitavel: '23790.00000 00000.000000 00000.000000 1 00000000010350' });
    expect(ed.status).toBe(200);
    expect((await owner.get(`${API}/boletos?clienteId=${c.id}&status=ABERTOS`)).body.total).toBe(4);
    expect((await agent.get(`${API}/boletos?clienteId=${c.id}`)).status).toBe(200);
    expect((await agent.post(`${API}/boletos`, { clienteId: c.id, descricao: 'X', valor: 10, vencimento: dia(1) })).status).toBe(403);
    // Cliente com histórico financeiro não é excluído.
    expect((await owner.del(`${API}/clientes/${c.id}`)).status).toBe(409);
  });

  it('vários boletos em sequência: mensagem N leva o boleto N, na ordem, com variáveis da parcela; pago no meio não é cobrado', async () => {
    const c = await novoCliente();
    const b1 = await boletoComPdf(c.id, 1, dia(2));
    const b2 = await boletoComPdf(c.id, 2, dia(4));
    const b3 = await boletoComPdf(c.id, 3, dia(6));
    const contrato = await upload(owner, 'contrato.pdf', pdf('Contrato'));
    const r = await owner.post(`${API}/automacoes`, {
      nome: 'Cobrança Maria', categoria: 'COBRANCA', canais: ['WHATSAPP', 'EMAIL'], clienteIds: [c.id], assunto: 'Parcela {{numero_parcela}}/{{total_parcelas}}',
      mensagem: 'Olá {{primeiro_nome}}, segue a parcela {{numero_parcela}} de {{valor_parcela}}, vence em {{data_vencimento}}.',
      regra: { tipo: 'DATAS', datas: [{ data: dia(1), horario: '09:00', mensagem: 'Apresentação: parcela {{numero_parcela}}.' }, { data: dia(3), horario: '09:00' }, { data: dia(5), horario: '09:00' }] },
      anexos: [{ envio: 1, arquivoId: contrato.body.id }, { envio: 1, boletoId: b1.id }, { envio: 2, boletoId: b2.id }, { envio: 3, boletoId: b3.id }],
      reenvio: null, ativar: true,
    });
    expect(r.status).toBe(201);
    expect(r.body.anexos.map((x: any) => [x.envio, x.boleto?.parcela ?? x.nome])).toEqual([[1, 'contrato.pdf'], [1, 1], [2, 2], [3, 3]]);
    const os = await prisma.ocorrencia.findMany({ where: { automacaoId: r.body.id }, orderBy: [{ agendadoPara: 'asc' }, { canal: 'asc' }] });
    expect(os.map((o) => [o.indice, o.boletoId])).toEqual([[1, b1.id], [1, b1.id], [2, b2.id], [2, b2.id], [3, b3.id], [3, b3.id]]);

    await tickAutomacoes(at(1, '09:00'));
    expect(calls).toHaveLength(2);
    expect(calls[0].texto).toBe('Apresentação: parcela 1.');
    for (const x of calls) expect(x.anexos).toEqual(['contrato.pdf', 'boleto-parcela-1.pdf']);
    expect(calls.find((x) => x.canal === 'EMAIL')!.assunto).toBe('Parcela 1/3');
    const e1 = await boleto(b1.id);
    expect(e1).toMatchObject({ statusEnvio: 'ENVIADO', status: 'PENDENTE', envios: 2 }); // mensagem enviada ≠ boleto pago

    // Parcela 2 paga antes da mensagem 2: nada sai dela (ocorrências canceladas); parcela 3 segue.
    const pg = await owner.post(`${API}/boletos/${b2.id}/pagamentos`, { valor: 100, pagoEm: dia(0), forma: 'Pix' });
    expect(pg.status).toBe(201);
    expect(pg.body.boleto.status).toBe('PAGO');
    expect(await prisma.ocorrencia.count({ where: { boletoId: b2.id, status: 'CANCELADA' } })).toBe(2);
    calls.length = 0;
    await tickAutomacoes(at(3, '09:00'));
    expect(calls).toHaveLength(0);
    await tickAutomacoes(at(5, '09:00'));
    expect(calls).toHaveLength(2);
    expect(calls[0].texto).toBe(`Olá Maria, segue a parcela 3 de R$ 100,00, vence em ${dia(6).split('-').reverse().join('/')}.`);
    expect(calls[0].anexos).toEqual(['boleto-parcela-3.pdf']);
    const h = await owner.get(`${API}/historico?automacaoId=${r.body.id}&status=ENVIADA`);
    expect(h.body.items.every((x: any) => x.anexos.length >= 1 && x.boletoId)).toBe(true);
    // Paga tudo: a sequência encerra sozinha.
    await owner.post(`${API}/boletos/${b1.id}/pagamentos`, { valor: 100, pagoEm: dia(0) });
    await owner.post(`${API}/boletos/${b3.id}/pagamentos`, { valor: 100, pagoEm: dia(0) });
    expect((await prisma.automacao.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('CONCLUIDA');
  });

  it('valida anexos: boleto só em cobrança, de um único cliente, datas crescentes; variável de boleto sem boleto bloqueia', async () => {
    const c = await novoCliente();
    const c2 = await novoCliente();
    const b = await novoBoleto(c.id);
    const base = { nome: 'Teste', canais: ['WHATSAPP'], mensagem: 'Oi {{primeiro_nome}}', regra: { tipo: 'UNICO', data: dia(1), horario: '10:00' } };
    expect((await owner.post(`${API}/automacoes`, { ...base, categoria: 'LEMBRETE', clienteIds: [c.id], anexos: [{ envio: 1, boletoId: b.id }] })).body.error).toMatch(/cobrança/);
    expect((await owner.post(`${API}/automacoes`, { ...base, categoria: 'COBRANCA', clienteIds: [c.id, c2.id], anexos: [{ envio: 1, boletoId: b.id }] })).body.error).toMatch(/único cliente/);
    const fora = await owner.post(`${API}/automacoes`, { ...base, categoria: 'COBRANCA', clienteIds: [c.id], regra: { tipo: 'DATAS', datas: [{ data: dia(3), horario: '10:00' }, { data: dia(2), horario: '10:00' }] }, anexos: [{ envio: 1, boletoId: b.id }] });
    expect(fora.body.error).toMatch(/ordem crescente/);
    const semBoleto = await owner.post(`${API}/automacoes`, { ...base, categoria: 'COBRANCA', clienteIds: [c.id], mensagem: 'Pague {{link_pagamento}}', ativar: true });
    expect(semBoleto.status).toBe(400);
    expect(semBoleto.body.error).toMatch(/nenhum boleto/);
    // Documento de outro cliente nunca vai para uma automação de vários clientes.
    const arq = await upload(owner, 'doc.pdf', pdf(), `?clienteId=${c.id}`);
    expect((await owner.post(`${API}/automacoes`, { ...base, categoria: 'LEMBRETE', clienteIds: [c2.id], anexos: [{ arquivoId: arq.body.id }] })).status).toBe(400);
    // Prévia com boleto.
    const pv = await owner.post(`${API}/preview`, { clienteId: c.id, boletoId: b.id, mensagem: 'Saldo {{valor_pendente}} doc {{numero_documento}}' });
    expect(pv.body.bloqueado).toBe(true);
    expect(pv.body.faltando).toEqual(['numero_documento']);
  });

  it('reenvio de boleto vencido e pendente conforme as regras; nunca reenvia boleto pago; respeita o máximo', async () => {
    const c = await novoCliente();
    const b1 = await boletoComPdf(c.id, 1, dia(2));
    const b2 = await boletoComPdf(c.id, 2, dia(3));
    const r = await owner.post(`${API}/automacoes`, {
      nome: 'Cobrança com reenvio', categoria: 'COBRANCA', canais: ['WHATSAPP'], clienteIds: [c.id], mensagem: 'Parcela {{numero_parcela}}',
      regra: { tipo: 'DATAS', datas: [{ data: dia(1), horario: '09:00' }, { data: dia(2), horario: '09:00' }] },
      anexos: [{ envio: 1, boletoId: b1.id }, { envio: 2, boletoId: b2.id }],
      reenvio: { offsets: [1, 3, 5], horario: '10:00', maxPorBoleto: 2, mensagem: 'Lembrete: parcela {{numero_parcela}} vencida, saldo {{valor_pendente}}.' }, ativar: true,
    });
    expect(r.status).toBe(201);
    const reenvios = await prisma.ocorrencia.findMany({ where: { automacaoId: r.body.id, tipo: 'REENVIO' }, orderBy: { agendadoPara: 'asc' } });
    expect(reenvios).toHaveLength(6);
    await tickAutomacoes(at(1, '09:00'));
    await tickAutomacoes(at(2, '09:00'));
    expect(calls.map((x) => x.texto)).toEqual(['Parcela 1', 'Parcela 2']);
    calls.length = 0;
    // D+1 do boleto 1: está vencido e pendente → reenvia só ele, com o próprio PDF.
    await tickAutomacoes(at(3, '10:00'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ texto: 'Lembrete: parcela 1 vencida, saldo R$ 100,00.', anexos: ['boleto-parcela-1.pdf'] });
    expect((await boleto(b1.id)).status).toBe('VENCIDO');
    // Boleto 1 pago: nenhum reenvio dele; boleto 2 continua sendo cobrado.
    await owner.post(`${API}/boletos/${b1.id}/pagamentos`, { valor: 100, pagoEm: dia(0) });
    calls.length = 0;
    await tickAutomacoes(at(4, '10:00'));
    expect(calls.map((x) => x.texto)).toEqual(['Lembrete: parcela 2 vencida, saldo R$ 100,00.']);
    await tickAutomacoes(at(5, '10:00'));
    await tickAutomacoes(at(6, '10:00'));
    await tickAutomacoes(at(8, '10:00'));
    expect(calls.filter((x) => x.texto.includes('parcela 1'))).toHaveLength(0);
    expect(calls.filter((x) => x.texto.includes('parcela 2'))).toHaveLength(2); // máximo de 2 reenvios por boleto
    const ign = await prisma.ocorrencia.findFirst({ where: { automacaoId: r.body.id, boletoId: b2.id, tipo: 'REENVIO', status: 'IGNORADA' } });
    expect(ign?.erro).toMatch(/Limite de 2/);
    // Reenvio manual: boleto pago é recusado.
    expect((await owner.post(`${API}/boletos/${b1.id}/reenviar`)).status).toBe(409);
    const man = await owner.post(`${API}/boletos/${b2.id}/reenviar`);
    expect(man.status).toBe(200);
  });

  it('comprovante pelo WhatsApp: vincula ao cliente e à parcela, fica em análise (não paga); duplicado e inconclusivo detectados; aprovar baixa', async () => {
    const c = await novoCliente();
    const b1 = await novoBoleto(c.id, { valor: 150, parcela: 1, totalParcelas: 2, vencimento: dia(3) });
    const b2 = await novoBoleto(c.id, { valor: 200, parcela: 2, totalParcelas: 2, vencimento: dia(33) });
    const { ch } = await createTestChannel(owner.me.org.id);
    const waId = c.whatsapp.replace(/\D/g, '');
    const comp = pdf('Comprovante Pix Nubank R$ 150,00 ID da transacao: E12345678202610281234abcdeXYZ', true);
    const r = await handleInboundMessage(ch, { phoneNumberId: ch.phoneNumberId!, waMessageId: `wamid.${uniq()}`, from: waId, timestamp: new Date(), type: 'document', text: 'segue o comprovante', mediaId: 'm1' },
      async () => ({ dados: comp, nome: 'comprovante.pdf', mime: 'application/pdf' }));
    expect(r).toBe('ok');
    const list = await owner.get(`${API}/comprovantes?status=EM_ANALISE&clienteId=${c.id}`);
    expect(list.body.items).toHaveLength(1);
    const cp = list.body.items[0];
    expect(cp).toMatchObject({ origem: 'WHATSAPP', valorDetectado: 150, instituicao: 'Nubank', duplicado: false });
    expect(cp.boleto.id).toBe(b1.id);
    expect(cp.confianca).toBeGreaterThanOrEqual(60);
    expect(cp.motivos.join(' ')).toMatch(/Valor confere/);
    expect((await boleto(b1.id)).status).toBe('EM_ANALISE'); // receber ≠ pagar
    expect((await boleto(b1.id)).valorPagoCentavos).toBe(0);
    const hist = await owner.get(`${API}/historico?direcao=IN&clienteId=${c.id}`);
    expect(hist.body.items[0]).toMatchObject({ status: 'RECEBIDA', categoria: 'COBRANCA', comprovanteId: cp.id });

    // Mesmo evento repetido: ignorado (idempotente). Mesmo arquivo em outra mensagem: duplicado.
    const mesmoId = (await prisma.comprovante.findUniqueOrThrow({ where: { id: cp.id } })).origemId!;
    expect(await receberMidiaWhatsApp(owner.me.org.id, { id: 'x', waId, phone: c.whatsapp }, { waMessageId: mesmoId, type: 'document', texto: '', baixar: async () => ({ dados: comp, nome: 'c.pdf' }) })).toBeNull();
    const dup = await receberMidiaWhatsApp(owner.me.org.id, { id: 'x', waId, phone: c.whatsapp }, { waMessageId: `wamid.${uniq()}`, type: 'document', texto: 'paguei', baixar: async () => ({ dados: comp, nome: 'c.pdf' }) });
    expect(dup?.duplicadoDeId).toBe(cp.id);
    expect(dup!.confianca).toBeLessThanOrEqual(10);
    expect((await owner.post(`${API}/comprovantes/${dup!.id}/aprovar`, {})).status).toBe(409);
    expect((await owner.post(`${API}/comprovantes/${dup!.id}/rejeitar`, { motivo: 'Duplicado' })).status).toBe(200);

    // Inconclusivo: imagem sem legenda útil de cliente com 2 boletos → em análise sem boleto definido.
    const inc = await receberMidiaWhatsApp(owner.me.org.id, { id: 'x', waId, phone: c.whatsapp }, { waMessageId: `wamid.${uniq()}`, type: 'image', texto: '', baixar: async () => ({ dados: png(), nome: 'foto.png' }) });
    expect(inc).toMatchObject({ status: 'EM_ANALISE', boletoId: null });
    expect((await owner.post(`${API}/comprovantes/${inc!.id}/aprovar`, {})).body.error).toMatch(/Escolha o boleto/);
    // Mídia de quem não é cliente e não fala de pagamento: não vira comprovante.
    expect(await receberMidiaWhatsApp(owner.me.org.id, { id: 'y', waId: '5511900001111', phone: '+5511900001111' }, { waMessageId: `wamid.${uniq()}`, type: 'image', texto: 'olha a foto', baixar: async () => ({ dados: png(), nome: 'f.png' }) })).toBeNull();

    // Aprovação: AGENT não pode; admin aprova → pago confirmado, com responsável e data.
    expect((await agent.post(`${API}/comprovantes/${cp.id}/aprovar`, {})).status).toBe(403);
    const ap = await admin.post(`${API}/comprovantes/${cp.id}/aprovar`, { observacoes: 'Conferido no extrato' });
    expect(ap.status).toBe(200);
    expect(ap.body.boleto.status).toBe('PAGO');
    expect(ap.body.pagamento).toMatchObject({ valorCentavos: 15000, origem: 'COMPROVANTE', comprovanteId: cp.id });
    expect(ap.body.comprovante).toMatchObject({ status: 'APROVADO', revisadoPorId: admin.me.user.id });
    expect((await boleto(b2.id)).status).toBe('PENDENTE');
    const aud = await prisma.auditLog.findFirst({ where: { action: 'automacoes.comprovante.aprovar', entityId: cp.id } });
    expect(aud?.userId).toBe(admin.me.user.id);
  });

  it('comprovante enviado pelo operador; rejeitar devolve o boleto ao status anterior', async () => {
    const c = await novoCliente();
    const b = await novoBoleto(c.id, { valor: 80, vencimento: dia(2) });
    const up = await owner.agent.post(`${API}/comprovantes?clienteId=${c.id}&origem=EMAIL&texto=${encodeURIComponent('Pagamento R$ 80,00')}`).set(owner.h()).set('content-type', 'application/octet-stream').set('x-file-name', 'recibo.png').send(png('r'));
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ boletoId: b.id, status: 'EM_ANALISE', origem: 'EMAIL' });
    expect((await boleto(b.id)).status).toBe('EM_ANALISE');
    expect((await owner.post(`${API}/comprovantes/${up.body.id}/rejeitar`, { motivo: 'Ilegível' })).status).toBe(200);
    expect((await boleto(b.id)).status).toBe('PENDENTE');
    const ev = await owner.get(`${API}/boletos/${b.id}`);
    expect(ev.body.eventos.some((e: any) => /rejeitado: Ilegível/.test(e.descricao))).toBe(true);
  });

  it('pagamento parcial, saldo restante, quitação e estorno auditado (somente o dono)', async () => {
    const c = await novoCliente();
    const b = await novoBoleto(c.id, { valor: 100, vencimento: dia(10) });
    expect((await owner.post(`${API}/boletos/${b.id}/pagamentos`, { valor: 150, pagoEm: dia(0) })).status).toBe(400);
    const p1 = await owner.post(`${API}/boletos/${b.id}/pagamentos`, { valor: 40, pagoEm: dia(0), forma: 'Dinheiro' });
    expect(p1.body.boleto).toMatchObject({ status: 'PARCIAL', valorPagoCentavos: 4000 });
    const det = await owner.get(`${API}/clientes/${c.id}`);
    expect(det.body.saldoPendente).toBe(60);
    const p2 = await owner.post(`${API}/boletos/${b.id}/pagamentos`, { valor: 60, pagoEm: dia(0) });
    expect(p2.body.boleto.status).toBe('PAGO');
    expect((await owner.post(`${API}/boletos/${b.id}/pagamentos`, { valor: 1, pagoEm: dia(0) })).status).toBe(409);
    expect((await owner.post(`${API}/boletos/${b.id}/cancelar`, { motivo: 'teste' })).status).toBe(400);
    expect((await admin.post(`${API}/pagamentos/${p2.body.pagamento.id}/estornar`, { motivo: 'Pix devolvido' })).status).toBe(403);
    const est = await owner.post(`${API}/pagamentos/${p2.body.pagamento.id}/estornar`, { motivo: 'Pix devolvido' });
    expect(est.status).toBe(200);
    expect(est.body.boleto).toMatchObject({ status: 'PARCIAL', valorPagoCentavos: 4000, pagoEm: null });
    const pags = await owner.get(`${API}/pagamentos?clienteId=${c.id}`);
    expect(pags.body.items).toHaveLength(2); // o estornado continua registrado
    expect(pags.body.items.find((p: any) => p.estornadoEm)).toMatchObject({ estornoMotivo: 'Pix devolvido' });
  });

  it('envio real de anexos: QR (Baileys) manda o PDF como documento; retentativa não repete o que já saiu; e-mail anexa; Cloud API faz upload', async () => {
    setAutomacaoSender('WHATSAPP', null);
    setAutomacaoSender('EMAIL', null);
    try {
      const ch = await owner.post('/api/channels', { name: 'Celular cobrança' });
      expect(ch.status).toBe(201);
      await prisma.channel.update({ where: { id: ch.body.id }, data: { status: 'CONNECTED' } });
      const enviados: any[] = [];
      let falharDocumento = true;
      qrManager.attachForTests(ch.body.id, {
        async sendMessage(_jid: string, content: any) {
          if (content.document && falharDocumento) { falharDocumento = false; throw new Error('Conexão caiu'); }
          enviados.push(content);
          return { key: { id: `QR${enviados.length}${uniq()}` } };
        },
      } as any, 'CONNECTED');
      const c = await novoCliente();
      const b = await boletoComPdf(c.id, 1, dia(3));
      outbox.length = 0;
      const r = await owner.post(`${API}/automacoes`, {
        nome: 'Envio real', categoria: 'COBRANCA', canais: ['WHATSAPP', 'EMAIL'], channelId: ch.body.id, clienteIds: [c.id], mensagem: 'Segue a parcela {{numero_parcela}}',
        regra: { tipo: 'UNICO', data: dia(1), horario: '09:00' }, anexos: [{ envio: 1, boletoId: b.id }], reenvio: null, ativar: true,
      });
      expect(r.status).toBe(201);
      const t1 = await tickAutomacoes(at(1, '09:00'));
      expect(t1.map((x) => x.acao).sort()).toEqual(['enviada', 'nova_tentativa']);
      expect(enviados).toHaveLength(1);
      expect(enviados[0].text).toBe('Segue a parcela 1');
      const wa = await prisma.ocorrencia.findFirstOrThrow({ where: { automacaoId: r.body.id, canal: 'WHATSAPP' } });
      expect(wa).toMatchObject({ status: 'PENDENTE', partesEnviadas: 1, tentativas: 1 });
      expect(wa.erro).toMatch(/Conexão caiu.*anexo/);
      await tickAutomacoes(new Date(at(1, '09:00').getTime() + 120_000));
      expect(enviados).toHaveLength(2); // só o documento: o texto não foi repetido
      expect(enviados[1]).toMatchObject({ fileName: 'boleto-parcela-1.pdf', mimetype: 'application/pdf' });
      expect(Buffer.isBuffer(enviados[1].document)).toBe(true);
      const mail = outbox.find((m) => m.to === c.email)!;
      expect(mail.attachments?.map((a) => a.filename)).toEqual(['boleto-parcela-1.pdf']);
      expect((await boleto(b.id)).statusEnvio).toBe('ENVIADO');

      // Cloud API: upload do arquivo em /media e envio pelo id.
      const { ch: cloud } = await createTestChannel(owner.me.org.id);
      const c2 = await novoCliente();
      const contact = await prisma.contact.create({ data: { orgId: owner.me.org.id, waId: c2.whatsapp.replace(/\D/g, ''), phone: c2.whatsapp } });
      await prisma.conversation.create({ data: { orgId: owner.me.org.id, contactId: contact.id, channelId: cloud.id, lastInboundAt: new Date() } });
      const arq = await upload(owner, 'manual.pdf', pdf('Manual'));
      const r2 = await owner.post(`${API}/automacoes`, {
        nome: 'Cloud', categoria: 'LEMBRETE', canais: ['WHATSAPP'], channelId: cloud.id, clienteIds: [c2.id], mensagem: 'Manual anexo',
        regra: { tipo: 'UNICO', data: dia(1), horario: '11:00' }, anexos: [{ arquivoId: arq.body.id }], ativar: true,
      });
      expect(r2.status).toBe(201);
      expect((await tickAutomacoes(at(1, '11:00'))).map((x) => x.acao)).toEqual(['enviada']);
      expect(graph.calls.some((x) => x.url.endsWith('/media') && x.body?.formData?.file)).toBe(true);
      expect(graph.calls.some((x) => x.body?.type === 'document' && x.body.document.id?.startsWith('media-') && x.body.document.filename === 'manual.pdf')).toBe(true);
    } finally {
      setAutomacaoSender('WHATSAPP', mockSender('WHATSAPP'));
      setAutomacaoSender('EMAIL', mockSender('EMAIL'));
    }
  });

  it('falha do WhatsApp e do e-mail com anexo ficam registradas separadamente e o boleto não é marcado como pago nem enviado', async () => {
    const c = await novoCliente();
    const b = await boletoComPdf(c.id, 1, dia(3));
    falhar.WHATSAPP = true;
    await owner.put(`${API}/config`, { maxTentativas: 1 });
    const r = await owner.post(`${API}/automacoes`, {
      nome: 'Falha', categoria: 'COBRANCA', canais: ['WHATSAPP', 'EMAIL'], clienteIds: [c.id], mensagem: 'Parcela {{numero_parcela}}',
      regra: { tipo: 'UNICO', data: dia(1), horario: '09:00' }, anexos: [{ envio: 1, boletoId: b.id }], reenvio: null, ativar: true,
    });
    const t = await tickAutomacoes(at(1, '09:00'));
    expect(t.map((x) => x.acao).sort()).toEqual(['enviada', 'falhou']);
    const h = await owner.get(`${API}/historico?automacaoId=${r.body.id}`);
    expect(h.body.items.find((x: any) => x.canal === 'WHATSAPP')).toMatchObject({ status: 'FALHOU', erro: 'WhatsApp (QR) não conectado' });
    expect(h.body.items.find((x: any) => x.canal === 'EMAIL')).toMatchObject({ status: 'ENVIADA' });
    const bo = await boleto(b.id);
    expect(bo.status).toBe('PENDENTE');
    expect(bo.statusEnvio).toBe('ENVIADO'); // e-mail saiu
    const ev = await owner.get(`${API}/boletos/${b.id}`);
    expect(ev.body.eventos.some((e: any) => e.tipo === 'ENVIO_FALHOU')).toBe(true);
  });

  it('relatórios, dashboard e calendário refletem os registros reais (sem contar duas vezes); exportação CSV', async () => {
    const outro = await registerClient();
    const R = (c: Client) => c.get(`${API}/relatorios?de=${dia(-1)}&ate=${dia(1)}`);
    const c = await outro.post(`${API}/clientes`, { nome: 'Relatório', whatsapp: '11955554444', consentimento: true });
    const b1 = await outro.post(`${API}/boletos`, { clienteId: c.body.id, descricao: 'A', valor: 100, vencimento: dia(-2) });
    const b2 = await outro.post(`${API}/boletos`, { clienteId: c.body.id, descricao: 'B', valor: 50, vencimento: dia(4) });
    await outro.post(`${API}/boletos`, { clienteId: c.body.id, descricao: 'C', valor: 70, vencimento: dia(20) });
    await outro.post(`${API}/boletos/${b2.body.id}/pagamentos`, { valor: 20, pagoEm: dia(0) });
    await outro.post(`${API}/boletos/${b1.body.id}/pagamentos`, { valor: 100, pagoEm: dia(0) });
    const rel = await R(outro);
    expect(rel.status).toBe(200);
    expect(rel.body.financeiro).toMatchObject({ boletosEmitidos: 3, pagamentosConfirmados: 2, boletosComPagamento: 2, valoresRecebidos: 120, valoresPendentes: 100, pagamentosParciais: 1, parcelasEmAtraso: 0 });
    const d = await outro.get(`${API}/dashboard`);
    expect(d.body).toMatchObject({ boletosPagos: 1, boletosAVencer: 1, boletosVencidos: 0, valoresPendentes: 100, comprovantesPendentes: 0 });
    const cal = await outro.get(`${API}/calendario?de=${at(-3, '00:00').toISOString()}&ate=${at(10, '00:00').toISOString()}`);
    expect(cal.body.boletos.map((x: any) => [x.descricao, x.status])).toEqual([['A', 'PAGO'], ['B', 'PARCIAL']]);
    const csv = await outro.get(`${API}/relatorios/export?tipo=pagamentos&de=${dia(-1)}&ate=${dia(1)}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.trim().split('\n')).toHaveLength(3);
    // Outra organização não vê nada.
    expect((await other.get(`${API}/boletos/${b1.body.id}`)).status).toBe(404);
  });

  it('assinatura inativa: cadastro de boletos e uploads bloqueados (402); leitura liberada', async () => {
    const c = await registerClient();
    const cli = await c.post(`${API}/clientes`, { nome: 'Gate', consentimento: true });
    const oid = c.me.org.id;
    await block(oid, 'MCKMENSAGEM');
    try {
      expect((await c.post(`${API}/boletos`, { clienteId: cli.body.id, descricao: 'X', valor: 10, vencimento: dia(1) })).status).toBe(402);
      expect((await upload(c, 'a.pdf', pdf())).status).toBe(402);
      expect((await c.get(`${API}/boletos`)).status).toBe(200);
      expect((await c.get(`${API}/relatorios`)).status).toBe(200);
    } finally {
      await unblock(oid, 'MCKMENSAGEM');
    }
  });
});
