/**
 * Unidade de medida dos produtos (v1.31.0) — regra pura, usada pelo servidor e pela web.
 *
 * Por que existe: o campo "Unidade" era texto livre. Um produto salvo com unidade "30" fazia o alerta do WhatsApp
 * mostrar "Saldo: 5 30", que o WhatsApp sublinha como se fosse telefone. Agora:
 *  - no cadastro só entram siglas com letra (UN, CX, KG...); número puro é recusado com mensagem clara;
 *  - na leitura, unidade numérica/vazia/estranha vira "UN" (mostrada como "unidade(s)").
 */

/** Siglas conhecidas → [singular, plural] por extenso. */
export const UNIDADES: Record<string, [string, string]> = {
  UN: ['unidade', 'unidades'], UND: ['unidade', 'unidades'], UNID: ['unidade', 'unidades'], U: ['unidade', 'unidades'],
  PC: ['peça', 'peças'], 'PÇ': ['peça', 'peças'], PCS: ['peça', 'peças'], CX: ['caixa', 'caixas'], PCT: ['pacote', 'pacotes'], PT: ['pacote', 'pacotes'],
  FD: ['fardo', 'fardos'], DZ: ['dúzia', 'dúzias'], PAR: ['par', 'pares'], RL: ['rolo', 'rolos'], SC: ['saco', 'sacos'], GL: ['galão', 'galões'],
  FR: ['frasco', 'frascos'], TB: ['tubo', 'tubos'], LATA: ['lata', 'latas'], LT: ['litro', 'litros'], L: ['litro', 'litros'], ML: ['ml', 'ml'],
  KG: ['kg', 'kg'], G: ['g', 'g'], GR: ['g', 'g'], MG: ['mg', 'mg'], TON: ['tonelada', 'toneladas'], M: ['metro', 'metros'], MT: ['metro', 'metros'],
  CM: ['cm', 'cm'], M2: ['m²', 'm²'], M3: ['m³', 'm³'], KIT: ['kit', 'kits'], CJ: ['conjunto', 'conjuntos'], FL: ['folha', 'folhas'], BL: ['bloco', 'blocos'],
  CT: ['cartela', 'cartelas'], GF: ['garrafa', 'garrafas'], BD: ['balde', 'baldes'], BOB: ['bobina', 'bobinas'], RESMA: ['resma', 'resmas'], SACHE: ['sachê', 'sachês'],
};

/** Opções do cadastro (as mais usadas primeiro). */
export const UNIDADES_CADASTRO: { sigla: string; nome: string }[] = [
  ['UN', 'Unidade'], ['CX', 'Caixa'], ['PCT', 'Pacote'], ['PC', 'Peça'], ['KG', 'Quilo (kg)'], ['G', 'Grama (g)'], ['L', 'Litro'], ['ML', 'Mililitro (ml)'],
  ['M', 'Metro'], ['M2', 'Metro quadrado (m²)'], ['M3', 'Metro cúbico (m³)'], ['DZ', 'Dúzia'], ['PAR', 'Par'], ['FD', 'Fardo'], ['RL', 'Rolo'], ['SC', 'Saco'],
  ['FR', 'Frasco'], ['LATA', 'Lata'], ['GF', 'Garrafa'], ['KIT', 'Kit'], ['CJ', 'Conjunto'], ['FL', 'Folha'], ['TON', 'Tonelada'],
].map(([sigla, nome]) => ({ sigla, nome }));

/** Sigla válida: 1 a 6 caracteres, começa por letra e não é número puro (aceita M2, M3, PÇ). */
export const unidadeValida = (u: string | null | undefined) => !!u && /^[A-ZÇ][A-ZÇ0-9]{0,5}$/.test(u.trim().toUpperCase());

/** Sigla para mostrar/usar: a salva, em maiúsculas, ou "UN" quando é número, vazia ou estranha. */
export function unidadeLegivel(u: string | null | undefined): string {
  const s = (u ?? '').trim().toUpperCase();
  return unidadeValida(s) ? s : 'UN';
}

/** Nome por extenso conforme a quantidade ("1 unidade", "15 unidades", "2,5 kg"). Sigla desconhecida fica em minúsculas. */
export function nomeUnidade(u: string | null | undefined, quantidade: number): string {
  const s = unidadeLegivel(u);
  const par = UNIDADES[s];
  if (!par) return s.toLowerCase();
  // Português: singular de 1 até menos de 2 ("1 unidade", "1,5 unidade"); 0 e 2+ no plural.
  return quantidade !== 0 && Math.abs(quantidade) < 2 ? par[0] : par[1];
}

/** Quantidade em milésimos → número em português (até 3 casas). */
export const numeroQtd = (mil: number) => (mil / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/** "15 unidades", "1 caixa", "2,5 kg" — sempre número + unidade em palavra (o WhatsApp não confunde com telefone). */
export function qtdUn(mil: number, u: string | null | undefined): string {
  return `${numeroQtd(mil)} ${nomeUnidade(u, mil / 1000)}`;
}
