/**
 * v1.48.0 — Variações do texto, teste A/B, variáveis e dias da semana das campanhas (funções puras, sem banco).
 * Usado pelo disparador (server) e pela prévia da tela (web).
 *
 * - Versões da mensagem: a principal (Campaign.message) + até MAX_VARIACOES extras. Cada contato recebe sempre a
 *   MESMA versão (sorteio fixo por campanha+contato), o que deixa o teste A/B justo e evita reenvio diferente.
 * - Spintax {Olá|Oi|E aí}: resolvido com sorteio fixo por campanha+contato (mesmo texto se precisar tentar de novo).
 * - Variáveis: {nome} (primeiro nome), {nome_completo}, {saudacao} (Bom dia/Boa tarde/Boa noite no horário de Brasília),
 *   {dono} (primeiro nome do sócio/dono vindo da Consulta CNPJ), {dono_completo} e {empresa} (v1.53.0).
 */

export const MAX_VARIACOES = 3;
export const AB_MINIMO_PADRAO = 30;
export const AB_LIMITES = { min: 10, max: 1000 };
/** Só conta para o A/B quem recebeu há pelo menos este tempo (dá tempo de responder). */
export const AB_ESPERA_MS = 2 * 60 * 60 * 1000;
export const DIAS_TODOS = '0123456';
export const LETRAS = ['A', 'B', 'C', 'D'];
export const DIAS_ROTULO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const SAUDACOES = ['Bom dia', 'Boa tarde', 'Boa noite'] as const;

/** Hash estável (FNV-1a 32 bits). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Gerador pseudoaleatório com semente (mulberry32): mesmo texto para o mesmo contato. */
export function randComSemente(semente: string): () => number {
  let a = hash32(semente) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolve {a|b|c} (aceita aninhadas). Chaves sem "|" (ex.: {nome}) ficam como estão. */
export function resolverVariacoes(texto: string, rand: () => number): string {
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

/** Lê a lista de variações gravada (JSON) sem quebrar com lixo. Só textos não vazios, no máximo MAX_VARIACOES. */
export function lerVariacoes(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, MAX_VARIACOES) : [];
  } catch {
    return [];
  }
}

/** Todas as versões da campanha: [principal, ...variações]. */
export function versoesDaCampanha(c: { message: string; variacoes?: string | null }): string[] {
  return [c.message, ...lerVariacoes(c.variacoes)];
}

/** Versão do contato: a já gravada, a vencedora do A/B ou o sorteio fixo por campanha+contato. */
export function escolherVersao(a: { campaignId: string; leadId: string; total: number; gravada?: number | null; vencedora?: number | null }): number {
  if (a.total <= 1) return 0;
  if (a.gravada != null && a.gravada >= 0 && a.gravada < a.total) return a.gravada;
  if (a.vencedora != null && a.vencedora >= 0 && a.vencedora < a.total) return a.vencedora;
  return hash32(`${a.campaignId}:${a.leadId}`) % a.total;
}

/** Saudação pelo horário de Brasília (5h–12h dia, 12h–18h tarde, resto noite). */
export function saudacaoDe(now: Date, tz = 'America/Sao_Paulo'): (typeof SAUDACOES)[number] {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite';
}

function limpar(t: string): string {
  return t.replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Troca as variáveis. Nome vazio some sem deixar vírgula/espaço sobrando. {dono}/{empresa}: v1.53.0 (Consulta CNPJ). */
export function aplicarVariaveis(texto: string, v: { nome?: string | null; saudacao: string; dono?: string | null; empresa?: string | null }): string {
  const completo = (v.nome ?? '').trim().replace(/\s+/g, ' ');
  const primeiro = completo.split(' ')[0] ?? '';
  const dono = (v.dono ?? '').trim().replace(/\s+/g, ' ');
  return limpar(texto
    .replace(/\{\s*nome_completo\s*\}/gi, completo)
    .replace(/\{\s*nome\s*\}/gi, primeiro)
    .replace(/\{\s*dono_completo\s*\}/gi, dono)
    .replace(/\{\s*dono\s*\}/gi, dono.split(' ')[0] ?? '')
    .replace(/\{\s*empresa\s*\}/gi, (v.empresa ?? '').trim())
    .replace(/\{\s*sauda[cç][aã]o\s*\}/gi, v.saudacao));
}

type DadosContato = { nome?: string | null; dono?: string | null; empresa?: string | null };

/** Texto final de uma versão para um contato (variações com sorteio fixo + variáveis). */
export function textoParaContato(versao: string, a: { campaignId: string; leadId: string; saudacao: string } & DadosContato): string {
  return aplicarVariaveis(resolverVariacoes(versao, randComSemente(`${a.campaignId}:${a.leadId}:txt`)), { nome: a.nome, saudacao: a.saudacao, dono: a.dono, empresa: a.empresa });
}

/** Os textos possíveis do contato com cada saudação (para a trava "nunca reenviar para quem já recebeu"). */
export function textosPossiveis(versao: string, a: { campaignId: string; leadId: string } & DadosContato): string[] {
  return [...new Set(SAUDACOES.map((s) => textoParaContato(versao, { ...a, saudacao: s })))];
}

/** Variáveis desconhecidas no texto (ex.: {nomee}), para avisar na tela. */
export function variaveisDesconhecidas(texto: string): string[] {
  const out = new Set<string>();
  for (const m of texto.matchAll(/\{([^{}|]*)\}/g)) {
    const k = m[1].trim().toLowerCase();
    if (!['nome', 'nome_completo', 'saudacao', 'saudação', 'dono', 'dono_completo', 'empresa'].includes(k)) out.add(`{${m[1]}}`);
  }
  return [...out];
}

// ---------------- Teste A/B ----------------

export interface ResultadoVersao { versao: number; enviadas: number; respostas: number; taxa: number; elegiveis: number; respostasElegiveis: number }

/** Junta os envios por versão. Elegíveis = enviadas há ≥ AB_ESPERA_MS (base da escolha da vencedora). */
export function resultadoPorVersao(total: number, envios: { variante: number | null; sentAt: Date | null; respondeuAt: Date | null }[], now: Date): ResultadoVersao[] {
  const out: ResultadoVersao[] = Array.from({ length: Math.max(1, total) }, (_, versao) => ({ versao, enviadas: 0, respostas: 0, taxa: 0, elegiveis: 0, respostasElegiveis: 0 }));
  for (const e of envios) {
    const v = e.variante ?? 0;
    if (!out[v] || !e.sentAt) continue;
    out[v].enviadas++;
    if (e.respondeuAt) out[v].respostas++;
    if (now.getTime() - e.sentAt.getTime() >= AB_ESPERA_MS) {
      out[v].elegiveis++;
      if (e.respondeuAt) out[v].respostasElegiveis++;
    }
  }
  for (const r of out) r.taxa = r.enviadas ? Math.round((r.respostas / r.enviadas) * 1000) / 10 : 0;
  return out;
}

/**
 * Vencedora do A/B: só quando TODAS as versões têm pelo menos `minimo` envios elegíveis. Maior taxa de resposta;
 * empate fica com a de menor índice (a principal). Ninguém respondeu em nenhuma → não decide (null).
 */
export function escolherVencedora(res: ResultadoVersao[], minimo: number): number | null {
  if (res.length < 2 || res.some((r) => r.elegiveis < minimo)) return null;
  let melhor = -1, taxa = -1;
  for (const r of res) {
    const t = r.respostasElegiveis / r.elegiveis;
    if (t > taxa) { taxa = t; melhor = r.versao; }
  }
  return taxa > 0 ? melhor : null;
}

// ---------------- Dias da semana e agendamento ----------------

/** Normaliza "1,2,3" / "12345" / [1,2] para "12345" (ordenado, sem repetir). Vazio → todos. */
export function normalizarDias(v: string | number[] | null | undefined): string {
  const lista = Array.isArray(v) ? v.map(String) : String(v ?? '').replace(/[^0-6]/g, '').split('');
  const s = [...new Set(lista.filter((d) => /^[0-6]$/.test(d)))].sort().join('');
  return s || DIAS_TODOS;
}

/** Dia da semana em Brasília (0 = domingo). */
export function diaDaSemanaLocal(now: Date, tz = 'America/Sao_Paulo'): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(w);
}

export function diaPermitido(dias: string | null | undefined, now: Date): boolean {
  return normalizarDias(dias).includes(String(diaDaSemanaLocal(now)));
}

/** Início agendado: no futuro (com folga de 1 min) e no máximo 60 dias à frente. */
export const AGENDA_MAX_DIAS = 60;
export function validarAgendamento(quando: Date, now: Date): string | null {
  if (Number.isNaN(quando.getTime())) return 'Data e hora do início inválidas';
  if (quando.getTime() < now.getTime() - 60_000) return 'Escolha um horário no futuro para o início';
  if (quando.getTime() > now.getTime() + AGENDA_MAX_DIAS * 86_400_000) return `O início pode ser agendado para até ${AGENDA_MAX_DIAS} dias à frente`;
  return null;
}
