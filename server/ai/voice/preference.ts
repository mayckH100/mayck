/**
 * Voz da IA — preferência do cliente por conversa (áudio ou texto), automática e humanizada.
 * Funções puras (testáveis): detector por palavras (sem chamada extra de IA), decisão de áudio,
 * marcadores do histórico e a parte do prompt que conta para a IA o que ela realmente consegue fazer.
 */
import { normalize } from '../../flows/logic.js';
import { decideReplyAsAudio } from './spoken.js';

export type VoicePreference = 'audio' | 'texto';
export const isVoicePreference = (v: unknown): v is VoicePreference => v === 'audio' || v === 'texto';

/** Marcadores do histórico enviado à IA (nunca vão para o cliente; saem da resposta se a IA copiar). */
export const MARK_AI_AUDIO = '[enviado como áudio]';
export const MARK_CLIENT_AUDIO = '[áudio do cliente, transcrito]';
const MARKER_RE = /\[\s*(?:enviado como [áa]udio|[áa]udio do cliente(?:,\s*transcrito)?)\s*\]\s*/gi;
export const stripVoiceMarkers = (t: string) => t.replace(MARKER_RE, '').replace(/[ \t]{2,}/g, ' ').trim();

// Palavras que nomeiam o áudio (texto já normalizado: sem acento, minúsculo).
const AUDIO = String.raw`(?:audios?|audiozinho|audinho|nota de voz|mensagem de voz|msg de voz|voz)`;
// Pedido: verbo/expressão de pedido seguido (até 5 palavras "de ligação") do áudio.
const ASK = String.raw`(?:manda|mande|mandar|manda ai|envia|envie|enviar|grava|grave|gravar|fala|fale|falar|responde|responda|responder|explica|explique|explicar|pode|poderia|podia|consegue|prefiro|preferia|prefere|quero|queria|seria|melhor|bora)`;
const GLUE = String.raw`(?:me|mim|te|pra|para|um|uma|o|a|em|por|de|do|da|ser|so|mesmo|ai|isso|isto|esse|essa|via|outro|outra|novo|nova|mais|tambem|entao|favor|pfv|pf|mandar|enviar|falar|responder|explicar|gravar|resposta|mensagem|com|sim|agora|aqui|ne)`;
const AUDIO_ASK_RE = new RegExp(String.raw`\b${ASK}\b(?:\s+${GLUE}){0,5}\s+${AUDIO}\b`);
// "áudio, por favor", "por áudio é melhor", "áudio é melhor", "em áudio fica melhor".
const AUDIO_TRAIL_RE = new RegExp(String.raw`\b${AUDIO}\b\s*(?:,\s*)?(?:por favor|pfv|pf|e melhor|fica melhor|seria melhor|melhor|prefiro|pode ser|serve)\b`);
// Mensagem curtinha que é só o pedido: "por áudio", "em áudio?", "áudio pfv".
const AUDIO_SHORT_RE = new RegExp(String.raw`^(?:(?:pode ser |pode |entao |ok |tá |ta )?(?:por|em|no|num|via) ${AUDIO}|${AUDIO} (?:pfv|pf|por favor))[\s?!.]*$`);
// Motivos para preferir ouvir: não consegue ler, está dirigindo, "você estava falando comigo por áudio".
const AUDIO_REASON_RE = /\b(?:nao (?:consigo|sei|to conseguindo|estou conseguindo|da pra|posso) ler|(?:to|estou|tô|vou estar) dirigindo|prefiro ouvir|quero ouvir|melhor ouvir|(?:estava|tava|estavam|tavam|vinha) (?:falando|mandando|respondendo|conversando)(?: comigo| pra mim)? (?:por|em|com|no) audios?)\b/;

// Texto: recusa do áudio ("não precisa de áudio", "sem áudio", "não manda áudio").
const NO_AUDIO_RE = new RegExp(String.raw`\b(?:nao (?:precisa|precisa de|precisa mandar|precisa ser|manda|mande|envia|envie|grava|grave|quero|gosto de|curto|precisava)|sem|nada de|chega de|para de mandar|pare de mandar)\s+(?:(?:mais|mandar|enviar|me|o|um|de|por|em)\s+){0,2}${AUDIO}\b`);
// Texto: não consegue ouvir agora.
const CANT_LISTEN_RE = /\b(?:nao (?:consigo|da pra|posso|to podendo|estou podendo|tenho como|vou conseguir|consegui) (?:ouvir|escutar|abrir (?:o |os |seu |esse |teu )?audios?)|(?:to|estou|tô) sem (?:fone|som)|sem fone)\b/;
// Texto: pedido explícito de texto/escrita.
const TEXT_ASK_RE = /\b(?:(?:prefiro|preferia|melhor|pode ser|poderia ser|manda|mande|responde|responda|fala|fale|explica|explique|pode mandar|pode responder|so|somente|apenas|quero|queria)(?:\s+(?:me|por|em|pra|mim|de|o|a|so|mesmo|ai|isso))*\s+(?:texto|escrito|escrita|mensagem escrita|msg escrita)|por escrito|me escreve|me escreva|escreve ai|escreva ai|escreve pra mim|escreva pra mim|escreve por favor|escreva por favor|pode escrever|prefiro ler|digita|digite|manda digitado)\b/;
// "Estou no trabalho, escreve" — imperativo no começo de uma frase (e não "como se escreve").
const TEXT_IMPERATIVE_RE = /(?:^|[,.;!?]\s*)(?:escreve|escreva)\b(?!\s+(?:com|o nome|isso direito))/;

/**
 * O cliente pediu explicitamente áudio ou texto nesta mensagem? Devolve 'audio', 'texto' ou null.
 * Ordem: recusa/impedimento de ouvir → texto; motivo para ouvir ou pedido de áudio → áudio; pedido de texto → texto.
 */
export function detectVoicePreference(raw: string | null | undefined): VoicePreference | null {
  if (!raw) return null;
  const t = normalize(raw).replace(/[“”"']/g, '');
  if (!t || t.length > 600) return null; // mensagens longas: não é um pedido de formato
  if (/\bcomo se escreve\b/.test(t)) return null;
  if (NO_AUDIO_RE.test(t) || CANT_LISTEN_RE.test(t)) return 'texto';
  if (AUDIO_REASON_RE.test(t)) return 'audio';
  if (AUDIO_ASK_RE.test(t) || AUDIO_TRAIL_RE.test(t) || AUDIO_SHORT_RE.test(t)) return 'audio';
  if (TEXT_ASK_RE.test(t) || TEXT_IMPERATIVE_RE.test(t)) return 'texto';
  return null;
}

/**
 * Responder em áudio? Voz desligada: nunca. Preferência do cliente (pedido explícito) vale acima do modo da
 * empresa — inclusive "nunca_audio" (o cliente pediu áudio, ele recebe). Sem preferência: `espelhar`
 * (áudio responde áudio), `sempre_audio` ou `nunca_audio`.
 */
export function decideWithPreference(
  s: { voiceEnabled: boolean; voiceReplyMode: string } | null | undefined,
  inboundWasAudio: boolean,
  pref: string | null | undefined,
): boolean {
  if (!s?.voiceEnabled) return false;
  if (pref === 'audio') return true;
  if (pref === 'texto') return false;
  return decideReplyAsAudio(s, inboundWasAudio);
}

/**
 * Parte do prompt sobre voz e sobre como a IA se apresenta. Natural e humana: nada de "sou uma assistente
 * virtual que só conversa por texto". Só fala que é assistente virtual se o cliente perguntar diretamente.
 */
export function voicePromptSection(a: { voiceEnabled: boolean; replyAsAudio: boolean; pref: string | null | undefined; company?: string | null }): string {
  const company = (a.company ?? '').trim() || 'empresa';
  const lines = [
    '### COMO VOCÊ CONVERSA (texto e áudio)',
    `- Converse como uma pessoa da equipe da ${company}: natural, calorosa, sem falar de sistema, robô ou limitações técnicas.`,
    `- Não diga que é robô, IA ou assistente virtual, a não ser que o cliente pergunte diretamente. Se perguntar, responda com honestidade e simpatia, por exemplo: "Sou a assistente virtual da ${company}, mas pode falar comigo à vontade${a.voiceEnabled ? ', por áudio ou por texto' : ''}!"`,
    `- No histórico, ${MARK_AI_AUDIO} marca respostas suas que foram como nota de voz e ${MARK_CLIENT_AUDIO} marca áudios do cliente que você ouviu. Nunca escreva esses marcadores na resposta.`,
  ];
  if (a.voiceEnabled) {
    lines.push(
      '- Você pode responder por áudio (nota de voz); o sistema converte sua resposta em áudio quando apropriado. Nunca diga que só conversa por texto, nem que não consegue mandar ou ouvir áudio, nem negue áudios que você já mandou.',
      '- Se o cliente pedir áudio, simplesmente responda (ex.: "Claro! ..."), sem anunciar nada técnico: sua resposta já vai em áudio. Se pedir texto, simplesmente escreva, sem comentar a troca.',
      a.replyAsAudio
        ? '- Esta resposta vai como ÁUDIO: escreva como fala natural de WhatsApp, frases curtas, sem listas longas, sem emojis e sem escrever "[áudio]".'
        : a.pref === 'texto'
          ? '- O cliente prefere texto nesta conversa: esta resposta vai por escrito.'
          : '- Esta resposta vai por escrito.',
    );
  } else {
    lines.push(
      '- No momento as respostas são por texto. Se o cliente pedir áudio, diga com leveza que agora consegue responder por escrito e siga ajudando — sem dizer que é robô e sem negar áudios que já tenham sido enviados nesta conversa.',
    );
  }
  return lines.join('\n');
}

/** Conteúdo de uma mensagem do histórico para a IA, com o marcador quando foi áudio. */
export function historyContent(m: { direction: string; sender?: string | null; type?: string | null; body?: string | null; transcript?: string | null }, clean: (s: string) => string = (s) => s): string {
  const audio = m.type === 'audio' || m.type === 'voice' || m.type === 'ptt';
  if (m.direction === 'IN') {
    const said = m.transcript ?? m.body ?? '';
    return audio && m.transcript ? `${MARK_CLIENT_AUDIO} ${said}` : said;
  }
  const said = clean(m.transcript && audio ? m.transcript : m.body ?? '');
  return audio && m.sender === 'ai' ? `${MARK_AI_AUDIO} ${said}` : said;
}
