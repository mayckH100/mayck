/**
 * IA conversacional avançada (v1.26.0) — parte pura (sem banco), usada pela IA do MCKBOT nas conversas com leads do
 * SDR e pela qualificação das respostas de campanha do MCK Mensagens. Tudo atrás do interruptor
 * "IA conversacional avançada" (SDR › Inteligência); desligado, nada aqui é chamado e as mensagens ficam como antes.
 *
 * Partes: 1) contexto rico do lead no prompt; 2) estilo WhatsApp humano; 3) planejamento antes de responder;
 * 4) guardrails com autoverificação; 5) handoff inteligente. Detalhes em docs/SDR.md › IA conversacional avançada.
 */

// ---------- 1) Contexto rico ----------
export interface LeadContexto {
  nome: string | null;
  empresa: string | null;
  receita: { razaoSocial: string; atividade: string | null; cidade: string | null; uf: string | null; situacao: string | null } | null;
  etapa: string | null;
  pontuacao: number | null;
  temperatura: string | null;
  respondidas: { pergunta: string; resposta: string }[];
  faltam: string[];
  objecoes: string[];
  campanha: string | null;
  resumo: string | null;
}

const clip = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Bloco do prompt com os dados do lead. São dados (não instruções) e nunca devem ser lidos de volta ao lead. */
export function contextoLines(c: LeadContexto | null): string[] {
  if (!c) return [];
  const out = ['DADOS DO LEAD (internos: use para personalizar a conversa; nunca liste esses dados, nunca fale de pontuação, etapa ou "cadastro"):'];
  if (c.nome) out.push(`- Nome: ${clip(c.nome, 60)}`);
  if (c.empresa) out.push(`- Empresa: ${clip(c.empresa, 80)}`);
  if (c.receita) {
    const local = [c.receita.cidade, c.receita.uf].filter(Boolean).join('/');
    out.push(`- Receita Federal: ${clip(c.receita.razaoSocial, 80)}${c.receita.atividade ? `, ${clip(c.receita.atividade, 80)}` : ''}${local ? `, ${local}` : ''}${c.receita.situacao ? ` (situação ${clip(c.receita.situacao, 20).toLowerCase()})` : ''}`);
  }
  if (c.etapa) out.push(`- Etapa no funil: ${c.etapa}${c.pontuacao !== null ? ` · pontuação ${c.pontuacao}/100${c.temperatura ? ` (${c.temperatura.toLowerCase()})` : ''}` : ''}`);
  if (c.campanha) out.push(`- Veio da campanha: ${clip(c.campanha, 80)}`);
  if (c.resumo) out.push(`- Resumo até aqui: ${clip(c.resumo, 200)}`);
  if (c.objecoes.length) out.push(`- Objeções que ele já levantou: ${c.objecoes.slice(0, 5).map((o) => clip(o, 40)).join('; ')} (não ignore; trate se voltarem)`);
  if (c.respondidas.length) {
    out.push('JÁ RESPONDIDO PELO LEAD (NUNCA pergunte de novo nem peça para confirmar; use essas respostas):');
    for (const r of c.respondidas.slice(0, 10)) out.push(`- ${clip(r.pergunta, 80)} → ${clip(r.resposta, 120)}`);
  }
  if (c.faltam.length) out.push(`AINDA NÃO SABEMOS: ${c.faltam.slice(0, 6).map((f) => clip(f, 80)).join(' | ')}`);
  return out;
}

/** A empresa usa emoji? (Instruções, tom de voz ou textos dela). Sem emoji da empresa, a IA também não usa. */
export const EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/gu;
export function empresaUsaEmoji(...textos: (string | null | undefined)[]): boolean {
  return textos.some((t) => !!t && new RegExp(EMOJI_RE.source, 'u').test(t));
}
