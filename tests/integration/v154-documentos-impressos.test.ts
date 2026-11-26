import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, fakeCnpj, prisma, uniq } from '../helpers.js';
import { RODAPE_DOCUMENTO } from '../../server/erp/shared/documento.js';

/**
 * v1.54.0 — dono (26/11): "o cliente pode fazer upload da logo dele e colocar informações para sair no documento
 * impresso ... no rodapé deve ser o nome nossa empresa e o site. O cliente não vai poder remover ou editar essa parte".
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const dataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

describe('ERP · documentos impressos (cabeçalho do cliente + rodapé fixo da MCK)', () => {
  let c: Client; let outra: Client; let orgId: string;
  beforeAll(async () => {
    c = await registerClient(); outra = await registerClient();
    orgId = c.me.org.id;
    await prisma.erpConfigFiscal.create({ data: { orgId, razaoSocial: 'Loja Exemplo LTDA', fantasia: 'Loja Exemplo', cnpj: '12345678000195', ie: '123456', logradouro: 'Rua A', numero: '10', bairro: 'Centro', municipio: 'Osasco', uf: 'SP', cep: '06000000', fone: '1133334444' } });
  });

  it('sem configuração: sugere os dados do emitente fiscal e devolve o rodapé da MCK', async () => {
    const r = await c.get('/api/erp/documentos/config');
    expect(r.status).toBe(200);
    expect(r.body.salvo).toBe(false);
    expect(r.body.rodape).toBe(RODAPE_DOCUMENTO);
    expect(r.body.rodape).toContain('MCK DESENVOLVIMENTO');
    expect(r.body.config).toMatchObject({ nomeExibicao: 'Loja Exemplo', cnpj: '12345678000195', ie: '123456', logradouro: 'Rua A', cidade: 'Osasco', uf: 'SP', telefone: '1133334444', logo: null });
  });

  it('salva e lê a configuração com logo PNG (tipo conferido pelos bytes)', async () => {
    const s = await c.put('/api/erp/documentos/config', { nomeExibicao: 'Exemplo Store', cnpj: '12.345.678/0001-95', whatsapp: '11999990000', email: 'contato@exemplo.com.br', site: 'exemplo.com.br', textoLivre: 'Orçamento válido conforme condições', uf: 'sp', logo: dataUrl('image/png', PNG) });
    expect(s.status).toBe(200);
    const g = await c.get('/api/erp/documentos/config');
    expect(g.body.salvo).toBe(true);
    expect(g.body.config).toMatchObject({ nomeExibicao: 'Exemplo Store', whatsapp: '11999990000', email: 'contato@exemplo.com.br', site: 'exemplo.com.br', uf: 'SP', textoLivre: 'Orçamento válido conforme condições' });
    expect(g.body.config.logo).toBe(dataUrl('image/png', PNG));
    // Sem "logo" no corpo: mantém o logo; logo null: remove.
    await c.put('/api/erp/documentos/config', { nomeExibicao: 'Exemplo Store 2' });
    expect((await c.get('/api/erp/documentos/config')).body.config.logo).toBe(dataUrl('image/png', PNG));
    // JPEG declarado como PNG: grava com o tipo REAL.
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
    await c.put('/api/erp/documentos/config', { nomeExibicao: 'Exemplo Store 2', logo: dataUrl('image/png', jpg) });
    expect((await c.get('/api/erp/documentos/config')).body.config.logo).toBe(dataUrl('image/jpeg', jpg));
    await c.put('/api/erp/documentos/config', { nomeExibicao: 'Exemplo Store 2', logo: null });
    expect((await c.get('/api/erp/documentos/config')).body.config.logo).toBeNull();
  });

  it('recusa arquivo que não é imagem (texto, SVG, HTML) e imagem acima de 500 KB', async () => {
    const texto = await c.put('/api/erp/documentos/config', { logo: dataUrl('image/png', Buffer.from('isto não é uma imagem, é texto puro')) });
    expect(texto.status).toBe(400);
    const svg = await c.put('/api/erp/documentos/config', { logo: dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')) });
    expect(svg.status).toBe(400);
    const html = await c.put('/api/erp/documentos/config', { logo: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' });
    expect(html.status).toBe(400);
    const grande = await c.put('/api/erp/documentos/config', { logo: dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(520 * 1024, 3)])) });
    expect(grande.status).toBe(400);
    expect(grande.body.error).toMatch(/500 KB/);
    expect((await c.get('/api/erp/documentos/config')).body.config.logo).toBeNull();
  });

  it('rodapé não é alterável: campo "rodape" (ou parecido) é ignorado e o texto continua o da MCK', async () => {
    const r = await c.put('/api/erp/documentos/config', { nomeExibicao: 'Tentativa', rodape: 'Sem MCK', rodapeTexto: 'x', ocultarRodape: true, footer: 'x' });
    expect(r.status).toBe(200);
    expect(r.body.rodape).toBe(RODAPE_DOCUMENTO);
    const g = await c.get('/api/erp/documentos/config');
    expect(g.body.rodape).toBe(RODAPE_DOCUMENTO);
    expect(JSON.stringify(g.body.config)).not.toMatch(/Sem MCK|rodape|footer/i);
    const row = await prisma.erpDocumentoConfig.findUnique({ where: { orgId } });
    expect(Object.keys(row ?? {}).some((k) => /rodape|footer/i.test(k))).toBe(false);
  });

  it('cada empresa vê só o próprio cabeçalho/logo; atendente não altera', async () => {
    await c.put('/api/erp/documentos/config', { nomeExibicao: 'Exemplo Store', logo: dataUrl('image/png', PNG) });
    const o = await outra.get('/api/erp/documentos/config');
    expect(o.status).toBe(200);
    expect(o.body.config.logo).toBeNull();
    expect(o.body.config.nomeExibicao).not.toBe('Exemplo Store');
    const inv = await c.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    const token = inv.body.link.split('/convite/')[1];
    const ag = new Client();
    const a = await ag.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Atendente', password: 'senhaMembro123' });
    ag.csrf = a.body.csrfToken;
    expect((await ag.put('/api/erp/documentos/config', { nomeExibicao: 'Hack' })).status).toBe(403);
    expect((await c.get('/api/erp/documentos/config')).body.config.nomeExibicao).toBe('Exemplo Store');
  });

  it('pedido em rascunho sai como Orçamento com "Válido até" (createdAt + validade da config)', async () => {
    const end = (await c.post('/api/erp/estoque/depositos', { nome: 'Loja', enderecos: ['D-01'] })).body.enderecos[0].id;
    const prod = (await c.post('/api/erp/produtos', { sku: 'DOC-1', nome: 'Produto Doc', precoBaseCents: 1000 })).body.id;
    await c.post('/api/erp/estoque/entrada', { produtoId: prod, enderecoId: end, qtdMil: 10_000, custoUnitCents: 400 });
    await c.put('/api/erp/produtos/config', { validadeOrcamentoDias: 7 });
    const cli = (await c.post('/api/erp/crm/parceiros', { documento: fakeCnpj(), nome: 'Cliente Doc', ehCliente: true })).body;
    const ped = await c.post('/api/erp/vendas/pedidos', { parceiroId: cli.id, itens: [{ produtoId: prod, qtdMil: 1_000 }] });
    expect(ped.status).toBe(201);
    const d = await c.get(`/api/erp/vendas/localizar/documento/${ped.body.id}`);
    expect(d.status).toBe(200);
    expect(d.body.pedido.status).toBe('RASCUNHO');
    expect(d.body.pedido.orcamento).toBe(true);
    const dias = (new Date(d.body.pedido.validoAte).getTime() - new Date(d.body.pedido.createdAt).getTime()) / 86_400_000;
    expect(Math.round(dias)).toBe(7);
    // Título do documento impresso (mesma função usada pela tela).
    const { tituloPedido } = await import('../../web/src/erp/impressao/modelo');
    expect(tituloPedido('pedido', d.body.pedido)).toBe(`Orçamento nº ${d.body.pedido.numero}`);
    expect(tituloPedido('romaneio', d.body.pedido)).toMatch(/^Romaneio/);
    // Depois de enviado, deixa de ser orçamento.
    expect((await c.post(`/api/erp/vendas/pedidos/${ped.body.id}/acao`, { evento: 'ENVIAR' })).status).toBeLessThan(300);
    const d2 = await c.get(`/api/erp/vendas/localizar/documento/${ped.body.id}`);
    expect(d2.body.pedido.orcamento).toBe(false);
    expect(d2.body.pedido.validoAte).toBeNull();
    expect(tituloPedido('pedido', d2.body.pedido)).toBe(`Pedido de venda nº ${d2.body.pedido.numero}`);
  });
});
