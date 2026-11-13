/**
 * Mercado Pago Point via API de Orders (a nova, que substitui a Payment Intents):
 *  - GET   /terminals/v1/list           → terminais da conta e modo de operação (PDV | STANDALONE)
 *  - PATCH /terminals/v1/setup          → coloca o terminal em modo PDV (necessário para receber orders)
 *  - POST  /v1/orders  (type "point")   → cria a cobrança no terminal (X-Idempotency-Key obrigatório)
 *  - GET   /v1/orders/{id}              → consulta
 *  - POST  /v1/orders/{id}/cancel       → cancela (created: 200; at_terminal: 202 + header x-allow-cancelable-status)
 * Docs: https://www.mercadopago.com.br/developers/pt/reference/in-person-payments/point/overview
 * O token é sempre o da empresa (credencial própria dela), passado a cada chamada; nunca é logado.
 */
import { randomUUID } from 'node:crypto';
import { httpFetch } from '../../lib/fetcher.js';
import { MaquininhaError, type CredencialMaquininha, type NovaCobranca, type ProvedorMaquininha, type ResultadoCobranca, type StatusCobranca, type Terminal } from './tipos.js';

export const MP_API = 'https://api.mercadopago.com';
/** Validade da cobrança no terminal (a API aceita de PT30S a PT3H; padrão PT15M). */
export const MP_EXPIRACAO = 'PT5M';

const MSG_CODIGO: Record<string, string> = {
  unauthorized: 'O Mercado Pago recusou o access token. Confira se colou o token de PRODUÇÃO da sua conta.',
  forbidden_checking_terminal_owner: 'Esta maquininha não pertence à conta do Mercado Pago do token informado.',
  already_queued_order_for_terminal: 'A maquininha já tem uma cobrança esperando. Conclua ou cancele na maquininha e tente de novo.',
  invalid_default_installments: 'Esse número de parcelas não está habilitado na sua conta do Mercado Pago.',
  invalid_installments_cost_config: 'Sua conta do Mercado Pago não está configurada para parcelamento.',
  minimum_amount_not_met: 'Valor abaixo do mínimo para esse número de parcelas.',
  cannot_cancel_order: 'Esta cobrança não pode mais ser cancelada pelo sistema (o pagamento já começou na maquininha). Cancele direto na maquininha.',
  order_already_canceled: 'A cobrança já estava cancelada.',
  order_not_found: 'Cobrança não encontrada no Mercado Pago.',
  terminal_not_allowed_action: 'Este modelo de maquininha não permite ativar o modo PDV pela API.',
  store_pos_not_found: 'A maquininha não está ligada a uma loja e um caixa no Mercado Pago. Crie a loja e o caixa no app do Mercado Pago e vincule a maquininha.',
};

type Resp = { status: number; body: any };

async function chamar(cred: CredencialMaquininha, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Resp> {
  if (!cred.accessToken) throw new MaquininhaError(400, 'Cole o access token do Mercado Pago na configuração da maquininha');
  let res: Response;
  try {
    res = await httpFetch(MP_API + path, {
      method,
      headers: { authorization: `Bearer ${cred.accessToken}`, 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e: any) {
    const msg = String(e?.message || e || 'erro de rede');
    console.error(`[maquininha:mp] ${method} ${path.split('?')[0]} falha de rede: ${msg}`);
    throw new MaquininhaError(0, `Não foi possível falar com o Mercado Pago (${msg})`);
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const e0 = Array.isArray(body?.errors) ? body.errors[0] : null;
    const codigo = String(e0?.code ?? body?.error ?? body?.code ?? (res.status === 401 ? 'unauthorized' : '')) || undefined;
    const original = String(e0?.message ?? body?.message ?? `Mercado Pago respondeu ${res.status}`);
    // Nunca logar o token: só método, caminho, status e código.
    console.error(`[maquininha:mp] ${method} ${path.split('?')[0]} status=${res.status} code=${codigo ?? '-'}`);
    const amigavel = (codigo && MSG_CODIGO[codigo]) || (res.status === 401 ? MSG_CODIGO.unauthorized : `Mercado Pago: ${original}`);
    throw new MaquininhaError(res.status, amigavel, codigo);
  }
  return { status: res.status, body };
}

/** Converte o status da order do Mercado Pago no status normalizado. */
export function statusDaOrder(status: string | null | undefined): StatusCobranca {
  switch (String(status ?? '').toLowerCase()) {
    case 'processed': return 'APROVADA';
    case 'canceled': case 'cancelled': return 'CANCELADA';
    case 'failed': return 'RECUSADA';
    case 'expired': return 'EXPIRADA';
    case 'refunded': return 'ESTORNADA';
    default: return 'PENDENTE'; // created | at_terminal | action_required | processing
  }
}

const centsDe = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && String(v ?? '') !== '' ? Math.round(n * 100) : null;
};

export function resultadoDaOrder(o: any): ResultadoCobranca {
  const pg = o?.transactions?.payments?.[0];
  const statusProvedor = String(o?.status ?? '');
  const detalhe = [o?.status_detail, pg?.status_detail].filter((x, i, a) => x && a.indexOf(x) === i).join(' / ') || null;
  return {
    externalId: String(o?.id ?? ''),
    status: statusDaOrder(statusProvedor),
    statusProvedor,
    detalhe,
    valorPagoCents: centsDe(pg?.paid_amount ?? o?.total_paid_amount),
  };
}

/** Corpo do POST /v1/orders para o terminal. */
export function corpoOrder(c: NovaCobranca) {
  if (!Number.isInteger(c.valorCents) || c.valorCents <= 0) throw new MaquininhaError(400, 'Valor da cobrança inválido');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(c.referencia)) throw new MaquininhaError(400, 'Referência da cobrança inválida');
  const parcelas = c.tipo === 'CREDITO' ? Math.max(1, Math.floor(c.parcelas || 1)) : 1;
  const payment_method: Record<string, unknown> = { default_type: c.tipo === 'DEBITO' ? 'debit_card' : 'credit_card' };
  // Parcelamento só no crédito; acima de 1x o MP exige dizer quem paga os juros (aqui: o lojista, "sem juros").
  if (c.tipo === 'CREDITO' && parcelas > 1) Object.assign(payment_method, { default_installments: parcelas, installments_cost: 'seller' });
  return {
    type: 'point',
    external_reference: c.referencia,
    expiration_time: MP_EXPIRACAO,
    transactions: { payments: [{ amount: (c.valorCents / 100).toFixed(2) }] },
    config: { point: { terminal_id: c.terminalId }, payment_method },
    ...(c.descricao ? { description: c.descricao.slice(0, 150) } : {}),
  };
}

export const mercadoPagoPoint: ProvedorMaquininha = {
  id: 'mercadopago_point',
  nome: 'Mercado Pago Point',
  disponivel: true,
  ajuda: 'Use o access token de PRODUÇÃO da sua conta do Mercado Pago (Suas integrações → sua aplicação → Credenciais de produção). A maquininha precisa estar em modo PDV.',

  async criarCobranca(cred, c) {
    const r = await chamar(cred, 'POST', '/v1/orders', { body: corpoOrder(c), headers: { 'X-Idempotency-Key': c.referencia } });
    return resultadoDaOrder(r.body);
  },

  async consultarStatus(cred, externalId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(externalId)) throw new MaquininhaError(400, 'Id da cobrança inválido');
    const r = await chamar(cred, 'GET', `/v1/orders/${externalId}`);
    return resultadoDaOrder(r.body);
  },

  async cancelar(cred, externalId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(externalId)) throw new MaquininhaError(400, 'Id da cobrança inválido');
    // Com a order já na tela da maquininha (at_terminal) o MP exige este header; para "created" ele é ignorado.
    const r = await chamar(cred, 'POST', `/v1/orders/${externalId}/cancel`, { headers: { 'X-Idempotency-Key': randomUUID(), 'x-allow-cancelable-status': 'at_terminal' } });
    const statusProvedor = String(r.body?.status ?? (r.status === 202 ? 'at_terminal' : 'canceled'));
    // 202 = aceito, o cancelamento só vale após a notificação/consulta.
    if (r.status === 202) return { confirmado: false, status: 'PENDENTE', statusProvedor };
    const status = statusDaOrder(statusProvedor);
    return { confirmado: status === 'CANCELADA', status, statusProvedor };
  },

  async listarTerminais(cred) {
    const out: Terminal[] = [];
    for (let offset = 0; offset < 500; offset += 50) {
      const r = await chamar(cred, 'GET', `/terminals/v1/list?limit=50&offset=${offset}`);
      const lista: any[] = r.body?.data?.terminals ?? [];
      for (const t of lista) {
        const modo = t?.operating_mode ? String(t.operating_mode) : null;
        out.push({ id: String(t.id), modo, loja: t?.store_id != null ? String(t.store_id) : null, caixa: t?.external_pos_id ?? (t?.pos_id != null ? String(t.pos_id) : null), prontoParaPdv: modo === 'PDV' });
      }
      const total = Number(r.body?.paging?.total ?? lista.length);
      if (lista.length < 50 || out.length >= total) break;
    }
    return out;
  },

  async ativarModoPdv(cred, terminalId) {
    const r = await chamar(cred, 'PATCH', '/terminals/v1/setup', { body: { terminals: [{ id: terminalId, operating_mode: 'PDV' }] } });
    const t = (r.body?.terminals ?? []).find((x: any) => String(x?.id) === terminalId) ?? { id: terminalId, operating_mode: 'PDV' };
    const modo = String(t.operating_mode ?? 'PDV');
    return { id: terminalId, modo, prontoParaPdv: modo === 'PDV' };
  },
};
