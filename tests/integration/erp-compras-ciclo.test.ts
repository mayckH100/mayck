import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj } from '../helpers.js';
import { nfeXml } from '../fixtures/nfe-exemplo.js';
import { prisma } from '../../server/db.js';
import { outbox } from '../../server/lib/mailer.js';
import { tickPrazosCompras } from '../../server/erp/compras/ciclo.js';
import { diaDe, somarDias, agoraNoFuso } from '../../server/erp/compras/prazo.js';

/** v1.36.0: ciclo da ordem de compra (etapas, linha do tempo, prazo) e rotina diária de avisos sem duplicar. */
describe('ERP · ciclo da ordem de compra, prazo e avisos', () => {
  let owner: Client; let orgId: string; let forn: any; let refri: any; let end: string;
  const hoje = () => agoraNoFuso('America/Sao_Paulo').dia;
  const acao = (id: string, evento: string, extra: object = {}) => owner.post(`/api/erp/compras/pedidos/${id}/acao`, { evento, ...extra });
  const novaOc = async (extra: object = {}) => (await owner.post('/api/erp/compras/pedidos', { parceiroId: forn.id, itens: [{ produtoId: refri.id, qtdMil: 24_000, precoUnitCents: 500 }], ...extra })).body;

  beforeAll(async () => {
    owner = await registerClient();
    end = (await owner.post('/api/erp/estoque/depositos', { nome: 'CD', enderecos: ['A-01'] })).body.enderecos[0].id;
    const cnpj = fakeCnpj();
    forn = (await owner.post('/api/erp/crm/parceiros', { documento: cnpj, nome: 'Bebidas Exemplo LTDA', email: 'vendas@bebidas.exemplo', ehFornecedor: true, ehCliente: false })).body;
    forn.cnpj = cnpj;
    refri = (await owner.post('/api/erp/produtos', { sku: 'REFRI-2L', nome: 'Refrigerante 2L', tipo: 'REVENDA' })).body;
    orgId = refri.orgId;
  });

  it('OC com prazo da cotação: aprova sozinha dentro da alçada, emissão calcula a previsão e a linha do tempo registra quem/quando/de→para', async () => {
    const oc = await novaOc({ prazoEntregaDias: 5 });
    expect((await acao(oc.id, 'ENVIAR')).body.status).toBe('APROVADO');
    expect((await acao(oc.id, 'ENVIAR_FORNECEDOR')).body.status).toBe('ENVIADO');
    const d = (await owner.get(`/api/erp/compras/pedidos/${oc.id}`)).body;
    expect(d.statusRotulo).toBe('OC emitida · aguardando entrega');
    expect(d.prazo).toMatchObject({ codigo: 'NO_PRAZO', dias: 5, previsaoDia: somarDias(hoje(), 5) });
    expect(d.historico.map((h: any) => `${h.de ?? '-'}>${h.para}:${h.evento}`)).toEqual(['->RASCUNHO:CRIAR', 'RASCUNHO>EM_APROVACAO:ENVIAR', 'EM_APROVACAO>APROVADO:APROVAR', 'APROVADO>ENVIADO:ENVIAR_FORNECEDOR']);
    expect(d.historico[2].userNome).toContain('Sistema');
    expect(d.historico[1].userNome).toBeTruthy();
    expect(d.acoes).toEqual(['REGISTRAR_ENTREGA', 'NF_ENTRADA', 'CANCELAR']);
  });

  it('data prevista editável; atrasada aparece no filtro "Atrasados"; rotina diária avisa a equipe e cobra o fornecedor uma vez por dia', async () => {
    const oc = await novaOc();
    await acao(oc.id, 'ENVIAR'); await acao(oc.id, 'ENVIAR_FORNECEDOR');
    const dezDiasAtras = somarDias(hoje(), -10);
    expect((await owner.put(`/api/erp/compras/pedidos/${oc.id}/prazo`, { previsaoEntrega: dezDiasAtras, observacao: 'fornecedor confirmou por telefone' })).status).toBe(200);
    const atrasados = (await owner.get('/api/erp/compras/pedidos?prazo=atrasados')).body;
    expect(atrasados.map((p: any) => p.id)).toContain(oc.id);
    expect(atrasados.find((p: any) => p.id === oc.id).prazo).toMatchObject({ codigo: 'ATRASADO', dias: 10, rotulo: 'Atrasado há 10 dias' });
    const hist = (await owner.get(`/api/erp/compras/pedidos/${oc.id}`)).body.historico.at(-1);
    expect(hist).toMatchObject({ evento: 'ALTERAR_PRAZO' }); expect(hist.observacao).toContain('fornecedor confirmou');

    // avisos ao fornecedor desligados por padrão
    expect((await owner.get('/api/erp/compras/config-avisos')).body).toMatchObject({ compraAvisoFornecedor: false, compraEmBreveDias: 2 });
    await tickPrazosCompras(new Date(), { orgId, ignorarHora: true });
    expect(await prisma.erpAvisoCompra.count({ where: { pedidoId: oc.id, tipo: 'ATRASADO' } })).toBe(1);
    expect(await prisma.erpAvisoCompra.count({ where: { pedidoId: oc.id, destino: 'FORNECEDOR' } })).toBe(0);

    // liga a cobrança ao fornecedor (e-mail) com texto próprio
    expect((await owner.put('/api/erp/compras/config-avisos', { compraAvisoFornecedor: true, compraAvisoFornCanal: 'EMAIL', compraAvisoFornTextoAtraso: 'Oi {fornecedor}, a OC {numero} de {data_prevista} está {dias_atraso} dias atrasada.' })).status).toBe(200);
    const antes = outbox.length;
    await tickPrazosCompras(new Date(), { orgId, ignorarHora: true });
    await tickPrazosCompras(new Date(), { orgId, ignorarHora: true }); // mesmo dia: não duplica
    expect(await prisma.erpAvisoCompra.count({ where: { pedidoId: oc.id, tipo: 'ATRASADO' } })).toBe(1);
    expect(await prisma.erpAvisoCompra.count({ where: { pedidoId: oc.id, tipo: 'FORN_ATRASO' } })).toBe(1);
    const mails = outbox.slice(antes).filter((m: any) => m.to === 'vendas@bebidas.exemplo');
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain(`a OC ${oc.numero} de `); expect(mails[0].text).toContain('10 dias atrasada');
    // CRM do fornecedor registra o envio
    expect(await prisma.erpInteracao.count({ where: { parceiroId: forn.id, tipo: 'EMAIL', status: 'ENVIADO' } })).toBeGreaterThanOrEqual(1);

    // dia seguinte: equipe recebe de novo (11 dias); fornecedor só a cada 3 dias
    const amanha = new Date(Date.now() + 86_400_000);
    await tickPrazosCompras(amanha, { orgId, ignorarHora: true });
    const at = await prisma.erpAvisoCompra.findMany({ where: { pedidoId: oc.id, tipo: 'ATRASADO' }, orderBy: { createdAt: 'asc' } });
    expect(at).toHaveLength(2); expect(at[1].titulo).toContain('11 dia(s)');
    expect(await prisma.erpAvisoCompra.count({ where: { pedidoId: oc.id, tipo: 'FORN_ATRASO' } })).toBe(1);
    await owner.put('/api/erp/compras/config-avisos', { compraAvisoFornecedor: false });
  });

  it('chega em breve, aguardando aprovação; central de avisos com não lidos', async () => {
    const breve = await novaOc({ previsaoEntrega: somarDias(hoje(), 1) });
    await acao(breve.id, 'ENVIAR'); await acao(breve.id, 'ENVIAR_FORNECEDOR');
    const grande = (await owner.post('/api/erp/compras/pedidos', { parceiroId: forn.id, itens: [{ produtoId: refri.id, qtdMil: 2_000_000, precoUnitCents: 500 }] })).body; // R$ 10.000 > alçada
    expect((await acao(grande.id, 'ENVIAR')).body.status).toBe('EM_APROVACAO');
    expect(await prisma.erpAvisoCompra.count({ where: { pedidoId: grande.id, tipo: 'AGUARDANDO_APROVACAO' } })).toBe(1); // na hora
    await tickPrazosCompras(new Date(), { orgId, ignorarHora: true });
    expect(await prisma.erpAvisoCompra.count({ where: { pedidoId: grande.id, tipo: 'AGUARDANDO_APROVACAO' } })).toBe(1); // mesmo dia: não repete
    const b = await prisma.erpAvisoCompra.findFirst({ where: { pedidoId: breve.id, tipo: 'CHEGA_EM_BREVE' } });
    expect(b?.titulo).toContain('amanhã');
    const av = (await owner.get('/api/erp/compras/avisos')).body;
    expect(av.naoLidos).toBeGreaterThanOrEqual(3);
    expect(av.avisos[0]).toHaveProperty('numero');
    await owner.post('/api/erp/compras/avisos/lidos', {});
    expect((await owner.get('/api/erp/compras/avisos')).body.naoLidos).toBe(0);
    expect((await acao(grande.id, 'CANCELAR', { motivo: 'Fornecedor sem estoque' })).body.status).toBe('CANCELADO');
  });

  it('sem XML: chegou → NF registrada → conferência → liberada → finalizada; cancelamento bloqueado depois da chegada', async () => {
    const oc = await novaOc();
    await acao(oc.id, 'ENVIAR'); await acao(oc.id, 'ENVIAR_FORNECEDOR');
    expect((await acao(oc.id, 'REGISTRAR_ENTREGA', { observacao: 'chegou no caminhão da tarde' })).body.status).toBe('AGUARDANDO_NF');
    expect((await acao(oc.id, 'CANCELAR', { motivo: 'x' })).status).toBe(400);
    expect((await acao(oc.id, 'NF_ENTRADA')).body.status).toBe('EM_CONFERENCIA');
    expect((await acao(oc.id, 'CONCLUIR_CONFERENCIA')).body.status).toBe('LIBERADA_ESTOQUE');
    expect((await acao(oc.id, 'FINALIZAR')).body.status).toBe('RECEBIDO');
    const d = (await owner.get(`/api/erp/compras/pedidos/${oc.id}`)).body;
    expect(d.statusRotulo).toBe('Em estoque (finalizada)'); expect(d.acoes).toEqual([]);
    expect(d.prazo.codigo).toBe('ENTREGUE');
    expect(d.historico.find((h: any) => h.evento === 'REGISTRAR_ENTREGA').observacao).toBe('chegou no caminhão da tarde');
    const tipos = (await prisma.erpAvisoCompra.findMany({ where: { pedidoId: oc.id } })).map((a) => a.tipo).sort();
    expect(tipos).toEqual(['LIBERADA_ESTOQUE', 'NF_LANCADA']);
  });

  it('com qualidade (produto marcado): NF-e vinculada → aguardando qualidade; lançar bloqueado até liberar; lançar dá entrada e finaliza', async () => {
    expect((await owner.put(`/api/erp/produtos/${refri.id}`, { sku: 'REFRI-2L', nome: 'Refrigerante 2L', tipo: 'REVENDA', exigeQualidade: true })).status).toBe(200);
    expect((await prisma.erpProduto.findUnique({ where: { id: refri.id } }))?.exigeQualidade).toBe(true);
    const oc = await novaOc();
    expect(oc.exigeQualidade).toBe(true);
    await acao(oc.id, 'ENVIAR'); await acao(oc.id, 'ENVIAR_FORNECEDOR');
    const imp = (await owner.post('/api/erp/estoque/nfe/importar', { xml: nfeXml(forn.cnpj) })).body;
    const nfe = (await owner.get(`/api/erp/estoque/nfe/${imp.id}`)).body;
    expect(nfe.pedidosAbertos.map((p: any) => p.id)).toContain(oc.id);
    await owner.put(`/api/erp/estoque/nfe/${nfe.id}/itens/${nfe.itens[0].id}`, { produtoId: refri.id, fatorMil: 12_000 });
    expect((await owner.put(`/api/erp/estoque/nfe/${nfe.id}/pedido`, { pedidoCompraId: oc.id })).status).toBe(200);
    expect((await owner.get(`/api/erp/compras/pedidos/${oc.id}`)).body.status).toBe('AGUARDANDO_QUALIDADE');
    const trava = await owner.post(`/api/erp/estoque/nfe/${nfe.id}/lancar`, { enderecoId: end });
    expect(trava.status).toBe(400); expect(trava.body.error ?? trava.body.message ?? JSON.stringify(trava.body)).toMatch(/qualidade/);
    expect((await acao(oc.id, 'LIBERAR_QUALIDADE')).body.status).toBe('EM_CONFERENCIA');
    expect((await owner.post(`/api/erp/estoque/nfe/${nfe.id}/lancar`, { enderecoId: end })).status).toBe(200);
    const d = (await owner.get(`/api/erp/compras/pedidos/${oc.id}`)).body;
    expect(d.status).toBe('RECEBIDO');
    expect(d.historico.map((h: any) => h.para)).toEqual(['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO', 'AGUARDANDO_QUALIDADE', 'EM_CONFERENCIA', 'RECEBIDO']);
    expect(d.historico.at(-1).observacao).toMatch(/lançada/);
    expect(diaDe(d.entregueEm)).toBe(hoje());
  });
});
