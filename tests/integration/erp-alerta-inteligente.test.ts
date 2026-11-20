import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { registerClient, Client, fakeCnpj, prisma, createTestChannel, installGraphMock, graph, sendInbound } from '../helpers.js';
import { montarAlerta, agoraLocal, tickAlertasErp } from '../../server/erp/alertas/alertas.js';
import { fakeAi } from '../../server/ai/providers.js';

const DIA = 86_400_000;
const isoMais = (iso: string, d: number) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + d * DIA).toISOString().slice(0, 10);
const STAFF = '5511977776666';
const ESTRANHO = '5511955554444';
const enviados = () => graph.calls.filter((c) => c.body?.to).map((c) => ({ to: String(c.body.to), text: String(c.body.text?.body ?? '') }));
const paraStaff = () => enviados().filter((m) => m.to === STAFF).map((m) => m.text);

async function cenario() {
  const owner = await registerClient();
  const end = (await owner.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['A-01'] })).body.enderecos[0].id as string;
  const forn = (await owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Distribuidora Boa Vista LTDA', fantasia: 'Boa Vista', ehCliente: false, ehFornecedor: true })).body;
  const cafe = (await owner.post('/api/erp/produtos', { sku: 'CAF-500', nome: 'Café 500 g', estoqueMinimoMil: 10_000, precoBaseCents: 1890, custoMedioCents: 1200, fornecedorPadraoId: forn.id })).body;
  const orgId = cafe.orgId as string;
  const acucar = (await owner.post('/api/erp/produtos', { sku: 'ACU-1', nome: 'Açúcar 1 kg', estoqueMinimoMil: 5_000, custoMedioCents: 450 })).body;
  const iog = (await owner.post('/api/erp/produtos', { sku: 'IOG-1', nome: 'Iogurte', controlaLote: true, controlaValidade: true, custoMedioCents: 300 })).body;
  const geleia = (await owner.post('/api/erp/produtos', { sku: 'GEL-1', nome: 'Geleia', custoMedioCents: 800 })).body;
  // Pedido de compra anterior do café: último custo R$ 12,50
  await owner.post('/api/erp/compras/pedidos', { parceiroId: forn.id, itens: [{ produtoId: cafe.id, qtdMil: 1_000, precoUnitCents: 1250 }] });
  await owner.post('/api/erp/estoque/entrada', { produtoId: cafe.id, enderecoId: end, qtdMil: 10_000, custoUnitCents: 1200 });
  await owner.post('/api/erp/estoque/entrada', { produtoId: geleia.id, enderecoId: end, qtdMil: 12_000, custoUnitCents: 800 });
  return { owner, orgId, end, forn, cafe, acucar, iog, geleia };
}

describe('ERP · alerta diário inteligente (v1.30.0)', () => {
  let x: Awaited<ReturnType<typeof cenario>>;
  let hoje: string; let amanha: string;
  beforeAll(async () => {
    x = await cenario();
    hoje = agoraLocal('America/Sao_Paulo').dia;
    amanha = isoMais(hoje, 1);
    // Consumo do café: 36 UN nos últimos 30 dias (saídas antigas inseridas direto no razão, sem mexer no saldo)
    const saldo = await prisma.erpSaldo.findFirstOrThrow({ where: { orgId: x.orgId, produtoId: x.cafe.id } });
    await prisma.erpMovimento.create({ data: { orgId: x.orgId, produtoId: x.cafe.id, loteId: saldo.loteId, enderecoId: saldo.enderecoId, tipo: 'SAIDA', qtdMil: -36_000, saldoAposMil: 0, createdAt: new Date(Date.now() - 10 * DIA) } });
    // Ajuste manual: saldo do café cai para 4 (entra em "Alterações")
    expect((await x.owner.post('/api/erp/estoque/ajuste', { saldoId: saldo.id, qtdMil: 6_000, motivo: 'Avaria na prateleira' })).status).toBe(200);
    // Lotes: um vencido (há 3 dias) e um vencendo (em 5 dias) com saldo
    expect((await x.owner.post('/api/erp/estoque/entrada', { produtoId: x.iog.id, enderecoId: x.end, qtdMil: 6_000, custoUnitCents: 300, lote: { numero: 'IOG-VENC', validade: isoMais(amanha, -3) } })).status).toBe(201);
    expect((await x.owner.post('/api/erp/estoque/entrada', { produtoId: x.iog.id, enderecoId: x.end, qtdMil: 24_000, custoUnitCents: 300, lote: { numero: 'IOG-OK', validade: isoMais(amanha, 5) } })).status).toBe(201);
    // Geleia "parada": criada há 40 dias, nunca saiu
    await prisma.erpProduto.update({ where: { id: x.geleia.id }, data: { createdAt: new Date(Date.now() - 40 * DIA) } });
    // Preço alterado na tela (registro novo no AuditLog)
    const p = (await x.owner.get(`/api/erp/produtos?q=CAF-500`)).body; const prod = (p.items ?? p)[0];
    expect((await x.owner.put(`/api/erp/produtos/${x.cafe.id}`, { ...prod, custosAdicionais: [], precoBaseCents: 1990, custoMedioCents: undefined, fornecedorPadraoId: x.forn.id })).status).toBe(200);
    // Caixa: abre com R$ 100, vende? (sem venda), retira R$ 20 e fecha contando R$ 75 → falta R$ 5
    const ab = (await x.owner.post('/api/erp/vendas/caixa/abrir', { valorAberturaCents: 10_000 })).body;
    expect((await x.owner.post(`/api/erp/vendas/caixa/sessoes/${ab.id}/movimentos`, { tipo: 'SANGRIA', valorCents: 2_000, motivo: 'Depósito no banco' })).status).toBe(201);
    expect((await x.owner.post(`/api/erp/vendas/caixa/sessoes/${ab.id}/fechar`, { valorContadoCents: 7_500, observacao: 'Troco errado' })).status).toBe(200);
  });

  it('monta todas as seções com os números certos (alerta de amanhã olhando o dia de hoje)', async () => {
    const cfg = await prisma.erpConfig.findUniqueOrThrow({ where: { orgId: x.orgId } });
    const a = await montarAlerta(x.orgId, { ...cfg, alertaSemSaidaDias: 15 }, amanha);
    const t = a!.texto;
    expect(t).toContain('📋 *Alerta diário do MCK ERP*');
    expect(t).toMatch(/\*\d\. 📦 Estoque baixo\*/);
    expect(t).toContain('CAF-500 · Café 500 g');
    expect(t).toContain('Saldo: 4 UN · Mínimo: 10 UN · Falta: 6 UN');
    expect(t).toContain('Consumo médio: 1,2 UN/dia (últimos 30 dias)');
    expect(t).toContain('Sugestão: comprar *42 UN*');
    expect(t).toContain('Fornecedor: Boa Vista · último custo R$ 12,50 · estimado R$ 525,00');
    expect(t).toContain('ACU-1 · Açúcar 1 kg ⚠️ sem estoque');
    expect(t).toContain('Código (gerado no envio)');
    expect(t).toContain('⏳ Validade');
    expect(t).toMatch(/lote IOG-VENC: 6 UN · R\$ 18,00 · 🔴 venceu/);
    expect(t).toContain('lote IOG-OK: 24 UN · R$ 72,00 · vence');
    expect(t).toContain('(em 5 dias)');
    expect(t).toContain('💤 Produtos parados');
    expect(t).toMatch(/GEL-1 · Geleia: 12 UN · R\$ 96,00 · nunca teve saída/);
    expect(t).toContain('🧾 Caixa de ontem');
    expect(t).toContain('troco inicial R$ 100,00');
    expect(t).toContain('Retirada R$ 20,00');
    expect(t).toContain('Depósito no banco');
    expect(t).toContain('*faltaram R$ 5,00* (quebra de caixa)');
    expect(t).toContain('Justificativa: Troco errado');
    expect(t).toContain('Preço de venda alterado: CAF-500 Café 500 g (R$ 18,90 → R$ 19,90)');
    expect(t).toContain('Ajuste manual de estoque (saída): CAF-500 Café 500 g (-6 UN · motivo: Avaria na prateleira)');
    expect(t).toContain('*✅ Ações sugeridas*');
    expect(t).toContain('Retirar da venda 1 lote vencido');
    expect(t).toContain('Conferir a falta de R$ 5,00');
  });

  it('seções desligadas na tela somem; opções salvas no JSON e devolvidas no GET', async () => {
    const r = await x.owner.put('/api/erp/alertas', { alertaAtivo: false, telefones: ['11 97777-6666'], alertaHora: 8, alertaDiasAntes: 3, alertaPagar: true, alertaEstoqueMinimo: true, alertaSemSaidaDias: 15, opcoes: { caixa: false, alteracoes: false, validadeDias: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.opcoes).toMatchObject({ caixa: false, alteracoes: false, validade: true, validadeDias: 3, compraWhatsapp: true });
    const cfg = await prisma.erpConfig.findUniqueOrThrow({ where: { orgId: x.orgId } });
    const t = (await montarAlerta(x.orgId, cfg, amanha))!.texto;
    expect(t).not.toContain('Caixa de ontem');
    expect(t).not.toContain('Alterações de ontem');
    expect(t).toContain('IOG-VENC'); // vencido aparece sempre
    expect(t).not.toContain('IOG-OK'); // vence em 5 dias > 3
    // tela antiga (sem "opcoes") não apaga o que foi salvo
    await x.owner.put('/api/erp/alertas', { alertaAtivo: false, telefones: ['11 97777-6666'], alertaHora: 8, alertaDiasAntes: 3, alertaPagar: true, alertaEstoqueMinimo: true, alertaSemSaidaDias: 15 });
    expect((await x.owner.get('/api/erp/alertas')).body.opcoes).toMatchObject({ caixa: false, validadeDias: 3 });
    await x.owner.put('/api/erp/alertas', { alertaAtivo: false, telefones: ['11 97777-6666'], alertaHora: 8, alertaDiasAntes: 3, alertaPagar: true, alertaEstoqueMinimo: true, alertaSemSaidaDias: 15, opcoes: { caixa: true, alteracoes: true, validadeDias: 30 } });
  });
});

describe('ERP · aprovação de compra pelo WhatsApp (v1.30.0)', () => {
  let x: Awaited<ReturnType<typeof cenario>>;
  let ctx: Awaited<ReturnType<typeof createTestChannel>>;
  let atac1: any; let atac2: any;
  const pedidos = () => prisma.erpPedidoCompra.findMany({ where: { orgId: x.orgId }, include: { itens: true }, orderBy: { numero: 'asc' } });
  const novoAlerta = async () => {
    const cfg = await prisma.erpConfig.findUniqueOrThrow({ where: { orgId: x.orgId } });
    return (await montarAlerta(x.orgId, cfg, agoraLocal('America/Sao_Paulo').dia, new Date(), { criarCodigo: true }))!;
  };
  const numeroDo = async (codigo: string, sku: string) => (JSON.parse((await prisma.erpAprovacaoCompra.findFirstOrThrow({ where: { orgId: x.orgId, codigo } })).itens) as any[]).find((i) => i.sku === sku).n as number;

  beforeAll(async () => {
    installGraphMock();
    x = await cenario();
    ctx = await createTestChannel(x.orgId);
    expect((await x.owner.put('/api/erp/alertas', { alertaAtivo: true, telefones: ['11 97777-6666'], alertaHora: 8, alertaDiasAntes: 3, alertaPagar: true, alertaEstoqueMinimo: true, alertaSemSaidaDias: 15 })).status).toBe(200);
    const saldo = await prisma.erpSaldo.findFirstOrThrow({ where: { orgId: x.orgId, produtoId: x.cafe.id } });
    await x.owner.post('/api/erp/estoque/ajuste', { saldoId: saldo.id, qtdMil: 6_000, motivo: 'Avaria' });
    atac1 = (await x.owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Atacadão Centro', ehCliente: false, ehFornecedor: true })).body;
    atac2 = (await x.owner.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Atacadão Zona Sul', ehCliente: false, ehFornecedor: true })).body;
  });
  beforeEach(() => graph.reset());

  it('envio cria o código; "ok aprovado" cria o pedido do item com fornecedor e pergunta do item sem fornecedor', async () => {
    const a = await novoAlerta();
    expect(a.codigo).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(a.texto).toContain(`Código *${a.codigo}*`);
    const antes = (await pedidos()).length;

    await sendInbound(ctx, STAFF, 'ok aprovado');
    const ps = await pedidos();
    expect(ps.length).toBe(antes + 1);
    const pc = ps[ps.length - 1];
    expect(pc).toMatchObject({ status: 'RASCUNHO', parceiroId: x.forn.id, totalCents: 7_500 }); // sem consumo: compra o que falta (6 UN)
    expect(pc.itens).toMatchObject([{ produtoId: x.cafe.id, qtdMil: 6_000, precoUnitCents: 1250 }]);
    expect(pc.observacoes).toContain(a.codigo!);
    const msgs = paraStaff();
    expect(msgs.join('\n')).toContain(`*Pedido de compra nº ${pc.numero}* — Boa Vista`);
    expect(msgs.join('\n')).toContain('6 UN × R$ 12,50 = R$ 75,00');
    expect(msgs.join('\n')).toContain('/erp/compras');
    expect(msgs.join('\n')).toContain('Tem preferência de fornecedor para *ACU-1 · Açúcar 1 kg*');
    // a mensagem da equipe não virou contato/lead
    expect(await prisma.contact.count({ where: { orgId: x.orgId, waId: STAFF } })).toBe(0);
    expect(await prisma.erpAprovacaoCompra.findFirst({ where: { orgId: x.orgId, codigo: a.codigo! } })).toMatchObject({ status: 'AGUARDANDO_FORNECEDOR', aprovadoPor: `+${STAFF}` });
  });

  it('nome ambíguo mostra opções; número escolhe; cria o pedido e confirma', async () => {
    await sendInbound(ctx, STAFF, 'atacadão');
    expect(paraStaff().join('\n')).toMatch(/Achei 2 fornecedores[\s\S]*1\) Atacadão Centro\n2\) Atacadão Zona Sul/);
    graph.reset();
    await sendInbound(ctx, STAFF, 'fornecedor que não existe');
    expect(paraStaff().join('\n')).toContain('Não achei fornecedor');
    graph.reset();
    await sendInbound(ctx, STAFF, 'Atacadão Zona Sul');
    const ps = await pedidos();
    const pc = ps[ps.length - 1];
    expect(pc).toMatchObject({ parceiroId: atac2.id, status: 'RASCUNHO' });
    expect(pc.itens).toMatchObject([{ produtoId: x.acucar.id, qtdMil: 5_000, precoUnitCents: 450 }]);
    expect(paraStaff().join('\n')).toContain(`*Pedido de compra nº ${pc.numero}* — Atacadão Zona Sul`);
    expect(await prisma.erpAprovacaoCompra.count({ where: { orgId: x.orgId, status: 'CONCLUIDA' } })).toBe(1);
  });

  it('idempotente: "aprovado" de novo e a mesma mensagem reenviada não duplicam', async () => {
    const n = (await pedidos()).length;
    await sendInbound(ctx, STAFF, 'APROVADO');
    expect(paraStaff().join('\n')).toContain('já foi aprovada');
    const { id } = await sendInbound(ctx, STAFF, 'aprovado');
    await sendInbound(ctx, STAFF, 'aprovado', { id }); // a Meta reenviou o mesmo evento
    expect((await pedidos()).length).toBe(n);
  });

  it('número não autorizado não aprova (segue o atendimento normal); conversa comum da equipe também segue', async () => {
    const a = await novoAlerta();
    const n = (await pedidos()).length;
    await sendInbound(ctx, ESTRANHO, 'aprovado');
    expect((await pedidos()).length).toBe(n);
    expect(await prisma.contact.count({ where: { orgId: x.orgId, waId: ESTRANHO } })).toBe(1);
    expect(await prisma.erpAprovacaoCompra.findFirst({ where: { orgId: x.orgId, codigo: a.codigo! } })).toMatchObject({ status: 'PENDENTE' });
    await sendInbound(ctx, STAFF, 'bom dia, tudo certo por aí?');
    expect(await prisma.erpAprovacaoCompra.findFirst({ where: { orgId: x.orgId, codigo: a.codigo! } })).toMatchObject({ status: 'PENDENTE' });
  });

  it('"APROVADO <n>" só do item sem fornecedor + "NÃO" → solicitação de compra sem fornecedor', async () => {
    // o açúcar agora tem fornecedor (última compra); produto novo, nunca comprado, fica sem
    const sal = (await x.owner.post('/api/erp/produtos', { sku: 'SAL-1', nome: 'Sal 1 kg', estoqueMinimoMil: 2_000, custoMedioCents: 200 })).body;
    const a = await novoAlerta();
    expect(a.texto).toMatch(/ACU-1 · Açúcar 1 kg[\s\S]*Fornecedor: Atacadão Zona Sul/);
    const nAcu = await numeroDo(a.codigo!, 'SAL-1');
    const sol0 = await prisma.erpSolicitacaoCompra.count({ where: { orgId: x.orgId } });
    const pc0 = (await pedidos()).length;
    await sendInbound(ctx, STAFF, `aprovado ${nAcu}`);
    expect(paraStaff().join('\n')).toContain('Tem preferência de fornecedor');
    graph.reset();
    await sendInbound(ctx, STAFF, 'NÃO');
    expect((await pedidos()).length).toBe(pc0);
    const sols = await prisma.erpSolicitacaoCompra.findMany({ where: { orgId: x.orgId }, include: { itens: true }, orderBy: { numero: 'desc' } });
    expect(sols.length).toBe(sol0 + 1);
    expect(sols[0]).toMatchObject({ status: 'RASCUNHO', origem: 'WHATSAPP' });
    expect(sols[0].itens).toMatchObject([{ produtoId: sal.id, qtdMil: 2_000 }]);
    expect(paraStaff().join('\n')).toContain(`*Solicitação de compra nº ${sols[0].numero}* — sem fornecedor`);
  });

  it('recusa, item fora da lista e código vencido (48 h)', async () => {
    let a = await novoAlerta();
    await sendInbound(ctx, STAFF, 'aprovado 9');
    expect(paraStaff().join('\n')).toContain('não está na lista');
    await sendInbound(ctx, STAFF, 'não aprovado');
    expect(await prisma.erpAprovacaoCompra.findFirst({ where: { orgId: x.orgId, codigo: a.codigo! } })).toMatchObject({ status: 'RECUSADA' });

    a = await novoAlerta();
    const n = (await pedidos()).length;
    await prisma.erpAprovacaoCompra.updateMany({ where: { orgId: x.orgId, codigo: a.codigo! }, data: { expiraEm: new Date(Date.now() - 1000) } });
    graph.reset();
    await sendInbound(ctx, STAFF, 'aprovado');
    expect(paraStaff().join('\n')).toContain('venceu');
    expect((await pedidos()).length).toBe(n);
  });

  it('alerta novo substitui o pendente anterior; tick automático envia em partes com código', async () => {
    const a1 = await novoAlerta();
    const a2 = await novoAlerta();
    expect(await prisma.erpAprovacaoCompra.findFirst({ where: { orgId: x.orgId, codigo: a1.codigo! } })).toMatchObject({ status: 'SUBSTITUIDA' });
    expect(await prisma.erpAprovacaoCompra.findFirst({ where: { orgId: x.orgId, codigo: a2.codigo! } })).toMatchObject({ status: 'PENDENTE' });
    graph.reset();
    await prisma.erpConfig.update({ where: { orgId: x.orgId }, data: { alertaHora: 0, alertaUltimoDia: null } });
    await tickAlertasErp();
    const txt = paraStaff().join('\n');
    expect(txt).toContain('📋 *Alerta diário do MCK ERP*');
    expect(txt).toMatch(/Código \*[A-HJ-NP-Z2-9]{4}\*/);
    expect(await prisma.erpAprovacaoCompra.findFirst({ where: { orgId: x.orgId, codigo: a2.codigo! } })).toMatchObject({ status: 'SUBSTITUIDA' });
  });

  it('resposta livre ("beleza, manda só o café"): a IA da empresa ajuda a entender, com uso registrado', async () => {
    await prisma.aiSettings.upsert({ where: { orgId: x.orgId }, update: { enabled: true, provider: 'fake' }, create: { orgId: x.orgId, enabled: true, provider: 'fake' } });
    const a = await novoAlerta();
    const nCafe = await numeroDo(a.codigo!, 'CAF-500');
    const n = (await pedidos()).length;
    fakeAi.script.push(`{"acao":"APROVAR","itens":[${nCafe}]}`);
    graph.reset();
    await sendInbound(ctx, STAFF, 'beleza, manda só o café');
    const ps = await pedidos();
    expect(ps.length).toBe(n + 1);
    expect(ps[ps.length - 1].itens.map((i) => i.produtoId)).toEqual([x.cafe.id]);
    expect(paraStaff().join('\n')).toContain('Compra aprovada');
    expect(await prisma.aiUsage.count({ where: { orgId: x.orgId, provider: 'fake', success: true } })).toBeGreaterThan(0);
    // IA diz "OUTRO" → não é sobre a compra: segue o caminho normal, nada criado
    const b = await novoAlerta();
    fakeAi.script.push('{"acao":"OUTRO"}');
    await sendInbound(ctx, STAFF, 'beleza, depois a gente vê o pedido do cliente');
    expect((await pedidos()).length).toBe(n + 1);
    expect(await prisma.erpAprovacaoCompra.findFirst({ where: { orgId: x.orgId, codigo: b.codigo! } })).toMatchObject({ status: 'PENDENTE' });
    await prisma.aiSettings.update({ where: { orgId: x.orgId }, data: { enabled: false } });
    // tela: últimas aprovações com situação e documentos gerados
    const l = (await x.owner.get('/api/erp/alertas/aprovacoes')).body;
    expect(l.length).toBeGreaterThan(3);
    expect(l.find((r: any) => r.codigo === a.codigo)).toMatchObject({ status: 'CONCLUIDA', aprovadoPor: `+${STAFF}`, documentos: [{ tipo: 'pedido', fornecedor: 'Boa Vista' }] });
  });
});
