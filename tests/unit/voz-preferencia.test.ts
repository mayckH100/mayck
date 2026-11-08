import { describe, it, expect } from 'vitest';
import {
  detectVoicePreference, decideWithPreference, voicePromptSection, historyContent, stripVoiceMarkers, MARK_AI_AUDIO, MARK_CLIENT_AUDIO,
} from '../../server/ai/voice/preference.js';

describe('Voz — preferência do cliente por conversa (detector por palavras, sem IA)', () => {
  it.each([
    'Poderia ser por áudio', 'manda áudio', 'pode ser por áudio?', 'fala por áudio', 'prefiro áudio', 'me explica em áudio',
    'Me manda um áudio explicando', 'Áudio, por favor', 'por áudio', 'Responde por audio pfv', 'grava um audio pra mim',
    'Pode me responder em áudio?', 'quero por voz', 'pode mandar nota de voz', 'não consigo ler agora, manda áudio', 'to dirigindo',
    'Mas você estava falando comigo por áudio até agora', 'PODE SER POR AUDIO', 'manda um audiozinho',
  ])('áudio: %s', (t) => expect(detectVoicePreference(t)).toBe('audio'));

  it.each([
    'prefiro texto', 'não consigo ouvir', 'estou no trabalho, escreve', 'manda por escrito', 'não precisa de áudio', 'Não precisa mandar áudio',
    'sem áudio por favor', 'pode mandar por texto mesmo', 'não consigo ouvir áudio agora', 'me escreve aí', 'prefiro por mensagem escrita',
    'to sem fone', 'Responde em texto', 'nao manda audio', 'Não posso ouvir agora',
  ])('texto: %s', (t) => expect(detectVoicePreference(t)).toBe('texto'));

  it.each([
    'oi, qual o horário?', 'recebi seu áudio', 'Você pode me mandar o link? ouvi seu áudio', 'seu áudio ficou cortado',
    'como se escreve o nome da rua?', 'quanto custa o plano?', 'manda o preço', 'qual o texto do contrato?', 'a voz de vocês é bonita', '', null,
  ])('nada: %s', (t) => expect(detectVoicePreference(t as string)).toBeNull());

  it('preferência vale acima do modo da empresa; voz desligada = sempre texto', () => {
    const s = (voiceEnabled: boolean, voiceReplyMode: string) => ({ voiceEnabled, voiceReplyMode });
    expect(decideWithPreference(s(true, 'espelhar'), false, 'audio')).toBe(true);
    expect(decideWithPreference(s(true, 'nunca_audio'), false, 'audio')).toBe(true); // o cliente pediu áudio: recebe
    expect(decideWithPreference(s(true, 'sempre_audio'), true, 'texto')).toBe(false);
    expect(decideWithPreference(s(true, 'espelhar'), true, null)).toBe(true); // espelhar sem preferência
    expect(decideWithPreference(s(true, 'espelhar'), false, null)).toBe(false);
    expect(decideWithPreference(s(true, 'nunca_audio'), true, null)).toBe(false);
    expect(decideWithPreference(s(false, 'sempre_audio'), true, 'audio')).toBe(false);
    expect(decideWithPreference(null, true, 'audio')).toBe(false);
  });

  it('prompt: voz ligada sabe que responde em áudio, humano, sem "só converso por texto"', () => {
    const p = voicePromptSection({ voiceEnabled: true, replyAsAudio: true, pref: 'audio', company: 'MCK DESENVOLVIMENTO' });
    expect(p).toContain('Você pode responder por áudio (nota de voz)');
    expect(p).toContain('Nunca diga que só conversa por texto');
    expect(p).toContain('Esta resposta vai como ÁUDIO');
    expect(p).toContain('Sou a assistente virtual da MCK DESENVOLVIMENTO, mas pode falar comigo à vontade, por áudio ou por texto');
    expect(p).toContain('a não ser que o cliente pergunte diretamente');
    expect(voicePromptSection({ voiceEnabled: true, replyAsAudio: false, pref: 'texto' })).toContain('prefere texto');
    const off = voicePromptSection({ voiceEnabled: false, replyAsAudio: false, pref: null });
    expect(off).toContain('No momento as respostas são por texto');
    expect(off).toContain('sem negar áudios que já tenham sido enviados');
    expect(off).not.toContain('Você pode responder por áudio');
  });

  it('histórico marca áudios (cliente e IA) e os marcadores nunca vão para o cliente', () => {
    expect(historyContent({ direction: 'IN', type: 'audio', transcript: 'qual o preço?', body: '[audio]' })).toBe(`${MARK_CLIENT_AUDIO} qual o preço?`);
    expect(historyContent({ direction: 'IN', type: 'text', body: 'oi' })).toBe('oi');
    expect(historyContent({ direction: 'OUT', sender: 'ai', type: 'audio', transcript: 'Claro, custa R$ 22.', body: 'Claro, custa R$ 22.' })).toBe(`${MARK_AI_AUDIO} Claro, custa R$ 22.`);
    expect(historyContent({ direction: 'OUT', sender: 'ai', type: 'text', body: 'Olá!' })).toBe('Olá!');
    expect(stripVoiceMarkers(`${MARK_AI_AUDIO} Claro! Te explico.`)).toBe('Claro! Te explico.');
    expect(stripVoiceMarkers('[Áudio do cliente, transcrito] oi')).toBe('oi');
  });
});
