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
