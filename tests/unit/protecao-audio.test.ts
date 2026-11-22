import { describe, it, expect } from 'vitest';
import {
  PROTECAO_PADRAO, avaliarEnvio, avaliarSaude, diaDoAquecimento, erroIndicaBloqueio, limitesEfetivos,
  sortearIntervaloMs, tempoDigitandoMs, tetoAquecimento, tipoEventoDesconexao, inicioDoDia, type DadosSaude,
} from '../../server/whatsapp/protecao/core.js';
import { limiteAudioSegundos, duracaoPorExtenso, AUDIO_NAO_TRANSCRITO } from '../../server/ai/voice/spoken.js';
import { audioFallbackText } from '../../server/whatsapp/inbound.js';

const DIA = 24 * 3600e3;
const agora = new Date('2026-11-22T15:00:00Z');

describe('proteção do número — aquecimento e limites', () => {
  it('aquecimento 20 → 50 → 100 por dia e depois o limite configurado', () => {
    expect(diaDoAquecimento(agora, agora)).toBe(1);
    expect(diaDoAquecimento(new Date(agora.getTime() - 3 * DIA), agora)).toBe(4);
    expect([1, 3, 4, 7, 8, 14].map((d) => tetoAquecimento(d, 14))).toEqual([20, 20, 50, 50, 100, 100]);
    expect(tetoAquecimento(15, 14)).toBeNull();
    const novo = limitesEfetivos(PROTECAO_PADRAO, agora, agora);
    expect(novo).toMatchObject({ dia: 20, hora: 5, aquecendo: true, diaAquecimento: 1 });
    const antigo = limitesEfetivos(PROTECAO_PADRAO, new Date(agora.getTime() - 30 * DIA), agora);
    expect(antigo).toMatchObject({ dia: 300, hora: 60, aquecendo: false });
    // Limite configurado menor que o teto do aquecimento vale.
    expect(limitesEfetivos({ ...PROTECAO_PADRAO, dayLimit: 15 }, agora, agora).dia).toBe(15);
    expect(limitesEfetivos({ ...PROTECAO_PADRAO, warmupEnabled: false }, agora, agora)).toMatchObject({ dia: 300, aquecendo: false });
  });

  it('avaliarEnvio: dia, hora, intervalo; desligada libera', () => {
    const base = { cfg: { ...PROTECAO_PADRAO, warmupEnabled: false }, now: agora, inicioAquecimento: agora, enviadosHora: 0, enviadosDia: 0, proximoPermitido: null, inicioDoProximoDia: new Date(agora.getTime() + 5 * 3600e3) };
    expect(avaliarEnvio(base)).toEqual({ ok: true });
    expect(avaliarEnvio({ ...base, enviadosDia: 300 })).toMatchObject({ ok: false, motivo: 'dia', tentarEmMs: 5 * 3600e3 });
    expect(avaliarEnvio({ ...base, enviadosHora: 60 })).toMatchObject({ ok: false, motivo: 'hora' });
    expect(avaliarEnvio({ ...base, proximoPermitido: agora.getTime() + 10_000 })).toMatchObject({ ok: false, motivo: 'intervalo', tentarEmMs: 10_000 });
    expect(avaliarEnvio({ ...base, cfg: { ...base.cfg, enabled: false }, enviadosDia: 9999 })).toEqual({ ok: true });
    const r = avaliarEnvio({ ...base, cfg: PROTECAO_PADRAO, enviadosDia: 20 });
    expect(r.ok === false && r.texto).toMatch(/aquecimento/);
  });

  it('intervalo aleatório entre mínimo e máximo; "digitando" entre ~1 e ~5 s', () => {
    expect(sortearIntervaloMs({ minGapSec: 20, maxGapSec: 60 }, () => 0)).toBe(20_000);
    expect(sortearIntervaloMs({ minGapSec: 20, maxGapSec: 60 }, () => 1)).toBe(60_000);
    expect(sortearIntervaloMs({ minGapSec: 30, maxGapSec: 10 }, () => 0.5)).toBe(30_000);
    expect(tempoDigitandoMs('oi', () => 0.5)).toBe(1000);
    expect(tempoDigitandoMs('x'.repeat(500), () => 0.5)).toBe(4000);
    expect(tempoDigitandoMs('x'.repeat(500), () => 1)).toBeLessThanOrEqual(4800);
  });

  it('início do dia em Brasília', () => {
    expect(inicioDoDia(new Date('2026-11-22T02:30:00Z')).toISOString()).toBe('2026-11-21T03:00:00.000Z');
    expect(inicioDoDia(new Date('2026-11-22T15:00:00Z')).toISOString()).toBe('2026-11-22T03:00:00.000Z');
  });

  it('desconexões: deploy e reinício não contam; 401 sessão encerrada; 403 restrição', () => {
    expect(tipoEventoDesconexao(440)).toBeNull();
    expect(tipoEventoDesconexao(515)).toBeNull();
    expect(tipoEventoDesconexao(401)).toBe('sessao_encerrada');
    expect(tipoEventoDesconexao(403)).toBe('restricao');
    expect(tipoEventoDesconexao(428)).toBe('desconexao');
    expect(erroIndicaBloqueio('Número sem WhatsApp')).toBe(true);
    expect(erroIndicaBloqueio('Fora da janela de 24 horas')).toBe(false);
  });
});

describe('proteção do número — saúde (Bom / Atenção / Risco)', () => {
  const bom: DadosSaude = { qr: true, protecaoLigada: true, aquecendo: false, enviadosHoje: 40, emMassaHoje: 30, emMassaHora: 5, limiteDia: 300, limiteHora: 60, falhasHoje: 0, emMassa7d: 100, responderam7d: 35, saidas7d: 0, bloqueios7d: 0, desconexoes7d: 0, restricoes7d: 0 };

  it('bom', () => {
    const s = avaliarSaude(bom);
    expect(s).toMatchObject({ nivel: 'BOM', rotulo: 'Bom', taxaResposta: 0.35, taxaSaida: 0 });
    expect(s.motivos).toEqual([]);
    expect(s.dicas.length).toBe(1);
  });

  it('atenção: resposta baixa, saída acima do ideal, perto do limite, desconexões, proteção desligada', () => {
    expect(avaliarSaude({ ...bom, responderam7d: 10 }).nivel).toBe('ATENCAO');
    expect(avaliarSaude({ ...bom, saidas7d: 2 }).nivel).toBe('ATENCAO');
    expect(avaliarSaude({ ...bom, emMassaHoje: 250 }).nivel).toBe('ATENCAO');
    expect(avaliarSaude({ ...bom, desconexoes7d: 2 }).nivel).toBe('ATENCAO');
    expect(avaliarSaude({ ...bom, protecaoLigada: false }).nivel).toBe('ATENCAO');
  });

  it('risco: restrição, saída ≥ 3%, quase ninguém responde, passou do limite, muitas desconexões', () => {
    expect(avaliarSaude({ ...bom, restricoes7d: 1 }).nivel).toBe('RISCO');
    expect(avaliarSaude({ ...bom, saidas7d: 2, bloqueios7d: 1 }).nivel).toBe('RISCO');
    expect(avaliarSaude({ ...bom, responderam7d: 2 }).nivel).toBe('RISCO');
    expect(avaliarSaude({ ...bom, emMassaHoje: 301 }).nivel).toBe('RISCO');
    expect(avaliarSaude({ ...bom, desconexoes7d: 5 }).nivel).toBe('RISCO');
  });

  it('poucos envios: sem taxas (não julga por amostra pequena)', () => {
    const s = avaliarSaude({ ...bom, emMassa7d: 10, responderam7d: 0, saidas7d: 1 });
    expect(s.taxaResposta).toBeNull();
    expect(s.taxaSaida).toBeNull();
    expect(s.nivel).toBe('BOM');
  });
});

describe('áudio — duração máxima e texto ao cliente', () => {
  it('limite padrão 2 min, dentro da faixa 10–600 s', () => {
    expect(limiteAudioSegundos(null)).toBe(120);
    expect(limiteAudioSegundos(0)).toBe(120);
    expect(limiteAudioSegundos(5)).toBe(10);
    expect(limiteAudioSegundos(9999)).toBe(600);
    expect(limiteAudioSegundos(90)).toBe(90);
  });
  it('duração por extenso e texto de áudio longo', () => {
    expect(duracaoPorExtenso(120)).toBe('2 minutos');
    expect(duracaoPorExtenso(90)).toBe('1 minuto e 30 segundos');
    expect(duracaoPorExtenso(45)).toBe('45 segundos');
    expect(audioFallbackText('longo', 60)).toContain('até 1 minuto');
    expect(audioFallbackText('longo')).toContain('até 2 minutos');
    expect(audioFallbackText('falha')).toMatch(/não consegui ouvir/);
    expect(AUDIO_NAO_TRANSCRITO).toBe('[áudio não transcrito]');
  });
});
