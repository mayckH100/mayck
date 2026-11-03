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

export async function consultarCnpj(raw: string): Promise<DadosCnpj> {
  const cnpj = onlyDigits(raw);
  if (!isValidCnpj(cnpj)) throw new CnpjErro('CNPJ inválido', 400);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await httpFetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (r.status === 404) throw new CnpjErro('CNPJ não encontrado na Receita', 404);
    if (!r.ok) throw new CnpjErro('Consulta à Receita indisponível agora; preencha manualmente', 502);
    return mapearBrasilApi((await r.json()) as Record<string, any>);
  } catch (e) {
    if (e instanceof CnpjErro) throw e;
    throw new CnpjErro('Consulta à Receita indisponível agora; preencha manualmente', 502);
  } finally { clearTimeout(t); }
}
