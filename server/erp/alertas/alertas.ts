/**
 * Alertas diários do MCK ERP por WhatsApp para a administração (números escolhidos em ERP › Alertas):
 * contas a pagar (fornecedores e contas da empresa separadas), estoque baixo com sugestão de compra e aprovação pelo
 * WhatsApp, lotes vencidos/vencendo, produtos parados, caixa e alterações do dia anterior, e "Ações sugeridas"
 * (v1.30.0; dados em dados.ts, texto em formato.ts, aprovação em aprovacao.ts). Um envio por dia, a partir da hora
 * escolhida (fuso da organização); texto longo vai em mais de uma mensagem.
 */
import { prisma } from '../../db.js';
import { erpLiberado } from '../../billing/erpAccess.js';
import { parseJson } from '../../lib/json.js';
import { sendToStaffNumber, type NotifyResult } from '../../whatsapp/handoffNotify.js';
import { coletarDados, type ConfigAlerta } from './dados.js';
import { formatarAlerta, qtdItens, temConteudo, MAX_LINHAS } from './formato.js';
import { lerOpcoes } from './opcoes.js';
import { criarAprovacao, expirarAprovacoes } from './aprovacao.js';

export { NOME_NATUREZA, type ConfigAlerta } from './dados.js';

/** Data (AAAA-MM-DD) e hora locais no fuso da organização. */
export function agoraLocal(tz: string, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24 };
}

type CfgCompleta = ConfigAlerta & { alertaOpcoes?: string | null };

/**
 * Monta o alerta (v1.30.0). `criarCodigo` = envio de verdade: cria a aprovação de compra pelo WhatsApp e põe o
 * código no texto; sem ele (prévia) o texto mostra "(gerado no envio)". Retorna null quando não há nada para avisar.
 */
export async function montarAlerta(orgId: string, cfg: CfgCompleta, hojeIso: string, now = new Date(), opts: { criarCodigo?: boolean } = {}): Promise<{ texto: string; partes: string[]; itens: number; codigo: string | null } | null> {
  const op = lerOpcoes(cfg.alertaOpcoes);
  const dados = await coletarDados(orgId, cfg, op, hojeIso, now);
  if (!temConteudo(dados)) return null;
  let codigo: string | null = null;
  if (opts.criarCodigo && op.compraWhatsapp && dados.estoqueBaixo?.length) {
    codigo = (await criarAprovacao(orgId, hojeIso, dados.estoqueBaixo.slice(0, MAX_LINHAS), now).catch((e) => { console.error('[erp-alertas] aprovação', orgId, (e as Error).message); return null; }))?.codigo ?? null;
  }
  const partes = formatarAlerta(dados, { codigo, previa: !opts.criarCodigo && op.compraWhatsapp });
  return { texto: partes.join('\n\n'), partes, itens: qtdItens(dados), codigo };
}

export const telefonesDe = (raw: string | null | undefined) => parseJson<string[] | null>(raw ?? null, null)?.filter((p) => typeof p === 'string' && p.trim()) ?? [];

/** Envia o texto para os números configurados e grava o status. Nunca lança. */
export async function enviarAlerta(orgId: string, telefones: string[], texto: string | string[], now = new Date()) {
  const partes = Array.isArray(texto) ? texto : [texto];
  const results: NotifyResult[] = [];
  for (const t of telefones.slice(0, 5)) {
    let r: NotifyResult | null = null;
    for (const p of partes) { r = await sendToStaffNumber(orgId, null, t, p); if (!r.ok) break; } // parte que falhou: não manda as seguintes fora de ordem
    results.push(r!);
  }
  const ok = results.some((r) => r.ok);
  const detail = results.map((r) => (r.ok ? `${r.phone}: enviado` : `${r.phone}: ${r.error}`)).join('; ').slice(0, 500);
  await prisma.erpConfig.update({ where: { orgId }, data: { alertaStatus: JSON.stringify({ at: now.toISOString(), ok, detail }) } }).catch(() => undefined);
  return { ok, results, detail };
}

/** Tick do agendador: para cada empresa com alerta ligado, envia uma vez por dia depois da hora escolhida. */
export async function tickAlertasErp(now = new Date()) {
  await expirarAprovacoes(now).catch(() => undefined);
  const cfgs = await prisma.erpConfig.findMany({ where: { alertaAtivo: true } });
  for (const c of cfgs) {
    const tels = telefonesDe(c.alertaTelefones);
    if (!tels.length) continue;
    const org = await prisma.organization.findUnique({ where: { id: c.orgId }, select: { timezone: true } });
    const { dia, hora } = agoraLocal(org?.timezone || 'America/Sao_Paulo', now);
    if (hora < c.alertaHora || c.alertaUltimoDia === dia) continue;
    if (!(await erpLiberado(c.orgId, now))) continue; // ERP só no Plano Completo: sem ele, não envia (e não gasta o dia)
    // Reserva o dia de forma atômica (evita envio duplicado com mais de uma instância).
    const claim = await prisma.erpConfig.updateMany({ where: { orgId: c.orgId, alertaAtivo: true, OR: [{ alertaUltimoDia: null }, { alertaUltimoDia: { not: dia } }] }, data: { alertaUltimoDia: dia } });
    if (!claim.count) continue;
    try {
      const a = await montarAlerta(c.orgId, c, dia, now, { criarCodigo: true });
      if (a) await enviarAlerta(c.orgId, tels, a.partes, now);
    } catch (e) { console.error('[erp-alertas]', c.orgId, (e as Error).message); }
  }
}

/**
 * Aviso ao(s) proprietário(s) por WhatsApp e e-mail em alterações sensíveis (ex.: custo de NF-e alterado com senha).
 * WhatsApp vai para o celular do proprietário (ou, sem ele, para os números de alerta do ERP). Nunca lança.
 */
export async function notificarProprietario(orgId: string, assunto: string, texto: string, anexos?: { filename: string; content: Buffer; contentType?: string }[]) {
  try {
    const { sendMail } = await import('../../lib/mailer.js');
    const donos = await prisma.membership.findMany({ where: { orgId, role: 'OWNER' }, select: { user: { select: { email: true, celular: true, phone: true } } } });
    const cfg = await prisma.erpConfig.findUnique({ where: { orgId }, select: { alertaTelefones: true } });
    const fones = [...new Set(donos.map((d) => d.user.celular || d.user.phone).filter((x): x is string => !!x))];
    for (const t of (fones.length ? fones : telefonesDe(cfg?.alertaTelefones)).slice(0, 5)) await sendToStaffNumber(orgId, null, t, `⚠️ ${assunto}\n${texto}`).catch(() => undefined);
    for (const d of donos) await sendMail({ to: d.user.email, subject: `MCK ERP · ${assunto}`, text: texto, kind: 'erp_aviso', attachments: anexos, html: `<p>${texto.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/\n/g, '<br>')}</p>` }).catch(() => false);
  } catch (e) { console.error('[erp] aviso ao proprietário falhou', e); }
}
