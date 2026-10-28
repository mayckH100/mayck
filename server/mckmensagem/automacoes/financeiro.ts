import { prisma } from '../../db.js';
import { HttpError } from '../../lib/http.js';
import { parseJson } from '../../lib/json.js';
import { localDate } from './rules.js';
import { valorDevidoDe, brl } from './vars.js';
import type { Boleto, Pagamento } from '@prisma/client';

/**
 * Regras financeiras dos boletos (seções 7, 9 e 10 da especificação).
 * - status financeiro é recalculado sempre a partir dos registros (pagamentos não estornados e comprovantes em análise);
 * - receber comprovante NÃO paga: só um pagamento registrado (baixa manual ou aprovação de comprovante) gera "PAGO";
 * - ao pagar: cancela as cobranças futuras daquele boleto e encerra a sequência quando todas as parcelas estão quitadas.
 */

export const STATUS_BOLETO = ['RASCUNHO', 'PENDENTE', 'VENCIDO', 'EM_ANALISE', 'PARCIAL', 'PAGO', 'CANCELADO'] as const;
export type StatusBoleto = typeof STATUS_BOLETO[number];
/** Em aberto (contam como valor a receber). */
export const ABERTOS: StatusBoleto[] = ['PENDENTE', 'VENCIDO', 'EM_ANALISE', 'PARCIAL'];
/** Podem receber cobrança automática (envio/reenvio). Em análise não é cobrado para evitar mensagem indevida. */
export const COBRAVEIS: StatusBoleto[] = ['PENDENTE', 'VENCIDO', 'PARCIAL'];

export const valorDevido = valorDevidoDe;
export const saldoDe = (b: Boleto) => Math.max(0, valorDevido(b) - b.valorPagoCentavos);
/** Data de vencimento (AAAA-MM-DD): é salva ao meio-dia UTC. */
export const vencYmd = (b: Pick<Boleto, 'vencimento'>) => b.vencimento.toISOString().slice(0, 10);
export const estaVencido = (b: Pick<Boleto, 'vencimento'>, now: Date, tz: string) => vencYmd(b) < localDate(now, tz);

export async function evento(b: Pick<Boleto, 'id' | 'orgId'>, tipo: string, descricao: string, dados?: unknown, operadorId?: string | null) {
  await prisma.boletoEvento.create({ data: { orgId: b.orgId, boletoId: b.id, tipo, descricao: descricao.slice(0, 1000), dados: dados === undefined ? null : JSON.stringify(dados), operadorId: operadorId ?? null } });
}

async function tzDe(orgId: string) {
  return (await prisma.automacaoConfig.findUnique({ where: { orgId }, select: { timezone: true } }))?.timezone ?? 'America/Sao_Paulo';
}

export const STATUS_LABEL: Record<string, string> = {
  RASCUNHO: 'Rascunho', PENDENTE: 'A vencer', VENCIDO: 'Vencido', EM_ANALISE: 'Comprovante em análise', PARCIAL: 'Pagamento parcial', PAGO: 'Pago confirmado', CANCELADO: 'Cancelado',
};

/** Recalcula valor pago e status a partir dos registros. Registra a mudança no histórico do boleto. */
export async function recalcularBoleto(id: string, opts: { now?: Date; operadorId?: string | null; motivo?: string } = {}): Promise<Boleto> {
  const now = opts.now ?? new Date();
  const b = await prisma.boleto.findUniqueOrThrow({ where: { id } });
  const pags = await prisma.pagamento.findMany({ where: { boletoId: id, estornadoEm: null }, orderBy: { pagoEm: 'asc' } });
  const pago = pags.reduce((s, p) => s + p.valorCentavos, 0);
  let status: string = b.status;
  if (b.status !== 'CANCELADO' && b.status !== 'RASCUNHO') {
    const emAnalise = await prisma.comprovante.count({ where: { boletoId: id, status: 'EM_ANALISE' } });
    const devido = valorDevido(b);
    if (pago > 0 && pago >= devido) status = 'PAGO';
    else if (emAnalise) status = 'EM_ANALISE';
    else if (pago > 0) status = 'PARCIAL';
    else if (estaVencido(b, now, await tzDe(b.orgId))) status = 'VENCIDO';
    else status = 'PENDENTE';
  }
  const data: any = { valorPagoCentavos: pago, status };
  if (status === 'PAGO') {
    data.pagoEm = pags[pags.length - 1]?.pagoEm ?? now;
    data.origemBaixa = pags[pags.length - 1]?.origem ?? 'MANUAL';
  } else if (b.status === 'PAGO') { data.pagoEm = null; data.origemBaixa = null; }
  const u = await prisma.boleto.update({ where: { id }, data });
  if (u.status !== b.status) {
    await evento(u, status === 'VENCIDO' ? 'VENCIDO' : b.status === 'PAGO' ? 'REABERTO' : 'STATUS', `Status: ${STATUS_LABEL[b.status] ?? b.status} → ${STATUS_LABEL[status] ?? status}${opts.motivo ? ` (${opts.motivo})` : ''}`, { de: b.status, para: status }, opts.operadorId);
  }
  if (u.status === 'PAGO' && b.status !== 'PAGO') await interromperCobrancas(u, 'Boleto pago — cobrança interrompida');
  return u;
}

/**
 * Após pagamento confirmado ou cancelamento: cancela envios/reenvios pendentes daquele boleto (o histórico é preservado)
 * e encerra a sequência de cobrança quando todos os boletos dela estão pagos ou cancelados.
 */
export async function interromperCobrancas(b: Boleto, motivo: string) {
  await prisma.ocorrencia.updateMany({ where: { orgId: b.orgId, boletoId: b.id, status: 'PENDENTE' }, data: { status: 'CANCELADA', erro: motivo } });
  const anexos = await prisma.automacaoAnexo.findMany({ where: { orgId: b.orgId, boletoId: b.id }, select: { automacaoId: true } });
  for (const automacaoId of new Set(anexos.map((x) => x.automacaoId))) {
    const a = await prisma.automacao.findFirst({ where: { id: automacaoId, orgId: b.orgId } });
    if (!a || a.categoria !== 'COBRANCA' || ['CANCELADA', 'CONCLUIDA'].includes(a.status)) continue;
    const ids = (await prisma.automacaoAnexo.findMany({ where: { automacaoId, boletoId: { not: null } }, select: { boletoId: true } })).map((x) => x.boletoId!);
    const abertos = await prisma.boleto.count({ where: { id: { in: ids }, status: { notIn: ['PAGO', 'CANCELADO'] } } });
    if (!abertos) {
      await prisma.ocorrencia.updateMany({ where: { automacaoId, status: 'PENDENTE' }, data: { status: 'CANCELADA', erro: 'Todas as parcelas pagas ou canceladas — sequência encerrada' } });
      await prisma.automacao.update({ where: { id: automacaoId }, data: { status: 'CONCLUIDA' } });
    }
  }
}

/** Marca como VENCIDO o que passou do vencimento (no fuso da organização). Executado pelo motor a cada 5 minutos. */
export async function atualizarVencidos(now = new Date()): Promise<number> {
  const cands = await prisma.boleto.findMany({ where: { status: 'PENDENTE', vencimento: { lt: now } }, take: 2000 });
  const tzs = new Map<string, string>();
  let n = 0;
  for (const b of cands) {
    if (!tzs.has(b.orgId)) tzs.set(b.orgId, await tzDe(b.orgId));
    if (!estaVencido(b, now, tzs.get(b.orgId)!)) continue;
    const r = await prisma.boleto.updateMany({ where: { id: b.id, status: 'PENDENTE' }, data: { status: 'VENCIDO' } });
    if (r.count) { n++; await evento(b, 'VENCIDO', 'Vencimento passou sem pagamento confirmado: status → Vencido'); }
  }
  return n;
}

export interface NovoPagamento {
  boleto: Boleto; valorCentavos: number; pagoEm: Date; forma?: string | null; origem: 'MANUAL' | 'COMPROVANTE';
  comprovanteId?: string | null; observacoes?: string | null; operadorId?: string | null;
}

/** Baixa (total ou parcial). Pagamento parcial não quita a parcela: registra o valor e mantém o saldo em cobrança. */
export async function registrarPagamento(p: NovoPagamento): Promise<{ pagamento: Pagamento; boleto: Boleto }> {
  const b = await prisma.boleto.findUniqueOrThrow({ where: { id: p.boleto.id } });
  if (b.status === 'CANCELADO') throw new HttpError(400, 'Boleto cancelado não recebe pagamento. Reabra-o antes.');
  if (b.status === 'RASCUNHO') throw new HttpError(400, 'Boleto em rascunho: emita-o (status pendente) antes de registrar pagamento');
  if (b.status === 'PAGO') throw new HttpError(409, 'Este boleto já está pago (confirmado). Nada foi registrado.');
  if (!Number.isInteger(p.valorCentavos) || p.valorCentavos <= 0) throw new HttpError(400, 'Informe um valor maior que zero');
  const saldo = saldoDe(b);
  if (p.valorCentavos > saldo) throw new HttpError(400, `Valor maior que o saldo da parcela (${brl(saldo)}). Ajuste juros/multa ou o valor atualizado antes.`);
  if (p.pagoEm.getTime() > Date.now() + 86400e3) throw new HttpError(400, 'A data do pagamento não pode estar no futuro');
  const pagamento = await prisma.pagamento.create({
    data: {
      orgId: b.orgId, boletoId: b.id, clienteId: b.clienteId, valorCentavos: p.valorCentavos, pagoEm: p.pagoEm, forma: p.forma ?? null,
      origem: p.origem, comprovanteId: p.comprovanteId ?? null, observacoes: p.observacoes ?? null, operadorId: p.operadorId ?? null,
    },
  });
  const parcial = p.valorCentavos < saldo;
  await evento(b, 'PAGAMENTO', `${parcial ? 'Pagamento parcial' : 'Pagamento'} de ${brl(p.valorCentavos)} registrado (${p.origem === 'COMPROVANTE' ? 'comprovante aprovado' : 'baixa manual'})${parcial ? `; saldo restante ${brl(saldo - p.valorCentavos)}` : ''}`, { pagamentoId: pagamento.id, valor: p.valorCentavos }, p.operadorId);
  const boleto = await recalcularBoleto(b.id, { operadorId: p.operadorId });
  return { pagamento, boleto };
}

/** Estorno/pagamento inválido: não apaga o registro; reabre a cobrança com auditoria. */
export async function estornarPagamento(pag: Pagamento, motivo: string, operadorId?: string | null) {
  if (pag.estornadoEm) throw new HttpError(400, 'Pagamento já estornado');
  await prisma.pagamento.update({ where: { id: pag.id }, data: { estornadoEm: new Date(), estornoMotivo: motivo, estornadoPorId: operadorId ?? null } });
  const b = await prisma.boleto.findUniqueOrThrow({ where: { id: pag.boletoId } });
  await evento(b, 'ESTORNO', `Pagamento de ${brl(pag.valorCentavos)} estornado: ${motivo}. Revise as automações de cobrança deste cliente (sequências encerradas não são reativadas sozinhas).`, { pagamentoId: pag.id }, operadorId);
  return recalcularBoleto(b.id, { operadorId, motivo: 'estorno' });
}

/** Saldo em aberto de um cliente (soma dos saldos dos boletos abertos). */
export async function saldoCliente(orgId: string, clienteId: string) {
  const bs = await prisma.boleto.findMany({ where: { orgId, clienteId, status: { in: ABERTOS } } });
  return bs.reduce((s, b) => s + saldoDe(b), 0);
}

export const reenvioPadraoDe = (raw: string | null | undefined) => parseJson<{ offsets: number[]; horario: string; maxPorBoleto: number; mensagem?: string | null }>(raw ?? '', { offsets: [-1, 0, 1, 3, 7], horario: '10:00', maxPorBoleto: 5 });
