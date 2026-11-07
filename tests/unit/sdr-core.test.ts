import { describe, it, expect } from 'vitest';
import {
  computeScore, temperatureOf, mergeAnswers, parseExtraction, normalizeQuestions, channelAllowed, renderTemplate, inBusinessHours,
  advanceStage, defaultCadenceSteps, SEGMENTS, normalizePhone, normalizeEmail, normalizeSteps, DEFAULT_QUESTIONS, OPT_OUT_WORDS,
} from '../../server/sdr/core.js';
import { parseCsv } from '../../server/sdr/csv.js';

describe('SDR — pontuação e temperatura', () => {
  const qs = DEFAULT_QUESTIONS; // pesos 35/20/25/20
  it('média ponderada das notas; sem resposta vale 0', () => {
    expect(computeScore(qs, {})).toBe(0);
    expect(computeScore(qs, { necessidade: { resposta: 'x', nota: 100 } })).toBe(35);
    expect(computeScore(qs, { necessidade: { resposta: 'x', nota: 100 }, porte: { resposta: 'y', nota: 100 }, prazo: { resposta: 'z', nota: 100 }, orcamento: { resposta: 'w', nota: 100 } })).toBe(100);
    expect(computeScore(qs, { necessidade: { resposta: 'x', nota: 80 }, prazo: { resposta: 'z', nota: 60 } })).toBe(43);
    expect(computeScore(qs, { necessidade: { resposta: '', nota: 100 } })).toBe(0);
    expect(computeScore(qs, { necessidade: { resposta: 'x', nota: 500 } })).toBe(35); // nota limitada a 100
  });
  it('frio / morno / quente pelos limites da empresa', () => {
    expect(temperatureOf(10)).toBe('FRIO');
    expect(temperatureOf(40)).toBe('MORNO');
    expect(temperatureOf(69)).toBe('MORNO');
    expect(temperatureOf(70)).toBe('QUENTE');
    expect(temperatureOf(55, 30, 50)).toBe('QUENTE');
  });
  it('respostas novas somam às antigas (vazio não apaga)', () => {
    const old = { necessidade: { resposta: 'site', nota: 70 } };
    const m = mergeAnswers(qs, old, { porte: { resposta: '5 pessoas', nota: 60 }, necessidade: { resposta: '', nota: 0 }, invasor: { resposta: 'x', nota: 100 } });
    expect(m).toEqual({ necessidade: { resposta: 'site', nota: 70 }, porte: { resposta: '5 pessoas', nota: 60 } });
  });
  it('lê o JSON da IA com tolerância', () => {
    expect(parseExtraction('```json\n{"respostas":{"prazo":{"resposta":"hoje","nota":90}},"resumo":"ok"}\n```')).toEqual({ respostas: { prazo: { resposta: 'hoje', nota: 90 } }, resumo: 'ok' });
    expect(parseExtraction('sem json')).toBeNull();
  });
  it('perguntas configuráveis normalizadas (máx. 8, ids únicos, peso 1–100)', () => {
    const q = normalizeQuestions([{ pergunta: 'Qual o orçamento?', peso: 500 }, { id: 'a', pergunta: 'x?' }, { id: 'a', pergunta: 'y?' }, { pergunta: '' }]);
    expect(q).toHaveLength(3);
    expect(q[0]).toMatchObject({ id: 'qual_o_orcamento', peso: 100 });
    expect(new Set(q.map((x) => x.id)).size).toBe(3);
  });
});

describe('SDR — canais permitidos (consentimento, opt-out, canal de entrada)', () => {
  const base = { phone: '+5511999990000', email: 'a@b.com.br', consentAt: null as Date | null, optOutAt: null as Date | null };
  it('lead frio importado sem consentimento: nunca WhatsApp, só e-mail', () => {
    expect(channelAllowed({ ...base, source: 'IMPORTACAO' }, 'WHATSAPP').ok).toBe(false);
    expect(channelAllowed({ ...base, source: 'IMPORTACAO' }, 'EMAIL').ok).toBe(true);
  });
  it('com consentimento: WhatsApp liberado', () => {
    expect(channelAllowed({ ...base, source: 'IMPORTACAO', consentAt: new Date() }, 'WHATSAPP').ok).toBe(true);
  });
  it('quem chamou no WhatsApp: segue no WhatsApp, sem e-mail', () => {
    expect(channelAllowed({ ...base, source: 'WHATSAPP' }, 'WHATSAPP').ok).toBe(true);
    expect(channelAllowed({ ...base, source: 'WHATSAPP' }, 'EMAIL').ok).toBe(false);
  });
  it('opt-out bloqueia tudo', () => {
    const l = { ...base, source: 'FORMULARIO', consentAt: new Date(), optOutAt: new Date() };
    expect(channelAllowed(l, 'WHATSAPP').ok).toBe(false);
    expect(channelAllowed(l, 'EMAIL').ok).toBe(false);
  });
  it('palavras de saída', () => {
    for (const w of ['SAIR', 'parar', 'Pare!', 'stop']) expect(OPT_OUT_WORDS.test(w)).toBe(true);
    expect(OPT_OUT_WORDS.test('não quero sair da reunião')).toBe(false);
  });
});

describe('SDR — cadências, modelos e horário', () => {
  it('cadência pronta para cada segmento, com WhatsApp e e-mail e dias crescentes', () => {
    for (const s of SEGMENTS) {
      const steps = defaultCadenceSteps(s.id);
      expect(steps.length).toBeGreaterThanOrEqual(4);
      expect(steps.some((x) => x.canal === 'EMAIL') && steps.some((x) => x.canal === 'WHATSAPP')).toBe(true);
      expect(steps.map((x) => x.dia)).toEqual([...steps.map((x) => x.dia)].sort((a, b) => a - b));
      expect(normalizeSteps(steps)).toHaveLength(steps.length);
    }
  });
  it('variáveis do modelo, com escape no HTML', () => {
    expect(renderTemplate('Oi {primeiro_nome} da {empresa}, aqui é {minha_empresa}', { nome: 'Ana Souza', empresa: 'Loja X', minhaEmpresa: 'MCK' })).toBe('Oi Ana da Loja X, aqui é MCK');
    expect(renderTemplate('{nome}', { nome: '<b>x</b>' }, (s) => s.replace(/</g, '&lt;'))).toBe('&lt;b>x&lt;/b>');
  });
  it('horário comercial no fuso da empresa', () => {
    const s = { workStart: '09:00', workEnd: '18:00', workDays: '1,2,3,4,5' };
    expect(inBusinessHours(s, new Date('2026-11-09T13:00:00Z'), 'America/Sao_Paulo')).toBe(true); // seg 10h
    expect(inBusinessHours(s, new Date('2026-11-09T22:00:00Z'), 'America/Sao_Paulo')).toBe(false); // seg 19h
    expect(inBusinessHours(s, new Date('2026-11-08T13:00:00Z'), 'America/Sao_Paulo')).toBe(false); // domingo
  });
  it('funil só anda para a frente pela automação; ganho/perdido ficam', () => {
    expect(advanceStage('NOVO', 'CONTATADO')).toBe('CONTATADO');
    expect(advanceStage('QUALIFICADO', 'RESPONDEU')).toBe('QUALIFICADO');
    expect(advanceStage('GANHO', 'REUNIAO')).toBe('GANHO');
  });
  it('telefone e e-mail normalizados', () => {
    expect(normalizePhone('(11) 98888-7777')).toBe('+5511988887777');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizeEmail(' Ana@Loja.com.BR ')).toBe('ana@loja.com.br');
    expect(normalizeEmail('nao-email')).toBeNull();
  });
});

describe('SDR — CSV', () => {
  it('ponto e vírgula, aspas, BOM, cabeçalhos com acento/sinônimos', () => {
    const rows = parseCsv('\uFEFFNome;Empresa;Celular;E-mail;Consentimento\r\n"Ana; Souza";Loja X;11988887777;ana@x.com;sim\r\nBeto;;;beto@y.com;\r\n');
    expect(rows).toEqual([
      { nome: 'Ana; Souza', empresa: 'Loja X', telefone: '11988887777', email: 'ana@x.com', consentimento: 'sim' },
      { nome: 'Beto', empresa: '', telefone: '', email: 'beto@y.com', consentimento: '' },
    ]);
  });
});
