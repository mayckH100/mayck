/**
 * Consulta de CNPJ na BrasilAPI (gratuita, dados da Receita Federal): razão social, endereço, CNAE,
 * situação cadastral e opção pelo Simples/MEI. Inscrição Estadual depende da SEFAZ (etapa fiscal).
 */
import { httpFetch } from '../../lib/fetcher.js';
import { isValidCnpj, onlyDigits } from '../../lib/documento.js';

export interface DadosCnpj {
  documento: string; nome: string; fantasia: string | null; situacaoCadastral: string | null;
  cnae: string | null; cnaeDescricao: string | null; regimeTributario: 'MEI' | 'SIMPLES' | 'NORMAL' | null;
  cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null;
  bairro: string | null; municipio: string | null; codigoMunicipio: string | null; uf: string | null;
  email: string | null; telefone: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : v != null && v !== '' && typeof v !== 'object' ? String(v) : null);

export function mapearBrasilApi(j: Record<string, any>): DadosCnpj {
  const regime = j.opcao_pelo_mei ? 'MEI' : j.opcao_pelo_simples ? 'SIMPLES' : (j.opcao_pelo_simples === false ? 'NORMAL' : null);
  const tel = onlyDigits(str(j.ddd_telefone_1) ?? '');
  return {
    documento: onlyDigits(String(j.cnpj ?? '')),
    nome: str(j.razao_social) ?? '',
    fantasia: str(j.nome_fantasia),
    situacaoCadastral: str(j.descricao_situacao_cadastral),
    cnae: str(j.cnae_fiscal),
    cnaeDescricao: str(j.cnae_fiscal_descricao),
    regimeTributario: regime,
    cep: str(j.cep) ? onlyDigits(String(j.cep)) : null,
    logradouro: [str(j.descricao_tipo_de_logradouro), str(j.logradouro)].filter(Boolean).join(' ') || null,
    numero: str(j.numero), complemento: str(j.complemento), bairro: str(j.bairro),
    municipio: str(j.municipio), codigoMunicipio: str(j.codigo_municipio_ibge), uf: str(j.uf),
    email: str(j.email)?.toLowerCase() ?? null,
    telefone: tel.length >= 10 ? `+55${tel}` : null,
  };
}

export class CnpjErro extends Error { constructor(msg: string, public status: number) { super(msg); } }

/** Mapeia a resposta da publica.cnpj.ws (fallback). */
export function mapearCnpjWs(j: Record<string, any>): DadosCnpj {
  const e = (j.estabelecimento ?? {}) as Record<string, any>;
  const simples = (j.simples ?? null) as Record<string, any> | null;
  const regime = simples?.mei === 'Sim' ? 'MEI' : simples?.simples === 'Sim' ? 'SIMPLES' : simples ? 'NORMAL' : null;
  const tel = onlyDigits(`${str(e.ddd1) ?? ''}${str(e.telefone1) ?? ''}`);
  return {
    documento: onlyDigits(String(e.cnpj ?? '')),
    nome: str(j.razao_social) ?? '',
    fantasia: str(e.nome_fantasia),
    situacaoCadastral: str(e.situacao_cadastral),
    cnae: str(e.atividade_principal?.id),
    cnaeDescricao: str(e.atividade_principal?.descricao),
    regimeTributario: regime,
    cep: str(e.cep) ? onlyDigits(String(e.cep)) : null,
    logradouro: [str(e.tipo_logradouro), str(e.logradouro)].filter(Boolean).join(' ') || null,
    numero: str(e.numero), complemento: str(e.complemento), bairro: str(e.bairro),
    municipio: str(e.cidade?.nome), codigoMunicipio: str(e.cidade?.ibge_id), uf: str(e.estado?.sigla),
    email: str(e.email)?.toLowerCase() ?? null,
    telefone: tel.length >= 10 ? `+55${tel}` : null,
  };
}

/**
 * Fontes gratuitas, em ordem. A BrasilAPI às vezes recusa IPs de nuvem (403/429) ou demora; nesses casos tenta a
 * minhareceita.org (mesmo formato) e depois a publica.cnpj.ws. 404 em uma fonte não encerra: só quando nenhuma achou.
 */
const FONTES: { nome: string; url: (c: string) => string; map: (j: Record<string, any>) => DadosCnpj }[] = [
  { nome: 'brasilapi', url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, map: mapearBrasilApi },
  { nome: 'minhareceita', url: (c) => `https://minhareceita.org/${c}`, map: mapearBrasilApi },
  { nome: 'cnpjws', url: (c) => `https://publica.cnpj.ws/cnpj/${c}`, map: mapearCnpjWs },
];
const HEADERS = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; MCKBOT/1.0; +https://mckbot.onrender.com/empresa)' };

export async function consultarCnpj(raw: string): Promise<DadosCnpj> {
  const cnpj = onlyDigits(raw);
  if (!isValidCnpj(cnpj)) throw new CnpjErro('CNPJ inválido', 400);
  let naoEncontrado = 0;
  for (const f of FONTES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await httpFetch(f.url(cnpj), { signal: ctrl.signal, headers: HEADERS });
      if (r.status === 404) { naoEncontrado++; continue; }
      if (!r.ok) { console.warn('[cnpj] fonte recusou', { fonte: f.nome, status: r.status }); continue; }
      const d = f.map((await r.json()) as Record<string, any>);
      if (d.nome) return { ...d, documento: d.documento || cnpj };
      console.warn('[cnpj] resposta sem razão social', { fonte: f.nome });
    } catch (e) {
      console.warn('[cnpj] fonte falhou', { fonte: f.nome, error: (e as Error).message });
    } finally { clearTimeout(t); }
  }
  if (naoEncontrado === FONTES.length) throw new CnpjErro('CNPJ não encontrado na Receita', 404);
  throw new CnpjErro('Consulta à Receita indisponível agora; preencha manualmente', 502);
}
