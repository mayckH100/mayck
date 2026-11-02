import { describe, it, expect } from 'vitest';
import { cleanAiText, findJsonMarkers } from '../../server/agenda/ai.js';
import { intentFromText, isOrderConfirmed, mergeIntent, needsDelivery, normalizeDelivery, normalizeItems, orderFingerprint, orderTypeFor } from '../../server/agenda/orders.js';

describe('Pedidos: marcadores e regras', () => {
  it('lê o JSON aninhado do [PEDIDO:...] e remove os marcadores do texto', () => {
    const t = 'Ok!\n[PEDIDO:{"itens":[{"nome":"Ração [M]","quantidade":2}],"entrega":{"nome":"Ana","cep":"06300000"}}]\n[TIPO:pedido]';
    const m = findJsonMarkers(t, 'PEDIDO');
    expect(m).toHaveLength(1);
    expect(JSON.parse(m[0].json).itens[0].nome).toBe('Ração [M]');
    expect(cleanAiText(t)).toBe('Ok!');
    expect(cleanAiText('Oi [PEDIDO:{"itens":[{"nome":"x"')).toBe('Oi');
  });

  it('classificação', () => {
    expect(intentFromText('x [TIPO:pedido]')).toBe('PEDIDO');
    expect(intentFromText('x [TIPO:reunião]')).toBe('REUNIAO');
    expect(intentFromText('x [TIPO:ambos]')).toBe('AMBOS');
    expect(intentFromText('sem marcador')).toBeNull();
    expect(mergeIntent(null, 'PEDIDO')).toBe('PEDIDO');
    expect(mergeIntent('REUNIAO', 'PEDIDO')).toBe('AMBOS');
    expect(mergeIntent('PEDIDO', null)).toBe('PEDIDO');
  });

  it('tipo e dados de entrega conforme a configuração', () => {
    expect(orderTypeFor({ orderType: 'FISICO' }, 'online')).toBe('FISICO');
    expect(orderTypeFor({ orderType: 'ONLINE' }, 'fisico')).toBe('ONLINE');
    expect(orderTypeFor({ orderType: 'AMBOS' }, 'online')).toBe('ONLINE');
    expect(orderTypeFor({ orderType: 'AMBOS' }, undefined)).toBe('FISICO');
    expect(needsDelivery({ orderAskDelivery: false }, 'FISICO')).toBe(true);
    expect(needsDelivery({ orderAskDelivery: false }, 'ONLINE')).toBe(false);
    expect(needsDelivery({ orderAskDelivery: true }, 'ONLINE')).toBe(true);
    const ok = normalizeDelivery({ nome: 'Ana', endereco: 'Rua A', cep: '06300-000', numero: '1', telefone: '(11) 98888-7777' });
    expect(ok.missing).toEqual([]);
    expect(ok.delivery.complemento).toBeNull();
    expect(normalizeDelivery({ nome: 'Ana' }).missing).toEqual(['endereço (rua e bairro/cidade)', 'CEP', 'número', 'telefone']);
  });

  it('itens sem preço, assinatura estável e confirmação explícita', () => {
    const items = normalizeItems([{ nome: 'Ração', quantidade: 2, preco: 999 }, 'Osso', { nome: '' }]);
    expect(items).toEqual([{ nome: 'Ração', quantidade: 2, obs: null }, { nome: 'Osso', quantidade: 1, obs: null }]);
    expect(orderFingerprint('FISICO', items)).toBe(orderFingerprint('FISICO', [...items].reverse()));
    expect(orderFingerprint('FISICO', items)).not.toBe(orderFingerprint('ONLINE', items));
    expect(isOrderConfirmed({ clientText: 'sim', lastAssistant: 'Posso registrar o seu pedido: 2x Ração e 1x Osso?', items })).toBe(true);
    expect(isOrderConfirmed({ clientText: 'não', lastAssistant: 'Posso registrar o seu pedido: 2x Ração e 1x Osso?', items })).toBe(false);
    expect(isOrderConfirmed({ clientText: 'sim', lastAssistant: 'Qual produto você quer?', items })).toBe(false);
    expect(isOrderConfirmed({ clientText: 'sim', lastAssistant: 'Posso registrar o seu pedido de Ração?', items })).toBe(false);
  });
});

import { transitionError, phoneKeys, statusMessage, ORDER_GROUPS, ORDER_STATUSES } from '../../server/agenda/orders.js';

describe('Pedidos: regras de status (0029)', () => {
  it('transições', () => {
    expect(transitionError('NOVO', 'CONFIRMADO', { admin: false })).toBeNull();
    expect(transitionError('CONFIRMADO', 'FINALIZADO', { admin: false })).toBeNull(); // online pula o envio
    expect(transitionError('NOVO', 'NOVO', { admin: true })).toMatch(/já está/);
    expect(transitionError('NOVO', 'CANCELADO', { admin: true })).toMatch(/Cancelar pedido/);
    expect(transitionError('FINALIZADO', 'ENTREGUE', { admin: true })).toMatch(/Devolvido/);
    expect(transitionError('FINALIZADO', 'DEVOLVIDO', { admin: false })).toBeNull();
    expect(transitionError('CANCELADO', 'NOVO', { admin: false })).toMatch(/donos e administradores/);
    expect(transitionError('CANCELADO', 'NOVO', { admin: true })).toBeNull();
    expect(transitionError('CANCELADO', 'CONFIRMADO', { admin: true })).toMatch(/reabra/);
  });

  it('grupos cobrem todos os status uma vez', () => {
    const all = Object.values(ORDER_GROUPS).flat();
    expect(all.sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('telefone com e sem o 9º dígito; mensagem em português', () => {
    expect(phoneKeys('11 98888-7777')).toEqual(['5511988887777', '551188887777']);
    expect(phoneKeys('551188887777')).toEqual(['551188887777', '5511988887777']);
    expect(statusMessage({ code: 'P-ABC234' }, 'PRONTO_RETIRADA', true, 'Retire na loja')).toBe('📦 Atualização do seu pedido *P-ABC234*\nNovo status: *Pronto para retirada*\n📝 Observação da loja: Retire na loja');
  });
});
