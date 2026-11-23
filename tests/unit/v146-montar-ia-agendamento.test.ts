import { describe, it, expect } from 'vitest';
import {
  textoDoHtml, normalizarLink, lerJson, normalizarProposta, precoNasFontes, documentos, blocoInstrucoes, mesclarInstrucoes,
  fluxoInicial, textoForaHorario, propostaVazia, mensagemFontes, MARCA_INI, MARCA_FIM, OPCAO_ATENDENTE, PREFIXO_DOC,
} from '../../server/ai/montar/core.js';
import { validateGraph } from '../../server/flows/logic.js';
import { normalizeGraph, menuHandleId } from '../../server/flows/handles.js';
import { slugify, validarSlug, horariosDoDia, diasDeAtendimento, horaLocal, precoBr, validarNome, pareceRobo, lerDia, passoMin } from '../../server/agendamento/core.js';
import { zonedToUtc } from '../../server/agenda/time.js';
import { mensagemDeValidacao } from '../../server/lib/http.js';
import { z } from 'zod';

describe('v1.46.0 — Monte sua IA: leitura das fontes', () => {
  it('textoDoHtml: título, descrições, corpo sem scripts/estilos e entidades decodificadas', () => {
    const html = `<html><head><title>Pet Feliz</title><meta name="description" content="Banho &amp; tosa em Osasco"><meta property="og:description" content='Agende já'>
      <style>.x{color:red}</style><script>alert('x')</script></head><body><h1>Preços</h1><p>Banho P: R$&nbsp;45,00</p><p>Banho P: R$&nbsp;45,00</p><!-- oculto --><li>Seg a sex 9h às 18h</li></body></html>`;
    const t = textoDoHtml(html);
    expect(t).toContain('Pet Feliz');
    expect(t).toContain('Banho & tosa em Osasco');
    expect(t).toContain('Agende já');
    expect(t).toContain('Banho P: R$ 45,00');
    expect(t.match(/Banho P/g)).toHaveLength(1); // linha repetida sai uma vez
    expect(t).not.toMatch(/alert|color:red|oculto/);
  });

  it('normalizarLink: domínio sem https, @ do Instagram e inválidos', () => {
    expect(normalizarLink('minhaloja.com.br')).toBe('https://minhaloja.com.br/');
    expect(normalizarLink('@pet.feliz')).toBe('https://www.instagram.com/pet.feliz/');
    expect(normalizarLink('http://a.com/x')).toBe('http://a.com/x');
    expect(normalizarLink('')).toBeNull();
    expect(normalizarLink('semponto')).toBeNull();
    expect(normalizarLink('javascript:alert(1)')).toBeNull();
  });

  it('lerJson: aceita cercas ```json e texto em volta; recusa lixo', () => {
    expect(lerJson('```json\n{"empresa":"A"}\n```')).toEqual({ empresa: 'A' });
    expect(lerJson('Aqui está: {"a":1} pronto')).toEqual({ a: 1 });
    expect(lerJson('sem json')).toBeNull();
    expect(lerJson('[1,2]')).toBeNull();
  });

  it('mensagemFontes: rotula cada fonte e respeita o limite total', () => {
    const m = mensagemFontes([{ tipo: 'link', nome: 'https://x.com', texto: 'a'.repeat(50_000) }, { tipo: 'texto', nome: '', texto: 'Banho R$ 45' }], 30_000);
    expect(m).toContain('### PÁGINA: https://x.com');
    expect(m).toContain('### TEXTO DO DONO');
    expect(m.length).toBeLessThan(31_000);
  });
});

describe('v1.46.0 — Monte sua IA: prévia', () => {
  const fontes = 'Banho pequeno R$ 45,00. Tosa R$ 80. Seg a sex 9h às 18h.';
  const raw = {
    empresa: 'Pet Feliz', segmento: 'pet shop', resumo: 'Banho e tosa em Osasco.',
    produtos: [{ nome: 'Banho pequeno', preco: 'R$ 45,00' }, { nome: 'Tosa', preco: 'R$ 80' }, { nome: 'Hidratação', preco: 'R$ 99,90' }, { nome: '' }],
    horarios: [{ dia: 1, inicio: '9:00', fim: '18:00' }, { dia: 2, inicio: '09:00', fim: '08:00' }, { dia: 1, inicio: '10:00', fim: '11:00' }, { dia: 9, inicio: '09:00', fim: '10:00' }],
    regras: ['Pagamento na retirada', ''], nuncaPrometer: ['desconto'], perguntas: [{ pergunta: 'Busca em casa?', resposta: 'Não.' }, { pergunta: 'x' }],
    setores: ['Ver preços', 'Falar com atendente', 'Agendar banho'], boasVindas: '', foraDoHorario: 'Estamos fechados agora!',
  };
  const p = normalizarProposta(raw, fontes);

  it('produtos sem nome caem; preço que não está nas fontes fica marcado', () => {
    expect(p.produtos.map((x) => x.nome)).toEqual(['Banho pequeno', 'Tosa', 'Hidratação']);
    expect(p.produtos.map((x) => x.precoConferido)).toEqual([true, true, false]);
    expect(precoNasFontes('R$ 45', 'custa 45,00')).toBe(true);
    expect(precoNasFontes('sob consulta', '')).toBe(true);
  });

  it('horários: faixa inválida, sobreposta ou com dia errado cai sozinha; as boas ficam', () => {
    expect(p.horarios).toEqual([{ dia: 1, inicio: '09:00', fim: '18:00' }]);
  });

  it('setores sem "atendente" (a opção já existe) e boas-vindas padrão com o nome', () => {
    expect(p.setores).toEqual(['Ver preços', 'Agendar banho']);
    expect(p.boasVindas).toContain('Pet Feliz');
    expect(p.perguntas).toHaveLength(1);
    expect(p.regras).toEqual(['Pagamento na retirada']);
    expect(propostaVazia(p)).toBe(false);
    expect(propostaVazia(normalizarProposta({}))).toBe(true);
    expect(normalizarProposta({ setores: [] }).setores.length).toBeGreaterThanOrEqual(2);
  });

  it('documentos da base: só com conteúdo e com o prefixo do assistente', () => {
    const docs = documentos(p);
    expect(docs.map((d) => d.title)).toEqual([`${PREFIXO_DOC}Sobre a empresa`, `${PREFIXO_DOC}Produtos e preços`, `${PREFIXO_DOC}Horário de atendimento`, `${PREFIXO_DOC}Regras e políticas`, `${PREFIXO_DOC}Perguntas frequentes`]);
    expect(docs[1].content).toContain('- Tosa: R$ 80');
    expect(docs[2].content).toContain('Segunda: 09:00 às 18:00');
  });

  it('instruções: bloco entre marcas, regra de transferência só a pedido, e mescla sem apagar o que o dono escreveu', () => {
    const b = blocoInstrucoes(p);
    expect(b.startsWith(MARCA_INI) && b.endsWith(MARCA_FIM)).toBe(true);
    expect(b).toContain('Só passe para um atendente humano se o cliente pedir');
    expect(b).toContain('Nunca prometa: desconto');
    const dono = 'Sempre chame o cliente de você.';
    const m1 = mesclarInstrucoes(dono, b, false);
    expect(m1.startsWith(dono)).toBe(true);
    const b2 = blocoInstrucoes({ ...p, empresa: 'Pet Feliz 2' });
    const m2 = mesclarInstrucoes(m1, b2, false);
    expect(m2).toContain(dono);
    expect(m2).toContain('Pet Feliz 2');
    expect(m2.split(MARCA_INI)).toHaveLength(2); // troca o bloco, não duplica
    expect(mesclarInstrucoes(dono, b, true)).toBe(b);
    expect(mesclarInstrucoes('', b, false)).toBe(b);
  });

  it('fluxo inicial válido: primeira mensagem → boas-vindas → menu (setores + atendente) → IA / transferência', () => {
    const g = normalizeGraph(fluxoInicial(p));
    expect(validateGraph(g)).toEqual([]);
    const start = g.nodes.find((n) => n.type === 'start')!;
    expect(start.data.triggers).toEqual([{ type: 'first_message' }]);
    const menu = g.nodes.find((n) => n.type === 'menu')!;
    expect(menu.data.options.map((o: any) => o.label)).toEqual(['Ver preços', 'Agendar banho', OPCAO_ATENDENTE]);
    const alvo = (h: string) => g.nodes.find((n) => n.id === g.edges.find((e) => e.source === menu.id && e.sourceHandle === h)?.target)?.type;
    expect(alvo(menuHandleId('s1'))).toBe('ai');
    expect(alvo(menuHandleId('humano'))).toBe('handoff');
    expect(alvo('invalid')).toBe('ai');
  });

  it('fora do horário: usa o texto da IA e garante o {horario}', () => {
    expect(textoForaHorario(p)).toBe('Estamos fechados agora! Nosso horário: {horario}.');
    expect(textoForaHorario({ ...p, foraDoHorario: '' })).toContain('{horario}');
  });
});

describe('v1.46.0 — página pública de agendamento (puro)', () => {
  const tz = 'America/Sao_Paulo';
  const exp = { workStart: '09:00', workEnd: '12:00', workDays: [1, 2, 3, 4, 5], minNoticeMin: 60 };
  // Segunda, 30/11/2026, 07:00 em Brasília.
  const agora = zonedToUtc(2026, 11, 30, 7, 0, tz);

  it('slug: nome vira endereço; validação e reservados', () => {
    expect(slugify('Clínica São José & Cia')).toBe('clinica-sao-jose-cia');
    expect(slugify('A')).toMatch(/^empresa-/);
    expect(validarSlug('pet-feliz')).toEqual({ slug: 'pet-feliz' });
    expect('erro' in validarSlug('Pet Feliz')).toBe(true);
    expect('erro' in validarSlug('admin')).toBe(true);
    expect('erro' in validarSlug('-ab')).toBe(true);
  });

  it('horários do dia: expediente, duração, antecedência mínima e ocupados', () => {
    const livres = horariosDoDia('2026-11-30', 60, exp, [{ start: zonedToUtc(2026, 11, 30, 10, 0, tz), end: zonedToUtc(2026, 11, 30, 10, 30, tz) }], tz, agora, 30);
    // 09:00 cabe (antecedência 60 min a partir das 07:00 = 08:00); 09:30 e 10:00 batem no ocupado 10:00–10:30; 11:00 é o último que cabe (fim 12:00).
    expect(livres.map((d) => horaLocal(d, tz))).toEqual(['09:00', '10:30', '11:00']);
    expect(horariosDoDia('2026-11-29', 30, exp, [], tz, agora, 30)).toEqual([]); // domingo
    expect(horariosDoDia('2027-02-01', 30, exp, [], tz, agora, 30)).toEqual([]); // além do limite de dias
    expect(horariosDoDia('2026-02-31', 30, exp, [], tz, agora, 30)).toEqual([]);
    expect(passoMin(15)).toBe(15);
    expect(horariosDoDia('2026-12-01', 15, exp, [], tz, agora, 30)).toHaveLength(12);
  });

  it('dias de atendimento só nos dias da semana configurados', () => {
    const dias = diasDeAtendimento(exp, tz, agora, 7);
    expect(dias).toEqual(['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-07']);
    expect(lerDia('2026-13-01')).toBeNull();
  });

  it('preço, nome e anti-robô', () => {
    expect(precoBr(4000)).toBe('R$ 40,00');
    expect(precoBr(123456)).toBe('R$ 1.234,56');
    expect(precoBr(null)).toBeNull();
    expect(validarNome('  Ana   Paula ')).toBe('Ana Paula');
    expect(validarNome('a')).toBeNull();
    expect(validarNome('veja http://spam')).toBeNull();
    expect(pareceRobo('preenchido', 10_000)).toBe(true);
    expect(pareceRobo('', 500)).toBe(true);
    expect(pareceRobo('', 8000)).toBe(false);
    expect(pareceRobo(undefined, undefined)).toBe(false);
  });
});

describe('v1.46.0 — erros de validação em português', () => {
  it('mensagem com o nome do campo e sem inglês', () => {
    const r = z.object({ name: z.string().min(2), email: z.string().email(), dailyLimit: z.number().max(10) }).safeParse({ name: 'a', email: 'x', dailyLimit: 99 });
    const m = mensagemDeValidacao(r.error!);
    expect(m).toContain('Nome: mínimo de 2 caracteres');
    expect(m).toContain('E-mail: e-mail inválido');
    expect(m).toContain('Limite diário: o máximo é 10');
    expect(m).not.toMatch(/Too|expected|Invalid/);
  });
});
