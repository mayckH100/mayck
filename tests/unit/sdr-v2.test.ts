import { describe, it, expect } from 'vitest';
import { kanbanNameToStage, kanbanTargetFor } from '../../server/sdr/core.js';
import { normalizeV2, normalizeDomains } from '../../server/sdr/v2config.js';

describe('SDR v2 — regras puras', () => {
  it('nome da etapa do Kanban → etapa do SDR', () => {
    expect(kanbanNameToStage('Ganho')).toBe('GANHO');
    expect(kanbanNameToStage('Venda fechada')).toBe('GANHO');
    expect(kanbanNameToStage('Perdido')).toBe('PERDIDO');
    expect(kanbanNameToStage('Reunião agendada')).toBe('REUNIAO');
    expect(kanbanNameToStage('Qualificados')).toBe('QUALIFICADO');
    expect(kanbanNameToStage('  novo ')).toBe('NOVO');
    expect(kanbanNameToStage('Em atendimento')).toBeNull();
    expect(kanbanNameToStage('Aguardando atendente')).toBeNull();
    const st = [{ name: 'Ganho', position: 3 }, { name: 'Novo', position: 0 }, { name: 'Qualificado', position: 2 }];
    expect(kanbanTargetFor('QUALIFICADO', st)?.position).toBe(2);
    expect(kanbanTargetFor('CONTATADO', st)).toBeNull();
  });

  it('configuração v2: padrão, rodízio sem membros desliga, domínios limpos', () => {
    expect(normalizeV2(null)).toEqual({ kanbanSync: true, rodizio: { enabled: false, members: [] }, embedDomains: [] });
    expect(normalizeV2({ rodizio: { enabled: true, members: [] } }).rodizio.enabled).toBe(false);
    expect(normalizeDomains(['https://www.Loja.com.br/contato', '*.exemplo.com', 'javascript:alert(1)', "x' 'unsafe-inline", 'localhost', 'loja.com.br:8080']))
      .toEqual(['www.loja.com.br', '*.exemplo.com', 'loja.com.br']);
  });
});
