/**
 * Maquininhas de cartão: configuração (/api/erp/vendas/maquininhas), cobrança no terminal a partir do PDV
 * (/api/erp/vendas/balcao/cartao) e webhook público do provedor (/api/webhooks/maquininhas/:provedor/:chave).
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, forbidden, notFound, HttpError } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { config } from '../../config.js';
import { decryptOrNull, encrypt, maskSecret } from '../../lib/crypto.js';
import { verifySignature } from '../../billing/mercadopago.js';
import { auditar } from '../shared/auditoria.js';
import { ehGestor, prepararVendaBalcao, simularVendaBalcao, vendaBalcaoSchema } from '../vendas/balcao.routes.js';
import { IDS_PROVEDORES, listaProvedores, provedor } from './registro.js';
import { MaquininhaError } from './tipos.js';
import { aplicarResultado, configDaEmpresa, credencialDa, fecharVenda, garantirConfig, maquininhaDoPdv, novaReferencia, sincronizar, visaoCobranca } from './servico.js';

/** Erro do provedor → resposta HTTP clara (credencial/terminal: 400; ocupado: 409; em breve: 501; rede/5xx: 502). */
function http(e: unknown): unknown {
  if (!(e instanceof MaquininhaError)) return e;
  if (e.status === 501) return new HttpError(501, e.message);
  if (e.status === 409) return new HttpError(409, e.message);
  if (e.status === 0 || e.status >= 500) return new HttpError(502, e.message);
  return new HttpError(400, e.message);
}
const tentar = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { throw http(e); } };

const urlWebhook = (prov: string, chave: string) => `${config.APP_URL.replace(/\/$/, '')}/api/webhooks/maquininhas/${prov}/${chave}`;

// ---------------- Configuração ----------------
export const maquininhasRouter = Router();

maquininhasRouter.get('/config', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await configDaEmpresa(orgId);
  res.json({
    provedores: listaProvedores(),
    config: c ? {
      provedor: c.provedor, ativo: c.ativo, temToken: !!c.accessTokenEnc, token: maskSecret(decryptOrNull(c.accessTokenEnc)),
      terminalPadraoId: c.terminalPadraoId, temWebhookSecret: !!c.webhookSecretEnc, webhookUrl: urlWebhook(c.provedor, c.webhookChave),
    } : null,
  });
}));

const cfgSchema = z.object({
  provedor: z.enum(IDS_PROVEDORES),
  accessToken: z.string().trim().max(500).optional(), // vazio/omitido = mantém o atual
  terminalPadraoId: z.string().trim().max(120).nullish(),
  ativo: z.boolean().optional(),
  webhookSecret: z.string().trim().max(500).nullish(), // "" ou null = remove; omitido = mantém
});
maquininhasRouter.put('/config', ah(async (req, res) => {
  if (!ehGestor(req)) throw forbidden();
  const orgId = orgOf(req);
  const b = cfgSchema.parse(req.body);
  const prov = provedor(b.provedor);
  if (!prov.disponivel) throw new HttpError(501, `${prov.nome}: integração em breve (precisa de credenciamento). Por enquanto use o Mercado Pago Point.`);
  if (b.accessToken && !/^[A-Za-z0-9_\-.]{20,500}$/.test(b.accessToken)) throw badRequest('Access token inválido: copie o token completo (começa com APP_USR-)');
  const antes = await garantirConfig(orgId);
  const trocouProvedor = antes.provedor !== b.provedor;
  const c = await prisma.erpMaquininhaConfig.update({
    where: { orgId },
    data: {
      provedor: b.provedor,
      ...(b.accessToken ? { accessTokenEnc: encrypt(b.accessToken) } : trocouProvedor ? { accessTokenEnc: null } : {}),
      ...(b.terminalPadraoId !== undefined ? { terminalPadraoId: b.terminalPadraoId || null } : trocouProvedor ? { terminalPadraoId: null } : {}),
      ...(b.ativo !== undefined ? { ativo: b.ativo } : {}),
      ...(b.webhookSecret !== undefined ? { webhookSecretEnc: b.webhookSecret ? encrypt(b.webhookSecret) : null } : {}),
    },
  });
  // Auditoria sem o token: só o que mudou de forma visível.
  await auditar(req, 'maquininha.config', 'erp_maquininha_config', orgId,
    { provedor: antes.provedor, terminalPadraoId: antes.terminalPadraoId, ativo: antes.ativo, temToken: !!antes.accessTokenEnc },
    { provedor: c.provedor, terminalPadraoId: c.terminalPadraoId, ativo: c.ativo, temToken: !!c.accessTokenEnc, tokenTrocado: !!b.accessToken });
  res.json({ ok: true, provedor: c.provedor, ativo: c.ativo, temToken: !!c.accessTokenEnc, token: maskSecret(decryptOrNull(c.accessTokenEnc)), terminalPadraoId: c.terminalPadraoId, temWebhookSecret: !!c.webhookSecretEnc, webhookUrl: urlWebhook(c.provedor, c.webhookChave) });
}));

maquininhasRouter.delete('/config', ah(async (req, res) => {
  if (!ehGestor(req)) throw forbidden();
  const orgId = orgOf(req);
  await prisma.erpMaquininhaConfig.deleteMany({ where: { orgId } });
  await auditar(req, 'maquininha.remover', 'erp_maquininha_config', orgId, null, null);
  res.json({ ok: true });
}));

maquininhasRouter.get('/terminais', ah(async (req, res) => {
  const c = await configDaEmpresa(orgOf(req));
  if (!c?.accessTokenEnc) throw badRequest('Salve o access token antes de buscar as maquininhas');
  const prov = provedor(c.provedor);
  res.json(await tentar(() => prov.listarTerminais(credencialDa(c))));
}));

maquininhasRouter.post('/terminais/:terminalId/modo-pdv', ah(async (req, res) => {
  if (!ehGestor(req)) throw forbidden();
  const orgId = orgOf(req);
  const c = await configDaEmpresa(orgId);
  if (!c?.accessTokenEnc) throw badRequest('Salve o access token antes');
  const prov = provedor(c.provedor);
  if (!prov.ativarModoPdv) throw badRequest(`${prov.nome} não precisa (ou não permite) ativar modo PDV pelo sistema`);
  const id = String(req.params.terminalId);
  if (!/^[A-Za-z0-9_\-]{3,120}$/.test(id)) throw badRequest('Terminal inválido');
  const t = await tentar(() => prov.ativarModoPdv!(credencialDa(c), id));
  await auditar(req, 'maquininha.modo_pdv', 'erp_maquininha_config', orgId, null, { terminalId: id, modo: t.modo });
  res.json(t);
}));

// ---------------- Cobrança no PDV ----------------
export const cobrancaCartaoRouter = Router();

/** Para a tela do PDV: há maquininha pronta? (sem ela, o cartão segue no lançamento manual.) */
cobrancaCartaoRouter.get('/maquininha', ah(async (req, res) => {
  const m = await maquininhaDoPdv(orgOf(req));
  res.json(m ? { ativa: true, provedor: m.prov.id, nome: m.prov.nome, terminalId: m.terminalId } : { ativa: false });
}));

const iniciarSchema = vendaBalcaoSchema.extend({
  tipo: z.enum(['CREDITO', 'DEBITO']).default('CREDITO'),
  parcelas: z.number().int().min(1).max(18).default(1),
});

cobrancaCartaoRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { tipo, parcelas, ...resto } = iniciarSchema.parse(req.body);
  const b = { ...resto, forma: 'CARTAO' as const };
  if (tipo === 'DEBITO' && parcelas > 1) throw badRequest('Débito é sempre à vista');
  const m = await maquininhaDoPdv(orgId);
  if (!m) throw new HttpError(409, 'Nenhuma maquininha configurada: lance o cartão manualmente ou configure em Maquininhas');
  const ctx = { orgId, userId: req.auth?.userId ?? null, gestor: ehGestor(req) };
  const prep = await prepararVendaBalcao(ctx, b);
  // Ensaio da venda inteira (estoque, desconto, caixa) antes de cobrar o cliente.
  const { totalCents } = await simularVendaBalcao(ctx, b, prep);

  // Uma cobrança por vez no terminal: confere a pendente mais recente (sincronizando) antes de mandar outra.
  const pend = await prisma.erpCobrancaCartao.findFirst({ where: { orgId, terminalId: m.terminalId, status: 'PENDENTE' }, orderBy: { createdAt: 'desc' } });
  if (pend) {
    const atual = await sincronizar(pend).catch(() => pend);
    if (atual.status === 'PENDENTE') throw new HttpError(409, 'Já existe uma cobrança aguardando nesta maquininha: conclua ou cancele antes de enviar outra', { cobrancaId: atual.id });
  }

  const venda = { ...b, caixaSessaoId: prep.sessao.id, contaId: prep.conta.id, parceiroId: b.parceiroId ?? null };
  let cob = await prisma.erpCobrancaCartao.create({
    data: { orgId, provedor: m.prov.id, terminalId: m.terminalId, referencia: novaReferencia(), valorCents: totalCents, tipo, parcelas: tipo === 'CREDITO' ? parcelas : 1, venda: JSON.stringify(venda), userId: ctx.userId, gestor: ctx.gestor, caixaSessaoId: prep.sessao.id },
  });
  try {
    const r = await m.prov.criarCobranca(credencialDa(m.cfg), { valorCents: totalCents, terminalId: m.terminalId, referencia: cob.referencia, tipo, parcelas: cob.parcelas, descricao: 'Venda balcão' });
    cob = await prisma.erpCobrancaCartao.update({ where: { id: cob.id }, data: { externalId: r.externalId || null, statusProvedor: r.statusProvedor, detalhe: r.detalhe ?? null } });
    cob = await aplicarResultado(cob, r);
  } catch (e) {
    if (e instanceof MaquininhaError && (e.status === 0 || e.status >= 500)) {
      // Pode ter chegado ao provedor: fica pendente e a próxima consulta reenvia com a MESMA chave de idempotência.
      cob = await prisma.erpCobrancaCartao.update({ where: { id: cob.id }, data: { detalhe: `Aguardando confirmação do envio: ${e.message}` } });
    } else {
      await prisma.erpCobrancaCartao.delete({ where: { id: cob.id } });
      throw http(e);
    }
  }
  await auditar(req, 'maquininha.cobranca', 'erp_cobranca_cartao', cob.id, null, { valorCents: cob.valorCents, tipo, parcelas: cob.parcelas, terminalId: cob.terminalId, provedor: cob.provedor });
  res.status(201).json(visaoCobranca(cob));
}));

async function cobrancaDa(orgId: string, id: string) {
  const c = await prisma.erpCobrancaCartao.findFirst({ where: { id, orgId } });
  if (!c) throw notFound('Cobrança');
  return c;
}
async function comPedido(c: Awaited<ReturnType<typeof cobrancaDa>>) {
  const pedido = c.pedidoId ? await prisma.erpPedidoVenda.findUnique({ where: { id: c.pedidoId }, include: { itens: true } }) : null;
  return { ...visaoCobranca(c), pedido };
}

/** Polling da tela "aguardando pagamento na maquininha". */
cobrancaCartaoRouter.get('/:id', ah(async (req, res) => {
  let c = await cobrancaDa(orgOf(req), req.params.id);
  if (c.status === 'PENDENTE') {
    try { c = await sincronizar(c); } catch (e) {
      // Falha momentânea na consulta não muda a cobrança: a tela tenta de novo.
      if (!(e instanceof MaquininhaError)) throw e;
      return res.json({ ...(await comPedido(c)), aviso: e.message });
    }
  }
  res.json(await comPedido(c));
}));

cobrancaCartaoRouter.post('/:id/cancelar', ah(async (req, res) => {
  const orgId = orgOf(req);
  let c = await cobrancaDa(orgId, req.params.id);
  if (c.status !== 'PENDENTE') throw new HttpError(409, c.status === 'APROVADA' ? 'O pagamento já foi aprovado: não dá para cancelar a cobrança (faça o estorno na maquininha)' : 'Esta cobrança já foi encerrada');
  const cfg = await configDaEmpresa(orgId);
  if (!cfg?.accessTokenEnc) throw badRequest('Maquininha sem credencial');
  const prov = provedor(c.provedor);
  const cred = credencialDa(cfg);
  if (!c.externalId) c = await tentar(() => sincronizar(c)); // envio pendente: obtém o id (idempotente) antes de cancelar
  if (c.status !== 'PENDENTE') return res.json(await comPedido(c));
  try {
    const r = await prov.cancelar(cred, c.externalId!);
    if (r.confirmado) c = await aplicarResultado(c, { externalId: c.externalId!, status: 'CANCELADA', statusProvedor: r.statusProvedor });
    else c = await prisma.erpCobrancaCartao.update({ where: { id: c.id }, data: { cancelamentoSolicitado: true, statusProvedor: r.statusProvedor } });
  } catch (e) {
    if (e instanceof MaquininhaError && (e.codigo === 'order_already_canceled')) {
      c = await aplicarResultado(c, { externalId: c.externalId!, status: 'CANCELADA', statusProvedor: 'canceled' });
    } else if (e instanceof MaquininhaError && e.codigo === 'cannot_cancel_order') {
      // Pode ter acabado de ser paga/recusada: sincroniza para mostrar o estado real junto com o aviso.
      c = await sincronizar(c).catch(() => c);
      if (c.status === 'PENDENTE') throw http(e);
    } else throw http(e);
  }
  await auditar(req, 'maquininha.cancelar', 'erp_cobranca_cartao', c.id, null, { status: c.status, cancelamentoSolicitado: c.cancelamentoSolicitado });
  res.json(await comPedido(c));
}));

/** Pagamento aprovado cuja venda não fechou (ERRO_VENDA): tenta registrar de novo (ex.: depois de reabrir o caixa). */
cobrancaCartaoRouter.post('/:id/concluir', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await cobrancaDa(orgId, req.params.id);
  if (c.status !== 'ERRO_VENDA') throw new HttpError(409, 'Só dá para concluir uma cobrança aprovada cuja venda não foi registrada');
  const b = z.object({ caixaSessaoId: z.string().nullish() }).parse(req.body ?? {});
  const r = await fecharVenda(c.id, { retentativa: true, caixaSessaoId: b.caixaSessaoId ?? null });
  if (r.status !== 'APROVADA') throw badRequest(r.detalhe ?? 'Não foi possível registrar a venda');
  res.json(await comPedido(r));
}));

// ---------------- Webhook público ----------------
export const maquininhaWebhookRouter = Router();
maquininhaWebhookRouter.use(express.json({ limit: '100kb' }));
/**
 * Notificação do provedor: a URL tem a chave secreta da empresa; o corpo NUNCA é confiado — serve só para saber qual
 * cobrança consultar na API com o token da própria empresa. Com a chave secreta de notificações salva, valida x-signature.
 */
maquininhaWebhookRouter.post('/:provedor/:chave', ah(async (req, res) => {
  const cfg = await prisma.erpMaquininhaConfig.findUnique({ where: { webhookChave: String(req.params.chave) } });
  if (!cfg || cfg.provedor !== req.params.provedor) return res.status(404).json({ error: 'Não encontrado' });
  const q = req.query as Record<string, unknown>;
  const body = (req.body ?? {}) as any;
  const dataId = String(q['data.id'] ?? body?.data?.id ?? '') || null;
  const secret = decryptOrNull(cfg.webhookSecretEnc);
  if (secret && !verifySignature({ secret, xSignature: req.get('x-signature'), xRequestId: req.get('x-request-id'), dataId })) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }
  const tipo = String(body.type ?? q.type ?? '');
  if ((tipo && tipo !== 'order') || !dataId) return res.status(200).json({ ok: true, ignorado: true });
  const cob = await prisma.erpCobrancaCartao.findFirst({ where: { orgId: cfg.orgId, externalId: dataId } });
  if (!cob) return res.status(200).json({ ok: true, ignorado: true });
  try {
    const r = await sincronizar(cob);
    return res.status(200).json({ ok: true, status: r.status });
  } catch (e) {
    // Rede/5xx: 500 faz o provedor reenviar. Credencial recusada: repetir não resolve → 200.
    if (e instanceof MaquininhaError && e.status !== 0 && e.status < 500) return res.status(200).json({ ok: false, ignorado: true });
    console.error('[maquininha] webhook falha temporária', e instanceof MaquininhaError ? `status=${e.status}` : (e as Error)?.message);
    return res.status(500).json({ error: 'Falha temporária' });
  }
}));
