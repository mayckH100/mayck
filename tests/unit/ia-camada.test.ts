import { describe, it, expect } from 'vitest';
import { searchQuery } from '../../server/ai/service.js';
import { boostCorrections } from '../../server/ai/rag.js';
import { attemptPlan } from '../../server/ai/core.js';
import { profileLines } from '../../server/ai/contactProfile.js';
import { valoresForaDaBase } from '../../server/ai/valueGuard.js';
import { PROMPT_VERSIONS, PURPOSE_LABEL } from '../../server/ai/prompts.js';
import { motivoHandoff } from '../../server/sdr/conversa.js';
import { planejamentoLines } from '../../server/sdr/conversa.js';

describe('v1.35.0 · camada de IA (regras puras)', () => {
  it('busca usa a pergunta anterior só quando a atual é curta', () => {
    expect(searchQuery('e quanto custa?', ['tem Onix 2022?'])).toBe('e quanto custa?\ntem Onix 2022?');
    expect(searchQuery('qual o preço do Onix 2022 completo à vista?', ['oi'])).toBe('qual o preço do Onix 2022 completo à vista?');
  });
  it('correções da equipe passam na frente', () => {
    const r = boostCorrections([{ item: { title: 'Estoque', text: '' }, score: 2 }, { item: { title: 'Correção: financiamento', text: '' }, score: 1.5 }]);
    expect(r[0].item.title).toMatch(/^Correção/);
  });
  it('plano de tentativas: principal → reserva → principal', () => {
    expect(attemptPlan('a', 'b', 2)).toEqual(['a', 'b', 'a']);
    expect(attemptPlan('a', null, 1)).toEqual(['a', 'a']);
    expect(attemptPlan('a', 'b', 0)).toEqual(['a']);
  });
  it('dados do contato: ignora nome que é telefone e não cria seção vazia', () => {
    expect(profileLines({ name: '5511999998888' })).toBe('');
    expect(profileLines({ name: 'Ana', tags: ['vip'], stage: 'Proposta' })).toMatch(/Nome: Ana[\s\S]*Etiquetas: vip[\s\S]*Etapa no funil: Proposta/);
  });
  it('valores fora da base', () => {
    expect(valoresForaDaBase('Sai R$ 74.900,00.', 'Onix por R$ 74.900,00')).toEqual([]);
    expect(valoresForaDaBase('Garantia de 2 anos e 10% off.', 'Onix por R$ 74.900,00')).toEqual(['10%', '2 anos']);
  });
  it('toda finalidade tem versão e nome na tela', () => {
    for (const k of Object.keys(PROMPT_VERSIONS)) expect(PURPOSE_LABEL[k]).toBeTruthy();
  });
  it('regra do dono no prompt: PASSAR_VENDEDOR só avisa a equipe, sem dizer que vai transferir', () => {
    const t = planejamentoLines({ sugerido: 'RESPONDER', metodo: 'PADRAO', handoff: true } as any).join('\n');
    expect(t).toMatch(/NÃO diz que vai transferir/);
    expect(t).not.toMatch(/especialista da equipe vai continuar/);
    expect(motivoHandoff({ textoLead: 'oi', plano: null, especialista: false })).toBeNull();
  });
});
