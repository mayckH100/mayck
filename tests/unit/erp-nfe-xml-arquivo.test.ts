import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { decodificarXml, lerArquivosXml, pareceXml, ArquivoXmlErro } from '../../server/erp/estoque/xmlArquivo';
import { lerNfe, NfeXmlErro } from '../../server/erp/estoque/nfe-xml';
import { real } from '../fixtures/nfe-real';

/**
 * v1.50.0 — "não estou conseguindo dar entrada através do XML" (dono, 23/11). Produção não tinha NENHUMA NF-e
 * importada: a falha era antes do servidor (seletor do Android filtrando o tipo, arquivo lido sempre como UTF-8)
 * e em variações de XML que o leitor recusava. Estes testes cobrem cada uma.
 */
const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));
const utf16le = (s: string, bom = true) => Uint8Array.from(Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')]));

function zip(arquivos: { nome: string; texto: string; deflate?: boolean }[]) {
  const partes: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const a of arquivos) {
    const raw = Buffer.from(a.texto, 'utf8'); const dados = a.deflate === false ? raw : deflateRawSync(raw); const nome = Buffer.from(a.nome);
    const metodo = a.deflate === false ? 0 : 8; const crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(metodo, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(dados.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nome.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(metodo, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(dados.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nome.length, 28); ch.writeUInt32LE(off, 42);
    partes.push(lh, nome, dados); central.push(ch, nome); off += 30 + nome.length + dados.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(arquivos.length, 8); eocd.writeUInt16LE(arquivos.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Uint8Array.from(Buffer.concat([...partes, cd, eocd]));
}

describe('NF-e XML · leitura do arquivo (celular/encoding/zip)', () => {
  it('o botão de importar não filtra o tipo do arquivo (no Android o filtro deixava o XML cinza)', () => {
    const src = readFileSync('web/src/erp/estoque/EntradaXml.tsx', 'utf8');
    const input = /<input type="file"[^>]*>/.exec(src)![0];
    expect(input).not.toMatch(/accept=/);
    expect(src).not.toMatch(/await f\.text\(\)/); // lia sempre como UTF-8
  });
  it('UTF-8 com BOM', () => {
    const d = decodificarXml(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('<?xml version="1.0"?><a>Ação</a>')]));
    expect(d.texto).toBe('<?xml version="1.0"?><a>Ação</a>');
  });
  it('ISO-8859-1 declarado e Latin-1 sem declaração mantêm os acentos', () => {
    expect(decodificarXml(latin1('<?xml version="1.0" encoding="ISO-8859-1"?><xNome>LATICÍNIOS SÃO JOÃO</xNome>')).texto).toContain('LATICÍNIOS SÃO JOÃO');
    const semDecl = decodificarXml(latin1('<xNome>PAPELARIA AÇÃO</xNome>'));
    expect(semDecl.texto).toBe('<xNome>PAPELARIA AÇÃO</xNome>');
    expect(semDecl.encoding).toBe('windows-1252');
  });
  it('UTF-16 (com e sem BOM) vira texto normal, sem bytes nulos', () => {
    for (const bom of [true, false]) {
      const d = decodificarXml(utf16le(real({ proc: true }), bom));
      expect(d.texto.includes('\u0000')).toBe(false);
      expect(lerNfe(d.texto).itens).toHaveLength(3);
    }
  });
  it('NF-e real em ISO-8859-1 é lida com o nome do item acentuado', async () => {
    const x = real({ proc: true }).replace('encoding="UTF-8"', 'encoding="ISO-8859-1"');
    const [a] = await lerArquivosXml('nota.xml', latin1(x));
    expect(lerNfe(a.xml).itens[2].descricao).toBe('GRAMPEADOR METAL 26/6 - AÇÃO RÁPIDA');
  });
  it('.zip com o XML dentro (deflate e sem compressão); ignora o PDF', async () => {
    const z = zip([{ nome: 'DANFE.pdf', texto: '%PDF-1.4' }, { nome: 'notas/NFe3525.xml', texto: real({ proc: true }) }, { nome: 'outra.XML', texto: real({ proc: true, chave: '35251112345678000195550010000456791123456780' }), deflate: false }]);
    const xs = await lerArquivosXml('notas.zip', z);
    expect(xs.map((x) => x.nome)).toEqual(['NFe3525.xml', 'outra.XML']);
    expect(xs.map((x) => lerNfe(x.xml).chave.slice(-4))).toEqual(['6789', '6780']);
  });
  it('PDF do DANFE, imagem e arquivo vazio dão mensagem clara', async () => {
    await expect(lerArquivosXml('danfe.pdf', Uint8Array.from(Buffer.from('%PDF-1.7 ...')))).rejects.toThrow(/PDF/);
    await expect(lerArquivosXml('foto.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).rejects.toThrow(ArquivoXmlErro);
    await expect(lerArquivosXml('vazio.xml', new Uint8Array())).rejects.toThrow(/vazio/);
    expect(pareceXml('  <nfeProc>')).toBe(true);
  });
});

describe('NF-e XML · variações do arquivo da nota', () => {
  const itens = (x: string) => lerNfe(x).itens.map((i) => [i.nItem, i.codigo, i.ean, i.cfop, i.unidade, i.qtdMil]);
  const esperado = [[1, '7891', '7891234567895', '5102', 'CX', 2000], [2, 'A4-500', null, '5405', 'PCT', 10000], [3, 'GRAMP', null, '6102', 'UN', 1500]];
  it('nfeProc com namespace, sem nfeProc, sem namespace, com prefixo, com CRLF e com BOM', () => {
    for (const x of [real({ proc: true }), real({}), real({ ns: false, proc: true }), real({ proc: true, prefixo: 'nfe' }), real({ proc: true, quebra: true }), '\uFEFF' + real({ proc: true })]) expect(itens(x)).toEqual(esperado);
    expect(lerNfe(real({ proc: true })).autorizada).toBe(true);
    expect(lerNfe(real({})).autorizada).toBe(false);
  });
  it('atributos com aspas simples (Id e nItem) — antes: "não é um XML de NF-e"', () => {
    expect(itens(real({ proc: true, aspas: "'" }))).toEqual(esperado);
  });
  it('bytes nulos e lixo antes do XML não atrapalham', () => {
    const x = 'Content-Type: text/xml\r\n\r\n' + real({ proc: true }).replace('<nfeProc', '\u0000<nfeProc');
    expect(itens(x)).toEqual(esperado);
  });
  it('entidades numéricas e CDATA no nome', () => {
    const x = real({ proc: true }).replace('DISTRIBUIDORA EXEMPLO DE PAPELARIA LTDA', 'DISTRIBUIDORA S&#195;O PAULO &amp; CIA').replace('CANETA ESFEROGRAFICA AZUL CX 50', '<![CDATA[CANETA "AZUL" <CX 50>]]>');
    const n = lerNfe(x);
    expect(n.emitente.nome).toBe('DISTRIBUIDORA SÃO PAULO & CIA');
    expect(n.itens[0].descricao).toBe('CANETA "AZUL" <CX 50>');
  });
  it('NFC-e (modelo 65, cupom de loja) agora é aceita', () => {
    const n = lerNfe(real({ proc: true, mod: '65' }));
    expect(n.modelo).toBe('65');
    expect(n.itens).toHaveLength(3);
  });
  it('resumo, evento, CT-e e NFS-e explicam o que é o arquivo', () => {
    const erro = (x: string) => { try { lerNfe(x); return ''; } catch (e) { expect(e).toBeInstanceOf(NfeXmlErro); return (e as Error).message; } };
    expect(erro('<?xml version="1.0"?><resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>35251112345678000195550010000456781123456789</chNFe><CNPJ>12345678000195</CNPJ></resNFe>')).toMatch(/RESUMO/);
    expect(erro('<?xml version="1.0"?><procEventoNFe versao="1.00"><evento><infEvento Id="ID1101113525"><tpEvento>110111</tpEvento></infEvento></evento></procEventoNFe>')).toMatch(/EVENTO/);
    expect(erro('<cteProc xmlns="http://www.portalfiscal.inf.br/cte"><CTe><infCte Id="CTe3525"></infCte></CTe></cteProc>')).toMatch(/CT-e/);
    expect(erro('<CompNfse><Nfse><InfNfse><Numero>1</Numero></InfNfse></Nfse></CompNfse>')).toMatch(/NFS-e/);
    expect(erro('<qualquer><coisa/></qualquer>')).toMatch(/infNFe não encontrado/);
  });
  it('itens sem nItem recebem a posição na nota', () => {
    const x = real({ proc: true }).replace(/ nItem="\d+"/g, '');
    expect(lerNfe(x).itens.map((i) => i.nItem)).toEqual([1, 2, 3]);
  });
});
