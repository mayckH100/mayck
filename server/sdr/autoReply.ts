/**
 * Identificador de resposta automática (v1.22.0) — local, sem IA e sem gastar cota.
 *
 * Quando o SDR ou uma campanha do MCK Mensagens manda mensagem, muitos leads têm resposta automática ligada:
 * saudação/ausência do WhatsApp Business, "obrigado pelo contato, retornaremos em breve", horário de atendimento,
 * menus "digite 1 para...", respostas rápidas do celular ("estou dirigindo", Modo Foco/Não Perturbe), apps de
 * auto-resposta e "fora do escritório" no e-mail. Isso NÃO é o lead respondendo: não qualifica, não pontua, não muda
 * etapa, não para a cadência, não vira opt-out/objeção e a IA não responde (evita robô conversando com robô).
 *
 * Regras por padrões em PT-BR/EN/ES + sinais de tempo (resposta em poucos segundos após o nosso envio), repetição
 * (mesmo texto já recebido do mesmo contato) e cabeçalhos de e-mail. Mensagem com sinal claro de pessoa ("tenho
 * interesse", "me manda o valor", "pode me ligar") só é automática quando há sinal de sistema (menu, "mensagem
 * automática", frase da empresa, cabeçalho) ou uma saudação de empresa muito forte.
 *
 * Função pura: nada de banco aqui (ver autoReplyService.ts).
 */

export type Confianca = 'alta' | 'media' | 'baixa';
export interface AutoReplyResult {
  automatica: boolean;
  confianca: Confianca;
  /** Motivo curto para a equipe (ex.: "frase de saudação de empresa; resposta em poucos segundos"). */
  motivo: string;
  /** Pontuação interna (≥ 4 = automática; 3–5 = faixa de dúvida). */
  pontos: number;
  /** Havia sinal claro de pessoa (interesse, pedido de valor, pedido para ligar). */
  humano: boolean;
}

export interface AutoReplyContext {
  /** Milissegundos desde o nosso último envio para este contato (WhatsApp). */
  msDesdeEnvio?: number | null;
  /** Mesmo texto já recebido antes deste contato. */
  repetida?: boolean;
  /** Frases extras cadastradas pela empresa (comparadas sem acento/maiúsculas). */
  frasesExtras?: string[];
  /** Cabeçalhos do e-mail (Auto-Submitted, X-Autoreply, Precedence...). */
  headers?: Record<string, unknown> | null;
  /** Assunto do e-mail. */
  assunto?: string | null;
}

type Cat = 'sistema' | 'empresa' | 'pessoal';
interface Regra { re: RegExp; peso: number; cat: Cat; motivo: string }

/** Minúsculas, sem acento, sem marcação do WhatsApp (*negrito*, _itálico_, ~riscado~), espaços únicos. */
export function normalizeText(s: string): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const R = (re: RegExp, peso: number, cat: Cat, motivo: string): Regra => ({ re, peso, cat, motivo });
const M_SIS = 'mensagem automática declarada';
const M_MENU = 'menu de opções';
const M_EMP = 'saudação/ausência de empresa';
const M_HOR = 'horário de atendimento';
const M_CEL = 'resposta automática do celular';
const M_AUS = 'aviso de ausência';

/** Padrões (texto já normalizado: sem acento e minúsculo). */
const REGRAS: Regra[] = [
  // ---- Sistema: declara que é automática, menu, app de auto-resposta ----
  R(/\b(mensagem|resposta|msg) automatica\b/, 6, 'sistema', M_SIS),
  R(/\b(enviad[ao]|gerad[ao]|respondid[ao]) automaticamente\b/, 6, 'sistema', M_SIS),
  R(/\bauto[- ]?(reply|replies|resposta|respuesta|responder|respond)\b/, 6, 'sistema', M_SIS),
  R(/\bautomatic (reply|response|message)\b/, 6, 'sistema', M_SIS),
  R(/\b(respuesta|mensaje) automatic[oa]\b/, 6, 'sistema', M_SIS),
  R(/\b(digite|tecle|responda com|escolha|selecione|pressione|disque|envie (o numero|apenas o numero)|marque|escriba|escribe|presione|press|reply with|type)\s+(a opcao |o numero |el numero |la opcion |the number |option )?\d{1,2}\b/, 6, 'sistema', M_MENU),
  R(/\b(escolha|selecione|digite) (uma das|a) opc(ao|oes)\b/, 5, 'sistema', M_MENU),
  R(/\b(elija|seleccione) una (de las )?opcion/, 5, 'sistema', M_MENU),
  R(/\bplease (choose|select) (an|one) option\b/, 5, 'sistema', M_MENU),
  R(/\bnotificac(ao|oes) (silenciad|desativad)/, 5, 'sistema', M_CEL),
  R(/\b(has|have) notifications silenced\b|\bnotifications (are )?silenced\b/, 5, 'sistema', M_CEL),
  R(/\bnotificaciones silenciadas\b/, 5, 'sistema', M_CEL),

  // ---- Empresa: saudação, ausência, horário de atendimento, regras do canal ----
  R(/\bagradece (o |seu |o seu |pelo |sua |a sua )?(contato|mensagem|preferencia)\b/, 4, 'empresa', M_EMP),
  R(/\b(obrigad[oa]|agradecemos|grat[oa]) (por|pelo|pela) (entrar em |seu |o seu |sua |a sua )?(contato|mensagem)\b/, 3, 'empresa', M_EMP),
  R(/\b(retornaremos|responderemos|retornamos|entraremos em contato|daremos retorno)\b/, 4, 'empresa', M_EMP),
  R(/\b(sua mensagem|seu contato|sua solicitacao) (foi recebid|e muito importante|foi registrad|sera respondid)/, 4, 'empresa', M_EMP),
  R(/\brecebemos (a )?sua (mensagem|solicitacao)\b/, 4, 'empresa', M_EMP),
  R(/\bem breve (um|uma|nossa|nosso|o|a) ?(de nossos |dos nossos |das nossas )?(atendente|consultor|consultora|especialista|equipe|colaborador|vendedor)/, 4, 'empresa', M_EMP),
  R(/\baguarde[^.!?\n]{0,40}(atendid|atendente|retorn|responder)/, 4, 'empresa', M_EMP),
  R(/\bseja (muito )?bem[- ]?vind[oa]\b/, 3, 'empresa', M_EMP),
  R(/\b(como|em que) (podemos|posso) (te |lhe )?(ajudar|ser util)\b/, 2, 'empresa', M_EMP),
  R(/\bno momento (nao estamos|estamos fora|nao podemos|estamos ausentes|nao conseguimos|estamos fechados|estamos em atendimento)\b/, 4, 'empresa', M_AUS),
  R(/\bestamos (ausentes|fora do escritorio|indisponiveis|em horario de almoco|fechados|fora do horario)\b/, 4, 'empresa', M_AUS),
  R(/\b(nosso|o nosso) horario de (atendimento|funcionamento)\b/, 4, 'empresa', M_HOR),
  R(/\bhorario de (atendimento|funcionamento)\b/, 2, 'empresa', M_HOR),
  R(/\bfora do (nosso )?horario( de atendimento| comercial)?\b/, 3, 'empresa', M_HOR),
  R(/\batendemos de (segunda|seg)\b/, 4, 'empresa', M_HOR),
  R(/\b(segunda|seg)\.? ?(a|-|ate) ?(sexta|sex|sabado|sab)\b[^.!?\n]{0,30}\b(das?|de) ?\d/, 3, 'empresa', M_HOR),
  R(/\bnao (atendemos|recebemos|aceitamos) (chamadas|ligacoes|ligacao|audios?|chamada)\b/, 4, 'empresa', 'regras do canal da empresa'),
  R(/\bnao (ouvimos|escutamos) (mensagens de voz|audios?)\b/, 4, 'empresa', 'regras do canal da empresa'),
  R(/\bpedimos que (envie|aguarde|nos envie|deixe|entre em contato)\b/, 3, 'empresa', M_EMP),
  R(/\bagradecemos a (sua )?(compreensao|preferencia|paciencia)\b/, 3, 'empresa', M_EMP),
  R(/\bpara agilizar (o |seu |o seu )?atendimento\b/, 3, 'empresa', M_EMP),
  R(/\bneste canal\b/, 2, 'empresa', 'regras do canal da empresa'),
  // EN
  R(/\bout of (the )?office\b/, 5, 'empresa', M_AUS),
  R(/\bthank(s| you) for (your message|contacting|reaching out|getting in touch|your email)\b/, 3, 'empresa', M_EMP),
  R(/\b(we will|we'll|we shall) (get back|respond|reply|answer|contact you)\b/, 4, 'empresa', M_EMP),
  R(/\bwe (have )?received your (message|email|request)\b/, 4, 'empresa', M_EMP),
  R(/\b(our )?(business|office|opening) hours\b/, 3, 'empresa', M_HOR),
  R(/\b(we are|we're) (currently )?(closed|away|unavailable|out of the office)\b/, 4, 'empresa', M_AUS),
  // ES
  R(/\bgracias por (contactar|contactarnos|comunicarte|comunicarse|escribir|escribirnos|tu mensaje|su mensaje)\b/, 3, 'empresa', M_EMP),
  R(/\b(responderemos|contestaremos|nos pondremos en contacto|le atenderemos|te atenderemos)\b/, 4, 'empresa', M_EMP),
  R(/\bhemos recibido (tu|su) mensaje\b/, 4, 'empresa', M_EMP),
  R(/\bhorario de atencion\b/, 3, 'empresa', M_HOR),
  R(/\bfuera de (la oficina|horario|nuestro horario)\b/, 4, 'empresa', M_AUS),
  R(/\ben este momento no (podemos|estamos)\b/, 4, 'empresa', M_AUS),

  // ---- Celular pessoal: dirigindo, reunião, férias, Não Perturbe, respostas rápidas ----
  R(/\bestou (dirigindo|no transito|ao volante|pilotando)\b/, 4, 'pessoal', M_CEL),
  R(/\b(no transito|dirigindo agora)\b/, 2, 'pessoal', M_CEL),
  R(/\b(no momento|agora|neste momento) nao (posso|consigo|estou podendo) (atender|responder|falar)\b/, 4, 'pessoal', M_CEL),
  R(/\b(nao posso|nao consigo) (falar|atender|responder) (agora|no momento)\b/, 4, 'pessoal', M_CEL),
  R(/\b(estou|to|tou) (em reuniao|em atendimento|em cirurgia|de plantao|em aula|em consulta|em procedimento|ocupad[oa]|indisponivel|ausente|sem sinal)\b/, 4, 'pessoal', M_CEL),
  R(/\b(respondo|retorno|te respondo|te retorno|ja respondo|ja te respondo|falo com (voce|vc)|te chamo|retorno o contato|retorno sua mensagem|respondo sua mensagem)\s+(depois|mais tarde|em breve|assim que|logo|quando|ja ja|jaja|o mais rapido|o quanto antes)\b/, 3, 'pessoal', M_CEL),
  R(/\b(responderei|retornarei|entrarei em contato|retornarei o contato)\b/, 4, 'pessoal', M_AUS),
  R(/\b(te|lhe) ligo (depois|mais tarde|em breve|assim que)\b|\bligo (pra|para) (voce|vc) (depois|mais tarde)\b/, 3, 'pessoal', M_CEL),
  R(/\b(estou|estarei) de (ferias|folga|licenca|recesso)\b/, 4, 'pessoal', M_AUS),
  R(/\b(viajando|ausente|fora|de ferias|de licenca) ate (o dia |dia |a data )?\d/, 4, 'pessoal', M_AUS),
  R(/\b(modo )?nao perturbe\b|\bmodo foco\b/, 4, 'pessoal', M_CEL),
  // EN
  R(/\bi(?: am|'m) (currently )?(driving|in a meeting|on vacation|on holiday|on leave|away|out of (the )?office|unavailable|busy right now)\b/, 4, 'pessoal', M_CEL),
  R(/\b(can't|cannot|can not|unable to) (talk|answer|respond|reply) (right )?now\b/, 4, 'pessoal', M_CEL),
  R(/\b(i will|i'll) (get back|respond|reply|answer|call you) (to you )?(later|soon|as soon|when)\b/, 3, 'pessoal', M_CEL),
  R(/\bdo not disturb\b|\bfocus mode\b/, 4, 'pessoal', M_CEL),
  // ES
  R(/\bestoy (manejando|conduciendo|en (una )?reunion|de vacaciones|ocupad[oa]|fuera de la oficina|en consulta)\b/, 4, 'pessoal', M_CEL),
  R(/\bno puedo (hablar|atender|contestar|responder) (ahora|en este momento)\b/, 4, 'pessoal', M_CEL),
  R(/\b(te|le) (respondo|contesto|llamo|escribo) (luego|despues|mas tarde|pronto|en breve|a la brevedad)\b/, 3, 'pessoal', M_CEL),
  R(/\bno molestar\b/, 4, 'pessoal', M_CEL),
];

/** Sinais claros de uma pessoa respondendo de verdade (interesse, pedido de valor, pedido de contato). */
const HUMANO: RegExp[] = [
  /\b(tenho|tem|temos|teria) interesse\b/, /\binteressad[oa]s?\b/, /\bme interess/,
  /\bquanto (custa|fica|e|sai|cobra|cobram|seria)\b/, /\b(qual|quais) (e |seria )?(o |os )?(valor|valores|preco|precos)\b/,
  /\b(me|nos) (manda|mande|envia|envie|passa|passe|liga|ligue|chama|chame|explica|explique)\b/, /\bpode (me )?(mandar|enviar|ligar|chamar|passar|explicar)\b/,
  /\bquero (sim|saber|conhecer|contratar|o|a|um|uma|mais)\b/, /\bgostaria de\b/, /\bcomo funciona\b/, /\bvamos (marcar|agendar|conversar)\b/,
  /\bsim,? (quero|tenho|pode)\b/, /\bpode sim\b/,
  // Pergunta do lead sobre a empresa ("qual o horário de atendimento?", "vocês atendem sábado?").
  /^(oi|ola|bom dia|boa tarde|boa noite)?[ ,!.]*(qual|quais|quanto|quantos|quantas|onde|quando|voces|vcs|tem|teria|aceita|aceitam|atende|atendem|faz|fazem|funciona|funcionam)\b[^?]{0,120}\?\s*$/,
  // EN / ES
  /\b(i'm|i am|we're|we are) interested\b/, /\bhow much\b/, /\bsend me\b/, /\bcall me\b/,
  /\bme interesa\b/, /\bcuanto (cuesta|vale|sale)\b/, /\b(mandame|enviame|llamame)\b/,
];

/** Linhas de menu ("1 - Financeiro", "2) Agendar", "1️⃣ Vendas"). */
function menuLines(original: string): number {
  return String(original ?? '').split(/\n/).filter((l) => /^\s*(\d{1,2}|[0-9]\ufe0f?\u20e3)\s*[-–—).:]?\s*[A-Za-zÀ-ÿ]/.test(l) && /^\s*(\d{1,2}\s*[-–—).:]|[0-9]\ufe0f?\u20e3)/.test(l)).length;
}

function headerValue(h: Record<string, unknown> | null | undefined, name: string): string {
  if (!h || typeof h !== 'object') return '';
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  const v = k ? h[k] : '';
  return (Array.isArray(v) ? v.join(' ') : String(v ?? '')).slice(0, 300);
}

/** Cabeçalhos padrão de resposta automática de e-mail (RFC 3834 e variantes). */
export function autoReplyHeaders(h: Record<string, unknown> | null | undefined): boolean {
  const auto = headerValue(h, 'Auto-Submitted').toLowerCase().trim();
  if (auto && auto !== 'no') return true;
  if (headerValue(h, 'X-Autoreply') || headerValue(h, 'X-Autorespond') || headerValue(h, 'X-Autoresponder')) return true;
  if (headerValue(h, 'X-Auto-Response-Suppress').toLowerCase().includes('all')) return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(headerValue(h, 'Precedence').trim())) return true;
  return false;
}

/** Assunto típico de resposta automática de e-mail. */
export const AUTO_SUBJECT_RE = /^\s*(auto(matic)?\s*(reply|resposta|response)|resposta autom[aá]tica|respuesta autom[aá]tica|out of (the )?office|ausente|aus[eê]ncia|f[eé]rias|fora do escrit[oó]rio|fuera de la oficina|vacaciones)/i;

export function detectAutoReply(text: string, ctx: AutoReplyContext = {}): AutoReplyResult {
  const original = String(text ?? '');
  const t = normalizeText(original);
  let pontos = 0;
  let sistema = 0, empresa = 0, pessoal = 0;
  const motivos: string[] = [];
  const add = (p: number, cat: Cat | 'extra', motivo: string) => {
    pontos += p;
    if (cat === 'sistema') sistema += p; else if (cat === 'empresa') empresa += p; else if (cat === 'pessoal') pessoal += p;
    if (!motivos.includes(motivo)) motivos.push(motivo);
  };

  if (ctx.headers && autoReplyHeaders(ctx.headers)) add(10, 'sistema', 'cabeçalho de resposta automática do e-mail');
  if (ctx.assunto && AUTO_SUBJECT_RE.test(ctx.assunto)) add(6, 'sistema', 'assunto de resposta automática');

  for (const r of REGRAS) if (r.re.test(t)) add(r.peso, r.cat, r.motivo);
  if (menuLines(original) >= 3) add(5, 'sistema', M_MENU);

  for (const f of ctx.frasesExtras ?? []) {
    const nf = normalizeText(f);
    if (nf.length >= 4 && t.includes(nf)) { add(6, 'sistema', 'frase cadastrada pela empresa'); break; }
  }

  // Formatação típica de saudação: vários trechos em *negrito* e ícones de aviso.
  const bold = (original.match(/\*[^*\n]{2,}\*/g) ?? []).length;
  let fmt = 0;
  if (bold >= 2) fmt++;
  if (/[⚠️📌⏰🕐🕘📞☎️🔔❗‼️]/u.test(original) && original.length > 60) fmt++;
  if (fmt && pontos > 0) add(Math.min(fmt, 2), 'extra', 'formatação típica de mensagem de saudação');

  const temTexto = t.length >= 2;
  if (ctx.repetida && t.length >= 15) add(t.length >= 40 ? 4 : 3, 'extra', 'mesmo texto já recebido deste contato');
  if (temTexto && typeof ctx.msDesdeEnvio === 'number' && ctx.msDesdeEnvio >= 0) {
    if (ctx.msDesdeEnvio <= 15_000) add(2, 'extra', 'resposta em poucos segundos após o nosso envio');
    else if (ctx.msDesdeEnvio <= 60_000) add(1, 'extra', 'resposta em menos de 1 minuto após o nosso envio');
  }

  const humano = HUMANO.some((re) => re.test(t));
  // Pessoa de verdade ("estou em reunião, mas tenho interesse, me manda o valor"): só é automática com sinal de
  // sistema, texto repetido longo ou saudação de empresa muito forte (várias frases típicas juntas).
  const travaHumano = humano && sistema === 0 && empresa < 7 && !(ctx.repetida && t.length >= 40);
  if (travaHumano) {
    return { automatica: false, confianca: 'baixa', motivo: 'mensagem com sinal de pessoa (interesse, pedido ou pergunta)', pontos, humano };
  }
  const confianca: Confianca = pontos >= 6 ? 'alta' : pontos >= 3 ? 'media' : 'baixa';
  const automatica = pontos >= 4 && (sistema + empresa + pessoal > 0 || !!ctx.repetida);
  return { automatica, confianca, motivo: motivos.slice(0, 4).join('; ') || 'sem sinais de resposta automática', pontos, humano };
}

/** Marca gravada em `Message.error` das mensagens recebidas que são resposta automática (sem migração). */
export const AUTO_MARK = 'AUTORESPOSTA';
export const autoMarkOf = (motivo: string) => `${AUTO_MARK}: ${motivo}`.slice(0, 300);
export const isAutoMarked = (error: string | null | undefined) => !!error && error.startsWith(AUTO_MARK);
/** Filtro Prisma: mensagens que NÃO são resposta automática (para o histórico que a IA lê). */
export const notAutoReply = { OR: [{ error: null }, { NOT: { error: { startsWith: AUTO_MARK } } }] };
