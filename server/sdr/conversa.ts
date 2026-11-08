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

// ---------- 2) Estilo WhatsApp humano ----------
export function estiloLines(o: { usaEmoji: boolean }): string[] {
  return [
    'ESTILO (WhatsApp, como uma pessoa da equipe):',
    '- Mensagens curtas: 1 a 3 frases. Nada de listas longas, a não ser que o lead peça.',
    '- No máximo UMA pergunta por mensagem, no final.',
    '- Espelhe o tom do lead: se ele escreve curto e informal, responda curto e informal; se é formal, seja formal.',
    '- Sem bajulação e sem frases de robô ("Entendido perfeitamente", "Ótima pergunta", "Fico feliz em ajudar", "Espero ter ajudado", "Não hesite em perguntar").',
    '- Use o nome do lead com moderação (no máximo uma vez a cada várias mensagens), nunca em toda resposta.',
    o.usaEmoji ? '- Emojis: no máximo 1, e só se combinar com o tom do lead.' : '- Não use emojis.',
  ];
}

const ROBO: RegExp[] = [
  /(?<!\p{L})(entendido|entendi) perfeitamente[.!,]?\s*/giu,
  /(?<!\p{L})(ótima|excelente|boa) pergunta[.!,]?\s*/giu,
  /\bfico (muito )?feliz em (poder )?(te )?ajudar[.!,]?\s*/giu,
  /\bagradeço (muito )?(pelo|o) seu contato[.!,]?\s*/giu,
  /\bespero ter (te )?ajudado[.!]?\s*/giu,
  /\bnão hesite em (me )?(perguntar|chamar|entrar em contato)[^.!?]*[.!]?\s*/giu,
  /\bestou (aqui )?(à|a) (sua )?disposição para (qualquer|quaisquer) (outra |outras )?(dúvida|dúvidas|coisa)[^.!?]*[.!]?\s*/giu,
  /\bcomo (um |uma )?(assistente virtual|inteligência artificial|modelo de linguagem)[^,.!?]*,\s*/giu,
];

/** Frases de robô que ainda aparecem no texto (para a checagem final). */
export function frasesDeRobo(text: string): string[] {
  return ROBO.flatMap((re) => [...text.matchAll(new RegExp(re.source, 'giu'))].map((m) => m[0].trim())).filter(Boolean);
}

/**
 * Polimento local (sem IA, sem custo): tira frases de robô, emojis quando a empresa não usa e o nome repetido quando
 * a IA já chamou o lead pelo nome há pouco. Mantém o sentido do texto.
 */
export function polirResposta(text: string, o: { usaEmoji: boolean; nome?: string | null; nomeRecente?: boolean }): string {
  let t = text;
  for (const re of ROBO) t = t.replace(new RegExp(re.source, 'giu'), '');
  if (!o.usaEmoji) t = t.replace(new RegExp(EMOJI_RE.source, 'gu'), '').replace(/\uFE0F|\u200D/g, '');
  const first = (o.nome ?? '').trim().split(/\s+/)[0];
  if (o.nomeRecente && first && first.length >= 2) {
    const n = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^((?:oi|olá|ola|bom dia|boa tarde|boa noite|certo|claro|tudo bem)),?\\s+${n}([,!.]?)`, 'i'), (_m, g: string, p: string) => `${g}${p || ','}`)
      .replace(new RegExp(`,\\s*${n}(?=[,!.?])`, 'gi'), '');
  }
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/^[\s,.!]+/, '').replace(/\n{3,}/g, '\n\n').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

// ---------- 3) Planejamento antes de responder ----------
export const OBJETIVOS = ['RESPONDER', 'QUALIFICAR', 'TRATAR_OBJECAO', 'AGENDAR', 'PASSAR_VENDEDOR'] as const;
export type Objetivo = (typeof OBJETIVOS)[number];
export interface Plano { intencao: string; objetivo: Objetivo }

const METODO_GUIA: Record<string, string> = {
  PADRAO: 'siga as perguntas de qualificação da empresa (as que ainda faltam), uma por vez',
  BANT: 'BANT: necessidade, orçamento, quem decide e prazo, nessa ordem natural da conversa',
  SPIN: 'SPIN: situação → problema → implicação → necessidade de solução, com perguntas abertas',
};

/** Próximo objetivo sugerido pelo estado do lead (a IA pode discordar e explicar no plano). */
export function objetivoSugerido(c: LeadContexto | null, intencaoLead: string): Objetivo {
  if (intencaoLead === 'SEM_INTERESSE') return 'TRATAR_OBJECAO';
  if (intencaoLead === 'REUNIAO') return 'AGENDAR';
  if (intencaoLead === 'COMPRA' || c?.temperatura === 'QUENTE') return 'AGENDAR';
  if (c && c.faltam.length) return 'QUALIFICAR';
  return c ? 'AGENDAR' : 'RESPONDER';
}

export function planejamentoLines(o: { metodo: string; sugerido: Objetivo; handoff: boolean }): string[] {
  return [
    'ANTES DE RESPONDER, PLANEJE (interno):',
    '- Entenda a intenção da última mensagem do lead (ex.: preço, dúvida, objeção, quer marcar, quer comprar, sem interesse, irritado) e escolha UM objetivo: RESPONDER, QUALIFICAR, TRATAR_OBJECAO, AGENDAR ou PASSAR_VENDEDOR.',
    `- Objetivo sugerido pelo estado do lead: ${o.sugerido}. Método: ${METODO_GUIA[o.metodo] ?? METODO_GUIA.PADRAO}.`,
    '- Sempre responda primeiro o que o lead perguntou; depois avance UM passo rumo ao objetivo.',
    o.handoff
      ? '- PASSAR_VENDEDOR quando: o lead está pronto para comprar/fechar, pede uma pessoa, está irritado ou pergunta algo que as Instruções e o CONTEXTO não respondem. Nesse caso diga, em uma frase, que um especialista da equipe vai continuar com ele.'
      : '- Não use PASSAR_VENDEDOR: continue o atendimento.',
    '- Escreva o plano na PRIMEIRA linha, exatamente assim (o lead não vê): [PLANO: intencao=<palavra>; objetivo=<OBJETIVO>]',
    '- Na linha de baixo, só a mensagem para o lead.',
  ];
}

/** Separa o plano (marcador interno) do texto. O marcador nunca vai para o lead, mesmo malformado. */
export function extrairPlano(text: string): { plano: Plano | null; texto: string } {
  let plano: Plano | null = null;
  const m = text.match(/\[\s*PLANO\s*:?([^\]]*)\]/i);
  if (m) {
    const intencao = (m[1].match(/inten[cç][aã]o\s*=\s*([^;\]]+)/i)?.[1] ?? '').trim().toLowerCase().slice(0, 40);
    const obj = (m[1].match(/objetivo\s*=\s*([A-Z_a-z]+)/i)?.[1] ?? '').toUpperCase() as Objetivo;
    if (OBJETIVOS.includes(obj)) plano = { intencao: intencao || 'outro', objetivo: obj };
  }
  const texto = text.replace(/\[\s*PLANO\s*:?[^\]]*\]\s*/gi, '').replace(/^\s*PLANO\s*:[^\n]*\n/i, '').trim();
  return { plano, texto };
}
