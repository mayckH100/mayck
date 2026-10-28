import { describe, it, expect } from 'vitest';
import { chunkText, rank, tokenize } from '../../server/ai/rag.js';
import { inventedPrices, isSensitiveQuestion } from '../../server/ai/guard.js';
import { FakeProvider, createProvider, GeminiProvider, OpenAICompatibleProvider } from '../../server/ai/providers.js';
import { buildSystemPrompt } from '../../server/ai/service.js';

describe('RAG', () => {
  it('tokeniza sem acentos e sem stopwords', () => {
    expect(tokenize('Qual é o horário de atendimento?')).toEqual(['horario', 'atendimento']);
  });
  it('fragmenta textos longos', () => {
    const chunks = chunkText(('Parágrafo de teste. '.repeat(30) + '\n\n').repeat(5), 500, 50);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunkText('   ')).toEqual([]);
  });
  it('ranqueia o trecho mais relevante primeiro', () => {
    const docs = [
      { text: 'Nosso horário de atendimento é de segunda a sexta, das 8h às 18h.' },
      { text: 'O plano básico custa R$ 49,90 por mês.' },
      { text: 'Entregamos em todo o Brasil pelos Correios.' },
    ];
    const r = rank('quanto custa o plano?', docs, 2);
    expect(r[0].item.text).toContain('49,90');
    expect(rank('xyz inexistente', docs)).toEqual([]);
  });
});

describe('Regras anti-invenção', () => {
  it('detecta perguntas sobre preço/política', () => {
    expect(isSensitiveQuestion('Qual o preço do plano?')).toBe(true);
    expect(isSensitiveQuestion('Como funciona a devolução?')).toBe(true);
    expect(isSensitiveQuestion('Bom dia, tudo bem?')).toBe(false);
  });
  it('bloqueia preço que não está no contexto e aceita o que está', () => {
    expect(inventedPrices('Custa R$ 49,90 por mês', 'O plano básico custa R$ 49,90')).toEqual([]);
    expect(inventedPrices('Custa R$ 39,90', 'O plano básico custa R$ 49,90')).toEqual(['R$ 39,90']);
    expect(inventedPrices('Sai por 100 reais', '')).toEqual(['100 reais']);
  });
  it('o prompt de sistema contém as regras e o contexto', () => {
    const p = buildSystemPrompt({ instructions: 'Seja breve', tone: 'amigável' }, 'CTX-123');
    expect(p).toContain('informar preços');
    expect(p).toContain('CTX-123');
    expect(p).toContain('[TRANSFERIR]');
    expect(p).toContain('amigável');
  });
});

describe('Provedores de IA', () => {
  it('provedor fake é determinístico', async () => {
    const f = new FakeProvider();
    const msgs = [{ role: 'system' as const, content: 'x\n### CONTEXTO\n[Doc]\nAbrimos às 8h.\n### FIM' }, { role: 'user' as const, content: 'que horas abre?' }];
    const a = await f.chat(msgs);
    const b = await f.chat(msgs);
    expect(a).toEqual(b);
    expect(a.text).toContain('Abrimos às 8h.');
    await expect(f.chat([{ role: 'user', content: 'falhar' }])).rejects.toThrow();
  });
  it('fábrica exige chave e escolhe o provedor', () => {
    expect(() => createProvider('gemini', null)).toThrow(/não configurada/);
    expect(createProvider('gemini', 'k')).toBeInstanceOf(GeminiProvider);
    expect(createProvider('openai', 'k')).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createProvider('fake', null)).toBeInstanceOf(FakeProvider);
    expect(() => createProvider('outro', 'k')).toThrow(/desconhecido/);
  });
  it('provedor fake é recusado fora do ambiente de teste', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createProvider('fake', null)).toThrow(/não pode ser usado fora dos testes/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
