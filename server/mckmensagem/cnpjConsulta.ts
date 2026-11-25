/**
 * v1.53.0 — Consulta CNPJ / Prospecção (MCK Mensagens).
 *
 * Fontes públicas e gratuitas do cadastro da Receita Federal, em ordem: BrasilAPI → minhareceita.org (mesmo formato)
 * → publica.cnpj.ws → ReceitaWS. Cache no banco por 30 dias (CnpjCache, compartilhado entre empresas: é dado público
 * da empresa) e limite diário de consultas na fonte por empresa usuária (CnpjUso).
 *
 * REGRAS FIXAS: só usamos o que a própria fonte de CNPJ devolve (telefone e e-mail DO CADASTRO DA EMPRESA). Nada de
 * buscar, raspar ou cruzar telefone/e-mail pessoal de sócio em outros lugares. CPF de sócio nunca é guardado nem
 * exibido (nem mascarado): do quadro de sócios ficam só nome, qualificação/cargo e data de entrada.
 */
import { prisma } from '../db.js';
import { httpFetch } from '../lib/fetcher.js';
import { isValidCnpj, normalizeDocumento, onlyDigits } from '../lib/documento.js';
import { parseJson } from '../lib/json.js';

export interface TelefoneCadastro { e164: string; exibicao: string; celular: boolean; whatsapp: string | null }
export interface SocioCadastro { nome: string; qualificacao: string | null; desde: string | null }
export interface FichaCnpj {
  cnpj: string;
  razaoSocial: string;
  fantasia: string | null;
  situacao: string | null;
  ativa: boolean;
  dataSituacao: string | null;
  motivoSituacao: string | null;
  abertura: string | null; // AAAA-MM-DD
  porte: string | null;
  naturezaJuridica: string | null;
  matrizFilial: string | null;
  capitalSocial: number | null;
  simples: 'MEI' | 'SIMPLES' | 'NORMAL' | null;
  cnaePrincipal: { codigo: string; descricao: string } | null;
  cnaesSecundarios: { codigo: string; descricao: string }[];
  endereco: { logradouro: string | null; numero: string | null; complemento: string | null; bairro: string | null; municipio: string | null; uf: string | null; cep: string | null };
  enderecoTexto: string | null;
  mapsUrl: string | null;
  telefones: TelefoneCadastro[];
  email: string | null;
  socios: SocioCadastro[];
  fonte: string; // nome legível da fonte (ex.: BrasilAPI)
  consultadoEm: string; // ISO
}

export const CACHE_DIAS = 30;
export const LIMITE_DIA_PADRAO = 300;
export const LOTE_MAX = 25; // CNPJs por requisição do lote (a tela manda em partes)
export const LOTE_TOTAL_MAX = 500; // CNPJs por lote na tela
export const limiteDia = () => {
  const n = Number(process.env.CNPJ_LIMITE_DIA);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : LIMITE_DIA_PADRAO;
};

export class ConsultaErro extends Error { constructor(msg: string, public status: number) { super(msg); } }

const str = (v: unknown): string | null => {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Data em AAAA-MM-DD a partir de AAAA-MM-DD ou DD/MM/AAAA. */
export function dataIso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Telefone do cadastro: DDD + número. Celular = 11 dígitos com 9 depois do DDD (regra nacional). Só celular ganha
 * botão de WhatsApp (wa.me); fixo aparece só para ligação.
 */
export function telefoneCadastro(raw: unknown): TelefoneCadastro | null {
  let d = onlyDigits(String(raw ?? ''));
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = d.slice(0, 2), num = d.slice(2);
  if (Number(ddd) < 11) return null;
  const celular = num.length === 9 && num[0] === '9';
  if (num.length === 9 && !celular) return null;
  const exibicao = celular ? `(${ddd}) ${num.slice(0, 5)}-${num.slice(5)}` : `(${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
  const e164 = `+55${ddd}${num}`;
  return { e164, exibicao, celular, whatsapp: celular ? `https://wa.me/55${ddd}${num}` : null };
}

function telefones(list: unknown[]): TelefoneCadastro[] {
  const out: TelefoneCadastro[] = [];
  for (const t of list) {
    for (const parte of String(t ?? '').split('/')) {
      const tel = telefoneCadastro(parte);
      if (tel && !out.some((x) => x.e164 === tel.e164)) out.push(tel);
    }
  }
  return out;
}

const emailOk = (v: unknown) => {
  const s = str(v)?.toLowerCase() ?? null;
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};

/** Só nome, qualificação e data de entrada. Nunca CPF/CNPJ do sócio, faixa etária ou representante legal. */
function socio(nome: unknown, qual: unknown, desde: unknown): SocioCadastro | null {
  const n = str(nome);
  if (!n) return null;
  return { nome: n.replace(/\s+/g, ' '), qualificacao: str(qual)?.replace(/\s+/g, ' ') ?? null, desde: dataIso(desde) };
}

function completar(base: Omit<FichaCnpj, 'enderecoTexto' | 'mapsUrl' | 'ativa'>): FichaCnpj {
  const e = base.endereco;
  const cepFmt = e.cep && e.cep.length === 8 ? `${e.cep.slice(0, 5)}-${e.cep.slice(5)}` : e.cep;
  const linha1 = [e.logradouro, e.numero].filter(Boolean).join(', ');
  const partes = [linha1 + (e.complemento ? ` ${e.complemento}` : ''), e.bairro, [e.municipio, e.uf].filter(Boolean).join(' - '), cepFmt ? `CEP ${cepFmt}` : null]
    .map((x) => (x ?? '').trim()).filter(Boolean);
  const enderecoTexto = partes.length ? partes.join(' · ') : null;
  const busca = [linha1, e.bairro, e.municipio, e.uf, cepFmt].filter(Boolean).join(', ');
  return {
    ...base,
    ativa: /ativa/i.test(base.situacao ?? '') && !/inativa/i.test(base.situacao ?? ''),
    enderecoTexto,
    mapsUrl: busca ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(busca)}` : null,
  };
}

/** BrasilAPI e minhareceita.org (mesmo formato). */
export function fichaDeBrasilApi(j: Record<string, any>, fonte: string, agora = new Date()): FichaCnpj {
  return completar({
    cnpj: onlyDigits(String(j.cnpj ?? '')),
    razaoSocial: str(j.razao_social) ?? '',
    fantasia: str(j.nome_fantasia),
    situacao: str(j.descricao_situacao_cadastral),
    dataSituacao: dataIso(j.data_situacao_cadastral),
    motivoSituacao: str(j.descricao_motivo_situacao_cadastral),
    abertura: dataIso(j.data_inicio_atividade),
    porte: str(j.porte) ?? str(j.descricao_porte),
    naturezaJuridica: str(j.natureza_juridica),
    matrizFilial: str(j.descricao_identificador_matriz_filial),
    capitalSocial: typeof j.capital_social === 'number' ? j.capital_social : null,
    simples: j.opcao_pelo_mei ? 'MEI' : j.opcao_pelo_simples ? 'SIMPLES' : j.opcao_pelo_simples === false ? 'NORMAL' : null,
    cnaePrincipal: str(j.cnae_fiscal) ? { codigo: String(j.cnae_fiscal), descricao: str(j.cnae_fiscal_descricao) ?? '' } : null,
    cnaesSecundarios: (Array.isArray(j.cnaes_secundarios) ? j.cnaes_secundarios : [])
      .filter((c: any) => c && Number(c.codigo) > 0).map((c: any) => ({ codigo: String(c.codigo), descricao: str(c.descricao) ?? '' })),
    endereco: {
      logradouro: [str(j.descricao_tipo_de_logradouro), str(j.logradouro)].filter(Boolean).join(' ') || null,
      numero: str(j.numero), complemento: str(j.complemento), bairro: str(j.bairro), municipio: str(j.municipio), uf: str(j.uf),
      cep: str(j.cep) ? onlyDigits(String(j.cep)) : null,
    },
    telefones: telefones([j.ddd_telefone_1, j.ddd_telefone_2]),
    email: emailOk(j.email),
    socios: (Array.isArray(j.qsa) ? j.qsa : []).map((s: any) => socio(s?.nome_socio, s?.qualificacao_socio, s?.data_entrada_sociedade)).filter(Boolean) as SocioCadastro[],
    fonte, consultadoEm: agora.toISOString(),
  });
}

/** publica.cnpj.ws */
export function fichaDeCnpjWs(j: Record<string, any>, agora = new Date()): FichaCnpj {
  const e = (j.estabelecimento ?? {}) as Record<string, any>;
  const s = (j.simples ?? null) as Record<string, any> | null;
  const cap = Number(String(j.capital_social ?? '').replace(',', '.'));
  return completar({
    cnpj: onlyDigits(String(e.cnpj ?? '')),
    razaoSocial: str(j.razao_social) ?? '',
    fantasia: str(e.nome_fantasia),
    situacao: str(e.situacao_cadastral),
    dataSituacao: dataIso(e.data_situacao_cadastral),
    motivoSituacao: str(e.motivo_situacao_cadastral?.descricao),
    abertura: dataIso(e.data_inicio_atividade),
    porte: str(j.porte?.descricao),
    naturezaJuridica: str(j.natureza_juridica?.descricao),
    matrizFilial: str(e.tipo),
    capitalSocial: Number.isFinite(cap) && String(j.capital_social ?? '') !== '' ? cap : null,
    simples: s?.mei === 'Sim' ? 'MEI' : s?.simples === 'Sim' ? 'SIMPLES' : s ? 'NORMAL' : null,
    cnaePrincipal: str(e.atividade_principal?.id) ? { codigo: String(e.atividade_principal.id), descricao: str(e.atividade_principal.descricao) ?? '' } : null,
    cnaesSecundarios: (Array.isArray(e.atividades_secundarias) ? e.atividades_secundarias : []).map((c: any) => ({ codigo: String(c?.id ?? ''), descricao: str(c?.descricao) ?? '' })).filter((c: any) => c.codigo),
    endereco: {
      logradouro: [str(e.tipo_logradouro), str(e.logradouro)].filter(Boolean).join(' ') || null,
      numero: str(e.numero), complemento: str(e.complemento), bairro: str(e.bairro), municipio: str(e.cidade?.nome), uf: str(e.estado?.sigla),
      cep: str(e.cep) ? onlyDigits(String(e.cep)) : null,
    },
    telefones: telefones([`${str(e.ddd1) ?? ''}${str(e.telefone1) ?? ''}`, `${str(e.ddd2) ?? ''}${str(e.telefone2) ?? ''}`]),
    email: emailOk(e.email),
    socios: (Array.isArray(j.socios) ? j.socios : []).map((x: any) => socio(x?.nome, x?.qualificacao_socio?.descricao, x?.data_entrada)).filter(Boolean) as SocioCadastro[],
    fonte: 'CNPJ.ws', consultadoEm: agora.toISOString(),
  });
}

/** ReceitaWS (limite baixo por minuto: última da fila). */
export function fichaDeReceitaWs(j: Record<string, any>, agora = new Date()): FichaCnpj {
  const ativ = (a: any) => (a && str(a.code) && a.code !== '00.00-0-00' ? { codigo: onlyDigits(a.code), descricao: str(a.text) ?? '' } : null);
  return completar({
    cnpj: onlyDigits(String(j.cnpj ?? '')),
    razaoSocial: str(j.nome) ?? '',
    fantasia: str(j.fantasia),
    situacao: str(j.situacao),
    dataSituacao: dataIso(j.data_situacao),
    motivoSituacao: str(j.motivo_situacao),
    abertura: dataIso(j.abertura),
    porte: str(j.porte),
    naturezaJuridica: str(j.natureza_juridica),
    matrizFilial: str(j.tipo),
    capitalSocial: Number.isFinite(Number(j.capital_social)) && j.capital_social != null ? Number(j.capital_social) : null,
    simples: j.simei?.optante ? 'MEI' : j.simples?.optante ? 'SIMPLES' : j.simples ? 'NORMAL' : null,
    cnaePrincipal: ativ((j.atividade_principal ?? [])[0]),
    cnaesSecundarios: (Array.isArray(j.atividades_secundarias) ? j.atividades_secundarias : []).map(ativ).filter(Boolean) as { codigo: string; descricao: string }[],
    endereco: {
      logradouro: str(j.logradouro), numero: str(j.numero), complemento: str(j.complemento), bairro: str(j.bairro), municipio: str(j.municipio), uf: str(j.uf),
      cep: str(j.cep) ? onlyDigits(String(j.cep)) : null,
    },
    telefones: telefones([j.telefone]),
    email: emailOk(j.email),
    socios: (Array.isArray(j.qsa) ? j.qsa : []).map((x: any) => socio(x?.nome, x?.qual, null)).filter(Boolean) as SocioCadastro[],
    fonte: 'ReceitaWS', consultadoEm: agora.toISOString(),
  });
}

interface Fonte { nome: string; url: (c: string) => string; map: (j: Record<string, any>) => FichaCnpj; naoAchou?: (j: Record<string, any>) => boolean }
const FONTES: Fonte[] = [
  { nome: 'BrasilAPI', url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, map: (j) => fichaDeBrasilApi(j, 'BrasilAPI') },
  { nome: 'Minha Receita', url: (c) => `https://minhareceita.org/${c}`, map: (j) => fichaDeBrasilApi(j, 'Minha Receita') },
  { nome: 'CNPJ.ws', url: (c) => `https://publica.cnpj.ws/cnpj/${c}`, map: (j) => fichaDeCnpjWs(j) },
  { nome: 'ReceitaWS', url: (c) => `https://receitaws.com.br/v1/cnpj/${c}`, map: (j) => fichaDeReceitaWs(j), naoAchou: (j) => j?.status === 'ERROR' },
];
const HEADERS = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; MCKBOT/1.0; +https://mckbot.onrender.com/empresa)' };

/** Normaliza e valida (aceita com ou sem máscara). */
export function normalizarCnpj(raw: string): string | null {
  const c = normalizeDocumento(raw);
  if (/^\d{1,14}$/.test(c) && c.length >= 12) {
    const p = c.padStart(14, '0');
    return isValidCnpj(p) ? p : null;
  }
  return c.length === 14 && isValidCnpj(c) ? c : null;
}

/** Extrai CNPJs válidos de um texto livre ou CSV (com ou sem máscara), sem repetir, na ordem. */
export function extrairCnpjs(texto: string, max = LOTE_TOTAL_MAX): { cnpjs: string[]; invalidos: number } {
  const out: string[] = [];
  let invalidos = 0;
  const re = /(?<![\dA-Za-z])([0-9A-Za-z]{2}\.?[0-9A-Za-z]{3}\.?[0-9A-Za-z]{3}\/?[0-9A-Za-z]{4}-?\d{2})(?![\dA-Za-z])/g;
  for (const m of String(texto ?? '').matchAll(re)) {
    if (!/\d/.test(m[1].slice(0, 12)) && !/^\d/.test(m[1])) continue;
    const c = normalizarCnpj(m[1]);
    if (!c) { if (/^\d[\d./-]+$/.test(m[1])) invalidos++; continue; }
    if (!out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return { cnpjs: out, invalidos };
}

/** Busca na fonte (sem cache). */
export async function buscarNaFonte(cnpj: string): Promise<FichaCnpj> {
  let naoEncontrado = 0;
  for (const f of FONTES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await httpFetch(f.url(cnpj), { signal: ctrl.signal, headers: HEADERS });
      if (r.status === 404) { naoEncontrado++; continue; }
      if (!r.ok) { console.warn('[cnpj-consulta] fonte recusou', { fonte: f.nome, status: r.status }); continue; }
      const j = (await r.json()) as Record<string, any>;
      if (f.naoAchou?.(j)) { naoEncontrado++; continue; }
      const ficha = f.map(j);
      if (ficha.razaoSocial) return { ...ficha, cnpj: ficha.cnpj || cnpj };
    } catch (e) {
      console.warn('[cnpj-consulta] fonte falhou', { fonte: f.nome, error: (e as Error).message });
    } finally { clearTimeout(t); }
  }
  if (naoEncontrado > 0) throw new ConsultaErro('CNPJ não encontrado no cadastro da Receita', 404);
  throw new ConsultaErro('As fontes públicas de CNPJ não responderam agora. Tente de novo em alguns minutos.', 502);
}

/** Dia (AAAA-MM-DD) em Brasília. */
export const diaBrt = (d = new Date()) => new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10);

export async function usoHoje(orgId: string, agora = new Date()) {
  const u = await prisma.cnpjUso.findUnique({ where: { orgId_dia: { orgId, dia: diaBrt(agora) } } });
  return { consultas: u?.consultas ?? 0, naFonte: u?.fonte ?? 0, limiteDia: limiteDia() };
}

async function contar(orgId: string, naFonte: boolean, agora: Date) {
  const dia = diaBrt(agora);
  await prisma.cnpjUso.upsert({
    where: { orgId_dia: { orgId, dia } },
    create: { orgId, dia, consultas: 1, fonte: naFonte ? 1 : 0 },
    update: { consultas: { increment: 1 }, ...(naFonte ? { fonte: { increment: 1 } } : {}) },
  });
}

/** Anti-abuso: no máximo N consultas por minuto por empresa (cache incluído). */
const POR_MINUTO = 60;
const janela = new Map<string, number[]>();
export const resetConsultaCnpjState = () => janela.clear();
function porMinuto(orgId: string, agora: number) {
  const arr = (janela.get(orgId) ?? []).filter((t) => agora - t < 60_000);
  if (arr.length >= POR_MINUTO) throw new ConsultaErro('Muitas consultas em pouco tempo. Aguarde um minuto e continue.', 429);
  arr.push(agora);
  janela.set(orgId, arr);
}

/**
 * Consulta com cache (30 dias) e limites por empresa. Cache não conta no limite diário (só consultas na fonte).
 * `atualizar` ignora o cache (conta como consulta na fonte).
 */
export async function consultarCnpjEmpresa(orgId: string, raw: string, opts: { atualizar?: boolean; agora?: Date } = {}): Promise<FichaCnpj & { doCache: boolean }> {
  const agora = opts.agora ?? new Date();
  const cnpj = normalizarCnpj(raw);
  if (!cnpj) throw new ConsultaErro('CNPJ inválido. Confira os 14 dígitos.', 400);
  porMinuto(orgId, agora.getTime());
  if (!opts.atualizar) {
    const c = await prisma.cnpjCache.findUnique({ where: { cnpj } });
    if (c && agora.getTime() - c.consultadoEm.getTime() < CACHE_DIAS * 864e5) {
      const ficha = parseJson<FichaCnpj | null>(c.dados, null);
      if (ficha?.razaoSocial) { await contar(orgId, false, agora); return { ...ficha, doCache: true }; }
    }
  }
  const uso = await usoHoje(orgId, agora);
  if (uso.naFonte >= uso.limiteDia) throw new ConsultaErro(`Limite diário de ${uso.limiteDia} consultas novas atingido. Consultas já feitas nos últimos ${CACHE_DIAS} dias continuam abrindo; o limite volta amanhã.`, 429);
  const ficha = await buscarNaFonte(cnpj);
  const dados = JSON.stringify(ficha);
  await prisma.cnpjCache.upsert({ where: { cnpj }, create: { cnpj, fonte: ficha.fonte, dados, consultadoEm: agora }, update: { fonte: ficha.fonte, dados, consultadoEm: agora } });
  await contar(orgId, true, agora);
  return { ...ficha, doCache: false };
}

/** Ficha do cache (para importar sem confiar em dados vindos da tela). */
export async function fichaDoCache(cnpj: string): Promise<FichaCnpj | null> {
  const c = await prisma.cnpjCache.findUnique({ where: { cnpj } });
  return c ? parseJson<FichaCnpj | null>(c.dados, null) : null;
}

/** Sócio/dono para {dono}: prefere administrador; nunca CPF. */
export function donoDaFicha(f: FichaCnpj): string | null {
  const adm = f.socios.find((s) => /administrador|titular|presidente|diretor|empres[áa]rio/i.test(s.qualificacao ?? ''));
  const s = adm ?? f.socios[0];
  if (!s) return null;
  return s.nome.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()).replace(/\s(D[aeo]s?|E)\s/g, (m) => m.toLowerCase()).slice(0, 100);
}

export const nomeEmpresa = (f: FichaCnpj) => (f.fantasia && !/^\*+$/.test(f.fantasia) ? f.fantasia : f.razaoSocial).slice(0, 120);

export function origemDoDado(f: FichaCnpj) {
  const d = new Date(f.consultadoEm);
  const data = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `Cadastro CNPJ – ${f.fonte} – ${data}`;
}
