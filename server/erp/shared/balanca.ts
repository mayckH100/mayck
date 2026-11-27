/**
 * Balança (v1.58.0), sem depender de marca:
 *  1. Etiqueta da balança (EAN-13 que começa com 2): 2 + código do produto (4, 5 ou 6 dígitos) + valor (6 ou 5 dígitos) + verificador.
 *     O valor é o preço total (centavos) ou o peso (gramas), conforme a configuração da loja. Padrão de Toledo, Filizola,
 *     Urano, Elgin e demais balanças etiquetadoras.
 *  2. Peso lido da balança ligada ao computador (serial/USB): `pesoDaBalanca` entende as respostas mais comuns
 *     (Toledo/Prix, Filizola, Urano, Elgin e as que mandam "1,250 kg" ou "01250").
 * Usado no servidor e na tela (sem dependências).
 */
export type ValorEtiqueta = 'PRECO' | 'PESO';
export interface EtiquetaBalanca { codigoProduto: string; valor: number; tipoValor: ValorEtiqueta }

export function eanValido(c: string): boolean {
  if (!/^\d{13}$/.test(c)) return false;
  const soma = [...c.slice(0, 12)].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === Number(c[12]);
}

/** Lê a etiqueta da balança. `digitos` = tamanho do código do produto (4, 5 ou 6). */
export function lerEtiquetaBalanca(codigo: string, digitos = 4, tipoValor: ValorEtiqueta = 'PRECO'): EtiquetaBalanca | null {
  const c = (codigo ?? '').replace(/\s+/g, '');
  if (!c.startsWith('2') || !eanValido(c)) return null;
  const d = [4, 5, 6].includes(digitos) ? digitos : 4;
  const codigoProduto = c.slice(1, 1 + d);
  // Layout: 2 CCCC 0 VVVVVV D (4 dígitos + 1 de preenchimento) · 2 CCCCC VVVVVV D · 2 CCCCCC VVVVV D.
  const valor = Number(c.slice(d === 6 ? 7 : 6, 12));
  if (!Number(codigoProduto) && codigoProduto !== '0000') return null;
  return { codigoProduto, valor, tipoValor };
}

/** Variações do código da etiqueta para achar o produto (com e sem zeros à esquerda). */
export function variantesCodigoBalanca(cod: string): string[] {
  const sem = cod.replace(/^0+/, '') || '0';
  return [...new Set([cod, sem, sem.padStart(4, '0'), sem.padStart(5, '0'), sem.padStart(6, '0')])];
}

/** Quantidade em milésimos (kg × 1000 = gramas) a partir da etiqueta. */
export function qtdMilDaEtiqueta(e: EtiquetaBalanca, precoKgCents: number): number {
  if (e.tipoValor === 'PESO') return e.valor;
  if (!precoKgCents) return 0;
  return Math.round((e.valor * 1000) / precoKgCents);
}

export type LeituraPeso = { ok: true; gramas: number } | { ok: false; erro: string };

/**
 * Peso enviado pela balança. Aceita:
 *  - "1.250", "1,250 kg", "ST,GS,+  1.250kg" (número com casa decimal = quilos);
 *  - "01250" (5 ou 6 dígitos sem vírgula = gramas, como Toledo/Prix e Filizola);
 *  - "IIIII" (instável), "NNNNN" (negativo), "SSSSS" (sobrecarga) → erro.
 * Considera a última leitura completa do texto.
 */
export function pesoDaBalanca(texto: string): LeituraPeso {
  const t = (texto ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ');
  const ultimo = (re: RegExp) => { let m: RegExpExecArray | null; let u: RegExpExecArray | null = null; while ((m = re.exec(t))) u = m; return u; };
  const fim = t.trim().split(/\s{2,}|\s(?=\S*$)/).pop() ?? '';
  if (/I{3,}/.test(fim) || /\bUS\b|instav/i.test(fim)) return { ok: false, erro: 'Peso instável: espere a balança parar' };
  if (/N{3,}|^-|\s-\s*\d/.test(fim)) return { ok: false, erro: 'Peso negativo: zere a balança (tara)' };
  if (/S{3,}|\bOL\b/.test(fim)) return { ok: false, erro: 'Peso acima do limite da balança' };
  const dec = ultimo(/([+-]?)\s*(\d{1,4})[.,](\d{1,3})\s*(kg|g)?/gi);
  if (dec) {
    if (dec[1] === '-') return { ok: false, erro: 'Peso negativo: zere a balança (tara)' };
    const n = Number(`${dec[2]}.${dec[3]}`);
    return { ok: true, gramas: Math.round((dec[4]?.toLowerCase() === 'g' ? n : n * 1000)) };
  }
  const int = ultimo(/(\d{5,6})/g);
  if (int) return { ok: true, gramas: Number(int[1]) };
  if (/I{2,}/.test(t)) return { ok: false, erro: 'Peso instável: espere a balança parar' };
  return { ok: false, erro: 'A balança não mandou um peso. Confira o cabo e a velocidade (baud).' };
}
