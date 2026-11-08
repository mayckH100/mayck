/**
 * Voz da IA (v1.23.0): regras puras (testáveis) de texto falado e de quando responder em áudio.
 */

export type ReplyMode = 'espelhar' | 'sempre_audio' | 'nunca_audio';
export const REPLY_MODES: readonly ReplyMode[] = ['espelhar', 'sempre_audio', 'nunca_audio'];

/** Vozes prontas do Gemini (nome técnico → rótulo para o cliente). */
export const GEMINI_VOICES: readonly { id: string; label: string; genero: 'feminina' | 'masculina' }[] = [
  { id: 'Kore', label: 'Kore — feminina, firme', genero: 'feminina' },
  { id: 'Aoede', label: 'Aoede — feminina, leve', genero: 'feminina' },
  { id: 'Leda', label: 'Leda — feminina, jovem', genero: 'feminina' },
  { id: 'Zephyr', label: 'Zephyr — feminina, animada', genero: 'feminina' },
  { id: 'Sulafat', label: 'Sulafat — feminina, calorosa', genero: 'feminina' },
  { id: 'Puck', label: 'Puck — masculina, animada', genero: 'masculina' },
  { id: 'Charon', label: 'Charon — masculina, explicativa', genero: 'masculina' },
  { id: 'Fenrir', label: 'Fenrir — masculina, empolgada', genero: 'masculina' },
  { id: 'Orus', label: 'Orus — masculina, firme', genero: 'masculina' },
  { id: 'Achird', label: 'Achird — masculina, amigável', genero: 'masculina' },
];
export const DEFAULT_VOICE = 'Kore';

/** Vozes da OpenAI (gpt-4o-mini-tts; todas falam português). */
export const OPENAI_VOICES: readonly { id: string; label: string; genero: 'feminina' | 'masculina' | 'neutra' }[] = [
  { id: 'coral', label: 'Coral — feminina, calorosa', genero: 'feminina' },
  { id: 'nova', label: 'Nova — feminina, animada', genero: 'feminina' },
  { id: 'shimmer', label: 'Shimmer — feminina, suave', genero: 'feminina' },
  { id: 'sage', label: 'Sage — feminina, calma', genero: 'feminina' },
  { id: 'marin', label: 'Marin — feminina, natural', genero: 'feminina' },
  { id: 'alloy', label: 'Alloy — neutra', genero: 'neutra' },
  { id: 'ash', label: 'Ash — masculina, clara', genero: 'masculina' },
  { id: 'echo', label: 'Echo — masculina, firme', genero: 'masculina' },
  { id: 'onyx', label: 'Onyx — masculina, grave', genero: 'masculina' },
  { id: 'ballad', label: 'Ballad — masculina, expressiva', genero: 'masculina' },
  { id: 'verse', label: 'Verse — masculina, versátil', genero: 'masculina' },
  { id: 'cedar', label: 'Cedar — masculina, natural', genero: 'masculina' },
];
/** Voz padrão de cada motor (ElevenLabs: o cliente escolhe da lista da conta dele). */
export const DEFAULT_VOICE_BY_ENGINE: Record<string, string> = { gemini: 'Kore', openai: 'coral', elevenlabs: '' };
export const DEFAULT_VOICE_STYLE = 'Fale de forma natural, calorosa e simpática, em ritmo de conversa, como um atendente brasileiro.';
export const isKnownVoice = (v: string) => GEMINI_VOICES.some((x) => x.id === v);
/** Voz equivalente nos provedores compatíveis com OpenAI (/audio/speech). */
export const openAiVoiceFor = (v: string) => (GEMINI_VOICES.find((x) => x.id === v)?.genero === 'masculina' ? 'ash' : 'coral');

/** Limites da transcrição: áudios maiores pedem para o cliente escrever. */
export const MAX_INBOUND_AUDIO_SECONDS = 120;
export const MAX_INBOUND_AUDIO_BYTES = 10 * 1024 * 1024;

/** Mensagem de voz/áudio recebida do WhatsApp? */
export const isAudioType = (type?: string | null) => type === 'audio' || type === 'voice' || type === 'ptt';

/**
 * Responder em áudio? `espelhar` (padrão): áudio quando o cliente mandou áudio; `sempre_audio`: sempre;
 * `nunca_audio`: nunca. Com a voz desligada, sempre texto.
 */
export function decideReplyAsAudio(s: { voiceEnabled: boolean; voiceReplyMode: string } | null | undefined, inboundWasAudio: boolean): boolean {
  if (!s?.voiceEnabled) return false;
  const mode = (REPLY_MODES as readonly string[]).includes(s.voiceReplyMode) ? (s.voiceReplyMode as ReplyMode) : 'espelhar';
  if (mode === 'nunca_audio') return false;
  if (mode === 'sempre_audio') return true;
  return inboundWasAudio;
}

/** Duração estimada da fala em português (≈ 14 caracteres por segundo, ritmo de conversa). */
export function estimateSpeechSeconds(text: string): number {
  return Math.ceil(text.replace(/\s+/g, ' ').trim().length / 14);
}

const URL_RE = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// Emojis e pictogramas (inclui seletores de variação e o "zero width joiner").
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/**
 * Separa o que vai na fala do que vai por escrito logo depois do áudio.
 * Links e e-mails nunca são lidos em voz alta; listas com preços/detalhes (3+ itens) também vão por escrito.
 * Devolve `spoken` (texto limpo para a voz) e `extra` (texto para mandar depois, ou '').
 */
export function splitForVoice(text: string): { spoken: string; extra: string } {
  const lines = text.replace(/\r/g, '').split('\n');
  const extraLines: string[] = [];
  const keep: string[] = [];
  const bullet = /^\s*(?:[-*•▪◦]|\d{1,2}[.)])\s+/;
  const listLines = lines.filter((l) => bullet.test(l));
  const detailList = listLines.length >= 3 && listLines.some((l) => /R\$\s?\d|\d+[.,]\d{2}\b|\bhttps?:/i.test(l));
  for (const l of lines) {
    if (detailList && bullet.test(l)) { extraLines.push(l.trim()); continue; }
    const links = l.match(URL_RE) ?? [];
    const mails = l.match(EMAIL_RE) ?? [];
    if (links.length || mails.length) {
      extraLines.push(l.trim());
      const rest = l.replace(URL_RE, '').replace(EMAIL_RE, '').replace(/[:\-–—]\s*$/, '').trim();
      if (rest.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) keep.push(rest);
      continue;
    }
    keep.push(l);
  }
  let spoken = cleanForSpeech(keep.join('\n'));
  if (extraLines.length) {
    const hint = detailList ? 'Te mandei os detalhes por escrito aqui embaixo.' : 'Te mandei o link aqui embaixo.';
    spoken = spoken ? `${spoken} ${hint}` : hint;
  }
  return { spoken, extra: extraLines.join('\n').trim() };
}

/** Limpa o texto para ser falado: sem markdown, emojis, marcadores, links; pontuação de frase. */
export function cleanForSpeech(text: string): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(URL_RE, ' ')
    .replace(/\[(?:AGENDAR|PEDIDO|ETAPA|TIPO|TRANSFERIR)[^\]]*\]/gi, ' ')
    .replace(EMOJI_RE, '')
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*•▪◦]|\d{1,2}[.)])\s+/gm, '')
    .replace(/[*_#~|<>]/g, ' ');
  // Cada linha vira uma frase (pontuação no fim se faltar).
  t = t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (/[.!?…:;,]$/.test(l) ? l : `${l}.`)).join(' ');
  return t.replace(/\s+([.,!?;:])/g, '$1').replace(/([.!?])\1+/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

/** Prompt para a IA reescrever a resposta como fala (o texto original é dado, não instrução). */
export function spokenRewritePrompt(): string {
  return [
    'Você reescreve respostas de atendimento de WhatsApp para virarem um ÁUDIO falado por um atendente brasileiro.',
    'Regras: português do Brasil natural e coloquial (pode usar "tá", "a gente", "beleza"), frases curtas, tom caloroso.',
    'Mantenha TODAS as informações e valores exatamente como estão; não invente nada, não acrescente promessas.',
    'Sem markdown, sem emojis, sem listas, sem links, sem e-mails. Mantenha números e valores como estão (ex.: R$ 22,00).',
    'Responda SOMENTE com o texto a ser falado, sem aspas e sem comentários.',
  ].join('\n');
}
