/**
 * v1.26.0 — Avaliação da IA conversacional avançada. Conversas de TESTE (nomes, empresas e números fictícios; nenhum
 * dado real de cliente). Cada caso traz a resposta típica do jeito antigo ("antes") e a saída do modelo com o prompt
 * novo ("depois", com o plano interno), mais uma nova tentativa quando o caso testa a autoverificação. As respostas são
 * fixas (sem chamar provedor): medem as regras e a rede de segurança do código, não a qualidade de um modelo real.
 *
 * Usado por tests/unit/sdr-conversa-avaliacao.test.ts e por scripts/avaliar-conversa.ts (relatório antes/depois).
 */
import { extrairPlano, polirResposta, verificarResposta, ajusteMecanico, motivoHandoff, comPassagem, frasesDeRobo, GRAVES, TEXTO_ESPECIALISTA, EMOJI_RE } from '../../server/sdr/conversa.js';
import { isExplicitHumanRequest } from '../../server/ai/humanRequest.js';
import { detectIntent } from '../../server/sdr/intel.js';

export interface CasoAvaliacao {
  id: string;
  descricao: string;
  /** Instruções da empresa + CONTEXTO (fontes da checagem). */
  fontes: string;
  usaEmoji: boolean;
  nome: string;
  nomeRecente: boolean;
  temperatura: string;
  /** Palavras de assuntos que o lead JÁ respondeu (a IA não pode perguntar de novo). */
  jaRespondido: string[];
  mensagemLead: string;
  antes: string;
  depois: string;
  depoisNovaTentativa?: string;
  esperaHandoff: boolean;
}

const CORRETORA = 'Corretora Exemplo. Seguro empresarial a partir de R$ 89,90 por mês. Vistoria em até 2 dias úteis. Desconto de 10% no pagamento anual.';
const SOFTWARE = 'Sistema Exemplo de agenda para clínicas. Plano Essencial R$ 49,90/mês, Plano Pro R$ 99,90/mês. Teste grátis de 7 dias.';

export const CASOS: CasoAvaliacao[] = [
  {
    id: 'saudacao-robotica', descricao: 'Lead responde "oi" à campanha', fontes: CORRETORA, usaEmoji: false, nome: 'Paula', nomeRecente: false, temperatura: 'FRIO', jaRespondido: [],
    mensagemLead: 'oi, quem é?',
    antes: 'Olá! Entendido perfeitamente! 😊 Fico feliz em ajudar. Sou o assistente virtual da Corretora Exemplo e estou à disposição para qualquer dúvida que você tiver. Você tem interesse em seguro? Qual o porte da sua empresa? Quantos funcionários?',
    depois: '[PLANO: intencao=duvida; objetivo=QUALIFICAR]\nOi, Paula! Aqui é da Corretora Exemplo, te mandei a mensagem sobre seguro empresarial. Vocês já têm algum seguro hoje?',
    esperaHandoff: false,
  },
  {
    id: 'nao-reperguntar', descricao: 'Lead já disse o número de funcionários', fontes: CORRETORA, usaEmoji: false, nome: 'Marcos', nomeRecente: true, temperatura: 'MORNO', jaRespondido: ['funcionários', 'funcionarios'],
    mensagemLead: 'e quanto fica?',
    antes: 'Ótima pergunta, Marcos! O valor depende do porte. Quantos funcionários vocês têm, Marcos?',
    depois: '[PLANO: intencao=preco; objetivo=QUALIFICAR]\nPara 12 funcionários começa em R$ 89,90 por mês. Vocês preferem pagar mensal ou anual?',
    esperaHandoff: false,
  },
  {
    id: 'preco-inventado', descricao: 'Modelo inventa um preço; a checagem pede nova tentativa', fontes: SOFTWARE, usaEmoji: false, nome: 'Bia', nomeRecente: false, temperatura: 'MORNO', jaRespondido: [],
    mensagemLead: 'tem plano mais barato?',
    antes: 'Temos sim! O Plano Lite sai por R$ 29,90/mês.',
    depois: '[PLANO: intencao=preco; objetivo=TRATAR_OBJECAO]\nTemos o Plano Lite por R$ 29,90/mês.',
    depoisNovaTentativa: '[PLANO: intencao=preco; objetivo=TRATAR_OBJECAO]\nO mais em conta é o Essencial, R$ 49,90/mês, e dá para testar 7 dias grátis. Quer que eu libere o teste?',
    esperaHandoff: false,
  },
  {
    id: 'cobertura-fora', descricao: 'Pergunta fora das Instruções; modelo insiste em inventar', fontes: CORRETORA, usaEmoji: false, nome: 'Rui', nomeRecente: false, temperatura: 'MORNO', jaRespondido: [],
    mensagemLead: 'cobre enchente? quanto a mais?',
    antes: 'Cobre sim! A cobertura de enchente custa R$ 15 a mais por mês e o prazo de carência é de 30 dias.',
    depois: '[PLANO: intencao=cobertura; objetivo=RESPONDER]\nCobre sim, são R$ 15 a mais por mês.',
    depoisNovaTentativa: '[PLANO: intencao=cobertura; objetivo=RESPONDER]\nCobre, com acréscimo de R$ 15.',
    esperaHandoff: true,
  },
  {
    id: 'irritado', descricao: 'Lead irritado com perguntas repetidas', fontes: CORRETORA, usaEmoji: false, nome: 'Léo', nomeRecente: false, temperatura: 'MORNO', jaRespondido: ['porte'],
    mensagemLead: 'já falei isso, vocês não entendem nada',
    antes: 'Peço desculpas pelo transtorno! Entendido perfeitamente. Poderia me informar novamente o porte da sua empresa?',
    depois: '[PLANO: intencao=irritado; objetivo=PASSAR_VENDEDOR]\nDesculpa, você tem razão.',
    esperaHandoff: true,
  },
  {
    id: 'pedido-humano', descricao: 'Lead pede para falar com uma pessoa', fontes: SOFTWARE, usaEmoji: false, nome: 'Ana', nomeRecente: false, temperatura: 'FRIO', jaRespondido: [],
    mensagemLead: 'quero falar com um atendente',
    antes: 'Claro! Vou transferir você.',
    depois: 'Claro, já chamo alguém da equipe para continuar com você.',
    esperaHandoff: true,
  },
  {
    id: 'lead-quente', descricao: 'Lead quer contratar', fontes: SOFTWARE, usaEmoji: true, nome: 'Caio', nomeRecente: false, temperatura: 'QUENTE', jaRespondido: ['clínica'],
    mensagemLead: 'gostei, quero contratar o Pro',
    antes: 'Que ótimo!!! 🎉🎉 Fico feliz em ajudar! O Plano Pro é excelente e tem muitos recursos. Posso te ajudar com mais alguma coisa? Quer saber mais sobre as funcionalidades?',
    depois: '[PLANO: intencao=compra; objetivo=PASSAR_VENDEDOR]\nShow! 🙂 O Pro é R$ 99,90/mês. Um especialista da equipe já te chama para finalizar.',
    esperaHandoff: true,
  },
  {
    id: 'objecao-caro', descricao: 'Objeção de preço, tom informal', fontes: CORRETORA, usaEmoji: false, nome: 'Duda', nomeRecente: false, temperatura: 'MORNO', jaRespondido: [],
    mensagemLead: 'achei caro kkk',
    antes: 'Entendo perfeitamente sua preocupação com o valor! Nosso seguro oferece uma excelente relação custo-benefício, com coberturas completas e atendimento de qualidade. Além disso, temos condições especiais que podem se adequar ao seu orçamento. Gostaria de saber mais? Posso te enviar uma proposta personalizada? Qual seria o valor ideal para você?',
    depois: '[PLANO: intencao=objecao; objetivo=TRATAR_OBJECAO]\nNo anual sai com 10% de desconto, ajuda bastante. Quer que eu simule pra você?',
    esperaHandoff: false,
  },
  {
    id: 'provedor', descricao: 'Lead pergunta se é robô; modelo cita a tecnologia', fontes: SOFTWARE, usaEmoji: false, nome: 'Gil', nomeRecente: false, temperatura: 'FRIO', jaRespondido: [],
    mensagemLead: 'você é um robô?',
    antes: 'Sou uma assistente virtual baseada no Gemini do Google, treinada para te ajudar!',
    depois: '[PLANO: intencao=duvida; objetivo=RESPONDER]\nSou a assistente virtual da equipe, uso o Gemini.',
    depoisNovaTentativa: '[PLANO: intencao=duvida; objetivo=QUALIFICAR]\nSou a assistente virtual da equipe e posso te ajudar com a agenda da clínica. Vocês atendem quantos pacientes por dia?',
    esperaHandoff: false,
  },
  {
    id: 'modelo-ignora-estilo', descricao: 'Modelo ignora as regras de estilo (rede de segurança local)', fontes: SOFTWARE, usaEmoji: false, nome: 'Íris', nomeRecente: true, temperatura: 'MORNO', jaRespondido: [],
    mensagemLead: 'como funciona o teste?',
    antes: 'Ótima pergunta, Íris! 😊 O teste grátis dura 7 dias. Quer começar hoje? Posso criar sua conta? Qual seu e-mail?',
    depois: 'Ótima pergunta, Íris! 😊 O teste grátis dura 7 dias. Quer começar hoje? Posso criar sua conta? Qual seu e-mail?',
    esperaHandoff: false,
  },
];

export type Criterio = 'curta' | 'umaPergunta' | 'semRobo' | 'emojiCerto' | 'naoRepergunta' | 'fiel' | 'semMarcador' | 'handoffCerto';
export const CRITERIOS: { id: Criterio; label: string }[] = [
  { id: 'curta', label: 'Curta (até 500 caracteres)' },
  { id: 'umaPergunta', label: 'No máximo uma pergunta' },
  { id: 'semRobo', label: 'Sem frase de robô' },
  { id: 'emojiCerto', label: 'Emoji só se a empresa usa' },
  { id: 'naoRepergunta', label: 'Não pergunta o que já foi respondido' },
  { id: 'fiel', label: 'Fiel às Instruções (sem valor inventado, dado sensível ou provedor)' },
  { id: 'semMarcador', label: 'Nada interno vaza ([PLANO])' },
  { id: 'handoffCerto', label: 'Passa ao vendedor quando deve (e só então)' },
];

/** Resultado final do jeito antigo: texto como veio; só transferia com pedido explícito. */
export function pipelineAntes(c: CasoAvaliacao) {
  return { texto: c.antes.trim(), handoff: isExplicitHumanRequest(c.mensagemLead, []) };
}

/** Mesmo caminho do código novo (sem banco): plano → estilo → checagem → 1 nova tentativa → ajuste/especialista → handoff. */
export function pipelineDepois(c: CasoAvaliacao) {
  const prep = (raw: string) => { const ex = extrairPlano(raw); return { plano: ex.plano, texto: polirResposta(ex.texto, { usaEmoji: c.usaEmoji, nome: c.nome, nomeRecente: c.nomeRecente }) }; };
  let { plano, texto } = prep(c.depois);
  let v = verificarResposta(texto, { fontes: c.fontes + '\n' + c.mensagemLead });
  let tentativas = 1;
  if (v.problemas.length && c.depoisNovaTentativa) {
    tentativas = 2;
    const p2 = prep(c.depoisNovaTentativa);
    const v2 = verificarResposta(p2.texto, { fontes: c.fontes + '\n' + c.mensagemLead });
    if (v2.problemas.length <= v.problemas.length) { texto = p2.texto; plano = p2.plano ?? plano; v = v2; }
  }
  const especialista = v.problemas.some((p) => GRAVES.includes(p));
  texto = especialista ? TEXTO_ESPECIALISTA : v.problemas.length ? ajusteMecanico(texto) : texto;
  const pedido = isExplicitHumanRequest(c.mensagemLead, []);
  const d = detectIntent(c.mensagemLead);
  const motivo = pedido ? 'pedido de atendente' : motivoHandoff({ textoLead: c.mensagemLead, sentimento: d.sentimento, intencao: d.intencao, plano, temperatura: c.temperatura, especialista });
  if (motivo && !pedido) texto = comPassagem(texto);
  return { texto, handoff: !!motivo, tentativas };
}

export function criterios(c: CasoAvaliacao, r: { texto: string; handoff: boolean }): Record<Criterio, boolean> {
  const perguntas = (r.texto.match(/[^.!?\n]*\?/g) ?? []).map((q) => q.toLowerCase());
  return {
    curta: r.texto.length <= 500,
    umaPergunta: (r.texto.match(/\?+/g) ?? []).length <= 1,
    semRobo: frasesDeRobo(r.texto).length === 0 && !/entendo perfeitamente/i.test(r.texto),
    emojiCerto: c.usaEmoji || !new RegExp(EMOJI_RE.source, 'u').test(r.texto),
    naoRepergunta: !perguntas.some((q) => c.jaRespondido.some((k) => q.includes(k.toLowerCase()))),
    fiel: !verificarResposta(r.texto, { fontes: c.fontes + '\n' + c.mensagemLead }).problemas.some((p) => GRAVES.includes(p)),
    semMarcador: !/\[\s*PLANO/i.test(r.texto),
    handoffCerto: r.handoff === c.esperaHandoff,
  };
}

export function avaliar() {
  const linhas = CASOS.map((c) => {
    const antes = pipelineAntes(c);
    const depois = pipelineDepois(c);
    return { caso: c, antes, depois, cAntes: criterios(c, antes), cDepois: criterios(c, depois) };
  });
  const total = (k: 'cAntes' | 'cDepois', id: Criterio) => linhas.filter((l) => l[k][id]).length;
  const resumo = CRITERIOS.map((cr) => ({ ...cr, antes: total('cAntes', cr.id), depois: total('cDepois', cr.id), de: linhas.length }));
  const ok = (k: 'cAntes' | 'cDepois') => linhas.filter((l) => Object.values(l[k]).every(Boolean)).length;
  return { linhas, resumo, casosOk: { antes: ok('cAntes'), depois: ok('cDepois'), de: linhas.length } };
}
