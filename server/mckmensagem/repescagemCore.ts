/**
 * v1.43.0 — Repescagem automática inteligente das campanhas do MCK Mensagens: regras puras (sem banco).
 *
 * - Separação de cada destinatário da campanha em grupos, pelo status da mensagem (enviada/entregue/lida) e pela
 *   resposta do contato: Respondeu, Visualizou e não respondeu, Não visualizou, Não entregue/falhou, Saiu (SAIR),
 *   Na fila e Não enviada (ignorada: sem consentimento, opt-out antes do envio...).
 * - Elegibilidade da repescagem: só "Visualizou e não respondeu" e "Não visualizou"; NUNCA para quem respondeu
 *   qualquer coisa, saiu, está em qualificação/qualificado/descartado/convertido, falhou ou bloqueou.
 * - Texto modelo com variações (spintax {a|b}) para quando a IA não está disponível.
 */

export const GRUPOS = ['RESPONDEU', 'VISUALIZOU', 'NAO_VISUALIZOU', 'FALHOU', 'SAIU', 'PENDENTE', 'NAO_ENVIADA'] as const;
export type GrupoCampanha = (typeof GRUPOS)[number];

export const GRUPO_ROTULO: Record<GrupoCampanha, string> = {
  RESPONDEU: 'Respondeu',
  VISUALIZOU: 'Visualizou e não respondeu',
  NAO_VISUALIZOU: 'Não visualizou',
  FALHOU: 'Não entregue / falhou',
  SAIU: 'Saiu (SAIR)',
  PENDENTE: 'Na fila',
  NAO_ENVIADA: 'Não enviada (ignorada)',
};

/** Grupos que recebem repescagem. */
export const GRUPOS_REPESCAGEM: GrupoCampanha[] = ['VISUALIZOU', 'NAO_VISUALIZOU'];

/** Status de lead que ainda pode receber repescagem (abordado e sem resposta). */
export const LEAD_STATUS_REPESCAGEM = ['CONTATADO'];

export const REPESCAGEM_PADRAO = { dias: 2, max: 2 };
export const REPESCAGEM_LIMITES = { diasMin: 1, diasMax: 30, maxMin: 1, maxMax: 5 };

const RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/**
 * Melhor status entre as mensagens do contato na campanha (original + repescagens): lida > entregue > enviada.
 * Só fica FAILED quando todas falharam. Lista vazia = null.
 */
export function melhorStatus(statuses: (string | null | undefined)[]): string | null {
  const vals = statuses.filter((s): s is string => !!s).map((s) => s.toUpperCase());
  if (!vals.length) return null;
  const ok = vals.filter((s) => s !== 'FAILED');
  if (!ok.length) return 'FAILED';
  return ok.reduce((a, b) => ((RANK[b] ?? -1) > (RANK[a] ?? -1) ? b : a));
}

export interface DadosGrupo {
  /** CampaignRecipient.status: PENDENTE | ENVIADA | FALHOU | IGNORADA */
  recipientStatus: string;
  /** melhorStatus() das mensagens enviadas a este contato na campanha. */
  msgStatus: string | null;
  /** Respondeu qualquer coisa depois do envio (resposta automática do celular não conta). */
  respondeu: boolean;
  /** Pediu para sair (SAIR / opt-out). */
  saiu: boolean;
}

export function classificarDestinatario(d: DadosGrupo): GrupoCampanha {
  if (d.saiu) return 'SAIU';
  if (d.respondeu) return 'RESPONDEU';
  if (d.recipientStatus === 'PENDENTE') return 'PENDENTE';
  if (d.recipientStatus === 'IGNORADA') return 'NAO_ENVIADA';
  if (d.recipientStatus === 'FALHOU' || d.msgStatus === 'FAILED') return 'FALHOU';
  if (d.msgStatus === 'READ') return 'VISUALIZOU';
  return 'NAO_VISUALIZOU';
}

export interface DadosElegibilidade {
  cfg: { ativa: boolean; dias: number; max: number };
  campanhaStatus: string;
  recipient: {
    status: string; sentAt: Date | null; repescagens: number; ultimaRepescagemAt: Date | null;
    repescagemStatus: string | null; respondeuAt: Date | null; repescagemAposAt: Date | null;
  };
  grupo: GrupoCampanha;
  lead: { status: string; optOutAt: Date | null } | null;
  contatoOptOut: boolean;
  /** Conversa no número da campanha está com atendente (modo humano) ou um atendente escreveu depois do envio. */
  atendimentoHumano: boolean;
  /** Último erro de envio indica bloqueio / número sem WhatsApp. */
  erroBloqueio: boolean;
}

export type Decisao =
  | { acao: 'ENVIAR'; tentativa: number }
  | { acao: 'FINALIZAR' }
  | { acao: 'AGUARDAR'; ate: Date | null }
  | { acao: 'PARAR'; status: 'RESPONDEU' | 'PARADA'; motivo: string }
  | { acao: 'IGNORAR' };

const DAY_MS = 86400e3;

/** Quando vence a próxima ação (repescagem ou "sem resposta") deste destinatário. */
export function proximaAcaoEm(r: DadosElegibilidade['recipient'], dias: number): Date | null {
  const base = r.ultimaRepescagemAt ?? r.sentAt;
  if (!base) return null;
  const due = base.getTime() + dias * DAY_MS;
  return new Date(Math.max(due, r.repescagemAposAt?.getTime() ?? 0));
}

/** Decide o que fazer com um destinatário agora. Ordem das travas = da mais forte para a mais fraca. */
export function decidirRepescagem(d: DadosElegibilidade, now: Date): Decisao {
  const r = d.recipient;
  if (!d.cfg.ativa) return { acao: 'IGNORAR' };
  if (d.campanhaStatus !== 'EM_ANDAMENTO' && d.campanhaStatus !== 'CONCLUIDA') return { acao: 'IGNORAR' };
  if (r.status !== 'ENVIADA' || !r.sentAt) return { acao: 'IGNORAR' };
  if (r.repescagemStatus) return { acao: 'IGNORAR' }; // RESPONDEU, SEM_RESPOSTA, PARADA ou ENVIANDO: nada a fazer
  // Nunca para quem respondeu qualquer coisa.
  if (r.respondeuAt || d.grupo === 'RESPONDEU') return { acao: 'PARAR', status: 'RESPONDEU', motivo: 'Contato respondeu' };
  if (!d.lead) return { acao: 'PARAR', status: 'PARADA', motivo: 'Contato removido da base' };
  if (d.grupo === 'SAIU' || d.lead.optOutAt || d.contatoOptOut) return { acao: 'PARAR', status: 'PARADA', motivo: 'Contato pediu para sair (SAIR)' };
  if (!LEAD_STATUS_REPESCAGEM.includes(d.lead.status)) return { acao: 'PARAR', status: d.lead.status === 'RESPONDEU' ? 'RESPONDEU' : 'PARADA', motivo: `Lead em "${d.lead.status}"` };
  if (d.grupo === 'FALHOU' || d.erroBloqueio) return { acao: 'PARAR', status: 'PARADA', motivo: 'Mensagem não entregue (falha ou bloqueio)' };
  if (!GRUPOS_REPESCAGEM.includes(d.grupo)) return { acao: 'IGNORAR' };
  if (d.atendimentoHumano) return { acao: 'PARAR', status: 'PARADA', motivo: 'Atendente cuidando da conversa' };
  const quando = proximaAcaoEm(r, d.cfg.dias);
  if (!quando || now.getTime() < quando.getTime()) return { acao: 'AGUARDAR', ate: quando };
  if (r.repescagens >= d.cfg.max) return { acao: 'FINALIZAR' };
  return { acao: 'ENVIAR', tentativa: r.repescagens + 1 };
}

// ---------------- Texto modelo (sem IA) ----------------

/** Resolve variações {a|b|c} (aceita aninhadas). Chaves sem "|" (ex.: {nome}) ficam como estão. */
export function resolverSpintax(texto: string, rand: () => number = Math.random): string {
  let out = texto;
  const re = /\{([^{}]*\|[^{}]*)\}/;
  for (let i = 0; i < 200 && re.test(out); i++) {
    out = out.replace(re, (_m, corpo: string) => {
      const ops = corpo.split('|');
      return ops[Math.min(ops.length - 1, Math.floor(rand() * ops.length))];
    });
  }
  return out;
}

export const MODELO_PADRAO: Record<'VISUALIZOU' | 'NAO_VISUALIZOU', string> = {
  VISUALIZOU: '{Oi|Olá} {nome}, {tudo bem|tudo certo}? {Sei que a rotina é corrida|Imagino que o dia esteja corrido}, então {só passando|passando rapidinho} para saber se {ficou alguma dúvida|posso te ajudar em algo} sobre a nossa mensagem. {Se fizer sentido|Se tiver interesse}, é só responder aqui {que eu te explico|que te passo os detalhes}.',
  NAO_VISUALIZOU: '{Oi|Olá} {nome}, {tudo bem|tudo certo}? {Te mandei uma mensagem há alguns dias|Passei aqui há alguns dias} e {talvez tenha ficado perdida|acho que ela se perdeu} no meio das conversas. {Se tiver interesse|Se fizer sentido para você}, {é só responder aqui|me responde aqui} que eu {te explico rapidinho|te passo os detalhes}.',
};

export const TEXTO_SAIR = 'Se não quiser mais receber mensagens, responda SAIR.';

/** Garante a saída "responda SAIR" no fim do texto. */
export function garantirSair(texto: string): string {
  const t = texto.trim();
  return /\bSAIR\b/.test(t) ? t : `${t}\n\n${TEXTO_SAIR}`;
}

function primeiroNome(nome: string | null | undefined): string {
  return (nome ?? '').trim().split(/\s+/)[0] ?? '';
}

/** {nome} vira o primeiro nome; sem nome, some sem deixar vírgula/espaço sobrando. */
export function personalizarNome(texto: string, nome: string | null | undefined): string {
  const first = primeiroNome(nome);
  return texto.replace(/\{\s*nome\s*\}/gi, first).replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Texto de repescagem sem IA: modelo da campanha (ou o padrão do grupo) + variações + nome + saída. */
export function textoModelo(modelo: string | null | undefined, grupo: GrupoCampanha, nome: string | null | undefined, rand: () => number = Math.random): string {
  const base = modelo?.trim() || MODELO_PADRAO[grupo === 'VISUALIZOU' ? 'VISUALIZOU' : 'NAO_VISUALIZOU'];
  return garantirSair(personalizarNome(resolverSpintax(base, rand), nome));
}

// ---------------- Checagem do texto escrito pela IA ----------------

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ');
function palavras(s: string): Set<string> {
  return new Set(norm(s).split(/\s+/).filter((w) => w.length > 2 && w !== 'sair'));
}
/** Parecença por palavras (0 a 1, Jaccard). */
export function parecenca(a: string, b: string): number {
  const A = palavras(a), B = palavras(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;

/**
 * Limpa e confere o texto da IA. Devolve null quando não serve (aí vai o texto modelo):
 * vazio/curto/longo demais, parecido demais com a mensagem original ou com a repescagem anterior, link que não estava
 * na campanha, marcador sem preencher, ou fala de ter visto a leitura (pressão).
 */
export function validarTextoIa(bruto: string, anteriores: string[]): string | null {
  let t = (bruto ?? '').trim().replace(/^```[a-z]*|```$/gi, '').trim();
  t = t.replace(/^(mensagem|resposta|texto)\s*:\s*/i, '').replace(/^["“']+|["”']+$/g, '').trim();
  if (t.length < 15 || t.length > 600) return null;
  if (/\[[^\]]*\]|\{[^}]*\}|<[^>]+>/.test(t)) return null;
  if (/visualiz|deixou no vist|(vi|notei|percebi) que (voce|vc) (leu|viu)/.test(norm(t).replace(/\s+/g, ' '))) return null;
  const permitidos = new Set(anteriores.flatMap((a) => a.match(URL_RE) ?? []));
  for (const u of t.match(URL_RE) ?? []) if (!permitidos.has(u)) return null;
  for (const a of anteriores) if (a && parecenca(t, a) >= 0.6) return null;
  return garantirSair(t);
}
