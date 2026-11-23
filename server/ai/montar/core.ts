/**
 * v1.46.0 — "Monte sua IA conversando": funções puras (sem banco) para
 *  - ler texto de páginas (site/Instagram) a partir do HTML;
 *  - montar o pedido para a IA e validar o JSON que ela devolve;
 *  - gerar a base de conhecimento, as instruções e o fluxo inicial (boas-vindas, menu de setores, fora do horário).
 * Nada aqui grava: a prévia é editável e só "Aplicar" muda a configuração (service.ts).
 */
import type { FlowGraph } from '../../flows/logic.js';
import { validarFaixas, type Faixa } from '../../inbox/core.js';

export const MAX_FONTE_CHARS = 30_000;
export const PREFIXO_DOC = 'Assistente: ';
export const NOME_FLUXO = 'Boas-vindas (assistente)';
export const OPCAO_ATENDENTE = 'Falar com um atendente';

export interface Produto { nome: string; preco: string; descricao: string; precoConferido: boolean }
export interface Pergunta { pergunta: string; resposta: string }
export interface Proposta {
  empresa: string;
  segmento: string;
  resumo: string;
  produtos: Produto[];
  horarios: Faixa[];
  horarioTexto: string;
  endereco: string;
  contato: string;
  pagamento: string;
  entrega: string;
  regras: string[];
  nuncaPrometer: string[];
  perguntas: Pergunta[];
  setores: string[];
  boasVindas: string;
  foraDoHorario: string;
}

const txt = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/\s+/g, ' ').trim().slice(0, max);
const lista = (v: unknown, max: number, maxItem: number) => (Array.isArray(v) ? v : []).map((x) => txt(x, maxItem)).filter(Boolean).slice(0, max);

/** Decodifica entidades HTML comuns. */
export function decodeEntities(s: string): string {
  const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ccedil: 'ç', atilde: 'ã', otilde: 'õ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', acirc: 'â', ecirc: 'ê', ocirc: 'ô', agrave: 'à' };
  return s
    .replace(/&#(\d+);/g, (_m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&([a-z]+);/gi, (m, n) => map[n.toLowerCase()] ?? m);
}

/** Texto legível de uma página: título, descrições (og/meta) e corpo sem scripts/estilos. */
export function textoDoHtml(html: string, max = MAX_FONTE_CHARS): string {
  const h = String(html ?? '').slice(0, 2_000_000);
  const metas: string[] = [];
  const title = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) metas.push(title);
  for (const m of h.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const nome = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? '';
    if (!/^(description|og:title|og:description|twitter:description)$/.test(nome)) continue;
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
    if (content) metas.push(content);
  }
  const corpo = h
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const linhas = decodeEntities([...new Set(metas.map((x) => decodeEntities(x).trim()))].join('\n') + '\n' + corpo)
    .split('\n').map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim()).filter(Boolean);
  const vistas = new Set<string>();
  const out: string[] = [];
  for (const l of linhas) { if (vistas.has(l)) continue; vistas.add(l); out.push(l); }
  return out.join('\n').slice(0, max);
}

/** Endereço digitado pelo dono → URL (aceita "@perfil" do Instagram e domínio sem https). Nulo = inválido. */
export function normalizarLink(raw: string): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^@[\w.]{1,30}$/.test(s)) s = `https://www.instagram.com/${s.slice(1)}/`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch { return null; }
}

export const SISTEMA_EXTRACAO = [
  'Você ajuda o dono de uma pequena empresa brasileira a configurar o atendimento automático no WhatsApp.',
  'Leia as FONTES (site, Instagram, texto, lista de preços, transcrição de áudio) e extraia SOMENTE o que está escrito nelas.',
  'Nunca invente preços, horários, endereços, prazos ou regras. Se algo não aparecer nas fontes, deixe vazio ("" ou []).',
  'Preços: copie exatamente como aparecem (ex.: "R$ 45,00", "a partir de R$ 30").',
  'Horários: dia 0 = domingo, 1 = segunda … 6 = sábado; "inicio" e "fim" em HH:MM (24 h). Repita um item por dia.',
  '"nuncaPrometer": o que a IA NÃO deve prometer (ex.: desconto, prazo de entrega não informado, diagnóstico) — use o que as fontes dizem e acrescente o óbvio para o segmento (no máximo 6 itens).',
  '"setores": de 2 a 4 opções curtas para o menu de boas-vindas (ex.: "Ver produtos e preços", "Agendar horário", "Fazer pedido", "Dúvidas"). Não inclua "Falar com atendente" (já existe).',
  '"boasVindas": 1 ou 2 frases cordiais com o nome da empresa, sem preço. "foraDoHorario": 1 frase avisando que está fora do horário e que responde assim que voltar (pode usar {horario}).',
  'Não cite empresas concorrentes. Português do Brasil.',
  'Responda SOMENTE com um JSON válido neste formato:',
  '{"empresa":"","segmento":"","resumo":"","produtos":[{"nome":"","preco":"","descricao":""}],"horarios":[{"dia":1,"inicio":"09:00","fim":"18:00"}],"horarioTexto":"","endereco":"","contato":"","pagamento":"","entrega":"","regras":[""],"nuncaPrometer":[""],"perguntas":[{"pergunta":"","resposta":""}],"setores":[""],"boasVindas":"","foraDoHorario":""}',
].join('\n');

export interface Fonte { tipo: 'link' | 'texto' | 'arquivo' | 'audio'; nome: string; texto: string }

/** Mensagem do usuário com as fontes (cada uma limitada; total limitado). */
export function mensagemFontes(fontes: Fonte[], max = MAX_FONTE_CHARS): string {
  const ROT: Record<Fonte['tipo'], string> = { link: 'PÁGINA', texto: 'TEXTO DO DONO', arquivo: 'ARQUIVO', audio: 'ÁUDIO DO DONO (transcrito)' };
  const partes: string[] = [];
  let resto = max;
  for (const f of fontes) {
    const t = String(f.texto ?? '').trim();
    if (!t || resto <= 200) continue;
    const corte = t.slice(0, Math.max(200, Math.min(resto, Math.floor(max / Math.max(1, fontes.length)) + 4000)));
    resto -= corte.length;
    partes.push(`### ${ROT[f.tipo]}${f.nome ? `: ${f.nome}` : ''}\n${corte}`);
  }
  return `FONTES:\n\n${partes.join('\n\n')}`;
}

/** Tira o JSON da resposta da IA (com ou sem cercas ```json). Nulo = não é JSON. */
export function lerJson(texto: string): Record<string, unknown> | null {
  const t = String(texto ?? '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const ini = t.indexOf('{');
  const fim = t.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    const v = JSON.parse(t.slice(ini, fim + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

const digitos = (s: string) => s.replace(/\D/g, '');

/** O preço aparece nas fontes? (compara os números: "45", "45,00", "45.00" casam). */
export function precoNasFontes(preco: string, fontes: string): boolean {
  const nums = (preco.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/[.,]00$/, ''));
  if (!nums.length) return true; // "sob consulta" e afins: nada a conferir
  const base = fontes.replace(/(\d)[.,]00\b/g, '$1');
  return nums.every((n) => {
    const d = digitos(n);
    return d.length > 0 && (base.includes(n) || base.includes(n.replace('.', ',')) || base.includes(n.replace(',', '.')) || digitos(base).includes(d));
  });
}

const SETORES_PADRAO = ['Ver produtos e preços', 'Tirar uma dúvida'];

/** Valida e limpa a proposta (da IA ou editada pelo dono). `fontes` = texto bruto para conferir preços. */
export function normalizarProposta(raw: Record<string, unknown> | null | undefined, fontes = ''): Proposta {
  const r = raw ?? {};
  const produtos = (Array.isArray(r.produtos) ? r.produtos : []).slice(0, 80).map((p: any) => {
    const nome = txt(p?.nome, 120);
    const preco = txt(p?.preco, 60);
    return { nome, preco, descricao: txt(p?.descricao, 300), precoConferido: !preco || !fontes ? true : precoNasFontes(preco, fontes) };
  }).filter((p) => p.nome);
  // Faixa a faixa: uma inválida (ou sobreposta) cai sozinha, sem derrubar as outras.
  let horarios: Faixa[] = [];
  for (const x of (Array.isArray(r.horarios) ? r.horarios : []).slice(0, 21)) {
    const f = { dia: Number((x as any)?.dia), inicio: txt((x as any)?.inicio, 5).padStart(5, '0'), fim: txt((x as any)?.fim, 5).padStart(5, '0') };
    const v = validarFaixas([...horarios, f]);
    if ('faixas' in v) horarios = v.faixas;
  }
  const perguntas = (Array.isArray(r.perguntas) ? r.perguntas : []).slice(0, 20).map((q: any) => ({ pergunta: txt(q?.pergunta, 200), resposta: txt(q?.resposta, 600) })).filter((q) => q.pergunta && q.resposta);
  const setores = [...new Set(lista(r.setores, 6, 40).filter((s) => !/atendente|humano|pessoa/i.test(s)))].slice(0, 4);
  const empresa = txt(r.empresa, 120);
  return {
    empresa, segmento: txt(r.segmento, 80), resumo: txt(r.resumo, 800),
    produtos, horarios, horarioTexto: txt(r.horarioTexto, 300),
    endereco: txt(r.endereco, 300), contato: txt(r.contato, 200), pagamento: txt(r.pagamento, 300), entrega: txt(r.entrega, 400),
    regras: lista(r.regras, 15, 300), nuncaPrometer: lista(r.nuncaPrometer, 10, 200), perguntas,
    setores: setores.length >= 2 ? setores : [...new Set([...setores, ...SETORES_PADRAO])].slice(0, Math.max(2, setores.length)),
    boasVindas: txt(r.boasVindas, 400) || `Olá! Bem-vindo(a)${empresa ? ` à ${empresa}` : ''}. Como posso ajudar?`,
    foraDoHorario: txt(r.foraDoHorario, 400),
  };
}

/** A proposta tem conteúdo suficiente para virar base de conhecimento? */
export const propostaVazia = (p: Proposta) => !p.resumo && !p.produtos.length && !p.horarios.length && !p.regras.length && !p.perguntas.length && !p.endereco;

const DIA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
export function horarioPorExtenso(f: Faixa[]): string {
  return [...f].sort((a, b) => a.dia - b.dia || a.inicio.localeCompare(b.inicio)).map((x) => `${DIA[x.dia]}: ${x.inicio} às ${x.fim}`).join('\n');
}

export interface DocGerado { title: string; content: string }

/** Documentos da base de conhecimento (só os que têm conteúdo). Títulos fixos com o prefixo do assistente. */
export function documentos(p: Proposta): DocGerado[] {
  const out: DocGerado[] = [];
  const sobre = [p.empresa && `Empresa: ${p.empresa}`, p.segmento && `Segmento: ${p.segmento}`, p.resumo, p.endereco && `Endereço: ${p.endereco}`, p.contato && `Contato: ${p.contato}`].filter(Boolean);
  if (sobre.length) out.push({ title: `${PREFIXO_DOC}Sobre a empresa`, content: sobre.join('\n') });
  if (p.produtos.length) out.push({ title: `${PREFIXO_DOC}Produtos e preços`, content: p.produtos.map((x) => `- ${x.nome}${x.preco ? `: ${x.preco}` : ''}${x.descricao ? ` — ${x.descricao}` : ''}`).join('\n') });
  const hor = [p.horarios.length ? horarioPorExtenso(p.horarios) : '', p.horarioTexto].filter(Boolean);
  if (hor.length) out.push({ title: `${PREFIXO_DOC}Horário de atendimento`, content: `Horário de atendimento:\n${hor.join('\n')}` });
  const pol = [p.pagamento && `Formas de pagamento: ${p.pagamento}`, p.entrega && `Entrega/retirada: ${p.entrega}`, ...p.regras.map((r) => `- ${r}`)].filter(Boolean);
  if (pol.length) out.push({ title: `${PREFIXO_DOC}Regras e políticas`, content: pol.join('\n') });
  if (p.perguntas.length) out.push({ title: `${PREFIXO_DOC}Perguntas frequentes`, content: p.perguntas.map((q) => `P: ${q.pergunta}\nR: ${q.resposta}`).join('\n\n') });
  return out;
}

export const MARCA_INI = '<!-- assistente:inicio -->';
export const MARCA_FIM = '<!-- assistente:fim -->';

/** Bloco de instruções gerado (entre marcas, para poder ser trocado depois sem mexer no resto). */
export function blocoInstrucoes(p: Proposta): string {
  const l: string[] = [MARCA_INI, `Você é o atendente virtual${p.empresa ? ` da ${p.empresa}` : ''} no WhatsApp.`];
  if (p.resumo) l.push(`Sobre a empresa: ${p.resumo}`);
  if (p.horarios.length || p.horarioTexto) l.push(`Horário de atendimento: ${[p.horarios.length ? horarioPorExtenso(p.horarios).replace(/\n/g, '; ') : '', p.horarioTexto].filter(Boolean).join('. ')}.`);
  if (p.endereco) l.push(`Endereço: ${p.endereco}.`);
  if (p.pagamento) l.push(`Pagamento: ${p.pagamento}.`);
  if (p.entrega) l.push(`Entrega: ${p.entrega}.`);
  l.push('Use preços e condições SOMENTE da base de conhecimento. Se não souber, diga que vai confirmar com a equipe (não transfira por isso).');
  l.push('Só passe para um atendente humano se o cliente pedir.');
  if (p.nuncaPrometer.length) l.push(`Nunca prometa: ${p.nuncaPrometer.join('; ')}.`);
  l.push(MARCA_FIM);
  return l.join('\n');
}

/** Junta com as instruções atuais: troca o bloco anterior do assistente, ou substitui tudo, ou acrescenta no fim. */
export function mesclarInstrucoes(atuais: string, bloco: string, substituir: boolean, max = 8000): string {
  const a = String(atuais ?? '');
  if (substituir || !a.trim()) return bloco.slice(0, max);
  const i = a.indexOf(MARCA_INI);
  const f = a.indexOf(MARCA_FIM);
  if (i >= 0 && f > i) return (a.slice(0, i) + bloco + a.slice(f + MARCA_FIM.length)).slice(0, max);
  const junto = `${a.trimEnd()}\n\n${bloco}`;
  return junto.length <= max ? junto : `${a.slice(0, Math.max(0, max - bloco.length - 2))}\n\n${bloco}`;
}

/** Fluxo inicial: primeira mensagem → boas-vindas → menu de setores; cada setor segue com a IA; "Falar com um atendente" transfere. */
export function fluxoInicial(p: Proposta): FlowGraph {
  const setores = p.setores.slice(0, 4);
  const opcoes = [...setores.map((label, i) => ({ id: `s${i + 1}`, label })), { id: 'humano', label: OPCAO_ATENDENTE }];
  const nodes: FlowGraph['nodes'] = [
    { id: 'start', type: 'start', position: { x: 40, y: 160 }, data: { triggers: [{ type: 'first_message' }] } },
    { id: 'boas', type: 'send_text', position: { x: 320, y: 160 }, data: { label: 'Boas-vindas', text: p.boasVindas } },
    { id: 'menu', type: 'menu', position: { x: 620, y: 160 }, data: { label: 'Menu de setores', text: 'Como posso ajudar? Responda com o número:', options: opcoes, variable: 'setor', maxRetries: 2 } },
  ];
  const edges: FlowGraph['edges'] = [
    { id: 'e-start', source: 'start', target: 'boas', sourceHandle: 'next' },
    { id: 'e-boas', source: 'boas', target: 'menu', sourceHandle: 'next' },
  ];
  setores.forEach((label, i) => {
    const id = `ia${i + 1}`;
    nodes.push({ id, type: 'ai', position: { x: 960, y: 40 + i * 120 }, data: { label: `IA: ${label}`, instructions: `O cliente escolheu "${label}" no menu. Ajude com isso de forma objetiva.`, continueConversation: true } });
    edges.push({ id: `e-${id}`, source: 'menu', target: id, sourceHandle: `opt-s${i + 1}` });
  });
  nodes.push({ id: 'humano', type: 'handoff', position: { x: 960, y: 40 + setores.length * 120 }, data: { label: 'Atendente', message: 'Certo! Vou chamar alguém da equipe para falar com você. 😊', reason: 'Cliente pediu atendente no menu' } });
  edges.push({ id: 'e-humano', source: 'menu', target: 'humano', sourceHandle: 'opt-humano' });
  // Resposta fora do menu: segue com a IA (ela entende texto livre).
  nodes.push({ id: 'livre', type: 'ai', position: { x: 960, y: 80 + (setores.length + 1) * 120 }, data: { label: 'IA: resposta livre', instructions: '', continueConversation: true } });
  edges.push({ id: 'e-livre', source: 'menu', target: 'livre', sourceHandle: 'invalid' });
  return { nodes, edges };
}

/** Texto padrão de fora do horário ({nome}/{horario} viram dados reais no envio). */
export function textoForaHorario(p: Proposta): string {
  const t = p.foraDoHorario.trim();
  if (t) return t.includes('{horario}') ? t : `${/[.!?]$/.test(t) ? t : `${t}.`} Nosso horário: {horario}.`;
  return `Olá {nome}! Agora estamos fora do horário de atendimento${p.empresa ? ` da ${p.empresa}` : ''}. Recebemos sua mensagem e respondemos assim que voltarmos. Nosso horário: {horario}.`;
}
