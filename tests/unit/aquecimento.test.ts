import { describe, it, expect } from 'vitest';
import {
  faixaDoDia, metaDoDia, dentroDaJanela, destinoPermitido, mesmoNumero, decidirAquecimento, proximoIntervaloMs,
  validarRoteiroIa, conversaLocal, atrasoRespostaMs, tempoDigitandoAquecimentoMs, expandir, proximoInicioDaJanela, CONVERSAS_LOCAIS,
} from '../../server/whatsapp/aquecimento/core.js';

const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };
// 2026-11-23 é segunda; 14:00 UTC = 11:00 em Brasília (UTC-3).
const brt = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 23, h + 3, m));

describe('v1.45.0 — aquecimento ativo: regras puras', () => {
  it('volume por dia: 10–15 no 1º dia, sobe sem cair até 60–80 no último e para depois', () => {
    expect(faixaDoDia(1, 14)).toEqual({ min: 10, max: 15 });
    expect(faixaDoDia(14, 14)).toEqual({ min: 60, max: 80 });
    let ant = faixaDoDia(1, 14)!;
    for (let d = 2; d <= 14; d++) {
      const f = faixaDoDia(d, 14)!;
      expect(f.min).toBeGreaterThanOrEqual(ant.min);
      expect(f.max).toBeGreaterThanOrEqual(ant.max);
      expect(f.max).toBeGreaterThan(f.min);
      ant = f;
    }
    expect(faixaDoDia(15, 14)).toBeNull();
    expect(faixaDoDia(0, 14)).toBeNull();
    expect(faixaDoDia(7, 7)).toEqual({ min: 60, max: 80 });
  });

  it('meta do dia fica dentro da faixa e é estável no mesmo dia', () => {
    for (let d = 1; d <= 14; d++) {
      const m = metaDoDia('canal-x', '2026-11-23', d, 14);
      const f = faixaDoDia(d, 14)!;
      expect(m).toBeGreaterThanOrEqual(f.min);
      expect(m).toBeLessThanOrEqual(f.max);
      expect(metaDoDia('canal-x', '2026-11-23', d, 14)).toBe(m);
    }
    expect(metaDoDia('canal-x', '2026-11-23', 20, 14)).toBe(0);
  });

  it('janela de horário em Brasília: 8h incluída, 21h excluída', () => {
    expect(dentroDaJanela(brt(7, 59), 8, 21)).toBe(false);
    expect(dentroDaJanela(brt(8, 0), 8, 21)).toBe(true);
    expect(dentroDaJanela(brt(20, 59), 8, 21)).toBe(true);
    expect(dentroDaJanela(brt(21, 0), 8, 21)).toBe(false);
    expect(dentroDaJanela(brt(2, 0), 8, 21)).toBe(false);
    expect(proximoInicioDaJanela(brt(22, 0), 8).toISOString()).toBe(new Date(Date.UTC(2026, 10, 24, 11, 0)).toISOString());
    expect(proximoInicioDaJanela(brt(6, 0), 8).toISOString()).toBe(brt(8, 0).toISOString());
  });

  it('nunca envia para quem não é número próprio (com e sem o 9 do Brasil)', () => {
    const proprios = ['5511988887777', '5521977776666'];
    expect(destinoPermitido('5511988887777', proprios)).toBe(true);
    expect(destinoPermitido('551188887777', proprios)).toBe(true); // conta antiga sem o 9
    expect(destinoPermitido('+55 (21) 97777-6666', proprios)).toBe(true);
    expect(destinoPermitido('5511912345678', proprios)).toBe(false); // contato/cliente
    expect(destinoPermitido('', proprios)).toBe(false);
    expect(destinoPermitido('123', ['123'])).toBe(false);
    expect(destinoPermitido('5511988887777', [])).toBe(false);
    expect(mesmoNumero('5511988887777', '5511988887778')).toBe(false);
  });

  it('decisão: ambiente, desligado, concluído, desconectado, Risco, assinatura, horário, meta e par', () => {
    const base = { ambienteLigado: true, cfg: { enabled: true, days: 14, startHour: 8, endHour: 21 }, inicio: brt(9), now: brt(11), conectado: true, nivel: 'BOM' as const, assinaturaAtiva: true, enviadosHoje: 0, temPar: true };
    expect(decidirAquecimento(base)).toMatchObject({ pode: true, dia: 1, meta: 15 });
    expect(decidirAquecimento({ ...base, ambienteLigado: false })).toMatchObject({ pode: false, motivo: 'ambiente' });
    expect(decidirAquecimento({ ...base, cfg: { ...base.cfg, enabled: false } })).toMatchObject({ pode: false, motivo: 'desligado' });
    expect(decidirAquecimento({ ...base, now: new Date(brt(11).getTime() + 15 * 86400e3) })).toMatchObject({ pode: false, motivo: 'concluido' });
    expect(decidirAquecimento({ ...base, conectado: false })).toMatchObject({ pode: false, motivo: 'desconectado' });
    expect(decidirAquecimento({ ...base, nivel: 'RISCO' })).toMatchObject({ pode: false, motivo: 'risco' });
    expect(decidirAquecimento({ ...base, nivel: 'ATENCAO' })).toMatchObject({ pode: true });
    expect(decidirAquecimento({ ...base, assinaturaAtiva: false })).toMatchObject({ pode: false, motivo: 'assinatura' });
    expect(decidirAquecimento({ ...base, now: brt(21, 30) })).toMatchObject({ pode: false, motivo: 'fora_horario' });
    expect(decidirAquecimento({ ...base, now: brt(7) , inicio: brt(6) })).toMatchObject({ pode: false, motivo: 'fora_horario' });
    expect(decidirAquecimento({ ...base, enviadosHoje: 15 })).toMatchObject({ pode: false, motivo: 'meta' });
    expect(decidirAquecimento({ ...base, temPar: false })).toMatchObject({ pode: false, motivo: 'sem_par' });
  });

  it('intervalos longos e aleatórios: nunca menos de 4 min, às vezes pausa extra, nunca em rajada', () => {
    const vals: number[] = [];
    for (let i = 0; i < 200; i++) vals.push(proximoIntervaloMs({ faltam: 60, msRestantes: 2 * 3600e3 }));
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(4 * 60_000);
    expect(Math.max(...vals)).toBeLessThanOrEqual(120 * 60_000);
    expect(new Set(vals).size).toBeGreaterThan(50);
    // Dia 1 (≈12 mensagens) espalhado em 13 h: intervalos de dezenas de minutos.
    const dia1 = proximoIntervaloMs({ faltam: 12, msRestantes: 13 * 3600e3, rand: seq([0.5, 0.9]) });
    expect(dia1).toBeGreaterThan(40 * 60_000);
    // Pausa aleatória extra quando o sorteio cai abaixo de 12%.
    const semPausa = proximoIntervaloMs({ faltam: 40, msRestantes: 6 * 3600e3, rand: seq([0.5, 0.5]) });
    const comPausa = proximoIntervaloMs({ faltam: 40, msRestantes: 6 * 3600e3, rand: seq([0.5, 0.05, 0.5]) });
    expect(comPausa).toBeGreaterThan(semPausa + 20 * 60_000 - 1);
    for (let i = 0; i < 100; i++) {
      const a = atrasoRespostaMs();
      expect(a).toBeGreaterThanOrEqual(40_000);
      expect(a).toBeLessThanOrEqual(12 * 60_000);
    }
    expect(tempoDigitandoAquecimentoMs('oi', () => 0.5)).toBe(1500);
    expect(tempoDigitandoAquecimentoMs('x'.repeat(500), () => 0.5)).toBe(7000);
  });

  it('roteiro da IA: aceita lista JSON curta; recusa link, telefone, venda e lista de 1 fala', () => {
    expect(validarRoteiroIa('["Oi, tudo bem?", "Tudo sim, e você? 😊"]')).toEqual(['Oi, tudo bem?', 'Tudo sim, e você? 😊']);
    expect(validarRoteiroIa('Aqui está: ["Bom dia!", "Bom dia! Já tomou café?", "Já sim"] fim')).toHaveLength(3);
    expect(validarRoteiroIa('["Oi", "Olha https://x.com"]')).toBeNull();
    expect(validarRoteiroIa('["Oi", "Me liga 11999998888"]')).toBeNull();
    expect(validarRoteiroIa('["Oi", "Tem promoção hoje"]')).toBeNull();
    expect(validarRoteiroIa('["Oi"]')).toBeNull();
    expect(validarRoteiroIa('sem json')).toBeNull();
    expect(validarRoteiroIa(null)).toBeNull();
  });

  it('banco local: variações sem chaves sobrando, sem link e no tamanho pedido', () => {
    expect(expandir('{a|b}', () => 0)).toBe('a');
    expect(expandir('{a|b}', () => 0.99)).toBe('b');
    const vistos = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const c = conversaLocal(1 + (i % 6));
      expect(c.length).toBeGreaterThanOrEqual(1);
      expect(c.length).toBeLessThanOrEqual(1 + (i % 6));
      for (const f of c) {
        expect(f).not.toMatch(/[{}|]/);
        expect(f).not.toMatch(/https?:|www\./);
        vistos.add(f);
      }
    }
    expect(vistos.size).toBeGreaterThan(150);
    expect(CONVERSAS_LOCAIS.length).toBeGreaterThanOrEqual(15);
  });
});
