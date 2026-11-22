import { describe, it, expect } from 'vitest';
import { crc16, pixCopiaECola, normalizarChave, valorEmCentavos, brCodeValido, codigoCobranca, txidDe, textoCobranca } from '../../server/pix/core.js';
import { lerCodigo, normalizarCodigo, linkWaMe, textoDoLink, lerReferral, agruparOrigens, rotuloOrigem } from '../../server/origem/core.js';
import { parseWebhook } from '../../server/whatsapp/cloudClient.js';
import { JanelaLimite, lerDominios, origemPermitida, visitanteValido, waIdDoVisitante, corValida, limparTexto, codigoEmbed } from '../../server/site/core.js';
import { decisaoRisco } from '../../server/mckmensagem/dispatcher.js';
import { transcricao, limparSaida } from '../../server/inbox/assistente.js';

/** Lê os campos TLV de primeiro nível do BR Code. */
function tlv(code: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < code.length) {
    const id = code.slice(i, i + 2), len = Number(code.slice(i + 2, i + 4));
    out[id] = code.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

describe('v1.44.0 — Pix copia e cola (BR Code + CRC16)', () => {
  it('CRC16-CCITT bate com o exemplo do manual do BR Code (Banco Central)', () => {
    const exemplo = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
    expect(crc16(exemplo)).toBe('1D3D');
    expect(brCodeValido(exemplo + '1D3D')).toBe(true);
    expect(brCodeValido(exemplo + '1D3E')).toBe(false);
    expect(crc16('123456789')).toBe('29B1'); // vetor clássico do CRC-16/CCITT-FALSE
  });

  it('gera o código com chave, valor, nome/cidade sem acento, txid e CRC corretos', () => {
    const code = codigoCobranca({ key: '+5511912345678', name: 'Padaria São João Ltda', city: 'Carapicuíba' }, 15050, txidDe('ckx1abc-def'));
    expect(brCodeValido(code)).toBe(true);
    const f = tlv(code);
    expect(f['00']).toBe('01');
    expect(f['26']).toContain('br.gov.bcb.pix');
    expect(tlv(f['26'])['01']).toBe('+5511912345678');
    expect(f['53']).toBe('986');
    expect(f['54']).toBe('150.50');
    expect(f['58']).toBe('BR');
    expect(f['59']).toBe('PADARIA SAO JOAO LTDA');
    expect(f['60']).toBe('CARAPICUIBA');
    expect(tlv(f['62'])['05']).toBe('MCKckx1abcdef');
    expect(code.slice(-4)).toBe(crc16(code.slice(0, -4)));
    // Mesma geração do Financeiro do ERP (reaproveitada).
    expect(code).toBe(pixCopiaECola({ chave: '+5511912345678', nome: 'Padaria São João Ltda', cidade: 'Carapicuíba', valorCents: 15050, txid: 'MCKckx1abcdef' }));
  });

  it('valida e normaliza a chave por tipo', () => {
    expect(normalizarChave('cpf', '529.982.247-25')).toEqual({ ok: true, chave: '52998224725' });
    expect(normalizarChave('cpf', '111.111.111-11').ok).toBe(false);
    expect(normalizarChave('cnpj', '11.222.333/0001-81')).toEqual({ ok: true, chave: '11222333000181' });
    expect(normalizarChave('cnpj', '11.222.333/0001-82').ok).toBe(false);
    expect(normalizarChave('cnpj', '12.ABC.345/01DE-35')).toEqual({ ok: true, chave: '12ABC34501DE35' }); // CNPJ alfanumérico
    expect(normalizarChave('email', ' Loja@Exemplo.com.br ')).toEqual({ ok: true, chave: 'loja@exemplo.com.br' });
    expect(normalizarChave('email', 'sem-arroba').ok).toBe(false);
    expect(normalizarChave('telefone', '(11) 91234-5678')).toEqual({ ok: true, chave: '+5511912345678' });
    expect(normalizarChave('telefone', '1234').ok).toBe(false);
    expect(normalizarChave('aleatoria', '123E4567-E89B-12D3-A456-426614174000')).toEqual({ ok: true, chave: '123e4567-e89b-12d3-a456-426614174000' });
    expect(normalizarChave('aleatoria', 'abc').ok).toBe(false);
    expect(normalizarChave('outro', 'x').ok).toBe(false);
  });

  it('entende o valor digitado em reais', () => {
    expect(valorEmCentavos('150')).toBe(15000);
    expect(valorEmCentavos('150,5')).toBe(15050);
    expect(valorEmCentavos('R$ 1.234,56')).toBe(123456);
    expect(valorEmCentavos('1.500')).toBe(150000);
    expect(valorEmCentavos('10.5')).toBe(1050);
    expect(valorEmCentavos(12.3)).toBe(1230);
    expect(valorEmCentavos('0')).toBeNull();
    expect(valorEmCentavos('abc')).toBeNull();
    expect(valorEmCentavos('-5')).toBeNull();
    expect(valorEmCentavos('99999999')).toBeNull(); // acima de R$ 1 milhão
    expect(textoCobranca(15050, 'Corte + barba', 'Barbearia X')).toContain('R$');
  });
});

describe('v1.44.0 — origem do lead', () => {
  it('lê o código do link e limpa o texto', () => {
    expect(lerCodigo('Olá! [ref:instagram-bio]')).toEqual({ codigo: 'instagram-bio', texto: 'Olá!' });
    expect(lerCodigo('[REF: Panfleto_2026 ] quero saber o preço')).toEqual({ codigo: 'panfleto_2026', texto: 'quero saber o preço' });
    expect(lerCodigo('Oi ref:google-meu-negocio')).toEqual({ codigo: 'google-meu-negocio', texto: 'Oi' });
    expect(lerCodigo('Qual a referência do produto?')).toBeNull();
    expect(lerCodigo('Olá!')).toBeNull();
    expect(lerCodigo(null)).toBeNull();
  });
  it('normaliza o código, monta o texto e o link wa.me', () => {
    expect(normalizarCodigo('Instagram Bio!')).toBe('instagram-bio');
    expect(normalizarCodigo('Promoção  de Natal')).toBe('promocao-de-natal');
    expect(normalizarCodigo('###')).toBe('');
    expect(textoDoLink('Olá!', 'instagram-bio')).toBe('Olá! [ref:instagram-bio]');
    const link = linkWaMe('+55 (11) 91234-5678', 'Olá!', 'instagram-bio')!;
    expect(link.startsWith('https://wa.me/5511912345678?text=')).toBe(true);
    expect(decodeURIComponent(link.split('text=')[1])).toBe('Olá! [ref:instagram-bio]');
    expect(lerCodigo(decodeURIComponent(link.split('text=')[1]))?.codigo).toBe('instagram-bio');
    expect(linkWaMe('123', 'Olá!', 'x')).toBeNull();
  });
  it('lê o referral do anúncio Click-to-WhatsApp no webhook da API oficial', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1' }, messages: [{ from: '5511999', id: 'w1', timestamp: '1700000000', type: 'text', text: { body: 'Quero saber mais' }, referral: { source_url: 'https://fb.me/abc', source_id: '120000', source_type: 'ad', headline: 'Promo de Natal', ctwa_clid: 'ARxx' } }] } }] }],
    };
    const { messages } = parseWebhook(body);
    expect(messages[0].referral).toEqual({ sourceUrl: 'https://fb.me/abc', sourceId: '120000', sourceType: 'ad', headline: 'Promo de Natal', ctwaClid: 'ARxx' });
    expect(lerReferral(null)).toBeUndefined();
    expect(lerReferral({})).toBeUndefined();
  });
  it('agrupa conversas e leads por origem (Sem origem por último)', () => {
    const nomes = new Map([['instagram-bio', 'Bio do Instagram']]);
    const r = agruparOrigens(['instagram-bio', null, 'instagram-bio', 'anuncio', 'site'], ['instagram-bio', null, null], nomes);
    expect(r[0]).toEqual({ origem: 'instagram-bio', rotulo: 'Bio do Instagram', conversas: 2, leads: 1 });
    expect(r[r.length - 1]).toEqual({ origem: null, rotulo: 'Sem origem', conversas: 1, leads: 2 });
    expect(rotuloOrigem('anuncio', nomes)).toBe('Anúncio (Click-to-WhatsApp)');
    expect(rotuloOrigem('site', nomes)).toBe('Chat do site');
  });
});

describe('v1.44.0 — chat do site', () => {
  it('limite por IP em janela fixa', () => {
    let t = 0;
    const l = new JanelaLimite(3, 60_000, () => t);
    expect([l.tentar('ip1'), l.tentar('ip1'), l.tentar('ip1'), l.tentar('ip1')]).toEqual([true, true, true, false]);
    expect(l.tentar('ip2')).toBe(true); // outro IP tem a própria conta
    expect(l.esperaSeg('ip1')).toBe(60);
    t = 59_000;
    expect(l.tentar('ip1')).toBe(false);
    t = 60_000;
    expect(l.tentar('ip1')).toBe(true); // nova janela
  });
  it('origem autorizada (opcional) e dados do visitante', () => {
    const d = lerDominios('https://www.Loja.com.br/contato\n*.minhaloja.com.br, lixo');
    expect(d).toEqual(['www.loja.com.br', '*.minhaloja.com.br']);
    expect(origemPermitida('https://evil.com', [])).toBe(true);
    expect(origemPermitida('https://www.loja.com.br', d)).toBe(true);
    expect(origemPermitida('https://blog.minhaloja.com.br', d)).toBe(true);
    expect(origemPermitida('https://minhaloja.com.br', d)).toBe(true);
    expect(origemPermitida('https://minhaloja.com.br.evil.com', d)).toBe(false);
    expect(origemPermitida('https://evil.com', d)).toBe(false);
    expect(origemPermitida(undefined, d)).toBe(false);
    expect(origemPermitida('https://loja.com.br', ['loja.com.br'])).toBe(true);
    expect(origemPermitida('https://www.loja.com.br', ['loja.com.br'])).toBe(true);
    expect(visitanteValido('a'.repeat(32))).toBe(true);
    expect(visitanteValido('xyz')).toBe(false);
    expect(visitanteValido('<script>'.repeat(5))).toBe(false);
    const w = waIdDoVisitante('k'.repeat(32), 'a'.repeat(32));
    expect(w).toMatch(/^site:[0-9a-f]{24}$/);
    expect(w).not.toContain('a'.repeat(32));
    expect(corValida('#00AAFF')).toBe('#00aaff');
    expect(corValida('red;background:url(x)')).toBe('#d90429');
    expect(limparTexto('oi\u0000 tudo\u0007 bem ')).toBe('oi tudo bem');
    expect(limparTexto('x'.repeat(3000)).length).toBe(2000);
    expect(codigoEmbed('https://mckbot.onrender.com/', 'f'.repeat(32))).toBe(`<script src="https://mckbot.onrender.com/widget.js" data-org="${'f'.repeat(32)}" async></script>`);
  });
});

describe('v1.44.0 — pausa das campanhas com o número em Risco', () => {
  it('pausa em Risco, retoma sozinha (auto) ou espera o Retomar (manual)', () => {
    expect(decisaoRisco({ nivel: 'RISCO', retomada: 'auto', pausada: false })).toBe('pausar');
    expect(decisaoRisco({ nivel: 'RISCO', retomada: 'manual', pausada: false })).toBe('pausar_manual');
    expect(decisaoRisco({ nivel: 'RISCO', retomada: 'auto', pausada: true })).toBe('pausar');
    expect(decisaoRisco({ nivel: 'ATENCAO', retomada: 'auto', pausada: true })).toBe('retomar');
    expect(decisaoRisco({ nivel: 'BOM', retomada: 'auto', pausada: false })).toBe('seguir');
    expect(decisaoRisco({ nivel: null, retomada: 'auto', pausada: true })).toBe('manter');
    expect(decisaoRisco({ nivel: null, retomada: 'auto', pausada: false })).toBe('seguir');
  });
});

describe('v1.44.0 — assistente do atendente', () => {
  const m = (direction: string, sender: string, body: string) => ({ direction, sender, type: 'text', body, createdAt: new Date() });
  it('monta a conversa sem notas internas e mantém o fim quando é longa', () => {
    const t = transcricao([m('IN', 'contact', 'Oi, quanto custa?'), m('INTERNAL', 'agent', 'nota secreta'), m('OUT', 'ai', 'Custa R$ 50.'), m('OUT', 'agent', '  ')]);
    expect(t).toBe('Cliente: Oi, quanto custa?\nIA: Custa R$ 50.');
    const longa = transcricao(Array.from({ length: 100 }, (_, i) => m('IN', 'contact', `mensagem ${i} ${'x'.repeat(100)}`)), 1000);
    expect(longa.length).toBeLessThanOrEqual(1000);
    expect(longa).toContain('mensagem 99');
    expect(longa).not.toContain('mensagem 0 ');
  });
  it('limpa a saída da IA', () => {
    expect(limparSaida('Sugestão: "Olá! Posso ajudar?"')).toBe('Olá! Posso ajudar?');
    expect(limparSaida('Resposta: oi [TRANSFERIR]')).toBe('oi');
    expect(limparSaida('• a\n\n• b\n• c\n• d\n• e\n• f', 5)).toBe('• a\n• b\n• c\n• d\n• e');
  });
});
