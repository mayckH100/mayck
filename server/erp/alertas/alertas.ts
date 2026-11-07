/**
 * Alertas diários do MCK ERP por WhatsApp para a administração (números escolhidos em ERP › Alertas):
 * contas a pagar vencidas e a vencer (fornecedores e contas da empresa separadas), produtos abaixo do estoque mínimo
 * e produtos com saldo sem saída há N dias. Um envio por dia, a partir da hora escolhida (fuso da organização).
 */
import { prisma } from '../../db.js';
import { planoCompletoAtivo } from '../../billing/service.js';
import { parseJson } from '../../lib/json.js';
import { sendToStaffNumber, type NotifyResult } from '../../whatsapp/handoffNotify.js';

const DIA = 86_400_000;
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const qtd = (mil: number) => (mil / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const ddmm = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
export const NOME_NATUREZA: Record<string, string> = { AGUA: 'Água', LUZ: 'Luz', INTERNET: 'Internet', TELEFONE: 'Telefone', ALUGUEL: 'Aluguel', IMPOSTO: 'Imposto', OUTRA_CONTA: 'Conta' };
const MAX_LINHAS = 15;

/** Data (AAAA-MM-DD) e hora locais no fuso da organização. */
export function agoraLocal(tz: string, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24 };
}

export interface ConfigAlerta { alertaDiasAntes: number; alertaPagar: boolean; alertaEstoqueMinimo: boolean; alertaSemSaidaDias: number }

/** Monta o texto do alerta. Retorna null quando não há nada para avisar. */
export async function montarAlerta(orgId: string, cfg: ConfigAlerta, hojeIso: string, now = new Date()): Promise<{ texto: string; itens: number } | null> {
  const blocos: string[] = [];
  let itens = 0;
  const hoje = new Date(`${hojeIso}T00:00:00Z`);

  if (cfg.alertaPagar) {
    const ate = new Date(hoje.getTime() + (cfg.alertaDiasAntes + 1) * DIA - 1);
    const ts = await prisma.erpTitulo.findMany({ where: { orgId, tipo: 'PAGAR', status: { in: ['EM_ABERTO', 'PARCIAL'] }, vencimento: { lte: ate } }, orderBy: { vencimento: 'asc' }, take: 200 });
    if (ts.length) {
      const ps = await prisma.erpParceiro.findMany({ where: { orgId, id: { in: ts.map((t) => t.parceiroId).filter(Boolean) as string[] } }, select: { id: true, nome: true, fantasia: true } });
      const P = new Map(ps.map((p) => [p.id, p.fantasia || p.nome]));
      const linha = (t: (typeof ts)[number]) => {
        const v = t.vencimento < hoje ? `VENCIDA ${ddmm(t.vencimento)}` : t.vencimento.getTime() < hoje.getTime() + DIA ? 'vence HOJE' : `vence ${ddmm(t.vencimento)}`;
        const quem = t.natureza && t.natureza !== 'FORNECEDOR' ? NOME_NATUREZA[t.natureza] ?? 'Conta' : (t.parceiroId ? P.get(t.parceiroId) : null) ?? 'Fornecedor';
        return `• ${quem}: ${t.descricao} — ${brl(t.valorCents - t.pagoCents)} (${v})`;
      };
      const forn = ts.filter((t) => !t.natureza || t.natureza === 'FORNECEDOR');
      const contas = ts.filter((t) => t.natureza && t.natureza !== 'FORNECEDOR');
      const total = (l: typeof ts) => brl(l.reduce((s, t) => s + t.valorCents - t.pagoCents, 0));
      if (forn.length) blocos.push([`*Fornecedores a pagar* (${forn.length}, ${total(forn)})`, ...forn.slice(0, MAX_LINHAS).map(linha), ...(forn.length > MAX_LINHAS ? [`… e mais ${forn.length - MAX_LINHAS}`] : [])].join('\n'));
      if (contas.length) blocos.push([`*Contas da empresa* (${contas.length}, ${total(contas)})`, ...contas.slice(0, MAX_LINHAS).map(linha), ...(contas.length > MAX_LINHAS ? [`… e mais ${contas.length - MAX_LINHAS}`] : [])].join('\n'));
      itens += ts.length;
    }
  }

  const precisaEstoque = cfg.alertaEstoqueMinimo || cfg.alertaSemSaidaDias > 0;
  if (precisaEstoque) {
    const produtos = await prisma.erpProduto.findMany({ where: { orgId, ativo: true, tipo: { not: 'SERVICO' } }, select: { id: true, sku: true, nome: true, unidade: true, estoqueMinimoMil: true, createdAt: true } });
    const saldos = await prisma.erpSaldo.groupBy({ by: ['produtoId'], where: { orgId }, _sum: { fisicoMil: true } });
    const fis = new Map(saldos.map((s) => [s.produtoId, s._sum.fisicoMil ?? 0]));
    if (cfg.alertaEstoqueMinimo) {
      const abaixo = produtos.filter((p) => p.estoqueMinimoMil > 0 && (fis.get(p.id) ?? 0) < p.estoqueMinimoMil);
      if (abaixo.length) {
        blocos.push([`*Abaixo do estoque mínimo* (${abaixo.length})`, ...abaixo.slice(0, MAX_LINHAS).map((p) => `• ${p.sku} ${p.nome}: ${qtd(fis.get(p.id) ?? 0)} ${p.unidade} (mínimo ${qtd(p.estoqueMinimoMil)})`), ...(abaixo.length > MAX_LINHAS ? [`… e mais ${abaixo.length - MAX_LINHAS}`] : [])].join('\n'));
        itens += abaixo.length;
      }
    }
    if (cfg.alertaSemSaidaDias > 0) {
      const desde = new Date(now.getTime() - cfg.alertaSemSaidaDias * DIA);
      const comSaldo = produtos.filter((p) => (fis.get(p.id) ?? 0) > 0 && p.createdAt < desde);
      if (comSaldo.length) {
        const ult = await prisma.erpMovimento.groupBy({ by: ['produtoId'], where: { orgId, produtoId: { in: comSaldo.map((p) => p.id) }, tipo: 'SAIDA' }, _max: { createdAt: true } });
        const U = new Map(ult.map((u) => [u.produtoId, u._max.createdAt]));
        const parados = comSaldo.filter((p) => { const u = U.get(p.id); return !u || u < desde; });
        if (parados.length) {
          blocos.push([`*Sem saída há ${cfg.alertaSemSaidaDias} dias ou mais* (${parados.length})`, ...parados.slice(0, MAX_LINHAS).map((p) => { const u = U.get(p.id); return `• ${p.sku} ${p.nome}: ${qtd(fis.get(p.id) ?? 0)} ${p.unidade} em estoque${u ? `, última saída ${ddmm(u)}` : ', nunca saiu'}`; }), ...(parados.length > MAX_LINHAS ? [`… e mais ${parados.length - MAX_LINHAS}`] : [])].join('\n'));
          itens += parados.length;
        }
      }
    }
  }

  if (!blocos.length) return null;
  const [a, m, d] = hojeIso.split('-');
  return { texto: [`*MCK ERP · alertas de ${d}/${m}/${a}*`, ...blocos].join('\n\n'), itens };
}

export const telefonesDe = (raw: string | null | undefined) => parseJson<string[] | null>(raw ?? null, null)?.filter((p) => typeof p === 'string' && p.trim()) ?? [];

/** Envia o texto para os números configurados e grava o status. Nunca lança. */
export async function enviarAlerta(orgId: string, telefones: string[], texto: string, now = new Date()) {
  const results: NotifyResult[] = [];
  for (const t of telefones.slice(0, 5)) results.push(await sendToStaffNumber(orgId, null, t, texto));
  const ok = results.some((r) => r.ok);
  const detail = results.map((r) => (r.ok ? `${r.phone}: enviado` : `${r.phone}: ${r.error}`)).join('; ').slice(0, 500);
  await prisma.erpConfig.update({ where: { orgId }, data: { alertaStatus: JSON.stringify({ at: now.toISOString(), ok, detail }) } }).catch(() => undefined);
  return { ok, results, detail };
}

/** Tick do agendador: para cada empresa com alerta ligado, envia uma vez por dia depois da hora escolhida. */
export async function tickAlertasErp(now = new Date()) {
  const cfgs = await prisma.erpConfig.findMany({ where: { alertaAtivo: true } });
  for (const c of cfgs) {
    const tels = telefonesDe(c.alertaTelefones);
    if (!tels.length) continue;
    const org = await prisma.organization.findUnique({ where: { id: c.orgId }, select: { timezone: true } });
    const { dia, hora } = agoraLocal(org?.timezone || 'America/Sao_Paulo', now);
    if (hora < c.alertaHora || c.alertaUltimoDia === dia) continue;
    if (!(await planoCompletoAtivo(c.orgId, now))) continue; // ERP só no Plano Completo: sem ele, não envia (e não gasta o dia)
    // Reserva o dia de forma atômica (evita envio duplicado com mais de uma instância).
    const claim = await prisma.erpConfig.updateMany({ where: { orgId: c.orgId, alertaAtivo: true, OR: [{ alertaUltimoDia: null }, { alertaUltimoDia: { not: dia } }] }, data: { alertaUltimoDia: dia } });
    if (!claim.count) continue;
    try {
      const a = await montarAlerta(c.orgId, c, dia, now);
      if (a) await enviarAlerta(c.orgId, tels, a.texto, now);
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
