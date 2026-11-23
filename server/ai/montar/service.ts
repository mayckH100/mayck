/**
 * v1.46.0 — "Monte sua IA conversando" (acesso ao banco, à web e à IA).
 * Fluxo: o dono manda link/texto/PDF/áudio → a IA da empresa (ou a MCK IA, respeitando a cota) extrai os dados →
 * prévia editável → "Aplicar" grava base de conhecimento, instruções, fluxo inicial e horário. Nada é gravado antes.
 */
import type { AiSettings } from '@prisma/client';
import { prisma } from '../../db.js';
import { HttpError } from '../../lib/http.js';
import { safeFetch } from '../../lib/ssrf.js';
import { audit } from '../../lib/audit.js';
import { aiChat, type AiChatSettings } from '../core.js';
import { mckIaReady, MCK_IA_MODEL } from '../mckIa.js';
import { mckQuotaStatus, MCK_QUOTA_REASON } from '../mckQuota.js';
import { iaDoAssistente } from '../../inbox/assistente.js';
import { reindexDoc } from '../service.js';
import { transcribeAudio } from '../voice/service.js';
import { textoDoPdf } from '../../mckmensagem/automacoes/comprovantes.js';
import { validateGraph } from '../../flows/logic.js';
import { normalizeGraph } from '../../flows/handles.js';
import {
  SISTEMA_EXTRACAO, NOME_FLUXO, PREFIXO_DOC, blocoInstrucoes, documentos, fluxoInicial, lerJson, mensagemFontes, mesclarInstrucoes,
  normalizarLink, normalizarProposta, propostaVazia, textoDoHtml, textoForaHorario, type Fonte, type Proposta,
} from './core.js';

export class MontarErro extends HttpError {
  constructor(msg: string) { super(400, msg); }
}

export type IaMontar = { ok: true; settings: AiChatSettings; modo: 'empresa' | 'mck' } | { ok: false; motivo: string };

/** Qual IA monta: a da empresa (se configurada e com limite) ou a MCK IA (se a empresa ainda não tem IA e há cota). */
export async function iaDoMontar(orgId: string): Promise<IaMontar> {
  const propria = await iaDoAssistente(orgId);
  if (propria.ok) return { ok: true, settings: propria.ai, modo: propria.ai.provider === 'mck' ? 'mck' : 'empresa' };
  if (propria.motivo === MCK_QUOTA_REASON) return { ok: false, motivo: propria.motivo };
  const atual = await prisma.aiSettings.findUnique({ where: { orgId } });
  const temChave = !!atual?.apiKeyEnc || atual?.provider === 'fake';
  if (!temChave && mckIaReady()) {
    if ((await mckQuotaStatus(orgId)).reached) return { ok: false, motivo: MCK_QUOTA_REASON };
    return { ok: true, settings: { provider: 'mck', model: MCK_IA_MODEL }, modo: 'mck' };
  }
  return { ok: false, motivo: propria.motivo };
}

const LIMITE_HTML = 2_000_000;

/** Baixa a página (só endereços públicos) e devolve o texto. */
export async function lerLink(raw: string): Promise<{ url: string; texto: string }> {
  const url = normalizarLink(raw);
  if (!url) throw new MontarErro('Link inválido. Cole o endereço do site (ex.: www.minhaloja.com.br) ou o @ do Instagram.');
  let html = '';
  try {
    const res = await safeFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; MCKBOT/1.0; +https://mckbot.onrender.com)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'pt-BR,pt;q=0.9' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const tipo = res.headers.get('content-type') ?? '';
    if (tipo && !/html|text|xml/i.test(tipo)) throw new Error('não é página');
    const buf = Buffer.from(await res.arrayBuffer());
    html = buf.subarray(0, LIMITE_HTML).toString('utf8');
  } catch {
    throw new MontarErro('Não consegui abrir esse link. Confira o endereço ou cole o texto do site no campo de texto.');
  }
  const texto = /<[a-z!]/i.test(html) ? textoDoHtml(html) : html.slice(0, 30000).trim();
  if (texto.replace(/\s/g, '').length < 40) {
    const insta = /instagram\.com/i.test(url);
    throw new MontarErro(insta
      ? 'O Instagram não mostra o perfil sem login. Copie a bio e as informações dos destaques (preços, horários) e cole no campo de texto.'
      : 'Essa página quase não tem texto para ler. Cole as informações no campo de texto ou envie o PDF de preços.');
  }
  return { url, texto };
}

export const MAX_ARQUIVO_BYTES = 8 * 1024 * 1024;
const AUDIO = /^audio\/|\.(ogg|opus|mp3|m4a|wav|webm|aac)$/i;

/** Texto de um arquivo enviado: PDF, texto/CSV ou áudio (transcrição com o motor da empresa ou da MCK IA). */
export async function lerArquivo(orgId: string, buf: Buffer, nome: string, mime: string): Promise<{ tipo: 'arquivo' | 'audio'; texto: string }> {
  if (!buf.length) throw new MontarErro('Arquivo vazio.');
  if (buf.length > MAX_ARQUIVO_BYTES) throw new MontarErro('Arquivo maior que 8 MB.');
  const n = nome.toLowerCase();
  if (mime === 'application/pdf' || n.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    const texto = textoDoPdf(buf);
    if (texto.replace(/\s/g, '').length < 20) throw new MontarErro('Não consegui ler o texto desse PDF (pode ser uma foto ou digitalização). Copie os preços e cole no campo de texto.');
    return { tipo: 'arquivo', texto };
  }
  if (/^text\/|csv|json/.test(mime) || /\.(txt|csv|md)$/.test(n)) {
    const texto = buf.toString('utf8').replace(/\u0000/g, '').trim().slice(0, 30000);
    if (!texto) throw new MontarErro('Arquivo sem texto.');
    return { tipo: 'arquivo', texto };
  }
  if (AUDIO.test(mime) || AUDIO.test(n)) {
    const ia = await iaDoMontar(orgId);
    if (!ia.ok) throw new MontarErro(ia.motivo);
    const atual = await prisma.aiSettings.findUnique({ where: { orgId } });
    // A transcrição respeita as mesmas cotas; para quem ainda não tem IA própria, usa a MCK IA.
    const override = { ...(atual ?? {}), orgId, enabled: true, transcribeAudio: true, transcribeMaxSeconds: 300, ...(ia.modo === 'mck' && atual?.provider !== 'mck' ? { provider: 'mck', model: MCK_IA_MODEL, apiKeyEnc: null, transcribeProvider: 'auto' } : {}) } as AiSettings;
    const r = await transcribeAudio({ orgId, conversationId: null, audio: buf, mime: mime || 'audio/ogg', settings: override });
    if (!r.ok) throw new MontarErro(r.code === 'longo' ? 'Áudio com mais de 5 minutos. Mande um áudio menor ou escreva no campo de texto.' : `Não consegui transcrever o áudio (${r.reason}). Escreva no campo de texto.`);
    return { tipo: 'audio', texto: r.text };
  }
  throw new MontarErro('Tipo de arquivo não aceito. Envie PDF, TXT/CSV ou áudio.');
}

export interface EntradaGerar { link?: string | null; texto?: string | null; arquivos?: { nome: string; tipo: 'arquivo' | 'audio'; texto: string }[] }

/** Monta a prévia (não grava nada). */
export async function gerarProposta(orgId: string, e: EntradaGerar): Promise<{ proposta: Proposta; fontes: string[]; modo: 'empresa' | 'mck' }> {
  const ia = await iaDoMontar(orgId);
  if (!ia.ok) throw new MontarErro(ia.motivo);
  const fontes: Fonte[] = [];
  if (e.link?.trim()) {
    const l = await lerLink(e.link);
    fontes.push({ tipo: 'link', nome: l.url, texto: l.texto });
  }
  if (e.texto?.trim()) fontes.push({ tipo: 'texto', nome: '', texto: e.texto.trim().slice(0, 20000) });
  for (const a of (e.arquivos ?? []).slice(0, 5)) if (a.texto?.trim()) fontes.push({ tipo: a.tipo === 'audio' ? 'audio' : 'arquivo', nome: a.nome.slice(0, 80), texto: a.texto.slice(0, 20000) });
  if (!fontes.length) throw new MontarErro('Envie pelo menos uma fonte: link do site/Instagram, texto, PDF de preços ou áudio.');
  const user = mensagemFontes(fontes);
  let json: Record<string, unknown> | null = null;
  try {
    const r = await aiChat({ orgId, purpose: 'montar-ia', settings: ia.settings, messages: [{ role: 'system', content: SISTEMA_EXTRACAO }, { role: 'user', content: user }], temperature: 0.1, maxTokens: 3000, timeoutMs: 40000, totalMs: 80000, retries: 1 });
    json = lerJson(r.text);
  } catch (err) {
    const msg = (err as Error).message;
    throw new MontarErro(/limite|cota/i.test(msg) ? msg : 'A IA não respondeu agora. Tente de novo em alguns instantes.');
  }
  if (!json) throw new MontarErro('A IA não devolveu um resultado legível. Tente de novo.');
  const proposta = normalizarProposta(json, fontes.map((f) => f.texto).join('\n'));
  if (propostaVazia(proposta)) throw new MontarErro('Não encontrei informações do negócio nas fontes. Escreva o que você vende, preços e horários no campo de texto.');
  return { proposta, fontes: fontes.map((f) => (f.tipo === 'link' ? f.nome : f.tipo === 'texto' ? 'Texto' : f.nome || 'Arquivo')), modo: ia.modo };
}

const ATIVO_ABERTO = (t: { type?: string }) => t.type === 'first_message' || t.type === 'message';

/** Fluxo ativo (de outra configuração) que já responde à primeira mensagem? */
async function outroFluxoDeEntrada(orgId: string, ignorarId?: string): Promise<string | null> {
  const ativos = await prisma.flow.findMany({ where: { orgId, status: 'ACTIVE', ...(ignorarId ? { id: { not: ignorarId } } : {}) }, select: { id: true, name: true, currentVersion: true } });
  for (const f of ativos) {
    const v = await prisma.flowVersion.findUnique({ where: { flowId_version: { flowId: f.id, version: f.currentVersion } }, select: { graph: true } });
    try {
      const g = JSON.parse(v?.graph ?? '{}');
      const start = (g.nodes ?? []).find((n: any) => n.type === 'start');
      if ((start?.data?.triggers ?? []).some(ATIVO_ABERTO)) return f.name;
    } catch { /* grafo ilegível: ignora */ }
  }
  return null;
}

/** O que "Aplicar" vai mudar (para a prévia avisar antes). */
export async function situacaoAtual(orgId: string) {
  const [ai, docs, inbox, fluxo] = await Promise.all([
    prisma.aiSettings.findUnique({ where: { orgId } }),
    prisma.knowledgeDoc.findMany({ where: { orgId, title: { startsWith: PREFIXO_DOC } }, select: { title: true } }),
    prisma.inboxSettings.findUnique({ where: { orgId } }),
    prisma.flow.findFirst({ where: { orgId, name: NOME_FLUXO }, select: { id: true } }),
  ]);
  const ia = await iaDoMontar(orgId);
  return {
    disponivel: ia.ok, motivo: ia.ok ? null : ia.motivo, modo: ia.ok ? ia.modo : null,
    temInstrucoes: !!ai?.instructions?.trim(), iaLigada: !!(ai?.enabled && ai.autoReply),
    docsDoAssistente: docs.map((d) => d.title), temHorario: !!inbox?.hoursEnabled,
    fluxoExistente: !!fluxo, outroFluxoAtivo: await outroFluxoDeEntrada(orgId, fluxo?.id),
    aplicadoEm: ai?.assistenteAplicadoEm ?? null,
    totalDocs: await prisma.knowledgeDoc.count({ where: { orgId } }),
  };
}

export interface OpcoesAplicar { substituirInstrucoes: boolean; criarFluxo: boolean; ativarFluxo: boolean; horario: boolean; ligarIa: boolean }

/** Grava a prévia confirmada. Nunca apaga documentos do dono: só cria ou atualiza os do assistente. */
export async function aplicar(orgId: string, userId: string | null, raw: unknown, o: OpcoesAplicar, req?: import('express').Request) {
  const p = normalizarProposta(raw as Record<string, unknown>);
  if (propostaVazia(p)) throw new MontarErro('A prévia está vazia. Gere de novo ou preencha os dados.');
  const feito: string[] = [];
  // 1) Base de conhecimento (cria ou atualiza só os documentos "Assistente: …").
  for (const d of documentos(p)) {
    const ex = await prisma.knowledgeDoc.findFirst({ where: { orgId, title: d.title } });
    const doc = ex ? await prisma.knowledgeDoc.update({ where: { id: ex.id }, data: { content: d.content } }) : await prisma.knowledgeDoc.create({ data: { orgId, title: d.title, content: d.content } });
    await reindexDoc(orgId, doc.id, d.content);
  }
  feito.push(`${documentos(p).length} documento(s) na base de conhecimento`);
  // 2) Instruções e IA.
  const atual = await prisma.aiSettings.upsert({ where: { orgId }, create: { orgId }, update: {} });
  const ia = await iaDoMontar(orgId);
  const data: Record<string, unknown> = { instructions: mesclarInstrucoes(atual.instructions, blocoInstrucoes(p), o.substituirInstrucoes), assistenteAplicadoEm: new Date() };
  if (o.ligarIa) {
    if (!ia.ok && !atual.apiKeyEnc && atual.provider !== 'mck' && atual.provider !== 'fake') throw new MontarErro(`Não dá para ligar a IA agora: ${ia.ok ? '' : ia.motivo}`);
    data.enabled = true;
    data.autoReply = true;
    if (ia.ok && ia.modo === 'mck' && atual.provider !== 'mck') { data.provider = 'mck'; data.model = MCK_IA_MODEL; }
    feito.push('IA ligada para responder no WhatsApp');
  }
  await prisma.aiSettings.update({ where: { orgId }, data });
  feito.push(o.substituirInstrucoes ? 'instruções da IA substituídas' : 'instruções da IA atualizadas');
  // 3) Fluxo inicial.
  let fluxoId: string | null = null;
  let fluxoAviso: string | null = null;
  if (o.criarFluxo) {
    const g = normalizeGraph(fluxoInicial(p));
    const erros = validateGraph(g);
    if (erros.length) throw new MontarErro(`Fluxo inválido: ${erros[0]}`);
    const ex = await prisma.flow.findFirst({ where: { orgId, name: NOME_FLUXO } });
    const outro = await outroFluxoDeEntrada(orgId, ex?.id);
    const ativar = o.ativarFluxo && !outro;
    if (o.ativarFluxo && outro) fluxoAviso = `O fluxo "${outro}" já responde à primeira mensagem; o de boas-vindas ficou como rascunho em Fluxos.`;
    if (ex) {
      const versao = ex.currentVersion + 1;
      await prisma.flowVersion.create({ data: { flowId: ex.id, version: versao, graph: JSON.stringify(g), createdById: userId } });
      await prisma.flow.update({ where: { id: ex.id }, data: { currentVersion: versao, status: ativar ? 'ACTIVE' : ex.status } });
      fluxoId = ex.id;
    } else {
      const f = await prisma.flow.create({ data: { orgId, name: NOME_FLUXO, description: 'Criado pelo assistente "Monte sua IA conversando": boas-vindas, menu de setores e atendente.', status: ativar ? 'ACTIVE' : 'DRAFT', versions: { create: { version: 1, graph: JSON.stringify(g), createdById: userId } } } });
      fluxoId = f.id;
    }
    feito.push(ativar ? 'fluxo de boas-vindas ativo' : 'fluxo de boas-vindas salvo como rascunho');
  }
  // 4) Horário de atendimento + mensagem de fora do horário (Inbox › Atendimento).
  if (o.horario && p.horarios.length) {
    const horas = { hoursEnabled: true, hours: JSON.stringify(p.horarios), awayMessage: textoForaHorario(p) };
    await prisma.inboxSettings.upsert({ where: { orgId }, create: { orgId, ...horas }, update: horas });
    feito.push('horário de atendimento e mensagem de fora do horário');
  }
  await audit(req ?? null, 'ai.assistente_aplicar', { orgId, userId, entity: 'ai_settings', entityId: orgId, meta: { docs: documentos(p).length, fluxo: !!fluxoId, horario: o.horario && p.horarios.length > 0, ligarIa: o.ligarIa, substituir: o.substituirInstrucoes } });
  return { ok: true, feito, fluxoId, fluxoAviso };
}
