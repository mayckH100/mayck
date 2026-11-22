/**
 * v1.42.0 — Proteção contra bloqueio do número (WhatsApp por QR): regras puras, sem banco.
 *
 * - Limites por número para envios EM MASSA (campanhas, cadências do SDR, automações, novas tentativas):
 *   teto por hora e por dia, intervalo aleatório entre um envio e outro e aquecimento de número novo.
 *   Respostas a quem acabou de escrever (IA, fluxos, atendente) nunca são seguradas: só contam no painel.
 * - "digitando..." antes das respostas automáticas (tempo proporcional ao tamanho do texto).
 * - Saúde do número: Bom / Atenção / Risco, com motivos e dicas.
 */

export interface ProtecaoConfig {
  enabled: boolean;
  hourLimit: number;
  dayLimit: number;
  minGapSec: number;
  maxGapSec: number;
  warmupEnabled: boolean;
  warmupDays: number;
  typingEnabled: boolean;
}

/** Padrões seguros (valem para quem nunca mexeu na configuração). */
export const PROTECAO_PADRAO: ProtecaoConfig = {
  enabled: true, hourLimit: 60, dayLimit: 300, minGapSec: 20, maxGapSec: 60,
  warmupEnabled: true, warmupDays: 14, typingEnabled: true,
};

/** Faixas aceitas na tela (o servidor valida com as mesmas). */
export const PROTECAO_FAIXAS = {
  hourLimit: [5, 500], dayLimit: [10, 3000], minGapSec: [3, 600], maxGapSec: [3, 900], warmupDays: [3, 30],
} as const;

const DAY_MS = 24 * 3600e3;

/** Dia do aquecimento (1 = primeiro dia) desde o início. */
export function diaDoAquecimento(inicio: Date, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - inicio.getTime()) / DAY_MS) + 1);
}

/**
 * Teto diário durante o aquecimento: 20 por dia no primeiro quarto do período, 50 até a metade e 100 até o fim;
 * depois vale o limite configurado (nunca acima dele).
 */
export function tetoAquecimento(dia: number, warmupDays: number): number | null {
  if (dia > warmupDays) return null;
  const f = dia / warmupDays;
  return f <= 0.25 ? 20 : f <= 0.5 ? 50 : 100;
}

export interface LimitesEfetivos { dia: number; hora: number; aquecendo: boolean; diaAquecimento: number | null; fimAquecimento: Date | null }

export function limitesEfetivos(cfg: ProtecaoConfig, inicioAquecimento: Date, now: Date): LimitesEfetivos {
  const base = { dia: cfg.dayLimit, hora: cfg.hourLimit, aquecendo: false, diaAquecimento: null, fimAquecimento: null };
  if (!cfg.warmupEnabled) return base;
  const dia = diaDoAquecimento(inicioAquecimento, now);
  const teto = tetoAquecimento(dia, cfg.warmupDays);
  if (teto === null) return base;
  const diaLim = Math.min(cfg.dayLimit, teto);
  return {
    dia: diaLim,
    // No aquecimento, no máximo ~1/4 do dia numa hora (não despeja tudo de uma vez).
    hora: Math.min(cfg.hourLimit, Math.max(5, Math.ceil(diaLim / 4))),
    aquecendo: true,
    diaAquecimento: dia,
    fimAquecimento: new Date(inicioAquecimento.getTime() + cfg.warmupDays * DAY_MS),
  };
}

/** Intervalo aleatório entre dois envios em massa do mesmo número. */
export function sortearIntervaloMs(cfg: Pick<ProtecaoConfig, 'minGapSec' | 'maxGapSec'>, rand: () => number = Math.random): number {
  const min = Math.max(0, cfg.minGapSec), max = Math.max(min, cfg.maxGapSec);
  return Math.round((min + rand() * (max - min)) * 1000);
}

export type Avaliacao =
  | { ok: true }
  | { ok: false; motivo: 'hora' | 'dia' | 'intervalo'; texto: string; tentarEmMs: number };

/**
 * Pode sair mais um envio em massa por este número agora?
 * `proximoPermitido` = instante liberado pelo intervalo aleatório desde o último envio em massa.
 */
export function avaliarEnvio(a: {
  cfg: ProtecaoConfig; now: Date; inicioAquecimento: Date;
  enviadosHora: number; enviadosDia: number; proximoPermitido: number | null; inicioDoProximoDia: Date;
}): Avaliacao {
  if (!a.cfg.enabled) return { ok: true };
  const lim = limitesEfetivos(a.cfg, a.inicioAquecimento, a.now);
  if (a.enviadosDia >= lim.dia) {
    return { ok: false, motivo: 'dia', texto: `Limite diário de proteção do número atingido (${lim.dia}${lim.aquecendo ? ', número em aquecimento' : ''}). Continua amanhã.`, tentarEmMs: Math.max(60_000, a.inicioDoProximoDia.getTime() - a.now.getTime()) };
  }
  if (a.enviadosHora >= lim.hora) {
    return { ok: false, motivo: 'hora', texto: `Limite por hora de proteção do número atingido (${lim.hora}). Continua em instantes.`, tentarEmMs: 5 * 60_000 };
  }
  if (a.proximoPermitido && a.now.getTime() < a.proximoPermitido) {
    return { ok: false, motivo: 'intervalo', texto: 'Aguardando o intervalo entre envios deste número.', tentarEmMs: a.proximoPermitido - a.now.getTime() };
  }
  return { ok: true };
}

/** Tempo de "digitando..." antes de uma resposta automática: ~30 ms por letra, entre 1 e 4 s, com variação. */
export function tempoDigitandoMs(texto: string, rand: () => number = Math.random): number {
  const base = Math.min(4000, Math.max(1000, 700 + (texto?.length ?? 0) * 30));
  return Math.round(base * (0.8 + rand() * 0.4));
}

/** Início do dia (00:00) no fuso informado. */
export function inicioDoDia(now: Date, tz = 'America/Sao_Paulo'): Date {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return new Date(now.getTime() - ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 - now.getMilliseconds());
}

// ---------- Saúde do número ----------

export type NivelSaude = 'BOM' | 'ATENCAO' | 'RISCO';
export const NIVEL_ROTULO: Record<NivelSaude, string> = { BOM: 'Bom', ATENCAO: 'Atenção', RISCO: 'Risco' };

export interface DadosSaude {
  qr: boolean;
  protecaoLigada: boolean;
  aquecendo: boolean;
  enviadosHoje: number;
  emMassaHoje: number;
  emMassaHora: number;
  limiteDia: number;
  limiteHora: number;
  falhasHoje: number;
  /** Envios em massa dos últimos 7 dias (base da taxa de resposta e de saída). */
  emMassa7d: number;
  /** Conversas que responderam depois de um envio em massa (7 dias). */
  responderam7d: number;
  /** Pedidos de saída (SAIR/PARAR, "não quero mais receber") em 7 dias. */
  saidas7d: number;
  /** Falhas que indicam bloqueio pelo contato ou número sem WhatsApp (7 dias). */
  bloqueios7d: number;
  desconexoes7d: number;
  /** Restrição/encerramento da sessão pelo WhatsApp (7 dias). */
  restricoes7d: number;
}

export interface Saude { nivel: NivelSaude; rotulo: string; taxaResposta: number | null; taxaSaida: number | null; motivos: string[]; dicas: string[] }

const pct = (n: number) => `${(n * 100).toFixed(1).replace('.', ',').replace(',0', '')}%`;

export function avaliarSaude(d: DadosSaude): Saude {
  const risco: string[] = [], atencao: string[] = [], dicas = new Set<string>();
  const taxaResposta = d.emMassa7d >= 20 ? Math.min(1, d.responderam7d / d.emMassa7d) : null;
  const taxaSaida = d.emMassa7d >= 20 ? Math.min(1, (d.saidas7d + d.bloqueios7d) / d.emMassa7d) : null;

  if (d.restricoes7d > 0) {
    risco.push('O WhatsApp encerrou ou restringiu a sessão deste número nos últimos 7 dias.');
    dicas.add('Pare os disparos por alguns dias e use o número só para responder quem chama.');
    dicas.add('Para disparos frequentes, prefira a API oficial (Avançado / API oficial).');
  }
  if (taxaSaida !== null && taxaSaida >= 0.03) {
    risco.push(`Muitos pedidos de saída ou bloqueios: ${pct(taxaSaida)} dos envios em massa.`);
    dicas.add('Envie só para quem autorizou ou falou com você recentemente e revise o texto da campanha.');
  } else if (taxaSaida !== null && taxaSaida >= 0.015) {
    atencao.push(`Pedidos de saída ou bloqueios acima do ideal: ${pct(taxaSaida)} dos envios em massa.`);
    dicas.add('Revise a lista: tire contatos antigos ou que nunca responderam.');
  }
  if (taxaResposta !== null && d.emMassa7d >= 50 && taxaResposta < 0.05) {
    risco.push(`Quase ninguém responde: ${pct(taxaResposta)} de resposta aos envios em massa.`);
    dicas.add('Mensagens sem resposta parecem spam para o WhatsApp: personalize com {nome} e faça uma pergunta simples.');
  } else if (taxaResposta !== null && taxaResposta < 0.15) {
    atencao.push(`Taxa de resposta baixa: ${pct(taxaResposta)}.`);
    dicas.add('Comece a conversa com uma pergunta e evite só links ou só propaganda.');
  }
  if (d.qr && d.emMassaHoje > d.limiteDia) {
    risco.push(`Envios em massa de hoje (${d.emMassaHoje}) passaram do limite seguro (${d.limiteDia}).`);
  } else if (d.qr && d.protecaoLigada && d.limiteDia > 0 && d.emMassaHoje >= d.limiteDia * 0.8) {
    atencao.push(`Perto do limite diário: ${d.emMassaHoje} de ${d.limiteDia} envios em massa hoje.`);
  }
  if (d.desconexoes7d >= 5) {
    risco.push(`${d.desconexoes7d} desconexões nos últimos 7 dias.`);
    dicas.add('Mantenha o celular com internet e bateria e abra o WhatsApp nele ao menos uma vez por dia.');
  } else if (d.desconexoes7d >= 2) {
    atencao.push(`${d.desconexoes7d} desconexões nos últimos 7 dias.`);
    dicas.add('Mantenha o celular com internet e bateria e abra o WhatsApp nele ao menos uma vez por dia.');
  }
  if (d.enviadosHoje >= 10 && d.falhasHoje / d.enviadosHoje >= 0.1) {
    atencao.push(`${d.falhasHoje} envio(s) com falha hoje.`);
    dicas.add('Confira números errados ou sem WhatsApp na lista de contatos.');
  }
  if (d.qr && !d.protecaoLigada) {
    atencao.push('A proteção de envio em massa está desligada.');
    dicas.add('Ligue a proteção: ela espaça os disparos e respeita limites seguros por hora e por dia.');
  }
  if (d.qr && d.aquecendo) dicas.add('Número em aquecimento: os limites sobem sozinhos nos próximos dias. Nesse período, priorize conversas com quem já conhece você.');
  if (!risco.length && !atencao.length) dicas.add('Continue assim: envie para quem conhece você, espaçado e com mensagens personalizadas.');

  const nivel: NivelSaude = risco.length ? 'RISCO' : atencao.length ? 'ATENCAO' : 'BOM';
  return { nivel, rotulo: NIVEL_ROTULO[nivel], taxaResposta, taxaSaida, motivos: [...risco, ...atencao], dicas: [...dicas] };
}

/** Erro de envio que indica bloqueio pelo contato, número sem WhatsApp ou recusa do WhatsApp. */
export function erroIndicaBloqueio(erro: string | null | undefined): boolean {
  if (!erro) return false;
  return /bloque|blocked|not.{0,10}whatsapp|sem whatsapp|não tem whatsapp|forbidden|\b403\b|spam|restri/i.test(erro);
}

/** Classifica uma desconexão do Baileys pelo código (null = não é desconexão relevante: deploy, reinício, QR expirado). */
export function tipoEventoDesconexao(code: number | undefined | null): 'desconexao' | 'sessao_encerrada' | 'restricao' | null {
  if (code === 440 || code === 515) return null; // connectionReplaced (deploy) / restartRequired (normal após ler o QR)
  if (code === 401) return 'sessao_encerrada';
  if (code === 403) return 'restricao';
  return 'desconexao';
}
