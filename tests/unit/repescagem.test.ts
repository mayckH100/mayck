import { describe, it, expect } from 'vitest';
import {
  classificarDestinatario, melhorStatus, decidirRepescagem, resolverSpintax, textoModelo, validarTextoIa, garantirSair, parecenca,
  type DadosElegibilidade,
} from '../../server/mckmensagem/repescagemCore.js';
import { LEAD_STATUS } from '../../server/mckmensagem/constants.js';

const DAY = 86400e3;
const t0 = new Date('2026-11-22T13:00:00Z');

function base(over: Partial<DadosElegibilidade> = {}, rec: Partial<DadosElegibilidade['recipient']> = {}): DadosElegibilidade {
  return {
    cfg: { ativa: true, dias: 2, max: 2 }, campanhaStatus: 'CONCLUIDA',
    recipient: { status: 'ENVIADA', sentAt: t0, repescagens: 0, ultimaRepescagemAt: null, repescagemStatus: null, respondeuAt: null, repescagemAposAt: null, ...rec },
    grupo: 'NAO_VISUALIZOU', lead: { status: 'CONTATADO', optOutAt: null }, contatoOptOut: false, atendimentoHumano: false, erroBloqueio: false,
    ...over,
  };
}

describe('v1.43.0 — separação automática dos contatos da campanha', () => {
  it('melhor status: lida > entregue > enviada; só falhou quando tudo falhou', () => {
    expect(melhorStatus([])).toBeNull();
    expect(melhorStatus(['SENT', 'READ', 'DELIVERED'])).toBe('READ');
    expect(melhorStatus(['FAILED', 'DELIVERED'])).toBe('DELIVERED');
    expect(melhorStatus(['FAILED', 'FAILED'])).toBe('FAILED');
    expect(melhorStatus(['sent', null])).toBe('SENT');
  });

  it('grupos: respondeu, visualizou, não visualizou, falhou, saiu, fila e não enviada', () => {
    const g = (o: Partial<Parameters<typeof classificarDestinatario>[0]>) => classificarDestinatario({ recipientStatus: 'ENVIADA', msgStatus: 'DELIVERED', respondeu: false, saiu: false, ...o });
    expect(g({ respondeu: true, msgStatus: 'READ' })).toBe('RESPONDEU');
    expect(g({ respondeu: true, msgStatus: null })).toBe('RESPONDEU'); // "sim" sem recibo de leitura também é resposta
    expect(g({ msgStatus: 'READ' })).toBe('VISUALIZOU');
    expect(g({ msgStatus: 'DELIVERED' })).toBe('NAO_VISUALIZOU');
    expect(g({ msgStatus: 'SENT' })).toBe('NAO_VISUALIZOU');
    expect(g({ msgStatus: 'FAILED' })).toBe('FALHOU');
    expect(g({ recipientStatus: 'FALHOU', msgStatus: null })).toBe('FALHOU');
    expect(g({ saiu: true, respondeu: true })).toBe('SAIU');
    expect(g({ recipientStatus: 'PENDENTE', msgStatus: null })).toBe('PENDENTE');
    expect(g({ recipientStatus: 'IGNORADA', msgStatus: null })).toBe('NAO_ENVIADA');
  });

  it('SEM_RESPOSTA entra na lista de status de lead (telas e filtros)', () => {
    expect(LEAD_STATUS).toContain('SEM_RESPOSTA');
    expect(LEAD_STATUS.slice(0, 7)).toEqual(['NOVO', 'CONTATADO', 'RESPONDEU', 'QUALIFICADO', 'AGUARDANDO', 'CONVERTIDO', 'DESCARTADO']);
  });
});

describe('v1.43.0 — elegibilidade da repescagem', () => {
  const depois = (dias: number) => new Date(t0.getTime() + dias * DAY + 60_000);

  it('espera os dias configurados e envia só para visualizou/não visualizou', () => {
    expect(decidirRepescagem(base(), depois(1))).toMatchObject({ acao: 'AGUARDAR' });
    expect(decidirRepescagem(base(), depois(2))).toEqual({ acao: 'ENVIAR', tentativa: 1 });
    expect(decidirRepescagem(base({ grupo: 'VISUALIZOU' }), depois(2))).toEqual({ acao: 'ENVIAR', tentativa: 1 });
    expect(decidirRepescagem(base({ grupo: 'PENDENTE' }), depois(9))).toEqual({ acao: 'IGNORAR' });
  });

  it('NUNCA reenvia para quem respondeu qualquer coisa (inclusive "sim")', () => {
    expect(decidirRepescagem(base({ grupo: 'RESPONDEU' }), depois(5))).toMatchObject({ acao: 'PARAR', status: 'RESPONDEU' });
    expect(decidirRepescagem(base({}, { respondeuAt: new Date(t0.getTime() + 1000) }), depois(5))).toMatchObject({ acao: 'PARAR', status: 'RESPONDEU' });
    for (const status of ['RESPONDEU', 'QUALIFICADO', 'AGUARDANDO', 'CONVERTIDO', 'DESCARTADO', 'SEM_RESPOSTA']) {
      expect(decidirRepescagem(base({ lead: { status, optOutAt: null } }), depois(5)).acao).toBe('PARAR');
    }
    // Já marcado como respondeu/parado/sem resposta/enviando: nada a fazer.
    for (const s of ['RESPONDEU', 'PARADA', 'SEM_RESPOSTA', 'ENVIANDO']) expect(decidirRepescagem(base({}, { repescagemStatus: s }), depois(9))).toEqual({ acao: 'IGNORAR' });
  });

  it('não envia para quem saiu, falhou/bloqueou, com atendente ou lead apagado', () => {
    expect(decidirRepescagem(base({ grupo: 'SAIU' }), depois(5))).toMatchObject({ acao: 'PARAR', status: 'PARADA' });
    expect(decidirRepescagem(base({ contatoOptOut: true }), depois(5))).toMatchObject({ acao: 'PARAR' });
    expect(decidirRepescagem(base({ lead: { status: 'CONTATADO', optOutAt: t0 } }), depois(5))).toMatchObject({ acao: 'PARAR' });
    expect(decidirRepescagem(base({ grupo: 'FALHOU' }), depois(5))).toMatchObject({ acao: 'PARAR' });
    expect(decidirRepescagem(base({ erroBloqueio: true }), depois(5))).toMatchObject({ acao: 'PARAR' });
    expect(decidirRepescagem(base({ atendimentoHumano: true }), depois(5))).toMatchObject({ acao: 'PARAR' });
    expect(decidirRepescagem(base({ lead: null }), depois(5))).toMatchObject({ acao: 'PARAR' });
  });

  it('limite de tentativas: depois da última sem resposta vira "Sem resposta" e para', () => {
    const r1 = { repescagens: 1, ultimaRepescagemAt: new Date(t0.getTime() + 2 * DAY) };
    expect(decidirRepescagem(base({}, r1), depois(3))).toMatchObject({ acao: 'AGUARDAR' });
    expect(decidirRepescagem(base({}, r1), depois(4))).toEqual({ acao: 'ENVIAR', tentativa: 2 });
    const r2 = { repescagens: 2, ultimaRepescagemAt: new Date(t0.getTime() + 4 * DAY) };
    expect(decidirRepescagem(base({}, r2), depois(5))).toMatchObject({ acao: 'AGUARDAR' });
    expect(decidirRepescagem(base({}, r2), depois(6))).toEqual({ acao: 'FINALIZAR' });
    // Máximo 1: a 1ª já é a última.
    expect(decidirRepescagem(base({ cfg: { ativa: true, dias: 2, max: 1 } }, r1), depois(4))).toEqual({ acao: 'FINALIZAR' });
  });

  it('desligada, campanha pausada/rascunho ou nova tentativa adiada: não faz nada', () => {
    expect(decidirRepescagem(base({ cfg: { ativa: false, dias: 2, max: 2 } }), depois(9))).toEqual({ acao: 'IGNORAR' });
    expect(decidirRepescagem(base({ campanhaStatus: 'PAUSADA' }), depois(9))).toEqual({ acao: 'IGNORAR' });
    expect(decidirRepescagem(base({ campanhaStatus: 'EM_ANDAMENTO' }), depois(2)).acao).toBe('ENVIAR');
    expect(decidirRepescagem(base({}, { repescagemAposAt: depois(3) }), depois(2))).toMatchObject({ acao: 'AGUARDAR' });
  });
});

describe('v1.43.0 — texto da repescagem sem IA e checagem do texto da IA', () => {
  it('spintax: escolhe uma variação, aceita aninhada e mantém {nome}', () => {
    expect(resolverSpintax('{Oi|Olá} {nome}', () => 0)).toBe('Oi {nome}');
    expect(resolverSpintax('{Oi|Olá} {nome}', () => 0.99)).toBe('Olá {nome}');
    expect(resolverSpintax('{a|{b|c}}', () => 0.99)).toBe('c');
    expect(resolverSpintax('sem variação')).toBe('sem variação');
  });

  it('texto modelo: nome, variações diferentes e saída SAIR; sem nome não sobra vírgula', () => {
    const a = textoModelo('{Oi|Olá} {nome}! Ainda tem interesse?', 'NAO_VISUALIZOU', 'Ana Souza', () => 0);
    const b = textoModelo('{Oi|Olá} {nome}! Ainda tem interesse?', 'NAO_VISUALIZOU', 'Ana Souza', () => 0.99);
    expect(a.startsWith('Oi Ana!')).toBe(true);
    expect(b.startsWith('Olá Ana!')).toBe(true);
    expect(a).toMatch(/responda SAIR/);
    const semNome = textoModelo('', 'VISUALIZOU', null, () => 0);
    expect(semNome).not.toMatch(/\{|\}| ,/);
    expect(semNome).toMatch(/SAIR/);
    expect(textoModelo('', 'VISUALIZOU', 'Bia', () => 0)).not.toBe(textoModelo('', 'NAO_VISUALIZOU', 'Bia', () => 0));
  });

  it('texto da IA: recusa cópia da original, link novo, marcador e "vi que você visualizou"; garante SAIR', () => {
    const original = 'Olá {nome}! Temos uma promoção de 20% no plano anual para novos clientes. Acesse https://exemplo.com.br/promo';
    expect(validarTextoIa('Olá Ana! Temos uma promoção de 20% no plano anual para novos clientes. Acesse https://exemplo.com.br/promo', [original])).toBeNull();
    expect(validarTextoIa('Oi Ana, ainda dá tempo de aproveitar o desconto do anual. Veja em https://outro.site/x', [original])).toBeNull();
    expect(validarTextoIa('Oi [nome], tudo bem? Posso te contar mais do desconto?', [original])).toBeNull();
    expect(validarTextoIa('Oi Ana, vi que você visualizou minha mensagem. Ficou com dúvida?', [original])).toBeNull();
    expect(validarTextoIa('ok', [original])).toBeNull();
    const bom = validarTextoIa('"Oi Ana, tudo certo? Ainda dá tempo de garantir o desconto no anual. Quer que eu te explique como funciona?"', [original]);
    expect(bom).toMatch(/^Oi Ana/);
    expect(bom).toMatch(/responda SAIR\.$/);
    expect(garantirSair('Oi! Responda SAIR para sair.')).toBe('Oi! Responda SAIR para sair.');
    expect(parecenca('a casa amarela bonita', 'a casa amarela bonita')).toBe(1);
  });
});
