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

import { buildCadenceReport, cadenceReportCsv, csvCell, parseStepTag, stepTag, cleanEventDetail, type Step } from '../../server/sdr/core.js';

describe('SDR v2 — relatório por cadência e passo', () => {
  const steps: Step[] = [{ dia: 0, canal: 'WHATSAPP', texto: 'a' }, { dia: 1, canal: 'EMAIL', texto: 'b' }, { dia: 3, canal: 'WHATSAPP', texto: 'c' }];
  const cads = [{ id: 'c1', name: '=Padrão', segment: 'varejo', steps }];
  const t = (h: number) => new Date(Date.UTC(2026, 10, 1, h));
  it('marca do passo', () => {
    expect(parseStepTag(`${stepTag('c1', 2)}Passo do dia 3`)).toEqual({ cadenceId: 'c1', step: 2 });
    expect(stepTag(null, 1)).toBe('');
    expect(cleanEventDetail('[c:c1#2] Passo do dia 3')).toBe('Passo do dia 3');
    expect(cleanEventDetail('[u:abc] Rodízio: Ana')).toBe('Rodízio: Ana');
  });
  it('conta envios por passo e atribui resposta/reunião/descadastro ao último passo enviado (uma vez por lead)', () => {
    const ev = [
      { leadId: 'L0', type: 'ENVIO', detail: '[c:c1#0] Passo do dia 0', createdAt: t(0) }, // antes do período: só estado
      { leadId: 'L1', type: 'RESPOSTA', detail: null, createdAt: t(1) }, // respondeu antes de qualquer envio: não conta
      { leadId: 'L1', type: 'ENVIO', detail: '[c:c1#0] Passo do dia 0', createdAt: t(2) },
      { leadId: 'L1', type: 'ENVIO', detail: '[c:c1#1] Passo do dia 1', createdAt: t(3) },
      { leadId: 'L1', type: 'RESPOSTA', detail: null, createdAt: t(4) },
      { leadId: 'L1', type: 'RESPOSTA', detail: null, createdAt: t(5) },
      { leadId: 'L1', type: 'REUNIAO', detail: null, createdAt: t(6) },
      { leadId: 'L0', type: 'OPTOUT', detail: null, createdAt: t(7) },
      { leadId: 'L2', type: 'ENVIO', detail: 'Passo do dia 3', createdAt: t(8) }, // antigo, sem marca: cadência atual do lead
    ];
    const [r] = buildCadenceReport(ev, t(1), cads, new Map([['L2', 'c1']]));
    expect(r).toMatchObject({ id: 'c1', leads: 3, enviados: 3, respondidos: 1, agendados: 1, descadastros: 1, taxaResposta: 33 });
    expect(r.passos.map((p) => [p.enviados, p.respondidos, p.agendados, p.descadastros])).toEqual([[1, 0, 0, 1], [1, 1, 1, 0], [1, 0, 0, 0]]);
    const csv = cadenceReportCsv([r]);
    expect(csv.startsWith('\uFEFFCadência;')).toBe(true);
    expect(csv).toContain("'=Padrão;Lojas e comércio;Total");
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(5);
    expect(csvCell('a;b"c')).toBe('"a;b""c"');
  });
});
