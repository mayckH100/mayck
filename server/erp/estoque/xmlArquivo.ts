/**
 * Leitura do ARQUIVO do XML da NF-e no navegador (v1.50.0), sem dependência e sem Node: a tela de Entrada por XML
 * importa este módulo (como já faz com server/erp/shared/*) e os testes unitários também.
 *
 * Por que existe: o arquivo era lido com `File.text()` (sempre UTF-8) e o seletor do celular filtrava por tipo.
 *  - XML em ISO-8859-1/Windows-1252 (muito comum em emissores antigos) virava "�" nos acentos;
 *  - XML salvo em UTF-16 (Bloco de Notas do Windows) virava texto com bytes nulos e a nota não era reconhecida;
 *  - XML compactado (.zip) enviado pelo fornecedor por e-mail/WhatsApp não era aceito.
 */

export type ArquivoXml = { nome: string; xml: string; encoding: string };
export class ArquivoXmlErro extends Error {}

const ini = (b: Uint8Array, ...sig: number[]) => sig.every((v, i) => b[i] === v);

/** Encoding declarado em <?xml ... encoding="..."?> (lido nos primeiros bytes como ASCII). */
export function encodingDeclarado(b: Uint8Array): string | null {
  let cab = '';
  for (let i = 0; i < Math.min(b.length, 300); i++) cab += String.fromCharCode(b[i]);
  const m = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i.exec(cab);
  return m ? m[1].toLowerCase() : null;
}

const LATIN = new Set(['iso-8859-1', 'iso8859-1', 'latin1', 'latin-1', 'windows-1252', 'cp1252', 'iso-8859-15']);

/** Bytes do arquivo → texto, respeitando BOM, UTF-16 e ISO-8859-1/Windows-1252. Remove BOM e bytes nulos. */
export function decodificarXml(b: Uint8Array): { texto: string; encoding: string } {
  let enc = 'utf-8';
  let corpo = b;
  if (ini(b, 0xef, 0xbb, 0xbf)) corpo = b.subarray(3);
  else if (ini(b, 0xff, 0xfe)) { enc = 'utf-16le'; corpo = b.subarray(2); }
  else if (ini(b, 0xfe, 0xff)) { enc = 'utf-16be'; corpo = b.subarray(2); }
  else if (b.length > 3 && b[0] === 0x3c && b[1] === 0) enc = 'utf-16le'; // "<\0?\0" sem BOM
  else if (b.length > 3 && b[0] === 0 && b[1] === 0x3c) enc = 'utf-16be';
  else {
    const decl = encodingDeclarado(b);
    if (decl && LATIN.has(decl)) enc = 'windows-1252';
  }
  let texto = new TextDecoder(enc).decode(corpo);
  // Declarou (ou não declarou) UTF-8 mas os bytes são Latin-1: o "�" aparece; relê como Windows-1252.
  if (enc === 'utf-8' && texto.includes('\uFFFD')) { texto = new TextDecoder('windows-1252').decode(corpo); enc = 'windows-1252'; }
  return { texto: limparXml(texto), encoding: enc };
}

/** BOM, bytes nulos e lixo antes do primeiro "<" (ex.: cabeçalho de e-mail colado) saem. */
export function limparXml(t: string): string {
  let s = t.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
  const i = s.indexOf('<');
  if (i > 0) s = s.slice(i);
  return s.trim();
}

/** Diz, sem ler a nota inteira, se o texto parece um XML (evita mandar PDF/imagem para o servidor). */
export const pareceXml = (t: string) => /^<(\?xml|[A-Za-z_][\w.:-]*)[\s>/]/.test(t.trimStart());

// ---------- ZIP (fornecedor que manda o XML compactado) ----------
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
export const ehZip = (b: Uint8Array) => ini(b, 0x50, 0x4b, 0x03, 0x04);

async function inflar(dados: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new ArquivoXmlErro('Este navegador não abre .zip: extraia o XML e envie o arquivo .xml');
  const stream = new Blob([dados as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Arquivos .xml de dentro de um .zip (lê o diretório central; aceita "stored" e "deflate"). */
export async function xmlsDoZip(b: Uint8Array): Promise<{ nome: string; bytes: Uint8Array }[]> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ArquivoXmlErro('Arquivo .zip danificado');
  const total = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out: { nome: string; bytes: Uint8Array }[] = [];
  for (let k = 0; k < total && p + 46 <= b.length; k++) {
    if (u32(b, p) !== 0x02014b50) break;
    const metodo = u16(b, p + 10); const comp = u32(b, p + 20);
    const nLen = u16(b, p + 28); const xLen = u16(b, p + 30); const cLen = u16(b, p + 32); const local = u32(b, p + 42);
    const nome = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nLen));
    p += 46 + nLen + xLen + cLen;
    if (!/\.xml$/i.test(nome) || nome.endsWith('/') || /(^|\/)__MACOSX\//.test(nome)) continue;
    if (u32(b, local) !== 0x04034b50) continue;
    const ini2 = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    const dados = b.subarray(ini2, ini2 + comp);
    if (metodo === 0) out.push({ nome, bytes: dados });
    else if (metodo === 8) out.push({ nome, bytes: await inflar(dados) });
  }
  return out;
}

/**
 * Um arquivo escolhido (bytes) → XMLs prontos para enviar. .zip vira os .xml de dentro.
 * Lança ArquivoXmlErro com mensagem para o cliente quando não é XML (PDF do DANFE, imagem, etc.).
 */
export async function lerArquivosXml(nome: string, b: Uint8Array): Promise<ArquivoXml[]> {
  if (!b.length) throw new ArquivoXmlErro(`${nome}: arquivo vazio`);
  if (ehZip(b)) {
    const xs = await xmlsDoZip(b);
    if (!xs.length) throw new ArquivoXmlErro(`${nome}: o .zip não tem nenhum arquivo .xml dentro`);
    return xs.map((x) => { const d = decodificarXml(x.bytes); return { nome: x.nome.split('/').pop() || x.nome, xml: d.texto, encoding: d.encoding }; });
  }
  if (ini(b, 0x25, 0x50, 0x44, 0x46)) throw new ArquivoXmlErro(`${nome}: é um PDF (o DANFE). Envie o arquivo .xml da nota, que o fornecedor manda junto com o PDF`);
  const d = decodificarXml(b);
  if (!pareceXml(d.texto)) throw new ArquivoXmlErro(`${nome}: não é um arquivo XML. Envie o .xml da NF-e (não o PDF nem a foto do DANFE)`);
  return [{ nome, xml: d.texto, encoding: d.encoding }];
}
