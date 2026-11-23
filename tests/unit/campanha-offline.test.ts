import { describe, it, expect } from 'vitest';
import { tipoErroEnvio, erroDeConexao } from '../../server/whatsapp/conexao.js';

describe('v1.46.1 — classificação do erro de envio (conexão × definitivo)', () => {
  it('erros de conexão/passageiros voltam para a fila', () => {
    for (const e of [
      'WhatsApp (QR) não conectado: abra Canais WhatsApp e conecte pelo QR code',
      'Canal WhatsApp não conectado: configure as credenciais da Cloud API em Canais WhatsApp',
      'Connection Closed', 'Timed Out', 'socket hang up', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443',
      'Falha de rede: fetch failed', 'Erro HTTP 503 da Graph API', 'Service Unavailable', 'Stream Errored (restart required)',
    ]) expect([e, tipoErroEnvio(e)]).toEqual([e, 'conexao']);
  });
  it('erros do número continuam FALHOU', () => {
    for (const e of [
      'Número inválido', 'O número não tem WhatsApp', 'Recipient phone number not on WhatsApp (131026)',
      'Contato bloqueou o número', 'Fora da janela de 24 horas: só é permitido enviar um modelo (template) aprovado pela Meta',
      'Contato pediu para não receber mensagens automáticas (opt-out)', 'Assinatura inativa',
    ]) expect([e, tipoErroEnvio(e)]).toEqual([e, 'definitivo']);
  });
  it('erro desconhecido ou vazio não volta sozinho (como antes)', () => {
    expect(tipoErroEnvio('O WhatsApp não confirmou o envio da mensagem')).toBe('outro');
    expect(tipoErroEnvio('Erro simulado')).toBe('outro');
    expect(tipoErroEnvio(null)).toBe('outro');
    expect(erroDeConexao('Connection Closed')).toBe(true);
    expect(erroDeConexao('Número inválido')).toBe(false);
  });
});
