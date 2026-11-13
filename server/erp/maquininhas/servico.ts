/**
 * Maquininhas no PDV — regras de negócio: configuração da empresa (token cifrado), envio da cobrança ao terminal,
 * sincronização do status (consulta ou webhook) e fechamento da venda SÓ quando o pagamento é aprovado.
 * Recusada/cancelada/expirada não gera venda. Se o pagamento foi aprovado mas a venda não fechou (ex.: caixa fechado
 * ou estoque acabou nesse meio-tempo), a cobrança fica em ERRO_VENDA com o motivo, para o lojista concluir ou estornar.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '../../db.js';
import { decrypt, randomToken } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { despacharEmBreve } from '../shared/events.js';
import { avisarPedidoErp } from '../vendas/avisoPedido.js';
import { executarVendaBalcao, prepararVendaBalcao, vendaBalcaoSchema } from '../vendas/balcao.routes.js';
import { provedor } from './registro.js';
import { MaquininhaError, type CredencialMaquininha, type ResultadoCobranca } from './tipos.js';
import type { ErpCobrancaCartao, ErpMaquininhaConfig } from '@prisma/client';

export const configDaEmpresa = (orgId: string) => prisma.erpMaquininhaConfig.findUnique({ where: { orgId } });
export const garantirConfig = (orgId: string) =>
  prisma.erpMaquininhaConfig.upsert({ where: { orgId }, update: {}, create: { orgId, webhookChave: randomToken(24) } });

export function credencialDa(cfg: Pick<ErpMaquininhaConfig, 'accessTokenEnc'>): CredencialMaquininha {
  if (!cfg.accessTokenEnc) throw new MaquininhaError(400, 'Cole o access token da maquininha em Maquininhas');
  return { accessToken: decrypt(cfg.accessTokenEnc) };
}

/** Maquininha pronta para o PDV (ativa, provedor integrado, token e terminal escolhidos) ou null = lançamento manual. */
export async function maquininhaDoPdv(orgId: string) {
  const cfg = await configDaEmpresa(orgId);
  if (!cfg || !cfg.ativo || !cfg.accessTokenEnc || !cfg.terminalPadraoId) return null;
  const prov = provedor(cfg.provedor);
  if (!prov.disponivel) return null;
  return { cfg, prov, terminalId: cfg.terminalPadraoId };
}

/** Referência única aceita pelos provedores (letras, números, "-"; até 64). */
export const novaReferencia = () => `MCK-${Date.now().toString(36)}-${randomBytes(9).toString('hex')}`.toUpperCase();

const FINAIS_SEM_VENDA = new Set(['RECUSADA', 'CANCELADA', 'EXPIRADA', 'ESTORNADA']);

/** Aplica o resultado vindo do provedor. Aprovado → tenta fechar a venda. Devolve a cobrança atualizada. */
export async function aplicarResultado(cob: ErpCobrancaCartao, r: ResultadoCobranca): Promise<ErpCobrancaCartao> {
  const base = { statusProvedor: r.statusProvedor || cob.statusProvedor, detalhe: r.detalhe ?? cob.detalhe, externalId: cob.externalId ?? (r.externalId || null) };
  if (cob.status !== 'PENDENTE') {
    // Já resolvida: só registra o que o provedor diz agora (ex.: estorno depois da venda).
    await prisma.erpCobrancaCartao.update({ where: { id: cob.id }, data: base });
    return prisma.erpCobrancaCartao.findUniqueOrThrow({ where: { id: cob.id } });
  }
  if (FINAIS_SEM_VENDA.has(r.status)) {
    await prisma.erpCobrancaCartao.updateMany({ where: { id: cob.id, status: 'PENDENTE' }, data: { ...base, status: r.status } });
    return prisma.erpCobrancaCartao.findUniqueOrThrow({ where: { id: cob.id } });
  }
  await prisma.erpCobrancaCartao.update({ where: { id: cob.id }, data: base });
  if (r.status === 'APROVADA') {
    if (r.valorPagoCents != null && r.valorPagoCents !== cob.valorCents) {
      await prisma.erpCobrancaCartao.updateMany({ where: { id: cob.id, status: 'PENDENTE' }, data: { status: 'ERRO_VENDA', detalhe: `Valor pago (${(r.valorPagoCents / 100).toFixed(2)}) diferente do cobrado (${(cob.valorCents / 100).toFixed(2)}): confira na maquininha` } });
    } else {
      await fecharVenda(cob.id);
    }
  }
  return prisma.erpCobrancaCartao.findUniqueOrThrow({ where: { id: cob.id } });
}

/**
 * Cria a venda balcão de uma cobrança aprovada (uma única vez: a "trava" é a troca de status dentro da mesma transação).
 * `caixaSessaoId` permite concluir em outro caixa aberto (retentativa de uma ERRO_VENDA).
 */
export async function fecharVenda(cobId: string, opts: { caixaSessaoId?: string | null; retentativa?: boolean } = {}) {
  const cob = await prisma.erpCobrancaCartao.findUniqueOrThrow({ where: { id: cobId } });
  if (cob.pedidoId) return cob;
  const de = opts.retentativa ? 'ERRO_VENDA' : 'PENDENTE';
  if (cob.status !== de) return cob;
  const venda = vendaBalcaoSchema.parse(JSON.parse(cob.venda));
  const b = { ...venda, forma: 'CARTAO' as const, caixaSessaoId: opts.retentativa ? (opts.caixaSessaoId ?? null) : cob.caixaSessaoId };
  const ctx = { orgId: cob.orgId, userId: cob.userId, gestor: cob.gestor };
  const prov = provedor(cob.provedor);
  const obs = `Maquininha ${prov.nome} · ${cob.tipo === 'DEBITO' ? 'débito' : `crédito ${cob.parcelas}x`} · ${cob.externalId ?? cob.referencia}`;
  try {
    const prep = await prepararVendaBalcao(ctx, b);
    const pedido = await prisma.$transaction(async (tx) => {
      const trava = await tx.erpCobrancaCartao.updateMany({ where: { id: cob.id, status: de, pedidoId: null }, data: { status: 'APROVADA' } });
      if (!trava.count) return null;
      const p = await executarVendaBalcao(tx, ctx, b, prep, obs);
      await tx.erpCobrancaCartao.update({ where: { id: cob.id }, data: { pedidoId: p.id, caixaSessaoId: prep.sessao.id, detalhe: cob.detalhe } });
      return p;
    });
    if (pedido) {
      despacharEmBreve();
      await audit(null, 'erp.pedido.balcao', { orgId: cob.orgId, userId: cob.userId, entity: 'erp_pedido_venda', entityId: pedido.id, meta: { antes: null, depois: { numero: pedido.numero, totalCents: pedido.totalCents, forma: 'CARTAO', caixaSessaoId: pedido.caixaSessaoId, cobrancaId: cob.id, provedor: cob.provedor } } });
      avisarPedidoErp(pedido, { balcao: true });
    }
  } catch (e) {
    const msg = (e as Error)?.message || 'falha ao registrar a venda';
    console.error(`[maquininha] pagamento aprovado mas a venda não fechou (cobranca=${cob.id}): ${msg}`);
    await prisma.erpCobrancaCartao.updateMany({ where: { id: cob.id, status: { in: ['PENDENTE', 'ERRO_VENDA'] }, pedidoId: null }, data: { status: 'ERRO_VENDA', detalhe: `Pagamento aprovado, mas a venda não foi registrada: ${msg}` } });
  }
  return prisma.erpCobrancaCartao.findUniqueOrThrow({ where: { id: cob.id } });
}

/** Consulta o provedor e aplica. Sem id externo (envio que caiu na rede), reenvia com a mesma chave de idempotência. */
export async function sincronizar(cob: ErpCobrancaCartao): Promise<ErpCobrancaCartao> {
  if (cob.status !== 'PENDENTE') return cob;
  const cfg = await configDaEmpresa(cob.orgId);
  if (!cfg?.accessTokenEnc) return cob;
  const prov = provedor(cob.provedor);
  const cred = credencialDa(cfg);
  const r = cob.externalId
    ? await prov.consultarStatus(cred, cob.externalId)
    : await prov.criarCobranca(cred, { valorCents: cob.valorCents, terminalId: cob.terminalId, referencia: cob.referencia, tipo: cob.tipo as 'CREDITO' | 'DEBITO', parcelas: cob.parcelas });
  return aplicarResultado(cob, r);
}

export function visaoCobranca(c: ErpCobrancaCartao) {
  return {
    id: c.id, provedor: c.provedor, terminalId: c.terminalId, externalId: c.externalId, referencia: c.referencia,
    valorCents: c.valorCents, tipo: c.tipo, parcelas: c.parcelas, status: c.status, statusProvedor: c.statusProvedor,
    detalhe: c.detalhe, cancelamentoSolicitado: c.cancelamentoSolicitado, pedidoId: c.pedidoId, caixaSessaoId: c.caixaSessaoId,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}
