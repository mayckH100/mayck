import { describe, it, expect } from 'vitest';
import { isExplicitHumanRequest, failureText, DEFAULT_FAILURE_TEXT, promisesTransfer } from '../../server/ai/humanRequest.js';
import { rank, stem, tokenize } from '../../server/ai/rag.js';
import { samePhone, orgNotifyPhones, handoffAlertText } from '../../server/whatsapp/handoffNotify.js';
import { freeSearchModel, mentionsCompetitor, buildSystemPrompt } from '../../server/ai/service.js';
import { htmlToText, knowledgePromptSection } from '../../server/ai/siteKnowledge.js';

describe('Regra: IA só transfere quando o cliente pede um humano', () => {
  it.each([
    'quero falar com um atendente', 'Quero falar com atendente', 'atendente', 'Atendente por favor', 'humano', 'HUMANO!!',
    'posso falar com uma pessoa?', 'me passa para um atendente', 'chama um humano aí', 'preciso de atendimento humano',
    'não quero falar com robô', 'tem alguém aí de verdade?', 'quero ser atendido por uma pessoa', 'falar com o vendedor',
    'prefiro um atendente', 'me transfere pro suporte humano', 'gostaria de falar com alguém da equipe',
  ])('pedido explícito: %s', (t) => expect(isExplicitHumanRequest(t)).toBe(true));

  it.each([
    'quero reagendar minha reunião', 'não sei qual plano escolher', 'quanto custa?', 'vocês atendem pessoa jurídica?',
    'quantas pessoas podem usar?', 'o atendimento de vocês é bom?', 'qual o horário de atendimento?', 'oi', 'não entendi',
    'meu cliente pediu um humano no robô dele, como configuro?', 'quero cancelar',
  ])('NÃO é pedido: %s', (t) => expect(isExplicitHumanRequest(t, ['atendente', 'humano', 'pessoa'])).toBe(false));

  it('palavras da empresa valem em mensagem curta ou em pedido', () => {
    expect(isExplicitHumanRequest('gerente', ['gerente'])).toBe(true);
    expect(isExplicitHumanRequest('quero o financeiro', ['financeiro'])).toBe(true);
    expect(isExplicitHumanRequest('o financeiro de vocês emite nota fiscal para empresas?', ['financeiro'])).toBe(false);
  });

  it('texto de falha nunca promete transferência', () => {
    expect(failureText({ failureMessage: 'Pode repetir?', fallbackMessage: 'x' })).toBe('Pode repetir?');
    expect(failureText({ failureMessage: '', fallbackMessage: 'Vou transferir você para um atendente humano.' })).toBe(DEFAULT_FAILURE_TEXT);
    expect(failureText({ failureMessage: '', fallbackMessage: 'Não entendi, pode explicar melhor?' })).toBe('Não entendi, pode explicar melhor?');
  });

  it('prompt proíbe transferir sem pedido e trata reagendamento', () => {
    const p = buildSystemPrompt({ instructions: 'Você é a Luana.', tone: '' }, '');
    expect(p).toContain('TRANSFERÊNCIA PARA HUMANO É PROIBIDA');
    expect(p).toContain('Reagendar ou cancelar');
    expect(p).not.toContain('Se não souber responder, se o cliente pedir um humano');
  });
});

describe('Base de conhecimento: radical, acentos e título', () => {
  it('radical leve', () => {
    expect(stem('conectar')).toBe('conect');
    expect(stem('conecte')).toBe('conect');
    expect(stem('conexao')).toBe('conect');
    expect(stem('concorrencia')).toBe('concorr');
    expect(stem('concorrente')).toBe('concorr');
    expect(tokenize('Vocês são melhores que a concorrência?')).toEqual(['melhor', 'concorr']);
  });
  it('as duas perguntas da produção acham o FAQ certo (título conta)', () => {
    const docs = [
      { title: 'FAQ - Por que escolher a MCK (diferenciais)', text: 'Por que a MCK e não outra plataforma?\n- Preço acessível.\nComo responder quando o cliente compara com um concorrente?' },
      { title: 'FAQ - Como começar e suporte', text: 'Crie a conta grátis. Conecte o WhatsApp lendo o QR code em Canais WhatsApp.' },
      { title: 'Horário', text: 'Atendemos de segunda a sexta.' },
    ].map((d) => ({ ...d, scoreText: `${d.title}\n${d.title}\n${d.text}` }));
    expect(rank('Vocês são melhores que a concorrência?', docs)[0].item.title).toMatch(/diferenciais/);
    expect(rank('Não entendi como conectar', docs)[0].item.title).toMatch(/Como começar/);
    expect(rank('qual a diferença para outra plataforma?', docs)[0].item.title).toMatch(/diferenciais/);
  });
});

describe('Números de aviso', () => {
  it('mesmo número com e sem o 9', () => {
    expect(samePhone('+5511949223539', '551149223539')).toBe(true);
    expect(samePhone('+5511949223539', '+5511900005300')).toBe(false);
    expect(samePhone('', '+5511900005300')).toBe(false);
  });
  it('lista nova; sem ela, o WhatsApp reserva antigo', () => {
    expect(orgNotifyPhones({ handoffNotifyPhones: '["+5511911112222","+5511933334444"]', backupPhone: '+5511900000000' })).toEqual(['+5511911112222', '+5511933334444']);
    expect(orgNotifyPhones({ handoffNotifyPhones: null, backupPhone: '+5511900000000' })).toEqual(['+5511900000000']);
    expect(orgNotifyPhones({ handoffNotifyPhones: '[]', backupPhone: '+5511900000000' })).toEqual([]);
    expect(orgNotifyPhones({ handoffNotifyPhones: null, backupPhone: null })).toEqual([]);
  });
  it('texto do aviso', () => {
    const t = handoffAlertText({ who: 'Ana (+5511999990000)', reason: 'Contato pediu atendimento humano', channel: 'WhatsApp 1 (11 90000-5300)', url: 'https://x/inbox/c1' });
    expect(t).toBe('🔔 Novo atendimento humano\nContato: Ana (+5511999990000)\nMotivo: Contato pediu atendimento humano\nWhatsApp: WhatsApp 1 (11 90000-5300)\nAbrir conversa: https://x/inbox/c1');
  });
});

describe('Concorrentes e site', () => {
  it('pesquisa Google só em modelo com cota grátis e quando cita concorrente', () => {
    expect(freeSearchModel('gemini-2.5-flash')).toBe(true);
    expect(freeSearchModel('gemini-2.5-flash-lite')).toBe(true);
    expect(freeSearchModel('gemini-3.5-flash-lite')).toBe(false);
    expect(mentionsCompetitor('Vocês são melhores que a concorrência?')).toBe(true);
    expect(mentionsCompetitor('já uso o outro sistema, qual a diferença?')).toBe(true);
    expect(mentionsCompetitor('qual o horário?')).toBe(false);
  });
  it('HTML vira texto sem scripts/menus', () => {
    expect(htmlToText('<html><head><title>x</title></head><body><nav>Menu</nav><h1>MCKBOT</h1><script>alert(1)</script><p>Robô &amp; IA</p><footer>rodapé</footer></body></html>')).toBe('MCKBOT\nRobô & IA');
  });
  it('sem nada ligado, nenhuma seção extra no prompt', async () => {
    expect(await knowledgePromptSection({ useMckSite: false, competitorNotes: '', webSearch: false })).toBe('');
    const s = await knowledgePromptSection({ useMckSite: false, competitorNotes: 'Entrega no mesmo dia', webSearch: false });
    expect(s).toContain('QUANDO O CLIENTE COMPARAR COM CONCORRENTES');
    expect(s).toContain('Entrega no mesmo dia');
    expect(s).not.toContain('MCK DESENVOLVIMENTO');
  });
});
