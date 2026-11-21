/**
 * Ciclo de vida da ordem de compra (v1.36.0): linha do tempo, avisos (central de avisos da aba Compras, WhatsApp da
 * equipe e fornecedor) e a rotina diária de prazos. Os avisos ficam em ErpAvisoCompra com chave única
 * (pedido, tipo, dia): rodar a rotina de novo no mesmo dia não duplica nada.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { erpLiberado } from '../../billing/erpAccess.js';
import { sendToStaffNumber } from '../../whatsapp/handoffNotify.js';
import { appUrl } from '../../lib/mailer.js';
import { configDa } from '../produtos/produtos.routes.js';
import { parseJson } from '../../lib/json.js';
import { enviarAoParceiro } from '../crm/interacoes.routes.js';
import { ROTULO_STATUS_COMPRA, STATUS_AGUARDANDO_ENTREGA, type StatusCompra } from './compra.machine.js';
import { situacaoPrazo, diaBr, agoraNoFuso as agoraLocal, preencherTexto, cobrarFornecedorHoje, TEXTO_FORN_ATRASO, TEXTO_FORN_LEMBRETE } from './prazo.js';

type Db = Prisma.TransactionClient | typeof prisma;
const telefonesDe = (raw: string | null | undefined) => parseJson<string[] | null>(raw ?? null, null)?.filter((p) => typeof p === 'string' && p.trim()) ?? [];

export type TipoAvisoCompra = 'AGUARDANDO_APROVACAO' | 'CHEGA_EM_BREVE' | 'ATRASADO' | 'NF_LANCADA' | 'LIBERADA_ESTOQUE' | 'FORN_LEMBRETE' | 'FORN_ATRASO';

/** Registra uma linha na linha do tempo da OC. */
export async function registrarHistorico(db: Db, a: { orgId: string; pedidoId: string; de: string | null; para: string; evento: string; userId?: string | null; userNome?: string | null; observacao?: string | null }) {
  await db.erpPedidoCompraHistorico.create({ data: { orgId: a.orgId, pedidoId: a.pedidoId, de: a.de, para: a.para, evento: a.evento, userId: a.userId ?? null, userNome: a.userNome ?? null, observacao: a.observacao?.slice(0, 500) ?? null } });
}

/** A OC exige liberação da qualidade? Padrão da empresa ou algum produto marcado. */
export async function qualidadeInicial(db: Db, orgId: string, produtoIds: string[]) {
  const cfg = await db.erpConfig.findUnique({ where: { orgId }, select: { compraQualidadePadrao: true } });
  if (cfg?.compraQualidadePadrao) return true;
  return (await db.erpProduto.count({ where: { orgId, id: { in: [...new Set(produtoIds)] }, exigeQualidade: true } })) > 0;
}

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const linkOc = () => `${appUrl()}/erp/compras`;

interface PedidoAviso { id: string; orgId: string; numero: number; status: string; parceiroId: string; totalCents: number; previsaoEntrega: Date | null; entregueEm?: Date | null }

/** Monta título e texto do aviso para a equipe. */
export function textoAvisoEquipe(tipo: TipoAvisoCompra, p: PedidoAviso & { fornecedor: string }, extra: { dias?: number; previsao?: string | null } = {}) {
  const prev = extra.previsao ? ` (previsão ${diaBr(extra.previsao)})` : '';
  const base = `OC nº ${p.numero} · ${p.fornecedor} · ${brl(p.totalCents)}`;
  switch (tipo) {
    case 'AGUARDANDO_APROVACAO': return { titulo: `OC nº ${p.numero} aguardando aprovação`, texto: `🟠 ${base}\nAguardando aprovação do gestor.` };
    case 'CHEGA_EM_BREVE': return { titulo: `OC nº ${p.numero} chega ${extra.dias === 0 ? 'hoje' : extra.dias === 1 ? 'amanhã' : `em ${extra.dias} dias`}`, texto: `🟡 ${base}\nEntrega ${extra.dias === 0 ? 'prevista para hoje' : `em ${extra.dias} dia(s)`}${prev}.` };
    case 'ATRASADO': return { titulo: `OC nº ${p.numero} atrasada há ${extra.dias} dia(s)`, texto: `🔴 ${base}\nAtrasada há ${extra.dias} dia(s)${prev}. Status: ${ROTULO_STATUS_COMPRA[p.status as StatusCompra] ?? p.status}.` };
    case 'NF_LANCADA': return { titulo: `OC nº ${p.numero}: NF registrada`, texto: `🧾 ${base}\nNF registrada. Próxima etapa: ${ROTULO_STATUS_COMPRA[p.status as StatusCompra] ?? p.status}.` };
    case 'LIBERADA_ESTOQUE': return { titulo: `OC nº ${p.numero} ${p.status === 'LIBERADA_ESTOQUE' ? 'liberada para estoque' : 'entrou no estoque'}`, texto: `✅ ${base}\n${ROTULO_STATUS_COMPRA[p.status as StatusCompra] ?? p.status}.` };
    default: return { titulo: `OC nº ${p.numero}`, texto: base };
  }
}

/** Cria o aviso (1 por OC/tipo/dia). Retorna null se já existia hoje. */
export async function criarAviso(a: { orgId: string; pedidoId: string; tipo: TipoAvisoCompra; dia: string; destino?: 'EQUIPE' | 'FORNECEDOR'; titulo: string; texto: string }) {
  try {
    return await prisma.erpAvisoCompra.create({ data: { orgId: a.orgId, pedidoId: a.pedidoId, tipo: a.tipo, dia: a.dia, destino: a.destino ?? 'EQUIPE', titulo: a.titulo, texto: a.texto } });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return null; // já avisado hoje
    throw e;
  }
}

/** Aviso para a equipe: central de avisos + WhatsApp dos números de alerta do ERP (se o alerta e a opção estiverem ligados). */
async function avisarEquipe(p: PedidoAviso, tipo: TipoAvisoCompra, dia: string, extra: { dias?: number; previsao?: string | null } = {}) {
  const forn = await prisma.erpParceiro.findUnique({ where: { id: p.parceiroId }, select: { nome: true, fantasia: true } });
  const t = textoAvisoEquipe(tipo, { ...p, fornecedor: forn?.fantasia || forn?.nome || 'Fornecedor' }, extra);
  const aviso = await criarAviso({ orgId: p.orgId, pedidoId: p.id, tipo, dia, titulo: t.titulo, texto: t.texto });
  if (!aviso) return null;
  const cfg = await prisma.erpConfig.findUnique({ where: { orgId: p.orgId }, select: { alertaAtivo: true, alertaTelefones: true, compraAvisoEquipeWhats: true } });
  const tels = cfg?.alertaAtivo && cfg.compraAvisoEquipeWhats ? telefonesDe(cfg.alertaTelefones) : [];
  if (tels.length) {
    const out: string[] = [];
    for (const tel of tels.slice(0, 5)) {
      const r = await sendToStaffNumber(p.orgId, null, tel, `*${t.titulo}*\n${t.texto}\n${linkOc()}`).catch((e) => ({ ok: false, phone: tel, error: (e as Error).message }));
      out.push(r.ok ? `${r.phone}: enviado` : `${r.phone}: ${'error' in r ? r.error : 'falha'}`);
    }
    await prisma.erpAvisoCompra.update({ where: { id: aviso.id }, data: { envio: out.join('; ').slice(0, 500) } }).catch(() => undefined);
  }
  return aviso;
}

/** Aviso ao fornecedor (lembrete/cobrança) pelos canais do sistema. Só com a opção ligada na empresa. */
async function avisarFornecedor(p: PedidoAviso, tipo: 'FORN_LEMBRETE' | 'FORN_ATRASO', dia: string, cfg: { compraAvisoFornCanal: string; compraAvisoFornTextoLembrete: string | null; compraAvisoFornTextoAtraso: string | null }, extra: { dias: number; previsao: string }) {
  const [forn, org, itens] = await Promise.all([
    prisma.erpParceiro.findUnique({ where: { id: p.parceiroId }, select: { id: true, nome: true, fantasia: true, email: true, telefone: true, contactId: true } }),
    prisma.organization.findUnique({ where: { id: p.orgId }, select: { name: true } }),
    prisma.erpPedidoCompraItem.findMany({ where: { pedidoId: p.id }, select: { descricao: true, qtdMil: true, recebidoMil: true } }),
  ]);
  if (!forn) return null;
  const modelo = tipo === 'FORN_LEMBRETE' ? cfg.compraAvisoFornTextoLembrete || TEXTO_FORN_LEMBRETE : cfg.compraAvisoFornTextoAtraso || TEXTO_FORN_ATRASO;
  const texto = preencherTexto(modelo, {
    fornecedor: forn.fantasia || forn.nome, empresa: org?.name ?? '', numero: String(p.numero), data_prevista: diaBr(extra.previsao), dias_atraso: String(extra.dias),
    itens: itens.filter((i) => i.qtdMil > i.recebidoMil).map((i) => `${i.descricao} (${((i.qtdMil - i.recebidoMil) / 1000).toLocaleString('pt-BR')})`).join('; ') || '—',
  });
  const titulo = tipo === 'FORN_LEMBRETE' ? `Lembrete ao fornecedor · OC nº ${p.numero}` : `Cobrança de atraso ao fornecedor · OC nº ${p.numero}`;
  const aviso = await criarAviso({ orgId: p.orgId, pedidoId: p.id, tipo, dia, destino: 'FORNECEDOR', titulo, texto });
  if (!aviso) return null;
  const canais: ('EMAIL' | 'WHATSAPP')[] = cfg.compraAvisoFornCanal === 'AMBOS' ? ['EMAIL', 'WHATSAPP'] : cfg.compraAvisoFornCanal === 'WHATSAPP' ? ['WHATSAPP'] : ['EMAIL'];
  const out: string[] = [];
  for (const c of canais) {
    const r = await enviarAoParceiro(p.orgId, forn, c, texto, { assunto: `${org?.name ?? ''} · Pedido de compra nº ${p.numero}`.trim() }).catch((e) => ({ ok: false, erro: (e as Error).message }));
    out.push(`${c === 'EMAIL' ? 'e-mail' : 'WhatsApp'}: ${r.ok ? 'enviado' : r.erro === 'OPT_OUT' ? 'fornecedor pediu para não receber' : r.erro}`);
  }
  await prisma.erpAvisoCompra.update({ where: { id: aviso.id }, data: { envio: out.join('; ').slice(0, 500) } }).catch(() => undefined);
  return aviso;
}

async function tzDa(orgId: string) {
  return (await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }))?.timezone || 'America/Sao_Paulo';
}

/**
 * Avisos disparados por mudança de etapa (chamado depois da transação; nunca lança):
 * EM_APROVACAO → aguardando aprovação; NF registrada; liberada para estoque / entrou no estoque.
 */
export async function avisarMudanca(pedidoId: string, evento: string, now = new Date()) {
  try {
    const p = await prisma.erpPedidoCompra.findUnique({ where: { id: pedidoId } });
    if (!p) return;
    const { dia } = agoraLocal(await tzDa(p.orgId), now);
    if (p.status === 'EM_APROVACAO') await avisarEquipe(p, 'AGUARDANDO_APROVACAO', dia);
    if (evento === 'NF_ENTRADA' || evento === 'NF_ENTRADA_QUALIDADE') await avisarEquipe(p, 'NF_LANCADA', dia);
    if (p.status === 'LIBERADA_ESTOQUE' || ((evento === 'RECEBER' || evento === 'RECEBER_PARCIAL' || evento === 'FINALIZAR') && ['RECEBIDO', 'RECEBIDO_PARCIAL'].includes(p.status))) await avisarEquipe(p, 'LIBERADA_ESTOQUE', dia);
  } catch (e) { console.error('[compras-avisos]', (e as Error).message); }
}

/**
 * Rotina diária de prazos (uma vez por dia por empresa, a partir da hora do alerta do ERP, padrão 8h, fuso da empresa):
 * equipe: aguardando aprovação, chega em breve, atrasado (todo dia enquanto atrasado, com os dias);
 * fornecedor (opção ligada; só OC emitida): lembrete N dias antes e cobrança no 1º dia de atraso e a cada 3 dias.
 */
export async function tickPrazosCompras(now = new Date(), opts: { orgId?: string; ignorarHora?: boolean } = {}) {
  const orgs = await prisma.erpPedidoCompra.groupBy({ by: ['orgId'], where: { ...(opts.orgId ? { orgId: opts.orgId } : {}), status: { in: [...STATUS_AGUARDANDO_ENTREGA] } } });
  const feitos: { orgId: string; avisos: number }[] = [];
  for (const { orgId } of orgs) {
    try {
      const cfg = await configDa(orgId);
      const tz = await tzDa(orgId);
      const { dia, hora } = agoraLocal(tz, now);
      if (!opts.ignorarHora && (hora < (cfg.alertaHora ?? 8) || cfg.compraRotinaDia === dia)) continue;
      if (!(await erpLiberado(orgId, now))) continue;
      const claim = await prisma.erpConfig.updateMany({ where: { orgId, OR: [{ compraRotinaDia: null }, { compraRotinaDia: { not: dia } }] }, data: { compraRotinaDia: dia } });
      if (!claim.count && !opts.ignorarHora) continue;
      let n = 0;
      const pedidos = await prisma.erpPedidoCompra.findMany({ where: { orgId, status: { in: [...STATUS_AGUARDANDO_ENTREGA] } }, take: 2000 });
      for (const p of pedidos) {
        const s = situacaoPrazo(p, dia, cfg.compraEmBreveDias, tz);
        if (p.status === 'EM_APROVACAO' && (await avisarEquipe(p, 'AGUARDANDO_APROVACAO', dia))) n++;
        if (s.codigo === 'EM_BREVE' && (await avisarEquipe(p, 'CHEGA_EM_BREVE', dia, { dias: s.dias, previsao: s.previsaoDia }))) n++;
        if (s.codigo === 'ATRASADO' && (await avisarEquipe(p, 'ATRASADO', dia, { dias: s.dias, previsao: s.previsaoDia }))) n++;
        if (cfg.compraAvisoFornecedor && ['ENVIADO', 'RECEBIDO_PARCIAL'].includes(p.status) && s.previsaoDia) {
          if (s.codigo !== 'ATRASADO' && s.dias >= 0 && s.dias <= Math.max(0, cfg.compraAvisoFornDias)) {
            const ja = await prisma.erpAvisoCompra.count({ where: { pedidoId: p.id, tipo: 'FORN_LEMBRETE' } });
            if (!ja && (await avisarFornecedor(p, 'FORN_LEMBRETE', dia, cfg, { dias: s.dias, previsao: s.previsaoDia }))) n++;
          }
          if (s.codigo === 'ATRASADO' && cobrarFornecedorHoje(s.dias) && (await avisarFornecedor(p, 'FORN_ATRASO', dia, cfg, { dias: s.dias, previsao: s.previsaoDia }))) n++;
        }
      }
      feitos.push({ orgId, avisos: n });
    } catch (e) { console.error('[compras-prazos]', orgId, (e as Error).message); }
  }
  return feitos;
}
