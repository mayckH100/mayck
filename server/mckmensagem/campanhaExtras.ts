import { prisma } from '../db.js';
import type { Campaign } from '@prisma/client';
import { isProductActive } from '../billing/service.js';
import { lerConteudo } from './automacoes/arquivos.js';
import {
  lerMidias, midiaDaVersao, lerPublico, atendeFiltroErp, ehRecorrencia, proximaDepoisDe, diaDoMesBrt, nomeExecucao, STATUS_NAO_COMPRA,
  type FiltroErp, type Publico, type ResumoCompras,
} from './campanhaCore.js';

/**
 * v1.49.0 — partes das campanhas que usam o banco: arquivo da versão, público (vinculados/etiqueta/compras do ERP)
 * e a criação das repetições (campanha que se repete).
 */

// ---------------- Imagem ou PDF ----------------

export interface MidiaCarregada { id: string; nome: string; mime: string; dados: Buffer }

/** Arquivo da versão (ou o da versão A). null = campanha só com texto. Lança erro se o arquivo sumiu. */
export async function midiaParaEnvio(c: Pick<Campaign, 'orgId' | 'midias'>, versao: number): Promise<MidiaCarregada | null> {
  const id = midiaDaVersao(lerMidias(c.midias), versao);
  if (!id) return null;
  const a = await prisma.arquivo.findFirst({ where: { id, orgId: c.orgId } });
  if (!a) throw new Error('A imagem/PDF da campanha foi excluída. Anexe de novo em Editar campanha.');
  return { id: a.id, nome: a.nome, mime: a.mime, dados: await lerConteudo(a.id) };
}

/** Dados dos arquivos (para a tela): nome, tipo e tamanho por versão. */
export async function midiasView(c: Pick<Campaign, 'orgId' | 'midias'>) {
  const ids = lerMidias(c.midias);
  const reais = ids.filter((x): x is string => !!x);
  if (!reais.length) return [];
  const arqs = new Map((await prisma.arquivo.findMany({ where: { orgId: c.orgId, id: { in: reais } }, select: { id: true, nome: true, mime: true, tamanho: true } })).map((a) => [a.id, a]));
  return ids.map((id) => (id ? arqs.get(id) ?? null : null));
}

// ---------------- Público pelas compras do ERP ----------------

/**
 * Resumo de compras de cada contato (lead) ligado a um cliente do ERP: pelo contato do MCKBOT (ErpParceiro.contactId)
 * ou pelo mesmo WhatsApp (ErpParceiro.telefone). Lead sem vínculo não aparece no mapa.
 */
export async function comprasPorLead(orgId: string, leads: { id: string; phone: string; contactId: string | null }[]): Promise<Map<string, ResumoCompras>> {
  const out = new Map<string, ResumoCompras>();
  if (!leads.length) return out;
  const contactIds = [...new Set(leads.map((l) => l.contactId).filter((x): x is string => !!x))];
  const phones = [...new Set(leads.map((l) => l.phone))];
  const parceiros: { id: string; contactId: string | null; telefone: string | null }[] = [];
  for (let i = 0; i < Math.max(contactIds.length, phones.length); i += 500) {
    const or: any[] = [];
    if (contactIds.slice(i, i + 500).length) or.push({ contactId: { in: contactIds.slice(i, i + 500) } });
    if (phones.slice(i, i + 500).length) or.push({ telefone: { in: phones.slice(i, i + 500) } });
    if (!or.length) continue;
    parceiros.push(...await prisma.erpParceiro.findMany({ where: { orgId, ehCliente: true, OR: or }, select: { id: true, contactId: true, telefone: true } }));
  }
  if (!parceiros.length) return out;
  const porParceiro = new Map<string, ResumoCompras>(parceiros.map((p) => [p.id, { gastoCents: 0, compras: 0, ultimaCompra: null }]));
  const pids = [...porParceiro.keys()];
  for (let i = 0; i < pids.length; i += 500) {
    const grupos = await prisma.erpPedidoVenda.groupBy({
      by: ['parceiroId'], where: { orgId, parceiroId: { in: pids.slice(i, i + 500) }, statusOperacional: { notIn: STATUS_NAO_COMPRA } },
      _sum: { totalCents: true }, _count: { _all: true }, _max: { createdAt: true },
    });
    for (const g of grupos) porParceiro.set(g.parceiroId, { gastoCents: g._sum.totalCents ?? 0, compras: g._count._all, ultimaCompra: g._max.createdAt ?? null });
  }
  const porContato = new Map<string, string>(), porFone = new Map<string, string>();
  for (const p of parceiros) {
    if (p.contactId && !porContato.has(p.contactId)) porContato.set(p.contactId, p.id);
    if (p.telefone && !porFone.has(p.telefone)) porFone.set(p.telefone, p.id);
  }
  for (const l of leads) {
    const pid = (l.contactId && porContato.get(l.contactId)) || porFone.get(l.phone);
    if (pid) out.set(l.id, porParceiro.get(pid)!);
  }
  return out;
}

/** Contatos elegíveis da organização (com consentimento, sem opt-out, não descartados). */
const baseElegivel = (orgId: string) => ({ orgId, optOutAt: null, consentAt: { not: null }, status: { not: 'DESCARTADO' } });

/** Prévia do público pelo ERP: quantos estão ligados ao ERP e quantos atendem ao filtro. */
export async function previaSegmentoErp(orgId: string, filtro: FiltroErp, agora = new Date()) {
  const leads = await prisma.lead.findMany({ where: baseElegivel(orgId), select: { id: true, phone: true, contactId: true } });
  const compras = await comprasPorLead(orgId, leads);
  let atendem = 0;
  for (const r of compras.values()) if (atendeFiltroErp(r, filtro, agora)) atendem++;
  const vinculados = compras.size;
  return {
    disponivel: vinculados > 0, contatos: leads.length, vinculados, atendem,
    motivo: vinculados ? null : 'Nenhum contato do MCK Mensagens está ligado a um cliente do MCK ERP ainda. O vínculo é feito pelo mesmo WhatsApp (telefone do cliente no ERP) ou pelo contato do MCKBOT ligado ao cliente. Cadastre os clientes no ERP com o WhatsApp para usar este filtro.',
  };
}

/** Leads do público (só os elegíveis). `vinculoCampaignId` = campanha cujos contatos vinculados entram no modo padrão. */
export async function leadsDoPublico(orgId: string, vinculoCampaignId: string, p: Publico, agora = new Date()): Promise<{ id: string; consentAt: Date | null }[]> {
  if (p.modo === 'erp') {
    const leads = await prisma.lead.findMany({ where: baseElegivel(orgId), select: { id: true, phone: true, contactId: true, consentAt: true } });
    const compras = await comprasPorLead(orgId, leads);
    return leads.filter((l) => { const r = compras.get(l.id); return !!r && atendeFiltroErp(r, p.erp, agora); }).map((l) => ({ id: l.id, consentAt: l.consentAt }));
  }
  const where: any = { orgId, optOutAt: null, status: { not: 'DESCARTADO' } };
  if (p.modo === 'etiqueta') where.tags = { contains: JSON.stringify(p.tag) };
  else where.campaignId = vinculoCampaignId;
  return prisma.lead.findMany({ where, select: { id: true, consentAt: true } });
}

// ---------------- Campanha que se repete ----------------

const ATIVAS = ['EM_ANDAMENTO', 'AGENDADA'];

/**
 * Cria as repetições que venceram. A campanha original (status EM_ANDAMENTO/AGENDADA/CONCLUIDA; pausada não repete)
 * gera uma NOVA campanha (execução) para o público atual; quem está na execução nova recebe uma vez nela.
 * Trava: updateMany com o valor antigo de recorrenciaProxima (só um processo cria cada repetição).
 * Execução anterior ainda enviando → esta repetição é pulada (nunca duas execuções ao mesmo tempo).
 */
export async function tickRecorrencia(now = new Date()): Promise<{ origemId: string; acao: 'criada' | 'pulada_anterior' | 'pulada_assinatura' | 'sem_publico' | 'fim' }[]> {
  const out: { origemId: string; acao: 'criada' | 'pulada_anterior' | 'pulada_assinatura' | 'sem_publico' | 'fim' }[] = [];
  const vencidas = await prisma.campaign.findMany({
    where: { recorrenciaOrigemId: null, recorrencia: { not: '' }, recorrenciaProxima: { lte: now }, status: { in: [...ATIVAS, 'CONCLUIDA'] } },
    take: 50,
  });
  for (const o of vencidas) {
    if (!ehRecorrencia(o.recorrencia) || !o.recorrenciaProxima) continue;
    const prox = o.recorrenciaProxima;
    const passouDoFim = !!o.recorrenciaFim && prox.getTime() > o.recorrenciaFim.getTime();
    const dia = o.iniciarEm ? diaDoMesBrt(o.iniciarEm) : diaDoMesBrt(prox);
    const seguinte = proximaDepoisDe(prox, o.recorrencia, now, o.recorrencia === 'MENSAL' ? dia : undefined);
    const novaProx = passouDoFim || (o.recorrenciaFim && seguinte.getTime() > o.recorrenciaFim.getTime()) ? null : seguinte;
    const claim = await prisma.campaign.updateMany({ where: { id: o.id, recorrenciaProxima: prox }, data: { recorrenciaProxima: novaProx } });
    if (claim.count !== 1) continue;
    if (passouDoFim) { out.push({ origemId: o.id, acao: 'fim' }); continue; }
    if (!(await isProductActive(o.orgId, 'MCKMENSAGEM'))) { out.push({ origemId: o.id, acao: 'pulada_assinatura' }); continue; }
    const anterior = await prisma.campaign.findFirst({ where: { OR: [{ id: o.id }, { recorrenciaOrigemId: o.id }], status: { in: ATIVAS } }, select: { id: true } });
    if (anterior && await prisma.campaignRecipient.count({ where: { campaignId: anterior.id, status: 'PENDENTE' } })) {
      console.warn('[mckmensagem] campanha', { campaignId: o.id, aviso: 'Repetição pulada: a execução anterior ainda está enviando.' });
      out.push({ origemId: o.id, acao: 'pulada_anterior' });
      continue;
    }
    const leads = (await leadsDoPublico(o.orgId, o.id, lerPublico(o.publico), now)).filter((l) => !!l.consentAt);
    const execucao = (await prisma.campaign.update({ where: { id: o.id }, data: { recorrenciaExecucao: { increment: 1 } }, select: { recorrenciaExecucao: true } })).recorrenciaExecucao;
    const nova = await prisma.campaign.create({ data: {
      orgId: o.orgId, name: nomeExecucao(o.name, prox), message: o.message, channelId: o.channelId, status: leads.length ? 'EM_ANDAMENTO' : 'CONCLUIDA',
      dailyLimit: o.dailyLimit, minIntervalSec: o.minIntervalSec, maxIntervalSec: o.maxIntervalSec, windowStart: o.windowStart, windowEnd: o.windowEnd,
      repescagemAtiva: o.repescagemAtiva, repescagemDias: o.repescagemDias, repescagemMax: o.repescagemMax, repescagemModelo: o.repescagemModelo, riscoRetomada: o.riscoRetomada,
      variacoes: o.variacoes, abAutoVencedora: o.abAutoVencedora, abMinimo: o.abMinimo, diasSemana: o.diasSemana, midias: o.midias,
      publico: o.publico, rodizio: o.rodizio, canaisRodizio: o.canaisRodizio, recorrenciaOrigemId: o.id, recorrenciaExecucao: execucao,
    } });
    for (let i = 0; i < leads.length; i += 500) {
      await prisma.campaignRecipient.createMany({ data: leads.slice(i, i + 500).map((l) => ({ campaignId: nova.id, leadId: l.id })) });
    }
    console.warn('[mckmensagem] campanha', { campaignId: o.id, aviso: `Repetição ${execucao} criada (${leads.length} contato(s))`, execucaoId: nova.id });
    out.push({ origemId: o.id, acao: leads.length ? 'criada' : 'sem_publico' });
  }
  return out;
}
