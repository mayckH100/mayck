/**
 * Aprovação de compra pelo WhatsApp (v1.30.0).
 *
 * O alerta diário lista os itens com estoque baixo numerados e com um código. Quando um número AUTORIZADO
 * (números do alerta do ERP ou celular do proprietário, conferidos no envio e de novo na resposta) responde
 * "APROVADO" (ou "APROVADO 1,3", "pode comprar", "ok aprovado"...), o sistema:
 *  - itens com fornecedor (do produto, da última compra ou do último lote): cria pedidos de compra em RASCUNHO,
 *    um por fornecedor (status inicial da compra.machine; quem envia/aprova continua sendo o ERP);
 *  - itens sem fornecedor: pergunta um a um "Tem preferência de fornecedor para X?"; aceita o nome de um fornecedor
 *    cadastrado (mostra opções se houver mais de um) ou NÃO → vão para uma solicitação de compra sem fornecedor;
 *  - confirma no WhatsApp com número, fornecedor, itens, quantidades, valor estimado e link do ERP.
 * Nunca envia nada ao fornecedor. Expira em 48 h. Idempotente (mensagem repetida/“aprovado” de novo não duplica).
 * A MCK IA só é usada como apoio para entender respostas livres, respeitando a cota; sem ela, palavras-chave.
 */
import { prisma } from '../../db.js';
import { normalize } from '../../flows/logic.js';
import { parseJson } from '../../lib/json.js';
import { appUrl } from '../../lib/mailer.js';
import { audit } from '../../lib/audit.js';
import { decryptOrNull } from '../../lib/crypto.js';
import { erpLiberado } from '../../billing/erpAccess.js';
import { samePhone, sendToStaffNumber } from '../../whatsapp/handoffNotify.js';
import { proximoNumero } from '../compras/compras.routes.js';
import { linhaCompra, temEmbalagem } from '../shared/embalagem.js';
import { brl, estimadoItem, qtdUn, nomeUnidade, unidadeLegivel, type ItemEstoqueBaixo } from './formato.js';

export const VALIDADE_MS = 48 * 3_600_000;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MSGS = 50;

export interface ItemAprovacao {
  n: number; produtoId: string; sku: string; nome: string; unidade: string; qtdMil: number;
  fornecedorId: string | null; fornecedorNome: string | null; custoUnitCents: number;
  /** v1.32.0: embalagem de compra, para mostrar "5 pacotes (50 peças)". Aprovações antigas não têm (= sem embalagem). */
  unidadeCompra?: string | null; fatorCompraMil?: number | null;
}
export interface ResumoPedido { tipo: 'pedido' | 'solicitacao'; id: string; numero: number; fornecedor: string | null; itens: number[]; totalCents: number }
export interface EstadoAprovacao {
  selecionados?: number[];
  pedidos?: ResumoPedido[];
  perguntas?: number[];
  atual?: number;
  escolhas?: Record<string, string | null>;
  opcoes?: { id: string; nome: string }[];
}

const digitos = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

export function gerarCodigo(rand: () => number = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALFABETO[Math.floor(rand() * ALFABETO.length) % ALFABETO.length];
  return s;
}

// ---------------- Entender a resposta (sem IA) ----------------
export type Interpretacao =
  | { acao: 'APROVAR'; itens: number[] | null; codigo: string | null }
  | { acao: 'RECUSAR'; codigo: string | null }
  | { acao: 'INVALIDO'; motivo: string; codigo: string | null };

const RE_APROVA = /\b(aprovad[oa]s?|aprovo|aprova|aprovar|aprovei|autorizad[oa]|autorizo|autoriza|pode comprar|pode pedir|pode fazer|pode gerar|pode mandar ver|pode seguir|confirmo|compra aprovada|ok aprovado|manda bala)\b/;
const RE_RECUSA = /\b(nao|n|nem) (aprovad|aprovo|aprova|autoriz|compr)|\b(recusad[oa]|reprovad[oa]|recuso|reprovo|cancela|cancelar|cancelado)\b/;

/**
 * Entende "APROVADO", "aprovado 1,3", "ok aprovado", "pode comprar 2 e 4", "Aprovado K7P2 1-3", "não aprovado".
 * `codigos` = códigos pendentes deste número (só eles são reconhecidos como código). null = não é sobre a aprovação.
 */
export function interpretarAprovacao(texto: string, nItens: number, codigos: string[] = []): Interpretacao | null {
  let t = normalize(texto).replace(/[*_~]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 300) return null;
  let codigo: string | null = null;
  for (const c of codigos) {
    const re = new RegExp(`\\b${c.toLowerCase()}\\b`);
    if (re.test(t)) { codigo = c; t = t.replace(re, ' ').replace(/\s+/g, ' ').trim(); break; }
  }
  if (RE_RECUSA.test(t)) return { acao: 'RECUSAR', codigo };
  if (!RE_APROVA.test(t)) return null;
  if (/\b(todos|todas|tudo)\b/.test(t) && !/\d/.test(t)) return { acao: 'APROVAR', itens: null, codigo };
  const resto = t.replace(/\b\d+\s*(h|hs|horas?|dias?)\b/g, ' ');
  const nums: number[] = [];
  for (const m of resto.matchAll(/(\d+)\s*(?:-|a|ate)\s*(\d+)|(\d+)/g)) {
    if (m[3]) nums.push(Number(m[3]));
    else { const a = Number(m[1]), b = Number(m[2]); if (b >= a && b - a < 100) for (let i = a; i <= b; i++) nums.push(i); else nums.push(a, b); }
  }
  if (!nums.length) return { acao: 'APROVAR', itens: null, codigo };
  const fora = nums.filter((n) => n < 1 || n > nItens);
  if (fora.length) return { acao: 'INVALIDO', motivo: `O item ${fora[0]} não está na lista (vai de 1 a ${nItens}). Responda, por exemplo, *APROVADO* ou *APROVADO 1,${Math.min(2, nItens)}*.`, codigo };
  return { acao: 'APROVAR', itens: [...new Set(nums)].sort((a, b) => a - b), codigo };
}

/** "não", "sem preferência", "tanto faz"... na pergunta do fornecedor. */
export const semPreferencia = (texto: string) => /^(nao|n|nenhum|nenhuma|sem preferencia|sem fornecedor|tanto faz|qualquer( um)?|pode ser qualquer( um)?|nao tenho( preferencia)?)\b/.test(normalize(texto).replace(/[.!*]/g, '').trim());

// ---------------- MCK IA como apoio ----------------
const RE_PODE_SER = /\b(sim|ok|pode|manda|fecha|fechado|compra|compre|comprar|pedido|beleza|blz|bora|autoriz|confirm|segue|faz|faca|quero|nao|cancel|libera|liberado)\b/;

/** Lê o JSON da IA. Exportada para teste. */
export function lerRespostaIa(raw: string, nItens: number): Interpretacao | null {
  const j = /\{[\s\S]*\}/.exec(raw ?? '')?.[0];
  if (!j) return null;
  try {
    const o = JSON.parse(j) as { acao?: string; itens?: unknown };
    if (o.acao === 'RECUSAR') return { acao: 'RECUSAR', codigo: null };
    if (o.acao !== 'APROVAR') return null;
    const itens = Array.isArray(o.itens) ? [...new Set(o.itens.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= nItens))].sort((a, b) => a - b) : [];
    return { acao: 'APROVAR', itens: itens.length ? itens : null, codigo: null };
  } catch { return null; }
}

/** Pergunta à IA da empresa (MCK IA ou a dela) se a resposta livre aprova a compra. Respeita a cota. Nunca lança. */
export async function interpretarComIa(orgId: string, texto: string, itens: Pick<ItemAprovacao, 'n' | 'nome'>[]): Promise<Interpretacao | null> {
  const t = normalize(texto);
  if (!t || t.length > 300 || !RE_PODE_SER.test(t)) return null;
  const started = Date.now();
  let ai: Awaited<ReturnType<typeof prisma.aiSettings.findUnique>> = null;
  try {
    ai = await prisma.aiSettings.findUnique({ where: { orgId } });
    if (!ai?.enabled) return null;
    if (ai.provider === 'mck') {
      const { mckQuotaStatus } = await import('../../ai/mckQuota.js');
      if ((await mckQuotaStatus(orgId)).reached) return null;
    }
    const { createProvider } = await import('../../ai/providers.js');
    const provider = createProvider(ai.provider, decryptOrNull(ai.apiKeyEnc), ai.baseUrl);
    const r = await provider.chat([
      { role: 'system', content: 'O dono de uma loja recebeu no WhatsApp uma lista numerada de produtos para comprar e respondeu. Diga se a resposta APROVA a compra (todos os itens ou só alguns números), RECUSA, ou é OUTRO assunto. Responda só JSON: {"acao":"APROVAR"|"RECUSAR"|"OUTRO","itens":[números] ou null}. Na dúvida, OUTRO.' },
      { role: 'user', content: `ITENS: ${itens.map((i) => `${i.n}) ${i.nome}`).join('; ').slice(0, 1500)}\nRESPOSTA: ${texto.slice(0, 300)}` },
    ], { model: ai.model, temperature: 0, maxTokens: 80, timeoutMs: 15000 });
    await prisma.aiUsage.create({ data: { orgId, provider: ai.provider, model: ai.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, latencyMs: Date.now() - started, success: true } }).catch(() => undefined);
    return lerRespostaIa(r.text, itens.length);
  } catch (e) {
    if (ai) await prisma.aiUsage.create({ data: { orgId, provider: ai.provider, model: ai.model, success: false, error: `ERP aprovação: ${(e as Error).message}`.slice(0, 500), latencyMs: Date.now() - started } }).catch(() => undefined);
    return null;
  }
}

// ---------------- Criação da aprovação (no envio do alerta) ----------------
/** Números que podem aprovar: os do alerta do ERP + celular do(s) proprietário(s). */
export async function telefonesAutorizados(orgId: string): Promise<string[]> {
  const [cfg, donos] = await Promise.all([
    prisma.erpConfig.findUnique({ where: { orgId }, select: { alertaTelefones: true } }),
    prisma.membership.findMany({ where: { orgId, role: 'OWNER', user: { disabledAt: null } }, select: { user: { select: { celular: true, phone: true } } } }),
  ]);
  const lista = [...(parseJson<string[] | null>(cfg?.alertaTelefones ?? null, null) ?? []), ...donos.map((d) => d.user.celular || d.user.phone)];
  const out: string[] = [];
  for (const t of lista) if (t && digitos(t).length >= 10 && !out.some((x) => samePhone(x, t))) out.push(t);
  return out;
}

export function itensDaAprovacao(lista: ItemEstoqueBaixo[]): ItemAprovacao[] {
  return lista.map((i, k) => ({ n: k + 1, produtoId: i.produtoId, sku: i.sku, nome: i.nome, unidade: unidadeLegivel(i.unidade), qtdMil: i.sugestao.sugeridaMil, fornecedorId: i.fornecedorId, fornecedorNome: i.fornecedorNome, custoUnitCents: i.custoUnitCents, unidadeCompra: i.unidadeCompra ?? null, fatorCompraMil: i.fatorCompraMil ?? null }));
}

/** Cria a aprovação do alerta de hoje (substitui as pendentes anteriores) e devolve o código. */
export async function criarAprovacao(orgId: string, dia: string, itens: ItemEstoqueBaixo[], now = new Date()) {
  const telefones = await telefonesAutorizados(orgId);
  if (!telefones.length || !itens.length) return null;
  await prisma.erpAprovacaoCompra.updateMany({ where: { orgId, status: 'PENDENTE' }, data: { status: 'SUBSTITUIDA', versao: { increment: 1 } } });
  for (let i = 0; i < 6; i++) {
    try {
      return await prisma.erpAprovacaoCompra.create({ data: { orgId, codigo: gerarCodigo(), dia, itens: JSON.stringify(itensDaAprovacao(itens)), telefones: JSON.stringify(telefones), expiraEm: new Date(now.getTime() + VALIDADE_MS) } });
    } catch (e) { if ((e as { code?: string }).code !== 'P2002') throw e; }
  }
  return null;
}

// ---------------- Criação dos pedidos ----------------
type Aprov = NonNullable<Awaited<ReturnType<typeof prisma.erpAprovacaoCompra.findFirst>>>;

async function criarDocumentos(a: Aprov, itens: ItemAprovacao[], escolha: (i: ItemAprovacao) => string | null, quem: string): Promise<ResumoPedido[]> {
  const orgId = a.orgId;
  const prods = await prisma.erpProduto.findMany({ where: { orgId, id: { in: itens.map((i) => i.produtoId) }, tipo: { not: 'SERVICO' } }, select: { id: true, nome: true } });
  const P = new Map(prods.map((p) => [p.id, p.nome]));
  const validos = itens.filter((i) => P.has(i.produtoId) && i.qtdMil > 0);
  const fornIds = [...new Set(validos.map(escolha).filter((x): x is string => !!x))];
  const forns = await prisma.erpParceiro.findMany({ where: { orgId, id: { in: fornIds } }, select: { id: true, nome: true, fantasia: true } });
  const F = new Map(forns.map((f) => [f.id, f.fantasia || f.nome]));
  const grupos = new Map<string | null, ItemAprovacao[]>();
  for (const i of validos) { const f = escolha(i); const k = f && F.has(f) ? f : null; grupos.set(k, [...(grupos.get(k) ?? []), i]); }
  const obs = `Gerado pela aprovação no WhatsApp (alerta de ${a.dia.split('-').reverse().join('/')}, código ${a.codigo}) por ${quem}.`;
  const out = await prisma.$transaction(async (tx) => {
    const r: ResumoPedido[] = [];
    for (const [fornecedorId, its] of grupos) {
      if (fornecedorId) {
        const linhas = its.map((i) => ({ produtoId: i.produtoId, descricao: P.get(i.produtoId)!, qtdMil: i.qtdMil, precoUnitCents: i.custoUnitCents, totalCents: Math.round((i.qtdMil * i.custoUnitCents) / 1000), solicitacaoItemId: null }));
        const total = linhas.reduce((s, l) => s + l.totalCents, 0);
        const pc = await tx.erpPedidoCompra.create({ data: { orgId, numero: await proximoNumero(tx, orgId, 'proximoPedidoCompra'), parceiroId: fornecedorId, status: 'RASCUNHO', totalCents: total, observacoes: obs, itens: { create: linhas } } });
        r.push({ tipo: 'pedido', id: pc.id, numero: pc.numero, fornecedor: F.get(fornecedorId)!, itens: its.map((i) => i.n), totalCents: total });
      } else {
        const s = await tx.erpSolicitacaoCompra.create({ data: { orgId, numero: await proximoNumero(tx, orgId, 'proximaSolicitacao'), origem: 'WHATSAPP', status: 'RASCUNHO', justificativa: `${obs} Sem fornecedor definido: cotar.`, itens: { create: its.map((i) => ({ produtoId: i.produtoId, qtdMil: i.qtdMil })) } } });
        r.push({ tipo: 'solicitacao', id: s.id, numero: s.numero, fornecedor: null, itens: its.map((i) => i.n), totalCents: its.reduce((x, i) => x + estimadoItem({ sugestao: { sugeridaMil: i.qtdMil } as any, custoUnitCents: i.custoUnitCents }), 0) });
      }
    }
    return r;
  });
  for (const d of out) {
    await audit(null, d.tipo === 'pedido' ? 'erp.pedido_compra.criar' : 'erp.solicitacao_compra.criar', { orgId, entity: d.tipo === 'pedido' ? 'erp_pedido_compra' : 'erp_solicitacao_compra', entityId: d.id, meta: { antes: null, depois: { numero: d.numero, totalCents: d.totalCents, origem: 'aprovação pelo WhatsApp', codigo: a.codigo, telefone: quem } } }).catch(() => undefined);
  }
  return out;
}

export function textoConfirmacao(codigo: string, docs: ResumoPedido[], itens: ItemAprovacao[], link = `${appUrl()}/erp/compras`) {
  const I = new Map(itens.map((i) => [i.n, i]));
  const L: string[] = [`✅ *Compra aprovada* · código ${codigo}`];
  for (const d of docs) {
    L.push('', d.tipo === 'pedido' ? `📄 *Pedido de compra nº ${d.numero}* — ${d.fornecedor}` : `📝 *Solicitação de compra nº ${d.numero}* — sem fornecedor (para cotar)`);
    for (const n of d.itens) {
      const i = I.get(n); if (!i) continue;
      const emb = { unidade: i.unidade, unidadeCompra: i.unidadeCompra, fatorCompraMil: i.fatorCompraMil };
      const lc = linhaCompra(i.qtdMil, i.custoUnitCents, emb);
      const preco = temEmbalagem(emb) ? `   💲 Preço: *${lc.precoEmbalagem!.replace('/', ' por ')}* · ${lc.precoBase!.replace('/', ' por ')}` : `   💲 Preço por ${nomeUnidade(i.unidade, 1)}: *${brl(i.custoUnitCents)}*`;
      L.push(`*${n}) ${i.nome}*${i.sku ? ` (cód. ${i.sku})` : ''}`, `   🛒 Quantidade: ${lc.quantidade}`,
        ...(i.custoUnitCents ? [preco, `   💰 Total: *${brl(lc.totalCents)}*`] : ['   💲 Sem preço de referência: informe no ERP antes de enviar']));
    }
    if (d.totalCents) L.push(`Total deste pedido: *${brl(d.totalCents)}*`);
  }
  const total = docs.reduce((s, d) => s + d.totalCents, 0);
  if (docs.length > 1 && total) L.push('', `Total de tudo: *${brl(total)}*`);
  L.push('', 'O pedido ficou como *rascunho* no ERP: confira e envie por lá. Nada foi enviado ao fornecedor.', `🔗 ${link}`);
  return L.join('\n');
}

const perguntaFornecedor = (i: ItemAprovacao) => `🤔 De qual fornecedor quer comprar *${i.nome}*${i.sku ? ` (cód. ${i.sku})` : ''}?\n🛒 Quantidade: ${qtdUn(i.qtdMil, i.unidade)}\nResponda com o *nome* do fornecedor, ou *NÃO* para seguir sem fornecedor (vira uma solicitação para cotar).`;

/** Fornecedores cadastrados que casam com o nome digitado (todas as palavras). Exato vence. */
export function casarFornecedor<T extends { id: string; nome: string; fantasia: string | null }>(lista: T[], texto: string): T[] {
  const q = normalize(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return [];
  const exato = lista.filter((f) => normalize(f.nome) === q || (f.fantasia && normalize(f.fantasia) === q));
  if (exato.length) return exato;
  const palavras = q.split(' ');
  return lista.filter((f) => { const alvo = normalize(`${f.nome} ${f.fantasia ?? ''}`).replace(/[^a-z0-9 ]/g, ' '); return palavras.every((p) => alvo.includes(p)); });
}

// ---------------- Resposta pelo WhatsApp ----------------
export interface MensagemEntrada { waMessageId: string; from: string; text: string; type: string }

async function autorizadoAgora(orgId: string, from: string) {
  return (await telefonesAutorizados(orgId)).some((t) => samePhone(t, from));
}

/**
 * Trata a resposta de um número autorizado com aprovação pendente. Devolve true quando a mensagem foi tratada aqui
 * (não segue para contato/SDR/IA/fluxos); false quando não tem nada a ver (segue o caminho normal).
 */
export async function tratarRespostaAprovacao(channel: { id: string; orgId: string }, m: MensagemEntrada, now = new Date()): Promise<boolean> {
  if (m.type !== 'text' || !m.text?.trim() || m.from.includes('@')) return false;
  const orgId = channel.orgId;
  const recentes = await prisma.erpAprovacaoCompra.findMany({ where: { orgId, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) }, status: { in: ['PENDENTE', 'AGUARDANDO_FORNECEDOR', 'PROCESSANDO', 'CONCLUIDA', 'EXPIRADA', 'SUBSTITUIDA', 'RECUSADA'] } }, orderBy: { createdAt: 'desc' }, take: 10 });
  const doNumero = recentes.filter((a) => parseJson<string[]>(a.telefones, []).some((t) => samePhone(t, m.from)));
  if (!doNumero.length) return false;
  if (doNumero.some((a) => parseJson<string[]>(a.mensagens, []).includes(m.waMessageId))) return true; // reenvio da mesma mensagem
  const ativas = doNumero.filter((a) => a.expiraEm > now);
  const responder = (texto: string) => sendToStaffNumber(orgId, channel.id, `+${digitos(m.from)}`, texto);

  // 1) Conversa da pergunta de fornecedor em andamento: qualquer texto é a resposta.
  const aguardando = ativas.find((a) => a.status === 'AGUARDANDO_FORNECEDOR');
  if (aguardando) {
    if (!(await autorizadoAgora(orgId, m.from))) return false;
    await responderFornecedor(aguardando, m, responder, now);
    return true;
  }

  const pendentes = ativas.filter((a) => a.status === 'PENDENTE');
  const codigos = doNumero.map((a) => a.codigo);
  const maxItens = Math.max(1, ...doNumero.map((a) => parseJson<ItemAprovacao[]>(a.itens, []).length));
  let it = interpretarAprovacao(m.text, maxItens, codigos);
  const alvoPorCodigo = it?.codigo ? doNumero.find((a) => a.codigo === it!.codigo) : undefined;
  const alvo = alvoPorCodigo ?? pendentes[0];

  if (!it && alvo && alvo.status === 'PENDENTE' && alvo.expiraEm > now) {
    const itens = parseJson<ItemAprovacao[]>(alvo.itens, []);
    it = await interpretarComIa(orgId, m.text, itens);
  }
  if (!it) return false; // não é sobre a aprovação: segue o caminho normal

  if (!(await autorizadoAgora(orgId, m.from))) return false;
  const marcar = (a: Aprov) => JSON.stringify([...parseJson<string[]>(a.mensagens, []), m.waMessageId].slice(-MAX_MSGS));

  // Referência: a do código citado, a pendente ativa ou, sem elas, a mais recente deste número.
  const ref = alvo ?? doNumero[0];
  const vencida = ref.expiraEm <= now || ['EXPIRADA', 'SUBSTITUIDA'].includes(ref.status);
  // Recusa / item inválido: só com aprovação pendente e dentro do prazo.
  if (it.acao !== 'APROVAR' && (ref.status !== 'PENDENTE' || vencida)) return false;

  // Já aprovada (ou em andamento): não cria de novo.
  if (['CONCLUIDA', 'PROCESSANDO'].includes(ref.status)) {
    const docs = parseJson<EstadoAprovacao>(ref.estado, {}).pedidos ?? [];
    await prisma.erpAprovacaoCompra.updateMany({ where: { id: ref.id }, data: { mensagens: marcar(ref) } });
    await responder(ref.status === 'PROCESSANDO' ? `⏳ A compra do código ${ref.codigo} já está sendo gerada.` : `ℹ️ A compra do código ${ref.codigo} já foi aprovada${docs.length ? `: ${docs.map((d) => `${d.tipo === 'pedido' ? 'pedido' : 'solicitação'} nº ${d.numero}`).join(', ')}` : ''}. Nada foi criado de novo.\n🔗 ${appUrl()}/erp/compras`);
    return true;
  }
  if (ref.status === 'RECUSADA') {
    await responder(`ℹ️ A compra do código ${ref.codigo} foi recusada antes. Os itens voltam no próximo alerta, ou faça o pedido em ERP › Compras.`);
    return true;
  }
  if (vencida) {
    if (ref.status === 'PENDENTE') await prisma.erpAprovacaoCompra.updateMany({ where: { id: ref.id, status: 'PENDENTE' }, data: { status: 'EXPIRADA', versao: { increment: 1 } } });
    await responder(ref.status === 'SUBSTITUIDA'
      ? `ℹ️ O código ${ref.codigo} foi trocado pelo do alerta mais novo. Responda *APROVADO* ao último alerta.`
      : `⌛ O código ${ref.codigo} venceu (vale 48 h). Os itens voltam no próximo alerta, ou faça o pedido em ERP › Compras.`);
    return true;
  }
  if (ref.status !== 'PENDENTE' || !alvo) return false;

  const itens = parseJson<ItemAprovacao[]>(alvo.itens, []);
  if (it.acao === 'INVALIDO') { await responder(`⚠️ ${it.motivo}`); return true; }
  if (it.acao === 'RECUSAR') {
    const ok = await prisma.erpAprovacaoCompra.updateMany({ where: { id: alvo.id, versao: alvo.versao, status: 'PENDENTE' }, data: { status: 'RECUSADA', mensagens: marcar(alvo), aprovadoPor: `+${digitos(m.from)}`, aprovadoEm: now, versao: { increment: 1 } } });
    if (ok.count) await responder(`👍 Certo, a compra do código ${alvo.codigo} não foi aprovada. Nenhum pedido foi criado.`);
    return true;
  }
  // APROVAR
  const sel = (it.itens ?? itens.map((i) => i.n)).filter((n) => itens.some((i) => i.n === n));
  if (!sel.length) { await responder('⚠️ Não encontrei esses itens na lista. Responda *APROVADO* para todos ou *APROVADO 1,2* para alguns.'); return true; }
  const claim = await prisma.erpAprovacaoCompra.updateMany({ where: { id: alvo.id, versao: alvo.versao, status: 'PENDENTE' }, data: { status: 'PROCESSANDO', mensagens: marcar(alvo), aprovadoPor: `+${digitos(m.from)}`, aprovadoEm: now, versao: { increment: 1 } } });
  if (!claim.count) return true; // outra mensagem/instância já está tratando
  const quem = `+${digitos(m.from)}`;
  try {
    if (!(await erpLiberado(orgId, now))) {
      await prisma.erpAprovacaoCompra.update({ where: { id: alvo.id }, data: { status: 'PENDENTE', versao: { increment: 1 } } });
      await responder('⚠️ O MCK ERP não está liberado no plano desta empresa: nenhum pedido foi criado.');
      return true;
    }
    const escolhidos = itens.filter((i) => sel.includes(i.n));
    const comForn = escolhidos.filter((i) => i.fornecedorId);
    const semForn = escolhidos.filter((i) => !i.fornecedorId);
    const docs = comForn.length ? await criarDocumentos(alvo, comForn, (i) => i.fornecedorId, quem) : [];
    // Fornecedor apagado depois do alerta: o item vai para a pergunta.
    const criados = new Set(docs.filter((d) => d.tipo === 'pedido').flatMap((d) => d.itens));
    const perguntar = [...comForn.filter((i) => !criados.has(i.n) && !docs.some((d) => d.itens.includes(i.n))), ...semForn].map((i) => i.n);
    const estado: EstadoAprovacao = { selecionados: sel, pedidos: docs, perguntas: perguntar, atual: 0, escolhas: {} };
    await prisma.erpAprovacaoCompra.update({ where: { id: alvo.id }, data: { status: perguntar.length ? 'AGUARDANDO_FORNECEDOR' : 'CONCLUIDA', estado: JSON.stringify(estado), versao: { increment: 1 } } });
    const partes: string[] = [];
    if (docs.length) partes.push(textoConfirmacao(alvo.codigo, docs, itens));
    if (perguntar.length) {
      partes.push(`${docs.length ? '' : `✅ Aprovado (código ${alvo.codigo}). `}${perguntar.length === 1 ? 'Falta 1 item' : `Faltam ${perguntar.length} itens`} sem fornecedor cadastrado.\n\n${perguntaFornecedor(itens.find((i) => i.n === perguntar[0])!)}`);
    }
    for (const p of partes) await responder(p);
  } catch (e) {
    console.error('[erp-aprovacao]', orgId, (e as Error).message);
    await prisma.erpAprovacaoCompra.update({ where: { id: alvo.id }, data: { status: 'PENDENTE', versao: { increment: 1 } } }).catch(() => undefined);
    await responder('⚠️ Não consegui gerar o pedido agora. Tente responder *APROVADO* de novo em alguns minutos ou faça em ERP › Compras.');
  }
  return true;
}

async function responderFornecedor(a: Aprov, m: MensagemEntrada, responder: (t: string) => Promise<unknown>, now: Date) {
  const orgId = a.orgId;
  const itens = parseJson<ItemAprovacao[]>(a.itens, []);
  const est = parseJson<EstadoAprovacao>(a.estado, {});
  const perguntas = est.perguntas ?? [];
  const atual = est.atual ?? 0;
  const item = itens.find((i) => i.n === perguntas[atual]);
  const mensagens = JSON.stringify([...parseJson<string[]>(a.mensagens, []), m.waMessageId].slice(-MAX_MSGS));
  const gravar = (data: Record<string, unknown>) => prisma.erpAprovacaoCompra.updateMany({ where: { id: a.id, versao: a.versao, status: 'AGUARDANDO_FORNECEDOR' }, data: { ...data, mensagens, versao: { increment: 1 } } }).then((r) => r.count === 1);
  if (!item) { await gravar({ status: 'CONCLUIDA' }); return; }

  const t = m.text.trim();
  let escolha: string | null | undefined; // undefined = ainda não decidiu
  let opcoes: EstadoAprovacao['opcoes'];
  let aviso = '';
  const n = /^\s*(\d{1,2})\s*$/.exec(t);
  if (est.opcoes?.length && n && Number(n[1]) >= 1 && Number(n[1]) <= est.opcoes.length) escolha = est.opcoes[Number(n[1]) - 1].id;
  else if (semPreferencia(t)) escolha = null;
  else if (/^(cancela|cancelar|parar|pare)\b/.test(normalize(t))) {
    if (!(await gravar({ status: 'CONCLUIDA' }))) return;
    await responder(`👍 Ok, parei aqui. ${perguntas.length - atual === 1 ? 'O item que faltava não foi pedido' : `Os ${perguntas.length - atual} itens que faltavam não foram pedidos`}; dá para incluir em ERP › Compras.`);
    return;
  } else {
    const forns = await prisma.erpParceiro.findMany({ where: { orgId, ehFornecedor: true }, select: { id: true, nome: true, fantasia: true }, take: 2000 });
    const achados = casarFornecedor(forns, t);
    if (achados.length === 1) escolha = achados[0].id;
    else if (achados.length > 1) {
      opcoes = achados.slice(0, 5).map((f) => ({ id: f.id, nome: f.fantasia || f.nome }));
      aviso = `Achei ${achados.length} fornecedores com "${t.slice(0, 40)}":\n${opcoes.map((o, i) => `${i + 1}) ${o.nome}`).join('\n')}\nResponda com o *número*${achados.length > 5 ? ', mais do nome' : ''} ou *NÃO*.`;
    } else aviso = `Não achei fornecedor cadastrado com "${t.slice(0, 40)}". Responda com outro nome (como está no ERP) ou *NÃO* para seguir sem fornecedor.`;
  }

  if (escolha === undefined) {
    if (await gravar({ estado: JSON.stringify({ ...est, opcoes: opcoes ?? est.opcoes }) })) await responder(aviso);
    return;
  }
  const escolhas = { ...(est.escolhas ?? {}), [String(item.n)]: escolha };
  const prox = atual + 1;
  if (prox < perguntas.length) {
    if (!(await gravar({ estado: JSON.stringify({ ...est, escolhas, atual: prox, opcoes: [] }) }))) return;
    await responder(perguntaFornecedor(itens.find((i) => i.n === perguntas[prox])!));
    return;
  }
  // Última resposta: cria os pedidos/solicitação dos itens perguntados.
  if (!(await gravar({ status: 'PROCESSANDO', estado: JSON.stringify({ ...est, escolhas, atual: prox, opcoes: [] }) }))) return;
  try {
    const its = itens.filter((i) => perguntas.includes(i.n));
    const docs = await criarDocumentos(a, its, (i) => escolhas[String(i.n)] ?? null, a.aprovadoPor ?? `+${digitos(m.from)}`);
    const todos = [...(est.pedidos ?? []), ...docs];
    await prisma.erpAprovacaoCompra.update({ where: { id: a.id }, data: { status: 'CONCLUIDA', estado: JSON.stringify({ ...est, escolhas, atual: prox, opcoes: [], pedidos: todos }), versao: { increment: 1 } } });
    await responder(textoConfirmacao(a.codigo, docs, itens));
  } catch (e) {
    console.error('[erp-aprovacao]', orgId, (e as Error).message);
    await prisma.erpAprovacaoCompra.update({ where: { id: a.id }, data: { status: 'AGUARDANDO_FORNECEDOR', estado: JSON.stringify({ ...est, escolhas: est.escolhas ?? {}, atual }), versao: { increment: 1 } } }).catch(() => undefined);
    await responder('⚠️ Não consegui gerar o pedido agora. Responda de novo em alguns minutos.');
  }
  void now;
}

/** Marca como EXPIRADA o que passou de 48 h (limpeza do agendador). */
export async function expirarAprovacoes(now = new Date()) {
  await prisma.erpAprovacaoCompra.updateMany({ where: { status: { in: ['PENDENTE', 'AGUARDANDO_FORNECEDOR'] }, expiraEm: { lte: now } }, data: { status: 'EXPIRADA', versao: { increment: 1 } } });
}
