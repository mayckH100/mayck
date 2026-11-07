/**
 * SDR com IA — Fase 2 "inteligência" (v1.21.0). Regras puras (sem banco):
 *  1) qualificação por método (Padrão, BANT ou SPIN) e explicação da pontuação para o vendedor.
 */
import type { Answers, Question, Temperature } from './core.js';
import { safeTz, zonedParts, zonedToUtc } from '../agenda/time.js';

// ---------- 1) Métodos de qualificação ----------
export const METODOS = ['PADRAO', 'BANT', 'SPIN'] as const;
export type Metodo = (typeof METODOS)[number];
export const METODO_LABEL: Record<Metodo, string> = {
  PADRAO: 'Padrão (minhas perguntas)',
  BANT: 'BANT (orçamento, decisor, necessidade, prazo)',
  SPIN: 'SPIN (situação, problema, implicação, necessidade)',
};

/** Perguntas fixas de cada método (o Padrão usa as perguntas configuradas pela empresa). */
export const METODO_QUESTIONS: Record<Exclude<Metodo, 'PADRAO'>, Question[]> = {
  BANT: [
    { id: 'necessidade', pergunta: 'Qual problema você precisa resolver? (Need)', peso: 30 },
    { id: 'orcamento', pergunta: 'Já tem um orçamento previsto para isso? Quanto pensa investir? (Budget)', peso: 25 },
    { id: 'decisor', pergunta: 'Quem decide a compra junto com você? (Authority)', peso: 20 },
    { id: 'prazo', pergunta: 'Para quando você precisa disso funcionando? (Timing)', peso: 25 },
  ],
  SPIN: [
    { id: 'situacao', pergunta: 'Como funciona hoje (processo, ferramentas, equipe)? (Situação)', peso: 15 },
    { id: 'problema', pergunta: 'Qual a maior dificuldade com isso hoje? (Problema)', peso: 30 },
    { id: 'implicacao', pergunta: 'O que essa dificuldade causa (vendas perdidas, tempo, dinheiro)? (Implicação)', peso: 25 },
    { id: 'necessidade', pergunta: 'Se isso fosse resolvido, o que mudaria para você? (Necessidade de solução)', peso: 30 },
  ],
};

export const normalizeMetodo = (m: unknown): Metodo => (METODOS.includes(String(m ?? '').toUpperCase() as Metodo) ? (String(m).toUpperCase() as Metodo) : 'PADRAO');

export function questionsForMetodo(metodo: Metodo, custom: Question[]): Question[] {
  return metodo === 'PADRAO' ? custom : METODO_QUESTIONS[metodo];
}

/** Linha do prompt da IA com o jeito de conduzir a conversa no método escolhido (vazio no Padrão). */
export function metodoPromptLine(metodo: Metodo): string {
  if (metodo === 'BANT') return '- Método BANT: descubra necessidade, orçamento, quem decide e prazo, sempre com naturalidade, sem parecer formulário.';
  if (metodo === 'SPIN') return '- Método SPIN: primeiro entenda a situação atual, depois o problema, depois o impacto (implicação) desse problema e, por fim, o que mudaria se fosse resolvido. Perguntas abertas, uma por vez.';
  return '';
}

// ---------- 1) Explicação da pontuação ("por que este lead é quente") ----------
const LABEL: Record<string, string> = {
  necessidade: 'necessidade', orcamento: 'orçamento', prazo: 'prazo', porte: 'porte', decisor: 'decisor',
  situacao: 'situação atual', problema: 'problema', implicacao: 'impacto do problema',
};
export const questionLabel = (q: Question) => LABEL[q.id] ?? q.pergunta.replace(/\s*\([^)]*\)\s*$/, '').replace(/\?$/, '').slice(0, 60);

export type Nivel = 'forte' | 'medio' | 'fraco' | 'falta';
export interface Fator { id: string; pergunta: string; label: string; resposta: string | null; nota: number | null; peso: number; pontos: number; nivel: Nivel; motivo: string | null }
export interface Explicacao { titulo: string; porque: string; fatores: Fator[]; faltam: string[]; proximaAcao: string }

const TEMP_LABEL: Record<Temperature, string> = { FRIO: 'frio', MORNO: 'morno', QUENTE: 'quente' };

/**
 * Explica a pontuação em português simples para o vendedor: quanto cada resposta somou (peso × nota), o que puxou
 * para cima, o que puxou para baixo e o que falta descobrir. A soma dos pontos dá a pontuação (arredondada).
 */
export function explainScore(questions: Question[], answers: Answers, score: number, temperature: Temperature, warm = 40, hot = 70): Explicacao {
  const total = questions.reduce((s, q) => s + q.peso, 0) || 1;
  const fatores: Fator[] = questions.map((q) => {
    const a = answers[q.id];
    if (!a?.resposta) return { id: q.id, pergunta: q.pergunta, label: questionLabel(q), resposta: null, nota: null, peso: q.peso, pontos: 0, nivel: 'falta', motivo: null };
    const nota = Math.min(100, Math.max(0, Number(a.nota) || 0));
    const nivel: Nivel = nota >= 70 ? 'forte' : nota >= 40 ? 'medio' : 'fraco';
    return { id: q.id, pergunta: q.pergunta, label: questionLabel(q), resposta: a.resposta, nota, peso: q.peso, pontos: Math.round((q.peso * nota) / total), nivel, motivo: a.motivo ?? null };
  });
  const by = (n: Nivel) => fatores.filter((f) => f.nivel === n).sort((a, b) => b.pontos - a.pontos);
  const fortes = by('forte'), fracos = by('fraco'), faltam = by('falta').map((f) => f.label);
  const list = (fs: Fator[]) => fs.map((f) => `${f.label}${f.resposta ? ` ("${f.resposta.slice(0, 50)}${f.resposta.length > 50 ? '…' : ''}")` : ''}`).join(', ');
  const faixa = temperature === 'QUENTE' ? `quente a partir de ${hot}` : temperature === 'MORNO' ? `morno de ${warm} a ${hot - 1}` : `frio abaixo de ${warm}`;
  const partes = [`Lead ${TEMP_LABEL[temperature]} com ${score} de 100 pontos (${faixa}).`];
  if (fortes.length) partes.push(`Puxou para cima: ${list(fortes)}.`);
  if (fracos.length) partes.push(`Puxou para baixo: ${list(fracos)}.`);
  if (faltam.length) partes.push(`Ainda falta saber: ${faltam.join(', ')}.`);
  if (!fortes.length && !fracos.length && !faltam.length) partes.push('Respostas medianas em tudo.');
  let proximaAcao: string;
  if (temperature === 'QUENTE') proximaAcao = 'Priorize: proponha a reunião/proposta hoje.';
  else if (temperature === 'MORNO') proximaAcao = faltam.length ? `Descubra ${faltam[0]} para confirmar o interesse.` : `Trabalhe o ponto fraco${fracos[0] ? ` (${fracos[0].label})` : ''} antes de propor.`;
  else proximaAcao = faltam.length >= questions.length ? 'Ainda sem informações: deixe a IA conversar ou faça a primeira abordagem.' : 'Baixa prioridade: mantenha na cadência de acompanhamento.';
  return { titulo: `${TEMP_LABEL[temperature][0].toUpperCase()}${TEMP_LABEL[temperature].slice(1)} · ${score}/100`, porque: partes.join(' '), fatores, faltam, proximaAcao };
}

// ---------- 2) Biblioteca de objeções ----------
export interface Objecao { id: string; titulo: string; gatilhos: string[]; resposta: string }

export const DEFAULT_OBJECOES: Objecao[] = [
  { id: 'preco', titulo: 'Preço / está caro', gatilhos: ['caro', 'preço alto', 'muito alto', 'sem dinheiro', 'fora do orçamento', 'não cabe no bolso', 'tá puxado'],
    resposta: 'Reconheça a preocupação, pergunte com o que está comparando e mostre o valor (o que ganha ou economiza). Ofereça a opção de entrada ou o teste. Nunca invente desconto.' },
  { id: 'fornecedor', titulo: 'Já tenho fornecedor', gatilhos: ['já tenho fornecedor', 'já uso', 'já trabalho com', 'já temos', 'já tenho um', 'já tenho uma'],
    resposta: 'Respeite a escolha. Pergunte o que mais gosta no atual e o que poderia ser melhor; se houver um ponto fraco, mostre como resolvemos, sem falar mal do concorrente.' },
  { id: 'agora_nao', titulo: 'Agora não / sem tempo', gatilhos: ['agora não', 'não é o momento', 'mais pra frente', 'mais para frente', 'sem tempo', 'depois eu vejo', 'outro momento', 'ano que vem'],
    resposta: 'Pergunte quando seria um bom momento e o que precisa acontecer até lá. Ofereça retomar na data que ele disser.' },
  { id: 'email', titulo: 'Manda por e-mail', gatilhos: ['manda por e-mail', 'manda por email', 'envia por e-mail', 'envia por email', 'manda o material', 'manda uma proposta', 'me manda as informações'],
    resposta: 'Aceite e confirme o e-mail. Antes, faça uma pergunta para personalizar (qual o principal objetivo) e proponha uma conversa rápida para explicar o material.' },
  { id: 'pensar', titulo: 'Vou pensar / falar com o sócio', gatilhos: ['vou pensar', 'preciso pensar', 'falar com meu sócio', 'falar com minha sócia', 'ver com meu chefe', 'ver com a diretoria', 'consultar'],
    resposta: 'Pergunte qual ponto ainda gera dúvida e quem mais participa da decisão. Ofereça incluir essa pessoa numa conversa rápida.' },
  { id: 'confianca', titulo: 'Não conheço vocês', gatilhos: ['não conheço', 'é confiável', 'é golpe', 'nunca ouvi falar', 'é seguro'],
    resposta: 'Apresente a empresa com fatos (tempo de mercado, clientes, garantias) e ofereça um teste ou uma referência.' },
];

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function normalizeObjecoes(list: unknown): Objecao[] {
  if (!Array.isArray(list)) return DEFAULT_OBJECOES;
  const out: Objecao[] = [];
  const seen = new Set<string>();
  for (const o of list.slice(0, 20)) {
    const titulo = String((o as any)?.titulo ?? '').trim().slice(0, 80);
    const resposta = String((o as any)?.resposta ?? '').trim().slice(0, 600);
    const gatilhos = (Array.isArray((o as any)?.gatilhos) ? (o as any).gatilhos : String((o as any)?.gatilhos ?? '').split(/[,;\n]/))
      .map((g: unknown) => String(g ?? '').trim().slice(0, 60)).filter(Boolean).slice(0, 15) as string[];
    if (!titulo || !resposta || !gatilhos.length) continue;
    let id = String((o as any)?.id ?? '').replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 30) || norm(titulo).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || `obj${out.length + 1}`;
    while (seen.has(id)) id = `${id}_${out.length + 1}`;
    seen.add(id);
    out.push({ id, titulo, gatilhos, resposta });
  }
  return out;
}

/** Objeção na mensagem do lead (por palavras-gatilho, sem acento e sem diferenciar maiúsculas). */
export function detectObjecao(text: string, itens: Objecao[]): Objecao | null {
  const t = ` ${norm(text || '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ')} `;
  if (t.trim().length < 2) return null;
  for (const o of itens) {
    for (const g of o.gatilhos) {
      const n = norm(g).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (n && t.includes(` ${n} `)) return o;
    }
  }
  return null;
}

/** Trecho do prompt: respostas aprovadas pela empresa para cada objeção (e a que o lead acabou de levantar). */
export function objecoesPromptLines(itens: Objecao[], atual: Objecao | null): string[] {
  if (!itens.length) return [];
  const lines = ['OBJEÇÕES (orientações aprovadas pela empresa; responda com suas palavras, curto e com empatia; nunca invente preço, desconto ou condição):'];
  for (const o of itens) lines.push(`- Se o cliente disser algo como ${o.gatilhos.slice(0, 3).map((g) => `"${g}"`).join(', ')} (${o.titulo}): ${o.resposta}`);
  if (atual) lines.push(`- A última mensagem do cliente é a objeção "${atual.titulo}": trate-a agora seguindo a orientação acima.`);
  return lines;
}

// ---------- 4) Resumo para o vendedor no handoff ----------
export interface Handoff { dor: string | null; orcamento: string | null; prazo: string | null; decisor: string | null; proximoPasso: string; resumo: string | null }
const pick = (answers: Answers, ...ids: string[]) => ids.map((id) => answers[id]?.resposta).filter(Boolean).join(' — ') || null;

/** Dor, orçamento, prazo, decisor e próximo passo, a partir das respostas (qualquer método) e do resumo da IA. */
export function buildHandoff(answers: Answers, lead: { stage: string; temperature: string; aiSummary: string | null; score: number }, proximaAcao: string): Handoff {
  const proximoPasso = lead.stage === 'REUNIAO' ? 'Reunião marcada: prepare a apresentação com a dor e o prazo acima.'
    : lead.stage === 'GANHO' ? 'Venda fechada: faça o pós-venda.'
    : lead.stage === 'PERDIDO' ? 'Perdido: registre o motivo e retome no futuro.' : proximaAcao;
  return {
    dor: pick(answers, 'necessidade', 'problema', 'implicacao'),
    orcamento: pick(answers, 'orcamento'),
    prazo: pick(answers, 'prazo'),
    decisor: pick(answers, 'decisor'),
    proximoPasso,
    resumo: lead.aiSummary,
  };
}

/** Linhas do resumo (aviso de lead quente e cartão do Kanban). */
export function handoffLines(h: Handoff): string[] {
  const v = (s: string | null) => s ?? 'não informado';
  return [`Dor: ${v(h.dor)}`, `Orçamento: ${v(h.orcamento)}`, `Prazo: ${v(h.prazo)}`, `Decisor: ${v(h.decisor)}`, `Próximo passo: ${h.proximoPasso}`];
}

// ---------- 5) Melhor horário de envio (horário comercial, fuso da empresa — padrão Brasília) ----------
const hmin = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };

/**
 * Hora (cheia) em que o lead mais responde, dentro do horário comercial. Sem histórico (menos de 2 respostas no
 * horário comercial): 10h, ou a 1ª hora cheia do expediente se ele começar depois. Empate: a mais cedo.
 */
export function bestSendHour(replies: Date[], s: { workStart: string; workEnd: string }, tz?: string | null): { hora: number; base: number } {
  const z = safeTz(tz ?? undefined);
  const a = hmin(s.workStart), b = hmin(s.workEnd);
  const first = Number.isFinite(a) ? Math.ceil(a / 60) : 9, last = Number.isFinite(b) ? Math.floor((b - 1) / 60) : 17;
  const fallback = Math.min(Math.max(10, first), Math.max(first, last));
  const count = new Map<number, number>();
  for (const d of replies) {
    const h = zonedParts(d, z).hour;
    if (h >= first && h <= last) count.set(h, (count.get(h) ?? 0) + 1);
  }
  const base = [...count.values()].reduce((x, y) => x + y, 0);
  if (base < 2) return { hora: fallback, base };
  const hora = [...count.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
  return { hora, base };
}

/** Próximo instante (≥ agora) na hora `hora` de um dia útil configurado; null se não houver nos próximos 8 dias. */
export function nextAtHour(now: Date, hora: number, s: { workDays: string }, tz?: string | null): Date | null {
  const z = safeTz(tz ?? undefined);
  const days = String(s.workDays || '').split(',').map((d) => Number(d.trim()));
  for (let i = 0; i < 9; i++) {
    const p = zonedParts(new Date(now.getTime() + i * 86400e3), z);
    const at = zonedToUtc(p.year, p.month, p.day, hora, 0, z);
    if (at.getTime() >= now.getTime() - 60e3 && days.includes(zonedParts(at, z).weekday)) return at;
  }
  return null;
}

/** Envio na janela de 2 h a partir do melhor horário? */
export function inBestWindow(now: Date, hora: number, tz?: string | null): boolean {
  const h = zonedParts(now, safeTz(tz ?? undefined)).hour;
  return h >= hora && h < hora + 2;
}

// ---------- 7) Intenção, sentimento e opt-out automático (LGPD) ----------
export type Intencao = 'OPTOUT' | 'SEM_INTERESSE' | 'REUNIAO' | 'COMPRA' | 'PRECO' | 'DUVIDA' | 'OUTRO';
export type Sentimento = 'POSITIVO' | 'NEUTRO' | 'NEGATIVO';
export const INTENCAO_LABEL: Record<Intencao, string> = {
  OPTOUT: 'Pediu para não receber mais', SEM_INTERESSE: 'Sem interesse', REUNIAO: 'Quer marcar conversa', COMPRA: 'Quer comprar/contratar',
  PRECO: 'Perguntou preço', DUVIDA: 'Dúvida', OUTRO: 'Conversa',
};
const plain = (s: string) => ` ${norm(s || '').replace(/[^\p{L}\p{N}?! ]/gu, ' ').replace(/\s+/g, ' ')} `;

/** Pedido de opt-out em frase (além das palavras exatas SAIR/PARAR do WhatsApp). */
const OPTOUT_RE = new RegExp([
  ' nao quero (mais )?receber',
  ' nao (me )?(mande|mandem|envie|enviem|chame|chamem|ligue|liguem) mais',
  ' (pare|parem|para|parar) de (me )?(mandar|enviar|chamar|ligar|incomodar)',
  ' (me )?(tira|tire|tirem|remova|remove|removam|exclua|excluam|apague) (meu numero |meu contato )?(da|dessa|desta|de sua|da sua) lista',
  ' (quero )?sair (da|dessa|desta) lista',
  ' (me )?descadastr',
  ' nao quero mais (mensagens?|contato|que me)',
  ' (lgpd|nao autorizo|nao autorizei)',
].join('|'));

export function isOptOutPhrase(text: string): boolean {
  return OPTOUT_RE.test(plain(text));
}

const has = (t: string, words: string[]) => words.some((w) => t.includes(` ${w}`));
export function detectIntent(text: string): { intencao: Intencao; sentimento: Sentimento } {
  const t = plain(text);
  const neg = has(t, ['ruim', 'pessimo', 'pessima', 'horrivel', 'absurdo', 'chato', 'irritad', 'reclama', 'golpe', 'nao gostei', 'decepcion', 'insatisfeit', 'raiva', 'palhacada', 'enganad', 'demora demais']) || /😡|👎|🤬|😠/u.test(text);
  const pos = has(t, ['otimo', 'otima', 'gostei', 'perfeito', 'perfeita', 'obrigad', 'show', 'top', 'legal', 'maravilh', 'excelente', 'adorei', 'massa', 'bacana', 'boa ']) || /👍|😊|🙏|😍|👏|❤/u.test(text);
  const sentimento: Sentimento = neg && !pos ? 'NEGATIVO' : pos && !neg ? 'POSITIVO' : 'NEUTRO';
  let intencao: Intencao = 'OUTRO';
  if (isOptOutPhrase(text)) intencao = 'OPTOUT';
  else if (has(t, ['nao tenho interesse', 'sem interesse', 'nao preciso', 'nao quero', 'ja resolvi', 'ja contratei', 'nao e pra mim', 'nao me interessa'])) intencao = 'SEM_INTERESSE';
  else if (has(t, ['marcar', 'agendar', 'reuniao', 'demonstracao', 'demo ', 'call ', 'videochamada', 'conversar amanha', 'que horas', 'qual horario', 'tem horario'])) intencao = 'REUNIAO';
  else if (has(t, ['quero contratar', 'quero comprar', 'vamos fechar', 'fechado', 'como contrato', 'como faco para contratar', 'como assino', 'pode mandar o contrato', 'manda o link de pagamento', 'quero assinar', 'tenho interesse', 'quero sim'])) intencao = 'COMPRA';
  else if (has(t, ['preco', 'quanto custa', 'quanto e', 'valor', 'valores', 'mensalidade', 'orcamento', 'tabela', 'planos'])) intencao = 'PRECO';
  else if (t.includes('?') || has(t, ['como funciona', 'duvida', 'explica', 'o que e'])) intencao = 'DUVIDA';
  return { intencao, sentimento };
}
