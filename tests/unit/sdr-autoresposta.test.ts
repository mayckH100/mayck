import { describe, it, expect } from 'vitest';
import { detectAutoReply, normalizeText, autoReplyHeaders, isAutoMarked, autoMarkOf } from '../../server/sdr/autoReply.js';

/** v1.22.0: identificador de resposta automática (local, sem IA). Textos genéricos, sem dados de clientes. */

// Caso real (texto genérico): campanha enviada e, no mesmo minuto, a saudação automática do WhatsApp Business.
const CASO_REAL = '*Clínica Médica agradece seu contato* ⚠️ Importante: neste canal *não atendemos chamadas via Whatsapp, não ouvimos mensagens de voz.* Para agilizar seu atendimento, pedimos que envie sua solicitação por *mensagem de texto.* Agradecemos a compreensão!';

const AUTOMATICAS: string[] = [
  CASO_REAL,
  // WhatsApp Business: ausência e saudação
  'Olá! Obrigado pelo contato. No momento não estamos disponíveis, retornaremos em breve.',
  'Olá, seja bem-vindo à Loja Exemplo! Em breve um de nossos atendentes irá te atender.',
  'Recebemos sua mensagem e em breve retornaremos. 😊',
  'Sua mensagem é muito importante para nós! Aguarde que logo você será atendido.',
  'Nosso horário de atendimento é de segunda a sexta, das 8h às 18h. Retornaremos assim que possível.',
  'Estamos fora do horário de atendimento. Atendemos de segunda a sábado das 9h às 19h.',
  'Esta é uma mensagem automática. Por favor, não responda.',
  'Mensagem automática: estamos em horário de almoço.',
  // Menus
  'Olá! Para falar com o setor desejado, digite 1 para Financeiro, 2 para Vendas, 3 para Suporte.',
  'Bem-vindo! Escolha uma das opções:\n1 - Agendar consulta\n2 - Valores\n3 - Falar com atendente',
  'Escolha uma opção:\n1️⃣ Orçamento\n2️⃣ Segunda via\n3️⃣ Outros assuntos',
  // Celular pessoal: respostas rápidas, dirigindo, reunião, plantão, férias, Não Perturbe
  'Estou dirigindo, respondo depois.',
  'Estou dirigindo.',
  'No momento não posso atender. Te ligo depois.',
  'Não posso falar agora.',
  'Estou em reunião, retorno assim que possível.',
  'Estou em atendimento, já te respondo.',
  'Estou em cirurgia, respondo mais tarde.',
  'Estou de plantão, retorno sua mensagem depois.',
  'Estou de férias até o dia 20/11. Responderei quando voltar.',
  'Viajando até 15/12, sem acesso ao WhatsApp.',
  'Estou com as notificações silenciadas (modo foco).',
  'Modo Não Perturbe ativado. Respondo assim que possível.',
  'Esta mensagem foi enviada automaticamente pelo AutoResponder.',
  // EN
  "I'm driving right now, I'll get back to you later.",
  'I am currently out of the office and will reply when I return.',
  'Thank you for contacting us! We will get back to you as soon as possible.',
  "Can't talk right now.",
  'Auto-reply: I have notifications silenced.',
  // ES
  'Estoy manejando, te respondo luego.',
  'Gracias por comunicarte con nosotros. Te responderemos a la brevedad.',
  'Estoy de vacaciones hasta el 3 de diciembre.',
  'Nuestro horario de atención es de lunes a viernes. Respuesta automática.',
  'No puedo hablar ahora.',
];

const HUMANAS: string[] = [
  'Obrigado, tenho interesse',
  'Pode me ligar amanhã?',
  'Estou em reunião, mas tenho interesse, me manda o valor',
  'Estou dirigindo, mas pode me mandar o preço que vejo depois',
  'quanto custa?',
  'Oi! Quero saber mais',
  'sim',
  'Não tenho interesse',
  'Obrigado pelo contato, mas já temos fornecedor.',
  'Bom dia, qual o horário de atendimento de vocês?',
  'Como funciona o sistema?',
  'me liga às 14h',
  'Pode mandar por e-mail',
  'ok',
  'Tô em reunião, mas quero sim, como funciona?',
  "I'm interested, how much is it?",
  'Me interesa, ¿cuánto cuesta?',
  'Recebi, vou ver com meu sócio e te falo.',
];

describe('detectAutoReply', () => {
  it.each(AUTOMATICAS)('automática: %s', (t) => {
    const r = detectAutoReply(t);
    expect(r.automatica, `${t} → ${JSON.stringify(r)}`).toBe(true);
    expect(r.motivo.length).toBeGreaterThan(3);
  });

  it.each(HUMANAS)('humana: %s', (t) => {
    const r = detectAutoReply(t);
    expect(r.automatica, `${t} → ${JSON.stringify(r)}`).toBe(false);
  });

  it('caso real: alta confiança, motivos de saudação e resposta em segundos', () => {
    const r = detectAutoReply(CASO_REAL, { msDesdeEnvio: 8_000 });
    expect(r).toMatchObject({ automatica: true, confianca: 'alta' });
    expect(r.motivo).toContain('saudação/ausência de empresa');
    expect(r.pontos).toBeGreaterThanOrEqual(12);
  });

  it('humano com interesse continua humano mesmo respondendo rápido', () => {
    expect(detectAutoReply('Estou em reunião, mas tenho interesse, me manda o valor', { msDesdeEnvio: 5_000 })).toMatchObject({ automatica: false, humano: true });
    expect(detectAutoReply('sim, quero', { msDesdeEnvio: 3_000 }).automatica).toBe(false);
  });

  it('tempo sozinho não basta; repetição de texto longo sim', () => {
    expect(detectAutoReply('Bom dia', { msDesdeEnvio: 2_000 }).automatica).toBe(false);
    // Saudação fraca sozinha não basta; a mesma saudação 2 s depois do nosso envio é robô.
    expect(detectAutoReply('Olá, em que posso ajudar você hoje?').automatica).toBe(false);
    expect(detectAutoReply('Olá, em que posso ajudar você hoje?', { msDesdeEnvio: 2_000 })).toMatchObject({ automatica: true, confianca: 'media' });
    const longo = 'Oi, aqui é da Padaria Exemplo, recebemos pedidos pelo site e entregamos no bairro';
    expect(detectAutoReply(longo).automatica).toBe(false);
    expect(detectAutoReply(longo, { repetida: true }).automatica).toBe(true);
  });

  it('frases extras da empresa', () => {
    expect(detectAutoReply('Bem vindos ao Studio Exemplo!').automatica).toBe(false);
    expect(detectAutoReply('Bem vindos ao Studio Exemplo!', { frasesExtras: ['bem vindos ao studio'] })).toMatchObject({ automatica: true, motivo: 'frase cadastrada pela empresa' });
  });

  it('e-mail: cabeçalhos e assunto', () => {
    expect(autoReplyHeaders({ 'Auto-Submitted': 'auto-replied' })).toBe(true);
    expect(autoReplyHeaders({ 'auto-submitted': 'no' })).toBe(false);
    expect(autoReplyHeaders({ 'X-Autoreply': 'yes' })).toBe(true);
    expect(autoReplyHeaders({ Precedence: 'auto_reply' })).toBe(true);
    expect(detectAutoReply('Volto dia 20.', { headers: { 'Auto-Submitted': 'auto-replied' } }).automatica).toBe(true);
    expect(detectAutoReply('Volto dia 20.', { assunto: 'Out of Office: viagem' }).automatica).toBe(true);
    expect(detectAutoReply('Olá, estarei fora do escritório até segunda-feira. Responderei quando voltar.').automatica).toBe(true);
    expect(detectAutoReply('Tenho interesse, me liga amanhã.', { assunto: 'Re: proposta' }).automatica).toBe(false);
  });

  it('normalização e marca', () => {
    expect(normalizeText('*Não* ATENDEMOS _chamadas_')).toBe('nao atendemos chamadas');
    expect(isAutoMarked(autoMarkOf('menu de opções'))).toBe(true);
    expect(isAutoMarked(null)).toBe(false);
  });
});
