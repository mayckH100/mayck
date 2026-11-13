import { describe, it, expect, afterEach } from 'vitest';
import { setFetch, resetFetch } from '../../server/lib/fetcher.js';
import { corpoOrder, statusDaOrder, resultadoDaOrder, mercadoPagoPoint, MP_EXPIRACAO } from '../../server/erp/maquininhas/mercadopagoPoint.js';
import { PROVEDORES, provedor, listaProvedores } from '../../server/erp/maquininhas/registro.js';
import { MaquininhaError } from '../../server/erp/maquininhas/tipos.js';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function mock(fn: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  setFetch(async (input, init) => {
    const c: Call = { url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const r = fn(c);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  });
  return calls;
}
const cred = { accessToken: 'APP_USR-token-da-loja-1234567890' };

describe('Maquininhas · Mercado Pago Point (API de Orders)', () => {
  afterEach(() => resetFetch());

  it('monta a order: crédito parcelado, valor em reais com 2 casas, terminal e validade', () => {
    const b = corpoOrder({ valorCents: 12345, terminalId: 'NEWLAND_N950__X1', referencia: 'MCK-ABC_1', tipo: 'CREDITO', parcelas: 3, descricao: 'Venda balcão' });
    expect(b).toEqual({
      type: 'point', external_reference: 'MCK-ABC_1', expiration_time: MP_EXPIRACAO,
      transactions: { payments: [{ amount: '123.45' }] },
      config: { point: { terminal_id: 'NEWLAND_N950__X1' }, payment_method: { default_type: 'credit_card', default_installments: 3, installments_cost: 'seller' } },
      description: 'Venda balcão',
    });
  });

  it('débito e crédito à vista não mandam parcelas; referência e valor inválidos são recusados', () => {
    expect(corpoOrder({ valorCents: 500, terminalId: 'T', referencia: 'R1', tipo: 'DEBITO', parcelas: 6 }).config.payment_method).toEqual({ default_type: 'debit_card' });
    expect(corpoOrder({ valorCents: 500, terminalId: 'T', referencia: 'R1', tipo: 'CREDITO', parcelas: 1 }).config.payment_method).toEqual({ default_type: 'credit_card' });
    expect(() => corpoOrder({ valorCents: 0, terminalId: 'T', referencia: 'R1', tipo: 'DEBITO', parcelas: 1 })).toThrow(MaquininhaError);
    expect(() => corpoOrder({ valorCents: 100, terminalId: 'T', referencia: 'com espaço', tipo: 'DEBITO', parcelas: 1 })).toThrow(/Referência/);
  });

  it('normaliza os status da order', () => {
    expect(statusDaOrder('created')).toBe('PENDENTE');
    expect(statusDaOrder('at_terminal')).toBe('PENDENTE');
    expect(statusDaOrder('action_required')).toBe('PENDENTE');
    expect(statusDaOrder('processed')).toBe('APROVADA');
    expect(statusDaOrder('failed')).toBe('RECUSADA');
    expect(statusDaOrder('canceled')).toBe('CANCELADA');
    expect(statusDaOrder('expired')).toBe('EXPIRADA');
    expect(statusDaOrder('refunded')).toBe('ESTORNADA');
    const r = resultadoDaOrder({ id: 'ORD1', status: 'processed', status_detail: 'accredited', transactions: { payments: [{ paid_amount: '50.00', status_detail: 'accredited' }] } });
    expect(r).toEqual({ externalId: 'ORD1', status: 'APROVADA', statusProvedor: 'processed', detalhe: 'accredited', valorPagoCents: 5000 });
  });

  it('cria a order com Bearer da loja e X-Idempotency-Key = referência', async () => {
    const calls = mock(() => ({ status: 201, body: { id: 'ORD9', status: 'created', transactions: { payments: [{ amount: '10.00', status: 'created' }] } } }));
    const r = await mercadoPagoPoint.criarCobranca(cred, { valorCents: 1000, terminalId: 'PAX_A910__1', referencia: 'MCK-1', tipo: 'DEBITO', parcelas: 1 });
    expect(r).toMatchObject({ externalId: 'ORD9', status: 'PENDENTE', statusProvedor: 'created' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.mercadopago.com/v1/orders');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.authorization).toBe(`Bearer ${cred.accessToken}`);
    expect(calls[0].headers['x-idempotency-key']).toBe('MCK-1');
    expect(calls[0].body.type).toBe('point');
  });

  it('erros do MP viram mensagens claras (terminal ocupado, token inválido, rede)', async () => {
    mock(() => ({ status: 409, body: { errors: [{ code: 'already_queued_order_for_terminal', message: 'x' }] } }));
    await expect(mercadoPagoPoint.criarCobranca(cred, { valorCents: 1000, terminalId: 'T', referencia: 'R', tipo: 'DEBITO', parcelas: 1 })).rejects.toMatchObject({ status: 409, codigo: 'already_queued_order_for_terminal', message: expect.stringMatching(/já tem uma cobrança/) });
    mock(() => ({ status: 401, body: { message: 'invalid token' } }));
    await expect(mercadoPagoPoint.listarTerminais(cred)).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/access token/) });
    setFetch(async () => { throw new Error('ECONNRESET'); });
    await expect(mercadoPagoPoint.consultarStatus(cred, 'ORD1')).rejects.toMatchObject({ status: 0 });
    await expect(mercadoPagoPoint.consultarStatus({ accessToken: '' }, 'ORD1')).rejects.toMatchObject({ status: 400 });
  });

  it('cancelamento: 200 cancela na hora; 202 (na tela da maquininha) fica aguardando confirmação', async () => {
    let calls = mock(() => ({ status: 200, body: { id: 'ORD1', status: 'canceled' } }));
    expect(await mercadoPagoPoint.cancelar(cred, 'ORD1')).toEqual({ confirmado: true, status: 'CANCELADA', statusProvedor: 'canceled' });
    expect(calls[0].url).toBe('https://api.mercadopago.com/v1/orders/ORD1/cancel');
    expect(calls[0].headers['x-allow-cancelable-status']).toBe('at_terminal');
    expect(calls[0].headers['x-idempotency-key']).toBeTruthy();
    calls = mock(() => ({ status: 202, body: { id: 'ORD1', status: 'at_terminal' } }));
    expect(await mercadoPagoPoint.cancelar(cred, 'ORD1')).toMatchObject({ confirmado: false, status: 'PENDENTE' });
    await expect(mercadoPagoPoint.cancelar(cred, '../x')).rejects.toMatchObject({ status: 400 });
  });

  it('lista terminais (modo PDV) e ativa o modo PDV', async () => {
    const calls = mock((c) => c.method === 'GET'
      ? { status: 200, body: { data: { terminals: [{ id: 'NEWLAND_N950__A', pos_id: 1, store_id: '9', external_pos_id: 'CX1', operating_mode: 'STANDALONE' }, { id: 'PAX_A910__B', operating_mode: 'PDV' }] }, paging: { total: 2, offset: 0, limit: 50 } } }
      : { status: 200, body: { terminals: [{ id: 'NEWLAND_N950__A', operating_mode: 'PDV' }] } });
    const l = await mercadoPagoPoint.listarTerminais(cred);
    expect(l).toEqual([
      { id: 'NEWLAND_N950__A', modo: 'STANDALONE', loja: '9', caixa: 'CX1', prontoParaPdv: false },
      { id: 'PAX_A910__B', modo: 'PDV', loja: null, caixa: null, prontoParaPdv: true },
    ]);
    expect(calls[0].url).toBe('https://api.mercadopago.com/terminals/v1/list?limit=50&offset=0');
    const t = await mercadoPagoPoint.ativarModoPdv!(cred, 'NEWLAND_N950__A');
    expect(t).toMatchObject({ id: 'NEWLAND_N950__A', modo: 'PDV', prontoParaPdv: true });
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: 'https://api.mercadopago.com/terminals/v1/setup', body: { terminals: [{ id: 'NEWLAND_N950__A', operating_mode: 'PDV' }] } });
  });
});

describe('Maquininhas · registro de provedores', () => {
  it('Mercado Pago Point integrado; Stone, PagBank e Cielo como "em breve" (precisam de credenciamento)', async () => {
    expect(Object.keys(PROVEDORES).sort()).toEqual(['cielo', 'mercadopago_point', 'pagbank_smart', 'stone_connect']);
    expect(listaProvedores().filter((p) => p.disponivel).map((p) => p.id)).toEqual(['mercadopago_point']);
    for (const id of ['stone_connect', 'pagbank_smart', 'cielo']) {
      const p = provedor(id);
      expect(p.disponivel).toBe(false);
      await expect(p.listarTerminais(cred)).rejects.toMatchObject({ status: 501, message: expect.stringMatching(/em breve.*credenciamento/) });
      await expect(p.criarCobranca(cred, { valorCents: 100, terminalId: 'T', referencia: 'R', tipo: 'DEBITO', parcelas: 1 })).rejects.toMatchObject({ status: 501 });
    }
    expect(() => provedor('xpto')).toThrow(MaquininhaError);
  });
});
