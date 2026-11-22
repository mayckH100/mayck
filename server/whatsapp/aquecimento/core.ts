/**
 * v1.45.0 — Aquecimento ATIVO do número (WhatsApp por QR): regras puras, sem banco.
 *
 * Os números QR da própria empresa conversam entre si (e, se a empresa quiser, com até 5 números próprios extras),
 * com volume que cresce dia a dia, só dentro da janela de horário, com intervalos longos e aleatórios.
 * Nunca envia para contato/cliente: o destino precisa estar na lista de números próprios (`destinoPermitido`).
 */

export interface AquecimentoConfig {
  enabled: boolean;
  days: number;
  startHour: number;
  endHour: number;
  peerChannelIds: string[];
  allowAsPeer: boolean;
  useAi: boolean;
  useExtras: boolean;
}

export const AQUECIMENTO_PADRAO: AquecimentoConfig = {
  enabled: false, days: 14, startHour: 8, endHour: 21, peerChannelIds: [], allowAsPeer: true, useAi: true, useExtras: true,
};

export const AQUECIMENTO_FAIXAS = { days: [3, 30], startHour: [6, 22], endHour: [7, 23] } as const;
export const MAX_NUMEROS_EXTRAS = 5;
/** Número com menos de 14 dias e aquecimento ativo desligado: aviso no cartão. */
export const DIAS_NUMERO_NOVO = 14;

const DAY_MS = 24 * 3600e3;
const MIN_MS = 60_000;

/** Só dígitos. */
export const soDigitos = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '');

/** Mesmo número? Considera o 9º dígito do Brasil (contas antigas sem o 9). */
export function mesmoNumero(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = soDigitos(a), y = soDigitos(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const semNove = (d: string) => (d.startsWith('55') && d.length === 13 && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d);
  return semNove(x) === semNove(y);
}

/**
 * Trava principal: o destino de uma mensagem de aquecimento precisa ser um número próprio da empresa
 * (outro número QR conectado dela ou número extra que ela declarou ser dela). Qualquer outro → false.
 */
export function destinoPermitido(destino: string | null | undefined, numerosProprios: (string | null | undefined)[]): boolean {
  const d = soDigitos(destino);
  if (d.length < 10 || d.length > 15) return false;
  return numerosProprios.some((n) => mesmoNumero(n, d));
}

/** Dia do aquecimento ativo (1 = primeiro dia). */
export function diaAtivo(inicio: Date, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - inicio.getTime()) / DAY_MS) + 1);
}

/**
 * Faixa de mensagens enviadas por dia: dia 1 = 10–15, subindo em linha reta até 60–80 no último dia.
 * Depois do período: null (aquecimento concluído).
 */
export function faixaDoDia(dia: number, dias: number): { min: number; max: number } | null {
  if (dia < 1 || dia > dias) return null;
  const f = dias <= 1 ? 1 : (dia - 1) / (dias - 1);
  return { min: Math.round(10 + 50 * f), max: Math.round(15 + 65 * f) };
}

/** Hash simples e estável (para sortear a meta do dia sem guardar nada). */
export function hashTexto(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Meta do dia deste número: um valor estável dentro da faixa (muda a cada dia). */
export function metaDoDia(channelId: string, dataLocal: string, dia: number, dias: number): number {
  const fx = faixaDoDia(dia, dias);
  if (!fx) return 0;
  return fx.min + (hashTexto(`${channelId}:${dataLocal}`) % (fx.max - fx.min + 1));
}

/** Hora e data (YYYY-MM-DD) no fuso informado. */
export function relogio(now: Date, tz = 'America/Sao_Paulo'): { hora: number; minuto: number; data: string; inicioDoDia: Date } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const hora = Number(get('hour')), minuto = Number(get('minute')), seg = Number(get('second'));
  return {
    hora, minuto, data: `${get('year')}-${get('month')}-${get('day')}`,
    inicioDoDia: new Date(now.getTime() - ((hora * 60 + minuto) * 60 + seg) * 1000 - now.getMilliseconds()),
  };
}

/** Dentro da janela de horário (Brasília)? Início incluído, fim excluído. */
export function dentroDaJanela(now: Date, startHour: number, endHour: number, tz = 'America/Sao_Paulo'): boolean {
  const { hora } = relogio(now, tz);
  return hora >= startHour && hora < endHour;
}

/** Quanto falta para o fim da janela de hoje (0 se fora dela). */
export function msAteFimDaJanela(now: Date, startHour: number, endHour: number, tz = 'America/Sao_Paulo'): number {
  if (!dentroDaJanela(now, startHour, endHour, tz)) return 0;
  const r = relogio(now, tz);
  return r.inicioDoDia.getTime() + endHour * 3600e3 - now.getTime();
}

/** Próximo início da janela (hoje, se ainda não começou; senão amanhã). */
export function proximoInicioDaJanela(now: Date, startHour: number, tz = 'America/Sao_Paulo'): Date {
  const r = relogio(now, tz);
  const hoje = new Date(r.inicioDoDia.getTime() + startHour * 3600e3);
  return hoje.getTime() > now.getTime() ? hoje : new Date(hoje.getTime() + DAY_MS);
}

/**
 * Intervalo até a próxima conversa iniciada por este número: espalha o que falta da meta pelo resto da janela,
 * com sorteio (0,6× a 1,5×), mínimo de 4 min e, às vezes (12%), uma pausa extra de 20 a 60 min. Nunca em rajada.
 */
export function proximoIntervaloMs(a: { faltam: number; msRestantes: number; rand?: () => number }): number {
  const rand = a.rand ?? Math.random;
  // Cada conversa gasta ~2 mensagens deste número (ele inicia e responde uma vez, em média).
  const conversas = Math.max(1, Math.ceil(a.faltam / 2));
  const base = a.msRestantes > 0 ? a.msRestantes / (conversas + 1) : 30 * MIN_MS;
  let ms = base * (0.6 + rand() * 0.9);
  if (rand() < 0.12) ms += (20 + rand() * 40) * MIN_MS;
  return Math.round(Math.min(120 * MIN_MS, Math.max(4 * MIN_MS, ms)));
}

/** Atraso realista da resposta do outro número: 40 s a 6 min (às vezes até 12 min). */
export function atrasoRespostaMs(rand: () => number = Math.random): number {
  const longo = rand() < 0.15;
  const s = longo ? 360 + rand() * 360 : 40 + rand() * 320;
  return Math.round(s * 1000);
}

/** "digitando…" antes de cada mensagem de aquecimento: ~60 ms por letra, entre 1,5 e 7 s, com variação. */
export function tempoDigitandoAquecimentoMs(texto: string, rand: () => number = Math.random): number {
  const base = Math.min(7000, Math.max(1500, 900 + (texto?.length ?? 0) * 60));
  return Math.round(base * (0.8 + rand() * 0.4));
}

export type MotivoParada = 'ambiente' | 'desligado' | 'concluido' | 'fora_horario' | 'desconectado' | 'risco' | 'assinatura' | 'meta' | 'sem_par';
export const MOTIVO_TEXTO: Record<MotivoParada, string> = {
  ambiente: 'Aquecimento desligado no servidor (emergência).',
  desligado: 'Aquecimento ativo desligado neste número.',
  concluido: 'Aquecimento concluído.',
  fora_horario: 'Fora do horário do aquecimento.',
  desconectado: 'Pausado: número desconectado. Volta sozinho quando reconectar.',
  risco: 'Pausado: o número está em nível Risco na Saúde do número. Volta sozinho quando o nível melhorar.',
  assinatura: 'Pausado: assinatura do MCKBOT inativa.',
  meta: 'Meta de hoje cumprida. Continua amanhã.',
  sem_par: 'Esperando um par: conecte outro número da empresa (ou cadastre um número próprio extra).',
};

/** Pode este número iniciar/enviar uma mensagem de aquecimento agora? (ordem = prioridade do motivo mostrado) */
export function decidirAquecimento(a: {
  ambienteLigado: boolean; cfg: Pick<AquecimentoConfig, 'enabled' | 'days' | 'startHour' | 'endHour'>; inicio: Date; now: Date;
  conectado: boolean; nivel: 'BOM' | 'ATENCAO' | 'RISCO' | null; assinaturaAtiva: boolean; enviadosHoje: number; temPar: boolean;
}): { pode: true; dia: number; meta: number } | { pode: false; motivo: MotivoParada; dia: number | null } {
  if (!a.ambienteLigado) return { pode: false, motivo: 'ambiente', dia: null };
  if (!a.cfg.enabled) return { pode: false, motivo: 'desligado', dia: null };
  const dia = diaAtivo(a.inicio, a.now);
  if (dia > a.cfg.days) return { pode: false, motivo: 'concluido', dia };
  if (!a.conectado) return { pode: false, motivo: 'desconectado', dia };
  if (a.nivel === 'RISCO') return { pode: false, motivo: 'risco', dia };
  if (!a.assinaturaAtiva) return { pode: false, motivo: 'assinatura', dia };
  if (!dentroDaJanela(a.now, a.cfg.startHour, a.cfg.endHour)) return { pode: false, motivo: 'fora_horario', dia };
  const fx = faixaDoDia(dia, a.cfg.days)!;
  if (a.enviadosHoje >= fx.max) return { pode: false, motivo: 'meta', dia };
  if (!a.temPar) return { pode: false, motivo: 'sem_par', dia };
  return { pode: true, dia, meta: fx.max };
}

// ---------- Frases ----------

/** Expande variações {a|b|c} (sorteia uma). */
export function expandir(texto: string, rand: () => number = Math.random): string {
  return texto.replace(/\{([^{}]+)\}/g, (_, g: string) => { const ops = g.split('|'); return ops[Math.floor(rand() * ops.length)] ?? ''; });
}

/**
 * Banco local de conversas casuais (pt-BR). Cada conversa é uma lista de falas alternadas; cada fala tem variações.
 * Sem marcas, sem links, sem números de telefone, sem venda.
 */
export const CONVERSAS_LOCAIS: string[][] = [
  ['{Oi|Opa|E aí|Olá}, {tudo bem|tudo certo|como vai}?', '{Tudo sim|Tudo certo|Tudo ótimo} {e você|e por aí|e contigo}? {😊|🙂|}', '{Tudo bem também|Por aqui tudo tranquilo|Tudo certo}, {obrigado|valeu}!', '{Que bom|Show|Ótimo} {👍|😄|}'],
  ['{Bom dia|Bom diaa|Dia}! {Já tomou café|Já tomou aquele café}?', '{Já sim|Acabei de tomar|Ainda não, tô indo agora} {☕|😅|}', '{Café é tudo|Sem café não dá|Melhor parte do dia} {kkk|haha|😂}', '{Verdade|Com certeza|Pode crer}'],
  ['{Viu o tempo hoje|Que calor hoje|Que frio hoje}, {né|hein}?', '{Nem me fale|Pois é|Demais}! {Tá difícil|Não tá fácil} {😅|🥵|🥶}', '{Disseram que|Parece que} {vai chover mais tarde|vai mudar amanhã|continua assim a semana toda}', '{Tomara que melhore|Vamos ver|Tomara} {🙏|}'],
  ['{Conseguiu descansar no fim de semana|Como foi o fim de semana}?', '{Consegui sim|Mais ou menos|Foi corrido}, {e o seu|e você}?', '{Fiquei em casa|Saí um pouco|Fui ver a família}, {foi bom|deu pra relaxar}', '{Que bom|Boa|Faz bem} {😊|👏|}'],
  ['{Já almoçou|Almoçou já}?', '{Ainda não|Já sim|Tô indo agora}, {e você|e tu}?', '{Vou daqui a pouco|Já, comi um prato feito|Hoje vai ser rapidinho}', '{Bom apetite|Aproveita|Bom almoço} {😋|🍽️|}'],
  ['{Assistiu o jogo ontem|Viu o jogo}?', '{Vi sim|Vi o final|Não deu pra ver}, {que jogo|foi tenso|foi bom demais}', '{Foi sofrido|Que emoção|No fim deu certo} {⚽|😂|}', '{Próximo vai ser melhor|Bora torcer|Semana que vem tem mais}'],
  ['{Tá corrida a semana|Semana puxada}, {né|hein}?', '{Muito|Demais|Nem fala}, {mas vai dar certo|mas tá indo|um dia de cada vez}', '{É isso|Força|Bora} {💪|🙏|}', '{Valeu|Obrigado|Pra você também}!'],
  ['{Me lembra depois de|Não esquece de} {ver aquilo|conferir aquela lista|olhar a agenda}?', '{Pode deixar|Combinado|Lembro sim} {👍|✅|}', '{Valeu|Obrigado|Show}!'],
  ['{Indica alguma série|Tá assistindo alguma série|Viu algum filme bom}?', '{Comecei uma ótima|Tô vendo uma de suspense|Vi um filme bem legal}, {depois te falo o nome|te passo depois}', '{Manda sim|Quero saber|Fechou} {😄|🍿|}', '{Pode deixar|Mando mais tarde}'],
  ['{Trânsito hoje tava|O trânsito tá} {complicado|pesado|tranquilo}?', '{Tava sim|Bem cheio|Até que tranquilo} {😩|🚗|}', '{Saí mais cedo|Peguei outro caminho|Fui de ônibus} {e deu certo|pra fugir}', '{Boa ideia|Esperto|Fez bem}'],
  ['{Tudo pronto pra amanhã|Amanhã tá de pé}?', '{Tudo certo|Tá sim|Confirmado}! {👍|😉|}', '{Perfeito|Ótimo|Combinado} {então|}', '{Até amanhã|Até lá}!'],
  ['{Boa tarde|Boa tardee}! {Como tá o dia|Como tá por aí}?', '{Tranquilo|Corrido|Produtivo}, {e o seu|e aí}?', '{Tá indo bem|Bastante coisa mas tá indo|Tranquilo também}', '{Que bom|Boa} {🙂|👊|}'],
  ['{Olha que bonito o céu hoje|Hoje o dia tá lindo}', '{Verdade|Reparei também|Tá mesmo} {😍|☀️|}', '{Dá vontade de sair|Dia bom pra caminhar|Bom pra dar uma volta}', '{Com certeza|Bora|Quem dera} {😄|}'],
  ['{Seu cachorro melhorou|O pet tá bem}?', '{Melhorou sim|Tá ótimo|Tá bem melhor}, {obrigado por perguntar|valeu} {🐶|❤️|}', '{Que bom|Fico feliz} {🙏|😊|}'],
  ['{Boa noite|Boa noitee}! {Tudo certo por aí|Dia foi bom}?', '{Tudo certo|Foi bom sim|Cansativo mas foi}, {e você|e aí}?', '{Também|Tudo bem}, {agora é descansar|hora de relaxar}', '{Isso aí|Merecido} {😴|🙌|}'],
  ['{Lembra daquele lugar que comentei|Conhece um lugar bom pra comer aqui perto}?', '{Lembro sim|Conheço uns dois}, {é bom mesmo|vale a pena}', '{Vamos marcar|Bora qualquer dia|Preciso ir}', '{Fechado|Combinado|Bora} {😋|👍|}'],
  ['{Conseguiu resolver aquilo|Deu certo aquela questão}?', '{Consegui sim|Quase|Ainda não, mas tô vendo}', '{Que bom|Se precisar me chama|Qualquer coisa fala}', '{Valeu|Obrigado}! {🙏|}'],
  ['{Que dia é hoje mesmo|Hoje é que dia}? {kkk|😂|haha}', '{Kkk|Haha|😂} {hoje é dia de trabalho|tô perdido também}', '{A semana voa|O tempo passa rápido demais}', '{Demais|Verdade|Pois é}'],
];

export const REACOES = ['👍', '❤️', '😂', '🙏', '😄', '👏'];

/** Uma conversa do banco local com 2 a `maxFalas` falas (variações sorteadas). */
export function conversaLocal(maxFalas: number, rand: () => number = Math.random): string[] {
  const base = CONVERSAS_LOCAIS[Math.floor(rand() * CONVERSAS_LOCAIS.length)] ?? CONVERSAS_LOCAIS[0];
  const n = Math.max(1, Math.min(base.length, maxFalas));
  return base.slice(0, n).map((f) => expandir(f, rand).replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
}

/** Uma mensagem avulsa (para número extra, sem resposta automática do outro lado). */
export function mensagemAvulsaLocal(rand: () => number = Math.random): string {
  return conversaLocal(1, rand)[0] ?? 'Oi, tudo bem?';
}

const RUIM = /(https?:\/\/|www\.|\.com\b|@|\d{6,}|pix|promo|desconto|compre|oferta|cliente|whatsapp|\bia\b|rob[ôo])/i;

/**
 * Valida o roteiro gerado pela IA: lista JSON de 2 a 6 falas curtas (até 160 caracteres), sem links, números longos,
 * e-mails ou assunto de venda. Devolve null se não servir (aí vale o banco local).
 */
export function validarRoteiroIa(texto: string | null | undefined): string[] | null {
  if (!texto) return null;
  const m = texto.match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const falas = arr.map((x) => String(typeof x === 'object' && x && 'texto' in x ? (x as { texto: unknown }).texto : x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (falas.length < 2) return null;
  if (falas.some((f) => f.length > 160 || RUIM.test(f))) return null;
  return falas.slice(0, 6);
}

/** Temas sorteados para a IA variar as conversas. */
export const TEMAS = ['clima', 'café da manhã', 'almoço', 'fim de semana', 'futebol', 'série ou filme', 'trânsito', 'rotina de trabalho', 'animal de estimação', 'planos para a semana', 'receita de comida', 'música', 'família', 'caminhada ou academia', 'feriado', 'lembrete de compromisso simples'];

/**
 * Remetente é um número próprio? Usado no recebimento: mensagem de outro número da empresa ou de extra declarado.
 */
export function remetenteProprio(remetente: string | null | undefined, proprios: (string | null | undefined)[]): boolean {
  return destinoPermitido(remetente, proprios);
}
