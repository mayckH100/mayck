import { describe, it, expect } from 'vitest';
import { AI_TEMPLATES, aiTemplateById } from '../../web/src/lib/aiTemplates.js';

describe('Modelos de Instruções da IA por segmento', () => {
  it('seis segmentos, texto editável, sem preço inventado e dentro do limite das Instruções', () => {
    expect(AI_TEMPLATES.map((t) => t.label)).toEqual(['Corretora de seguros', 'Salão de beleza / barbearia', 'Clínica / consultório', 'Loja / comércio', 'Restaurante / delivery', 'Prestador de serviço']);
    for (const t of AI_TEMPLATES) {
      expect(t.text).toContain('[preencha');
      expect(t.text).not.toMatch(/R\$\s*\d/); // preço sempre como campo a preencher
      expect(t.text).not.toMatch(/\b\d{1,2}(h|:\d{2})\s*(às|a|-)\s*\d/); // nenhum horário de funcionamento fixo
      expect(t.text.length).toBeLessThan(8000);
      expect(t.text).toMatch(/nunca invente/);
    }
    expect(aiTemplateById('salao')?.label).toBe('Salão de beleza / barbearia');
    expect(aiTemplateById('x')).toBeNull();
  });
});
