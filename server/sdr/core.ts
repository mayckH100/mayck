/**
 * SDR com IA — regras puras (sem banco): pontuação, temperatura, funil, cadências padrão, modelos com variáveis,
 * horário comercial e quais canais podem ser usados com cada lead (consentimento, opt-out e canal de entrada).
 */
import { safeTz, zonedParts } from '../agenda/time.js';

export const STAGES = ['NOVO', 'CONTATADO', 'RESPONDEU', 'QUALIFICADO', 'REUNIAO', 'GANHO', 'PERDIDO'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  NOVO: 'Novo', CONTATADO: 'Contatado', RESPONDEU: 'Respondeu', QUALIFICADO: 'Qualificado', REUNIAO: 'Reunião marcada', GANHO: 'Ganho', PERDIDO: 'Perdido',
};
export const FINAL_STAGES: Stage[] = ['GANHO', 'PERDIDO'];
export const SOURCES = ['MANUAL', 'IMPORTACAO', 'WHATSAPP', 'FORMULARIO'] as const;
export type Source = (typeof SOURCES)[number];
export type Temperature = 'FRIO' | 'MORNO' | 'QUENTE';
export type Channel = 'WHATSAPP' | 'EMAIL';

/** O funil só anda para a frente pela automação (o vendedor pode mover para qualquer etapa na tela). */
export function advanceStage(cur: string, next: Stage): Stage {
  const a = STAGES.indexOf(cur as Stage), b = STAGES.indexOf(next);
  if (a < 0) return next;
  if (FINAL_STAGES.includes(cur as Stage)) return cur as Stage;
  return b > a ? next : (cur as Stage);
}

// ---------- Perguntas e pontuação ----------
export interface Question { id: string; pergunta: string; peso: number }
export const DEFAULT_QUESTIONS: Question[] = [
  { id: 'necessidade', pergunta: 'O que você precisa resolver?', peso: 35 },
  { id: 'porte', pergunta: 'Qual o tamanho da sua empresa (pessoas/clientes por mês)?', peso: 20 },
  { id: 'prazo', pergunta: 'Para quando você precisa?', peso: 25 },
  { id: 'orcamento', pergunta: 'Quanto pensa investir?', peso: 20 },
];

/** Normaliza as perguntas configuradas (máx. 8; id simples; peso 1–100). */
export function normalizeQuestions(list: unknown): Question[] {
  if (!Array.isArray(list)) return [];
  const out: Question[] = [];
  const seen = new Set<string>();
  for (const q of list.slice(0, 8)) {
    const pergunta = String((q as any)?.pergunta ?? '').trim().slice(0, 200);
    if (!pergunta) continue;
    let id = String((q as any)?.id ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]/g, '').slice(0, 30);
    if (!id) id = pergunta.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || `q${out.length + 1}`;
    while (seen.has(id)) id = `${id}_${out.length + 1}`;
    seen.add(id);
    const peso = Math.min(100, Math.max(1, Math.round(Number((q as any)?.peso) || 25)));
    out.push({ id, pergunta, peso });
  }
  return out;
}

export interface Answer { resposta: string; nota: number }
export type Answers = Record<string, Answer>;

/** Pontuação 0–100: média das notas (0–100) das respostas, ponderada pelo peso; pergunta sem resposta vale 0. */
export function computeScore(questions: Question[], answers: Answers): number {
  if (!questions.length) return 0;
  let total = 0, sum = 0;
  for (const q of questions) {
    total += q.peso;
    const a = answers[q.id];
    if (a && a.resposta) sum += q.peso * Math.min(100, Math.max(0, Number(a.nota) || 0));
  }
  return total ? Math.round(sum / total) : 0;
}

export function temperatureOf(score: number, warm = 40, hot = 70): Temperature {
  if (score >= hot) return 'QUENTE';
  if (score >= warm) return 'MORNO';
  return 'FRIO';
}

export const answeredCount = (questions: Question[], answers: Answers) => questions.filter((q) => answers[q.id]?.resposta).length;

/** Junta as respostas novas da IA às antigas (resposta vazia não apaga a anterior). */
export function mergeAnswers(questions: Question[], old: Answers, fresh: Record<string, unknown>): Answers {
  const out: Answers = {};
  for (const q of questions) {
    const n = fresh?.[q.id] as any;
    const resposta = typeof n === 'object' && n ? String(n.resposta ?? '').trim().slice(0, 300) : '';
    if (resposta) out[q.id] = { resposta, nota: Math.min(100, Math.max(0, Math.round(Number(n.nota) || 0))) };
    else if (old[q.id]?.resposta) out[q.id] = old[q.id];
  }
  return out;
}

/** Lê o JSON da extração da IA de forma tolerante (cercas de código, texto em volta). */
export function parseExtraction(raw: string): { respostas: Record<string, unknown>; resumo: string } | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```(json)?/gi, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(cleaned.slice(start, end + 1));
    const respostas = j && typeof j.respostas === 'object' && j.respostas ? j.respostas : {};
    return { respostas, resumo: String(j.resumo ?? '').trim().slice(0, 200) };
  } catch {
    return null;
  }
}

// ---------- Cadências ----------
export interface Step { dia: number; canal: Channel; assunto?: string; texto: string }

export function normalizeSteps(list: unknown): Step[] {
  if (!Array.isArray(list)) return [];
  const out: Step[] = [];
  for (const s of list.slice(0, 12)) {
    const canal = String((s as any)?.canal ?? '').toUpperCase() === 'EMAIL' ? 'EMAIL' : 'WHATSAPP';
    const texto = String((s as any)?.texto ?? '').trim().slice(0, 2000);
    if (!texto) continue;
    const dia = Math.min(60, Math.max(0, Math.round(Number((s as any)?.dia) || 0)));
    const assunto = canal === 'EMAIL' ? String((s as any)?.assunto ?? '').trim().slice(0, 150) || 'Contato da {minha_empresa}' : undefined;
    out.push({ dia, canal, ...(assunto ? { assunto } : {}), texto });
  }
  return out.sort((a, b) => a.dia - b.dia);
}

export const SEGMENTS: { id: string; label: string }[] = [
  { id: 'geral', label: 'Geral' },
  { id: 'software', label: 'Software e serviços B2B' },
  { id: 'saude', label: 'Clínicas e consultórios' },
  { id: 'beleza', label: 'Salão e barbearia' },
  { id: 'varejo', label: 'Lojas e comércio' },
  { id: 'alimentacao', label: 'Restaurantes e delivery' },
  { id: 'servicos', label: 'Prestadores de serviço' },
  { id: 'seguros', label: 'Corretora de seguros' },
];
export const segmentLabel = (id: string | null | undefined) => SEGMENTS.find((s) => s.id === id)?.label ?? 'Geral';

const OFERTA: Record<string, string> = {
  geral: 'te mostrar como podemos te ajudar',
  software: 'te mostrar a plataforma funcionando numa conversa rápida de 20 minutos',
  saude: 'te ajudar a marcar sua consulta ou avaliação',
  beleza: 'reservar um horário para você',
  varejo: 'te ajudar a escolher e separar o que você precisa',
  alimentacao: 'te mandar o cardápio e as opções do dia',
  servicos: 'agendar uma visita ou um orçamento sem compromisso',
  seguros: 'fazer uma cotação sem compromisso',
};

/** Cadência pronta do segmento: o cliente não precisa configurar nada. Cada lead recebe só os passos dos canais permitidos para ele. */
export function defaultCadenceSteps(segment: string): Step[] {
  const oferta = OFERTA[segment] ?? OFERTA.geral;
  return [
    { dia: 0, canal: 'WHATSAPP', texto: `Oi {primeiro_nome}, tudo bem? Aqui é da {minha_empresa} 😊 Ficou alguma dúvida? Posso ${oferta}.` },
    { dia: 1, canal: 'EMAIL', assunto: '{primeiro_nome}, posso te ajudar?', texto: `Olá, {primeiro_nome}!\n\nAqui é da {minha_empresa}. Vi o seu interesse e queria saber se posso ${oferta}.\n\nÉ só responder este e-mail ou chamar a gente no WhatsApp.\n\nAbraço,\nEquipe {minha_empresa}` },
    { dia: 3, canal: 'WHATSAPP', texto: `Oi {primeiro_nome}! Passando para saber se ainda posso te ajudar. Se quiser, é só me dizer o melhor dia e horário 😉` },
    { dia: 6, canal: 'EMAIL', assunto: 'Ainda faz sentido para você, {primeiro_nome}?', texto: `Olá, {primeiro_nome}!\n\nSei que a rotina é corrida. Se ainda fizer sentido, posso ${oferta}. Se não for o momento, tudo bem também.\n\nEquipe {minha_empresa}` },
    { dia: 9, canal: 'WHATSAPP', texto: `Oi {primeiro_nome}, vou encerrar por aqui para não te incomodar. Quando precisar, é só chamar. Obrigado! 🙏` },
  ];
}

export const VARIABLES = ['{nome}', '{primeiro_nome}', '{empresa}', '{segmento}', '{minha_empresa}'];

/** Troca as variáveis do modelo. `esc` escapa os valores (e-mail em HTML). */
export function renderTemplate(tpl: string, v: { nome?: string | null; empresa?: string | null; segmento?: string | null; minhaEmpresa?: string | null }, esc: (s: string) => string = (s) => s): string {
  const nome = (v.nome ?? '').trim();
  const map: Record<string, string> = {
    nome: nome || 'tudo bem',
    primeiro_nome: nome.split(/\s+/)[0] || 'olá',
    empresa: (v.empresa ?? '').trim() || 'sua empresa',
    segmento: segmentLabel(v.segmento).toLowerCase(),
    minha_empresa: (v.minhaEmpresa ?? '').trim() || 'nossa empresa',
  };
  return tpl.replace(/\{\s*(nome|primeiro_nome|empresa|segmento|minha_empresa)\s*\}/g, (_m, k: string) => esc(map[k]));
}

// ---------- Horário comercial ----------
const hm = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
export function inBusinessHours(s: { workStart: string; workEnd: string; workDays: string }, now: Date, tz?: string | null): boolean {
  const p = zonedParts(now, safeTz(tz ?? undefined));
  const days = String(s.workDays || '').split(',').map((d) => Number(d.trim())).filter((d) => d >= 0 && d <= 6);
  if (!days.includes(p.weekday)) return false;
  const cur = p.hour * 60 + p.minute, a = hm(s.workStart), b = hm(s.workEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return cur >= a && cur < b;
}

// ---------- Canais permitidos ----------
export interface LeadForRules { source: string; phone: string | null; email: string | null; consentAt: Date | null; optOutAt: Date | null }
/**
 * WhatsApp: só para quem iniciou a conversa no WhatsApp ou deu consentimento (lead frio importado sem consentimento: nunca).
 * E-mail: só com e-mail e nunca para quem chegou pelo WhatsApp (a conversa continua no canal de entrada).
 * Opt-out bloqueia os dois.
 */
export function channelAllowed(lead: LeadForRules, canal: Channel): { ok: boolean; reason?: string } {
  if (lead.optOutAt) return { ok: false, reason: 'pediu para sair' };
  if (canal === 'WHATSAPP') {
    if (!lead.phone) return { ok: false, reason: 'sem telefone' };
    if (lead.source !== 'WHATSAPP' && !lead.consentAt) return { ok: false, reason: 'sem consentimento para WhatsApp' };
    return { ok: true };
  }
  if (!lead.email) return { ok: false, reason: 'sem e-mail' };
  if (lead.source === 'WHATSAPP') return { ok: false, reason: 'lead do WhatsApp: segue no canal de entrada' };
  return { ok: true };
}

export const DAY_MS = 24 * 3600 * 1000;

/** Data do passo `i` a partir do início da cadência. */
export function stepDueAt(start: Date, steps: Step[], i: number): Date | null {
  const s = steps[i];
  return s ? new Date(start.getTime() + s.dia * DAY_MS) : null;
}

const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
export const normalizeEmail = (e: unknown): string | null => {
  const s = String(e ?? '').trim().toLowerCase();
  return s && EMAIL_RE.test(s) ? s : null;
};
/** Telefone brasileiro/internacional → E.164 (+55 assumido para 10–11 dígitos). */
export function normalizePhone(p: unknown): string | null {
  let d = String(p ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (d.length < 12 || d.length > 15) return null;
  return '+' + d;
}

export const OPT_OUT_WORDS = /^\s*(sair|parar|pare|stop|descadastrar|cancelar inscri[cç][aã]o)\s*[.!]*\s*$/i;

// ---------- Kanban do MCKBOT (v1.19.0) ----------
const normName = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Nome da etapa do Kanban → etapa do SDR (null = não corresponde a nenhuma). */
export function kanbanNameToStage(name: string): Stage | null {
  const n = normName(name);
  if (/^(ganh|won\b|venda fechada|fechad|cliente\b)/.test(n)) return 'GANHO';
  if (/^(perd|lost\b|venda perdida|cancelad|descartad)/.test(n)) return 'PERDIDO';
  if (/^(reuniao|demonstracao|demo\b|visita agendada)/.test(n)) return 'REUNIAO';
  if (/^qualificad/.test(n)) return 'QUALIFICADO';
  if (/^(respondeu|interessad)/.test(n)) return 'RESPONDEU';
  if (/^(contatado|em contato|contato feito|abordad)/.test(n)) return 'CONTATADO';
  if (/^(novo|nova|lead novo|novos)\b/.test(n)) return 'NOVO';
  return null;
}

/** Etapa do SDR → etapa existente do Kanban (a primeira, na ordem do funil, cujo nome corresponde). */
export function kanbanTargetFor<T extends { name: string; position: number }>(stage: Stage, stages: T[]): T | null {
  return [...stages].sort((a, b) => a.position - b.position).find((s) => kanbanNameToStage(s.name) === stage) ?? null;
}
