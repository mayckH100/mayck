/**
 * v1.41.0 — Regras puras do atendimento no Inbox (sem banco, sem Node): a tela importa algumas delas.
 * - Respostas rápidas: atalho, variáveis {nome} e {atendente}, filtro da lista do "/".
 * - Distribuição automática: rodízio e "menos ocupado".
 * - Horário de atendimento: faixas por dia da semana no fuso da empresa.
 * - Pesquisa de satisfação: leitura da nota 1 a 5.
 */

// ---------------- Respostas rápidas ----------------

export const ATALHO_MAX = 30;
export const RESPOSTA_MAX = 2000;

/** "/Preço Pix" → "preco-pix". Só letras sem acento, números, "-" e "_". Vazio = inválido. */
export function normalizarAtalho(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^\/+/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, ATALHO_MAX);
}

/** Primeiro nome do contato (ou vazio). */
export function primeiroNome(nome?: string | null): string {
  const n = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  // Nome que é só número de telefone não vira saudação.
  return /\p{L}/u.test(n) ? n : '';
}

/**
 * Troca {nome} (primeiro nome do contato) e {atendente} no texto. Sem o valor, a variável some
 * e a pontuação que sobra é arrumada ("Olá {nome}, tudo bem?" → "Olá, tudo bem?").
 */
export function renderResposta(texto: string, vars: { nome?: string | null; atendente?: string | null }): string {
  const nome = primeiroNome(vars.nome);
  const atendente = primeiroNome(vars.atendente);
  return String(texto ?? '')
    .replace(/\{\s*nome\s*\}/gi, nome)
    .replace(/\{\s*atendente\s*\}/gi, atendente)
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/([,;:])(?=[,.!?;:])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t,]+/gm, '')
    .trim();
}

export interface RespostaRapida { id: string; shortcut: string; text: string }

/** Lista do "/" filtrada: atalho que começa com o termo primeiro, depois atalho/texto que contém o termo. */
export function filtrarRespostas<T extends RespostaRapida>(lista: T[], termo: string, max = 8): T[] {
  const q = normalizarAtalho(termo);
  const qt = String(termo ?? '').replace(/^\//, '').trim().toLowerCase();
  if (!q && !qt) return [...lista].sort((a, b) => a.shortcut.localeCompare(b.shortcut)).slice(0, max);
  const comeca = lista.filter((r) => r.shortcut.startsWith(q));
  const contem = lista.filter((r) => !comeca.includes(r) && ((q && r.shortcut.includes(q)) || (qt && r.text.toLowerCase().includes(qt))));
  return [...comeca.sort((a, b) => a.shortcut.localeCompare(b.shortcut)), ...contem].slice(0, max);
}

/**
 * Termo do "/" que está sendo digitado no cursor: "Olá /pre" (cursor no fim) → { termo: "pre", inicio: 4 }.
 * Só vale no começo do texto ou depois de espaço/quebra de linha (links como "a/b" não abrem a lista).
 */
export function termoBarra(texto: string, cursor: number): { termo: string; inicio: number } | null {
  const antes = String(texto ?? '').slice(0, Math.max(0, cursor));
  const m = /(^|\s)\/([^\s/]{0,30})$/.exec(antes);
  if (!m) return null;
  return { termo: m[2], inicio: antes.length - m[2].length - 1 };
}

// ---------------- Distribuição automática ----------------

export type Estrategia = 'rodizio' | 'menos_ocupado';
export interface Candidato { userId: string; abertas: number }

/**
 * Escolhe o atendente. `ordem` é a ordem fixa da equipe (ex.: entrada na equipe); `ultimo` é quem recebeu por último.
 * - rodizio: o próximo da ordem depois do último (volta ao começo).
 * - menos_ocupado: quem tem menos conversas abertas; empate segue o rodízio.
 */
export function escolherAtendente(candidatos: Candidato[], ordem: string[], ultimo: string | null | undefined, estrategia: Estrategia): string | null {
  if (!candidatos.length) return null;
  const pos = (id: string) => { const i = ordem.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const ordenados = [...candidatos].sort((a, b) => pos(a.userId) - pos(b.userId) || a.userId.localeCompare(b.userId));
  const proximo = (lista: Candidato[]) => {
    if (!ultimo) return lista[0].userId;
    const pu = pos(ultimo);
    const depois = lista.find((c) => pos(c.userId) > pu && c.userId !== ultimo);
    return (depois ?? lista[0]).userId;
  };
  if (estrategia === 'menos_ocupado') {
    const min = Math.min(...ordenados.map((c) => c.abertas));
    return proximo(ordenados.filter((c) => c.abertas === min));
  }
  return proximo(ordenados);
}

// ---------------- Horário de atendimento ----------------

export interface Faixa { dia: number; inicio: string; fim: string }
export const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export const hhmm = (s: string): number | null => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : (String(s).trim() === '24:00' ? 1440 : null);
};

/** Valida e ordena as faixas. Devolve o erro em português ou a lista limpa. */
export function validarFaixas(raw: unknown): { faixas: Faixa[] } | { erro: string } {
  if (!Array.isArray(raw)) return { erro: 'Horário inválido' };
  if (raw.length > 21) return { erro: 'No máximo 3 faixas por dia' };
  const out: Faixa[] = [];
  for (const f of raw as Faixa[]) {
    const dia = Number(f?.dia);
    const a = hhmm(f?.inicio); const b = hhmm(f?.fim);
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) return { erro: 'Dia da semana inválido' };
    if (a == null || b == null) return { erro: `Horário inválido em ${DIAS[dia]} (use HH:MM)` };
    if (b <= a) return { erro: `Em ${DIAS[dia]}, o fim (${f.fim}) precisa ser depois do início (${f.inicio})` };
    out.push({ dia, inicio: String(f.inicio).trim().padStart(5, '0'), fim: String(f.fim).trim().padStart(5, '0') });
  }
  out.sort((x, y) => x.dia - y.dia || hhmm(x.inicio)! - hhmm(y.inicio)!);
  for (let d = 0; d < 7; d++) {
    const doDia = out.filter((f) => f.dia === d);
    if (doDia.length > 3) return { erro: `No máximo 3 faixas em ${DIAS[d]}` };
    for (let i = 1; i < doDia.length; i++) if (hhmm(doDia[i].inicio)! < hhmm(doDia[i - 1].fim)!) return { erro: `Faixas sobrepostas em ${DIAS[d]}` };
  }
  return { faixas: out };
}

/** Dia da semana (0 = domingo) e minutos do dia no fuso. */
export function localDiaMin(d: Date, tz: string): { dia: number; min: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dia: wd[p.weekday] ?? 0, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** Está dentro do horário de atendimento? Sem faixas = nunca está (todo horário é "fora"). */
export function dentroDoHorario(faixas: Faixa[], agora: Date, tz = 'America/Sao_Paulo'): boolean {
  const { dia, min } = localDiaMin(agora, tz);
  return faixas.some((f) => f.dia === dia && min >= hhmm(f.inicio)! && min < hhmm(f.fim)!);
}

const fmtHora = (s: string) => { const [h, m] = s.split(':'); return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`; };

/** "seg a sex, 8h às 12h e 13h às 18h; sáb, 8h às 12h". Dias seguidos com o mesmo horário são agrupados. */
export function descreverHorario(faixas: Faixa[]): string {
  const porDia = Array.from({ length: 7 }, (_, d) => faixas.filter((f) => f.dia === d).map((f) => `${fmtHora(f.inicio)} às ${fmtHora(f.fim)}`).join(' e '));
  const partes: string[] = [];
  // Começa na segunda para "seg a sex" sair natural; domingo fica por último.
  const ordem = [1, 2, 3, 4, 5, 6, 0];
  let i = 0;
  while (i < ordem.length) {
    const txt = porDia[ordem[i]];
    if (!txt) { i++; continue; }
    let j = i;
    while (j + 1 < ordem.length && porDia[ordem[j + 1]] === txt) j++;
    const dias = j === i ? DIAS_CURTOS[ordem[i]] : j === i + 1 ? `${DIAS_CURTOS[ordem[i]]} e ${DIAS_CURTOS[ordem[j]]}` : `${DIAS_CURTOS[ordem[i]]} a ${DIAS_CURTOS[ordem[j]]}`;
    partes.push(`${dias}, ${txt}`);
    i = j + 1;
  }
  return partes.join('; ');
}

export const AWAY_PADRAO = 'Olá {nome}! Agora estamos fora do horário de atendimento. Recebemos sua mensagem e respondemos assim que voltarmos. Nosso horário: {horario}.';

/** Texto final da mensagem de fora do horário ({nome} e {horario}). */
export function textoForaDoHorario(modelo: string, faixas: Faixa[], nome?: string | null): string {
  const base = String(modelo ?? '').trim() || AWAY_PADRAO;
  return renderResposta(base.replace(/\{\s*horario\s*\}/gi, descreverHorario(faixas) || 'em breve'), { nome });
}

/** Pode mandar de novo? No máximo 1 vez a cada `horas` por contato. */
export function podeAvisarForaDoHorario(ultimo: Date | null | undefined, agora: Date, horas: number): boolean {
  if (!ultimo) return true;
  return agora.getTime() - ultimo.getTime() >= Math.max(1, horas) * 3600_000;
}

// ---------------- Pesquisa de satisfação ----------------

export const CSAT_PERGUNTA_PADRAO = 'De 1 a 5, como foi seu atendimento? Responda só com o número (1 = ruim, 5 = ótimo).';
export const CSAT_OBRIGADO_PADRAO = 'Obrigado pela sua avaliação! 😊';
export const CSAT_JANELA_MS = 24 * 3600_000;

const TECLA: Record<string, string> = { '1️⃣': '1', '2️⃣': '2', '3️⃣': '3', '4️⃣': '4', '5️⃣': '5' };

/**
 * Nota da resposta: "5", "5!", "nota 4", "3 estrelas", "4️⃣", "⭐⭐⭐⭐". Qualquer outra coisa → null
 * (frases com outros números, "10", "1 a 5", "obrigado"...).
 */
export function lerNotaCsat(texto: string | null | undefined): number | null {
  let t = String(texto ?? '').trim();
  for (const [k, v] of Object.entries(TECLA)) t = t.split(k).join(v);
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[!.\s]+$/g, '').trim();
  const estrelas = /^(?:⭐|🌟|★){1,5}$/u.exec(t);
  if (estrelas) return [...t].length;
  const m = /^(?:(?:minha\s+)?nota\s*[:=]?\s*|e\s+)?([1-5])(?:\s*(?:estrelas?|pontos?|⭐+))?$/u.exec(t);
  return m ? Number(m[1]) : null;
}

/** A pesquisa ainda aceita resposta? (até 24 h depois de enviada). */
export function csatAberta(enviadaEm: Date, agora: Date): boolean {
  return agora.getTime() - enviadaEm.getTime() <= CSAT_JANELA_MS;
}

/** Média com 1 casa decimal (null sem notas). */
export function mediaCsat(notas: number[]): number | null {
  const v = notas.filter((n) => n >= 1 && n <= 5);
  return v.length ? Math.round((v.reduce((a, n) => a + n, 0) / v.length) * 10) / 10 : null;
}
