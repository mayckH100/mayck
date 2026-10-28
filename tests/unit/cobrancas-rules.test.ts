import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { detectarTipo, problemaSeguranca, nomeSeguro } from '../../server/mckmensagem/automacoes/arquivos.js';
import { extrair, identificar, textoDoPdf } from '../../server/mckmensagem/automacoes/comprovantes.js';
import { valorDevidoDe, renderMensagem, problemaRender } from '../../server/mckmensagem/automacoes/vars.js';
import { horariosReenvio } from '../../server/mckmensagem/automacoes/engine.js';
import type { Boleto, Cliente } from '@prisma/client';

const boleto = (o: Partial<Boleto> = {}): Boleto => ({
  id: 'b1', orgId: 'o', clienteId: 'c', descricao: 'Mensalidade', numeroDocumento: null, parcela: 1, totalParcelas: 3, valorCentavos: 10000, valorAtualizadoCentavos: null,
  jurosCentavos: 0, multaCentavos: 0, descontoCentavos: 0, valorPagoCentavos: 0, emissao: null, vencimento: new Date('2026-11-10T12:00:00Z'), codigoBarras: null, linhaDigitavel: null,
  linkPagamento: null, arquivoId: null, status: 'PENDENTE', statusEnvio: 'NAO_ENVIADO', enviadoEm: null, envios: 0, pagoEm: null, origemBaixa: null, observacoes: null, criadoPorId: null,
  createdAt: new Date(), updatedAt: new Date(), ...o,
});

describe('Arquivos: tipo real e segurança', () => {
  it('detecta pelo conteúdo, não pela extensão', () => {
    expect(detectarTipo(Buffer.from('%PDF-1.7 ...'), 'x.png')).toBe('pdf');
    expect(detectarTipo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), 'a.pdf')).toBe('png');
    expect(detectarTipo(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'a.jpeg')).toBe('jpg');
    expect(detectarTipo(Buffer.from('RIFF0000WEBPVP8 '), 'a')).toBe('webp');
    expect(detectarTipo(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x41]), 'a.zip')).toBeNull();
    expect(detectarTipo(Buffer.from('a,b\n1,2'), 'l.csv')).toBe('csv');
    expect(detectarTipo(Buffer.from('MZ\x90\x00'), 'a.pdf')).toBeNull();
  });
  it('recusa executável, PDF com JavaScript e documento com macro', () => {
    expect(problemaSeguranca(Buffer.from('%PDF-1.4 /JavaScript'), 'pdf')).toMatch(/conteúdo ativo/);
    expect(problemaSeguranca(Buffer.from('%PDF-1.4 /Launch'), 'pdf')).toMatch(/conteúdo ativo/);
    expect(problemaSeguranca(Buffer.from('PK\x03\x04 word/vbaProject.bin'), 'docx')).toMatch(/macros/);
    expect(problemaSeguranca(Buffer.from('%PDF-1.4 texto normal'), 'pdf')).toBeNull();
  });
  it('nome seguro, sem caminho e com a extensão real', () => {
    expect(nomeSeguro('../../etc/passwd', 'pdf')).toBe('passwd.pdf');
    expect(nomeSeguro('C:\\boletos\\nov "1".pdf', 'pdf')).toBe('nov 1.pdf');
    expect(nomeSeguro('foto.jpeg', 'jpg')).toBe('foto.jpeg');
  });
});

describe('Comprovantes: extração e identificação', () => {
  it('extrai valor, data, id da transação (E2E Pix) e instituição', () => {
    const e = extrair('Comprovante de transferência Pix - Banco Inter\nValor: R$ 1.234,56\nData 28/10/2026\nID: E00416968202610281530abcdefghiJK');
    expect(e.valores).toEqual([123456]);
    expect(e.datas).toEqual(['2026-10-28']);
    expect(e.transacaoId).toBe('E00416968202610281530abcdefghiJK');
    expect(e.instituicao).toBe('Inter');
    expect(e.palavraChave).toBe(true);
  });
  it('lê texto de PDF comprimido (FlateDecode) e sem compressão', () => {
    const conteudo = 'BT (Pagamento R$ 150,00) Tj [(Auten) 12 (ticacao: XYZ12345)] TJ ET';
    const mk = (z: boolean) => Buffer.concat([Buffer.from('%PDF-1.4\n<<>>\nstream\n'), z ? deflateSync(Buffer.from(conteudo)) : Buffer.from(conteudo), Buffer.from('\nendstream\n%%EOF')]);
    for (const z of [true, false]) {
      const t = textoDoPdf(mk(z));
      expect(t).toContain('Pagamento R$ 150,00');
      expect(t).toContain('Autenticacao: XYZ12345');
    }
  });
  it('identifica a parcela pelo valor ou pela linha digitável; inconclusivo quando nada confere', () => {
    const b1 = boleto({ id: 'b1', valorCentavos: 15000, vencimento: new Date('2026-11-10T12:00:00Z') });
    const b2 = boleto({ id: 'b2', valorCentavos: 20000, parcela: 2, linhaDigitavel: '23790.12345 60000.000000 00000.000000 1 99990000020000' });
    const porValor = identificar(extrair('Pix R$ 150,00'), [b1, b2], true);
    expect(porValor.boleto?.id).toBe('b1');
    expect(porValor.confianca).toBeGreaterThanOrEqual(60);
    const porLinha = identificar(extrair('Pagamento de boleto. Linha: 23790 12345 60000 000000 00000 000000 1 99990000020000'), [b1, b2], true);
    expect(porLinha.boleto?.id).toBe('b2');
    const nada = identificar(extrair('R$ 9,99'), [b1, b2], true);
    expect(nada.boleto).toBeNull();
    expect(nada.motivos.join(' ')).toMatch(/inconclusivo/);
    const semCliente = identificar(extrair('R$ 150,00'), [], false);
    expect(semCliente.confianca).toBe(0);
  });
});

describe('Valores e variáveis do boleto', () => {
  it('valor devido = atualizado (ou original) + juros + multa − desconto', () => {
    expect(valorDevidoDe(boleto({ valorCentavos: 10000, jurosCentavos: 150, multaCentavos: 200, descontoCentavos: 50 }))).toBe(10300);
    expect(valorDevidoDe(boleto({ valorCentavos: 10000, valorAtualizadoCentavos: 12000 }))).toBe(12000);
  });
  it('variáveis de boleto exigem boleto vinculado; com boleto usam os dados da parcela', () => {
    const c = { nome: 'Ana Lima', parcelas: 10, valorCentavos: 100000 } as Cliente;
    const sem = renderMensagem('Parcela {{numero_parcela}}', c);
    expect(problemaRender(sem)).toMatch(/boleto vinculado/);
    const com = renderMensagem('{{primeiro_nome}}: parcela {{numero_parcela}}/{{total_parcelas}} de {{valor_parcela}}, saldo {{valor_pendente}}, vence {{data_vencimento}}', c, 'America/Sao_Paulo',
      { boleto: boleto({ valorPagoCentavos: 4000 }) });
    expect(problemaRender(com)).toBeNull();
    expect(com.texto).toBe('Ana: parcela 1/3 de R$ 100,00, saldo R$ 60,00, vence 10/11/2026');
  });
  it('reenvios relativos ao vencimento no fuso da automação', () => {
    const hs = horariosReenvio(boleto(), { offsets: [3, -1, 0], horario: '10:00', maxPorBoleto: 3 }, 'America/Sao_Paulo');
    expect(hs.map((d) => d.toISOString())).toEqual(['2026-11-09T13:00:00.000Z', '2026-11-10T13:00:00.000Z', '2026-11-13T13:00:00.000Z']);
  });
});
