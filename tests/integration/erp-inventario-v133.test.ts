/**
 * v1.33.0 — inventário: contagem por QR (soma a cada leitura) e digitada, por lote e local; relatório Físico x Sistema
 * (quantidade e R$, sobras, faltas, líquido); aviso ao proprietário (app + WhatsApp + e-mail) quando há diferença;
 * ajuste só com a senha do proprietário + motivo; correção manual de saldo com prévia antes/depois/R$.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, uniq, prisma, createTestChannel, installGraphMock, graph } from '../helpers.js';
import { outbox } from '../../server/lib/mailer.js';

const SENHA_DONO = 'senhaSegura123';

describe('ERP · inventário com relatório, aviso e senha do proprietário (v1.33.0)', () => {
  let owner: Client & { signup: any }; let agente: Client; let orgId: string; let end: string; let endB: string;
  let caneta: any; let caderno: any; let loteA: any; let loteB: any; let invId: string;

  beforeAll(async () => {
    installGraphMock();
    owner = await registerClient();
    const dep = (await owner.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['A-01', 'B-01'] })).body;
    [end, endB] = dep.enderecos.sort((x: any, y: any) => x.codigo.localeCompare(y.codigo)).map((e: any) => e.id);
    orgId = dep.orgId;
    await createTestChannel(orgId);
    caneta = (await owner.post('/api/erp/produtos', { sku: 'MCK0001', nome: 'Canetack', controlaLote: true })).body;
    caderno = (await owner.post('/api/erp/produtos', { sku: 'CAD', nome: 'Caderno' })).body;
    loteA = (await owner.post('/api/erp/estoque/entrada', { produtoId: caneta.id, enderecoId: end, qtdMil: 10_000, custoUnitCents: 200, lote: { fabricante: 'F-1' } })).body.lote;
    loteB = (await owner.post('/api/erp/estoque/entrada', { produtoId: caneta.id, enderecoId: end, qtdMil: 4_000, custoUnitCents: 200 })).body.lote;
    await owner.post('/api/erp/estoque/entrada', { produtoId: caderno.id, enderecoId: endB, qtdMil: 6_000, custoUnitCents: 1_000 });
    const inv = await owner.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    agente = new Client();
    const r = await agente.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token: inv.body.link.split('/convite/')[1], name: 'Contador', password: 'senhaMembro123' });
    agente.csrf = r.body.csrfToken; agente.me = r.body;
  });

  it('conta lendo o QR (cada leitura soma 1) e digitando; contagem fica no lote e no local', async () => {
    invId = (await owner.post('/api/erp/estoque/inventarios', { descricao: 'Geral novembro' })).body.id;
    const etq = `MCK1;${loteA.numero};F-1;-;MCK0001;Canetack`;
    for (let i = 0; i < 3; i++) {
      const r = await agente.post(`/api/erp/estoque/inventarios/${invId}/contar`, { endereco: 'a-01', codigo: etq, modo: 'QR' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ contadoMil: (i + 1) * 1000, leituras: i + 1, lote: loteA.numero, endereco: 'A-01' });
    }
    // digitado: substitui pela quantidade contada (8)
    expect((await agente.post(`/api/erp/estoque/inventarios/${invId}/contar`, { endereco: 'A-01', codigo: loteA.numero, qtdMil: 8_000, modo: 'MANUAL' })).body.contadoMil).toBe(8_000);
    // código do produto com 2 lotes no local: pede para escolher o lote
    const amb = await agente.post(`/api/erp/estoque/inventarios/${invId}/contar`, { endereco: 'A-01', codigo: 'MCK0001', qtdMil: 1_000 });
    expect(amb.status).toBe(400);
    expect(amb.body.details.escolherLote.map((l: any) => l.id).sort()).toEqual([loteA.id, loteB.id].sort());
    expect((await agente.post(`/api/erp/estoque/inventarios/${invId}/contar`, { endereco: 'A-01', loteId: loteB.id, qtdMil: 4_000 })).body.contadoMil).toBe(4_000);
    // produto com um lote só no local: lê pelo código de barras/código
    expect((await agente.post(`/api/erp/estoque/inventarios/${invId}/contar`, { endereco: 'B-01', codigo: 'CAD', qtdMil: 7_000 })).body.contadoMil).toBe(7_000);
    const det = (await owner.get(`/api/erp/estoque/inventarios/${invId}`)).body;
    const a = det.contagens.find((c: any) => c.loteId === loteA.id);
    expect(a).toMatchObject({ contadoMil: 8_000, modo: 'MANUAL', leituras: 3, contadoPor: 'Contador', lote: loteA.numero });
    // contagem cega: quem conta não vê o sistema
    expect((await agente.get(`/api/erp/estoque/inventarios/${invId}`)).body.contagens[0].sistemaMil).toBeNull();
    expect((await agente.get(`/api/erp/estoque/inventarios/${invId}/relatorio`)).status).toBe(403);
  });

  it('ao encerrar: relatório Físico x Sistema e aviso ao proprietário (app, WhatsApp e e-mail) só com o resumo', async () => {
    graph.reset(); const antesMail = outbox.length;
    expect((await agente.post(`/api/erp/estoque/inventarios/${invId}/acao`, { acao: 'ENVIAR' })).body.status).toBe('EM_APROVACAO');
    const rel = (await owner.get(`/api/erp/estoque/inventarios/${invId}/relatorio`)).body;
    const linha = (loteId: string) => rel.linhas.find((l: any) => l.loteId === loteId);
    expect(linha(loteA.id)).toMatchObject({ sistemaMil: 10_000, contadoFinalMil: 8_000, diferencaMil: -2_000, custoUnitCents: 200, diferencaCents: -400, situacao: 'falta', local: 'Loja · A-01' });
    expect(linha(loteB.id)).toMatchObject({ diferencaMil: 0, situacao: 'ok' });
    expect(rel.linhas.find((l: any) => l.sku === 'CAD')).toMatchObject({ diferencaMil: 1_000, diferencaCents: 1_000, situacao: 'sobra' });
    expect(rel.totais).toMatchObject({ linhas: 3, divergentes: 2, sobras: 1, faltas: 1, sobrasCents: 1_000, faltasCents: 400, liquidoCents: 600 });
    expect(rel.totais.maior).toMatchObject({ sku: 'CAD', diferencaCents: 1_000 });
    const csv = await owner.get(`/api/erp/estoque/inventarios/${invId}/relatorio?formato=csv`);
    expect(csv.text).toContain('Valor líquido (R$);6,00');
    // aviso no app
    const pend = (await owner.get('/api/erp/estoque/inventarios/pendentes')).body;
    expect(pend[0]).toMatchObject({ id: invId, resumo: { divergentes: 2, liquidoCents: 600 } });
    // WhatsApp do dono (canal de alertas) e e-mail, só com o resumo
    const zap = graph.calls.filter((c) => c.body?.to).map((c) => String(c.body.text?.body ?? ''));
    expect(zap.some((t) => t.includes('Inventário com diferença') && t.includes('Itens com diferença: *2* de 3') && t.includes('Valor líquido: *+R$ 6,00*') && t.includes('Caderno'))).toBe(true);
    const mail = outbox.slice(antesMail).find((m) => m.subject?.includes('Inventário com diferença'));
    expect(mail?.text).toContain('Maior diferença');
    expect(mail?.text).not.toContain(loteB.numero); // só o resumo, sem a lista toda
    // estoque NÃO mudou ainda
    const s = (await owner.get(`/api/erp/estoque/saldos?produtoId=${caneta.id}`)).body.find((x: any) => x.loteId === loteA.id);
    expect(s.fisicoMil).toBe(10_000);
  });

  it('inventário sem diferença não avisa ninguém', async () => {
    const outro = (await owner.post('/api/erp/estoque/inventarios', { descricao: 'Só caderno', produtoIds: [caderno.id] })).body;
    await owner.post(`/api/erp/estoque/inventarios/${outro.id}/contar`, { endereco: 'B-01', codigo: 'CAD', qtdMil: 6_000 });
    graph.reset(); const antes = outbox.length;
    await owner.post(`/api/erp/estoque/inventarios/${outro.id}/acao`, { acao: 'ENVIAR' });
    expect((await owner.get(`/api/erp/estoque/inventarios/${outro.id}/relatorio`)).body.totais.divergentes).toBe(0);
    expect(graph.calls.filter((c) => c.body?.to)).toHaveLength(0);
    expect(outbox.slice(antes).some((m) => m.subject?.includes('Inventário'))).toBe(false);
    expect((await owner.get('/api/erp/estoque/inventarios/pendentes')).body.map((p: any) => p.id)).not.toContain(outro.id);
  });

  it('aprovar exige motivo e a senha do PROPRIETÁRIO (papel não basta); depois grava movimento por lote', async () => {
    const url = `/api/erp/estoque/inventarios/${invId}/acao`;
    expect((await owner.post(url, { acao: 'APROVAR', senhaProprietario: SENHA_DONO })).status).toBe(400); // sem motivo
    expect((await owner.post(url, { acao: 'APROVAR', motivo: 'Contagem de novembro' })).status).toBe(403); // sem senha
    expect((await owner.post(url, { acao: 'APROVAR', motivo: 'Contagem de novembro', senhaProprietario: 'errada123' })).status).toBe(403);
    // o funcionário não aprova com a própria senha…
    expect((await agente.post(url, { acao: 'APROVAR', motivo: 'Contagem de novembro', senhaProprietario: 'senhaMembro123' })).status).toBe(403);
    // …mas aprova se o dono digitar a senha dele na hora
    const ok = await agente.post(url, { acao: 'APROVAR', motivo: 'Contagem de novembro', senhaProprietario: SENHA_DONO });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'CONCLUIDO', motivoAjuste: 'Contagem de novembro', aprovadoPorId: owner.me.user?.id ?? expect.any(String) });
    const movs = await prisma.erpMovimento.findMany({ where: { docTipo: 'inventario', docId: invId } });
    expect(movs.map((m) => m.qtdMil).sort((a, b) => a - b)).toEqual([-2_000, 1_000]);
    expect(movs.find((m) => m.qtdMil < 0)!.loteId).toBe(loteA.id);
    expect(movs.every((m) => m.tipo === 'INVENTARIO' && m.loteId)).toBe(true);
    const log = await prisma.auditLog.findFirst({ where: { orgId, action: 'erp.inventario.aprovar' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(log)).toContain('Contagem de novembro');
    expect(await prisma.auditLog.count({ where: { orgId, action: 'erp.inventario.senha_recusada' } })).toBeGreaterThanOrEqual(3);
    // aparece no rastreio do lote
    const t = (await owner.get(`/api/erp/estoque/rastreio/lote/${loteA.id}`)).body;
    expect(t.eventos.some((e: any) => e.categoria === 'inventario' && /faltou/.test(e.texto))).toBe(true);
    expect(t.destinos.find((d: any) => d.tipo === 'inventario').qtdMil).toBe(2_000);
  });

  it('correção manual de saldo: prévia antes/depois/R$, motivo e senha do proprietário; vira movimento do lote', async () => {
    const s = (await owner.get(`/api/erp/estoque/saldos?produtoId=${caneta.id}`)).body.find((x: any) => x.loteId === loteB.id);
    const previa = (await agente.post('/api/erp/estoque/inventarios/corrigir-saldo', { saldoId: s.id, novoMil: 3_500, previa: true })).body;
    expect(previa).toMatchObject({ antesMil: 4_000, depoisMil: 3_500, diferencaMil: -500, valorCents: -100, lote: loteB.numero });
    expect((await agente.post('/api/erp/estoque/inventarios/corrigir-saldo', { saldoId: s.id, novoMil: 3_500, motivo: 'Achei quebrada' })).status).toBe(403);
    const r = await agente.post('/api/erp/estoque/inventarios/corrigir-saldo', { saldoId: s.id, novoMil: 3_500, motivo: 'Achei quebrada', senhaProprietario: SENHA_DONO });
    expect(r.status).toBe(200);
    expect(r.body.aprovadoPor).toBe('Usuário Teste');
    const m = await prisma.erpMovimento.findFirst({ where: { docTipo: 'inventario', docId: r.body.inventarioId } });
    expect(m).toMatchObject({ loteId: loteB.id, qtdMil: -500, tipo: 'INVENTARIO' });
    const log = await prisma.auditLog.findFirst({ where: { orgId, action: 'erp.estoque.correcao_saldo' } });
    expect(JSON.stringify(log)).toContain('Achei quebrada');
  });

  it('outra empresa não acessa o inventário', async () => {
    const outra = await registerClient();
    expect((await outra.get(`/api/erp/estoque/inventarios/${invId}/relatorio`)).status).toBe(404);
  });
});
