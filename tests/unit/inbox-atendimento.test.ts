import { describe, it, expect } from 'vitest';
import {
  normalizarAtalho, renderResposta, filtrarRespostas, termoBarra, escolherAtendente, validarFaixas, dentroDoHorario,
  descreverHorario, textoForaDoHorario, podeAvisarForaDoHorario, lerNotaCsat, csatAberta, mediaCsat, type Faixa,
} from '../../server/inbox/core.js';

describe('Inbox v1.41.0 — respostas rápidas', () => {
  it('normaliza o atalho', () => {
    expect(normalizarAtalho('/Preço Pix')).toBe('preco-pix');
    expect(normalizarAtalho('  //endereço ')).toBe('endereco');
    expect(normalizarAtalho('###')).toBe('');
  });
  it('troca {nome} e {atendente} e arruma a pontuação quando falta o nome', () => {
    expect(renderResposta('Olá {nome}, aqui é {atendente}!', { nome: 'Maria Silva', atendente: 'Ana Souza' })).toBe('Olá Maria, aqui é Ana!');
    expect(renderResposta('Olá {nome}, tudo bem?', { nome: null })).toBe('Olá, tudo bem?');
    expect(renderResposta('Oi {nome}!', { nome: '5511999999999' })).toBe('Oi!');
  });
  it('filtra a lista do "/" (começa com primeiro, depois contém no texto)', () => {
    const l = [{ id: '1', shortcut: 'pix', text: 'Nossa chave Pix é...' }, { id: '2', shortcut: 'preco', text: 'Planos a partir de...' }, { id: '3', shortcut: 'horario', text: 'Atendemos de segunda a sexta; pagamento via pix' }];
    expect(filtrarRespostas(l, 'p').map((r) => r.shortcut)).toEqual(['pix', 'preco', 'horario']);
    expect(filtrarRespostas(l, 'pre').map((r) => r.shortcut)).toEqual(['preco']);
    expect(filtrarRespostas(l, '').map((r) => r.shortcut)).toEqual(['horario', 'pix', 'preco']);
  });
  it('detecta o "/" no cursor só no início ou depois de espaço', () => {
    expect(termoBarra('/pre', 4)).toEqual({ termo: 'pre', inicio: 0 });
    expect(termoBarra('Olá /pi', 7)).toEqual({ termo: 'pi', inicio: 4 });
    expect(termoBarra('site.com/abc', 12)).toBeNull();
    expect(termoBarra('/pix e mais', 11)).toBeNull();
  });
});

describe('Inbox v1.41.0 — distribuição automática', () => {
  const ordem = ['a', 'b', 'c'];
  it('rodízio: próximo depois do último, voltando ao começo', () => {
    const cand = ordem.map((userId) => ({ userId, abertas: 0 }));
    expect(escolherAtendente(cand, ordem, null, 'rodizio')).toBe('a');
    expect(escolherAtendente(cand, ordem, 'a', 'rodizio')).toBe('b');
    expect(escolherAtendente(cand, ordem, 'c', 'rodizio')).toBe('a');
    // "b" offline: depois de "a" vai para "c".
    expect(escolherAtendente(cand.filter((c) => c.userId !== 'b'), ordem, 'a', 'rodizio')).toBe('c');
    // Último que saiu da equipe: começa pelo primeiro.
    expect(escolherAtendente(cand, ordem, 'z', 'rodizio')).toBe('a');
  });
  it('menos ocupado: menor número de conversas abertas; empate segue o rodízio', () => {
    expect(escolherAtendente([{ userId: 'a', abertas: 3 }, { userId: 'b', abertas: 1 }, { userId: 'c', abertas: 2 }], ordem, null, 'menos_ocupado')).toBe('b');
    expect(escolherAtendente([{ userId: 'a', abertas: 1 }, { userId: 'b', abertas: 1 }, { userId: 'c', abertas: 2 }], ordem, 'a', 'menos_ocupado')).toBe('b');
    expect(escolherAtendente([{ userId: 'a', abertas: 1 }, { userId: 'b', abertas: 1 }], ordem, 'b', 'menos_ocupado')).toBe('a');
  });
  it('sem candidatos: ninguém', () => {
    expect(escolherAtendente([], ordem, 'a', 'rodizio')).toBeNull();
  });
});

describe('Inbox v1.41.0 — horário de atendimento', () => {
  const semana: Faixa[] = [1, 2, 3, 4, 5].flatMap((dia) => [{ dia, inicio: '08:00', fim: '12:00' }, { dia, inicio: '13:00', fim: '18:00' }]);
  it('valida faixas (formato, fim depois do início, sobreposição)', () => {
    expect(validarFaixas(semana)).toEqual({ faixas: semana });
    expect(validarFaixas([{ dia: 1, inicio: '18:00', fim: '08:00' }])).toHaveProperty('erro');
    expect(validarFaixas([{ dia: 1, inicio: '8h', fim: '18:00' }])).toHaveProperty('erro');
    expect(validarFaixas([{ dia: 1, inicio: '08:00', fim: '12:00' }, { dia: 1, inicio: '11:00', fim: '13:00' }])).toHaveProperty('erro');
    expect(validarFaixas([{ dia: 7, inicio: '08:00', fim: '12:00' }])).toHaveProperty('erro');
  });
  it('confere no fuso de Brasília (UTC−3)', () => {
    // Segunda 23/11/2026: 10:00 BRT = 13:00 UTC (aberto); 12:30 BRT (almoço) fechado; 18:00 BRT fechado; sábado fechado.
    expect(dentroDoHorario(semana, new Date('2026-11-23T13:00:00Z'))).toBe(true);
    expect(dentroDoHorario(semana, new Date('2026-11-23T15:30:00Z'))).toBe(false);
    expect(dentroDoHorario(semana, new Date('2026-11-23T21:00:00Z'))).toBe(false);
    expect(dentroDoHorario(semana, new Date('2026-11-23T20:59:00Z'))).toBe(true);
    expect(dentroDoHorario(semana, new Date('2026-11-28T13:00:00Z'))).toBe(false);
    // 01:00 UTC de terça = 22:00 BRT de segunda: fechado.
    expect(dentroDoHorario(semana, new Date('2026-11-24T01:00:00Z'))).toBe(false);
    expect(dentroDoHorario([], new Date('2026-11-23T13:00:00Z'))).toBe(false);
  });
  it('descreve o horário agrupando dias seguidos', () => {
    expect(descreverHorario(semana)).toBe('seg a sex, 8h às 12h e 13h às 18h');
    expect(descreverHorario([...semana, { dia: 6, inicio: '08:30', fim: '12:00' }])).toBe('seg a sex, 8h às 12h e 13h às 18h; sáb, 8h30 às 12h');
  });
  it('texto padrão com {nome} e {horario}', () => {
    const t = textoForaDoHorario('', semana, 'João Pedro');
    expect(t).toContain('Olá João!');
    expect(t).toContain('seg a sex, 8h às 12h e 13h às 18h');
  });
  it('no máximo 1 aviso a cada X horas por contato', () => {
    const agora = new Date('2026-11-23T23:00:00Z');
    expect(podeAvisarForaDoHorario(null, agora, 12)).toBe(true);
    expect(podeAvisarForaDoHorario(new Date(agora.getTime() - 11 * 3600_000), agora, 12)).toBe(false);
    expect(podeAvisarForaDoHorario(new Date(agora.getTime() - 12 * 3600_000), agora, 12)).toBe(true);
  });
});

describe('Inbox v1.41.0 — nota da pesquisa de satisfação (CSAT)', () => {
  it('aceita só 1 a 5', () => {
    for (const [t, n] of [['5', 5], ['1', 1], [' 4! ', 4], ['nota 3', 3], ['Nota: 2', 2], ['5 estrelas', 5], ['4️⃣', 4], ['⭐⭐⭐', 3], ['3.', 3]] as const) expect(lerNotaCsat(t)).toBe(n);
    for (const t of ['0', '6', '10', '1 a 5', 'obrigado', 'ok', '', 'liguei 3 vezes', '45', '⭐⭐⭐⭐⭐⭐']) expect(lerNotaCsat(t)).toBeNull();
  });
  it('vale por 24 horas', () => {
    const t0 = new Date('2026-11-23T12:00:00Z');
    expect(csatAberta(t0, new Date(t0.getTime() + 23 * 3600_000))).toBe(true);
    expect(csatAberta(t0, new Date(t0.getTime() + 25 * 3600_000))).toBe(false);
  });
  it('média com uma casa', () => {
    expect(mediaCsat([5, 4, 4])).toBe(4.3);
    expect(mediaCsat([])).toBeNull();
  });
});
