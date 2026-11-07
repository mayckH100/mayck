/**
 * SDR com IA — Fase 2 "inteligência" (v1.21.0). Regras puras (sem banco):
 *  1) qualificação por método (Padrão, BANT ou SPIN) e explicação da pontuação para o vendedor.
 */
import type { Answers, Question, Temperature } from './core.js';

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
