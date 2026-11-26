import { describe, it, expect } from 'vitest';
import { cabecalhoHtml, paginaHtml, cssDocumento } from '../../web/src/erp/impressao/modelo';
import { htmlTabela, htmlFicha, htmlDeCsv, lerCsv, orientacaoPara, linhaFiltros } from '../../web/src/erp/impressao/listas';
import { listaParceiros, fichaParceiro, listaPedidos, relatorioBi } from '../../web/src/erp/impressao/cadastros';
import { listaSaldos } from '../../web/src/erp/impressao/estoque';
import { RODAPE_DOCUMENTO, posicaoLogoValida } from '../../server/erp/shared/documento';

/**
 * v1.55.0 — dono (26/11): "tudo que tenha exportar também tem a opção exportar via PDF ... bem profissional: no centro
 * da folha ... ou no canto esquerdo superior o logo e embaixo com letras pequenas as informações que cadastrou."
 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const agora = new Date('2026-11-26T14:05:00Z'); // 11:05 em São Paulo
const XSS = '<script>alert(1)</script>';
const CFG = { nomeExibicao: 'Loja Exemplo', cnpj: '12345678000195', ie: '123', logradouro: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'Osasco', uf: 'SP', cep: '06000000', telefone: '1133334444', whatsapp: '11999990000', email: 'a@b.com', site: 'loja.com.br', textoLivre: '', logo: PNG };
const pagina = (d: any, cfg: any = CFG) => paginaHtml({ ...d, config: cfg });

describe('cabeçalho profissional: logo à esquerda ou no centro (v1.55.0)', () => {
  it('Esquerda (padrão): logo no canto, dados embaixo em letra pequena, título e número/data à direita na mesma faixa', () => {
    const h = cabecalhoHtml(CFG, 'a4', '', { titulo: 'Pedido de venda nº 12', subtitulo: '26/11/2026 10:30' });
    expect(h).toContain('class="mck-cab mck-cab-a4 mck-cab-esq"');
    // ordem: bloco da empresa (logo, depois dados) e só então a faixa do documento
    const iLogo = h.indexOf('<img class="mck-logo"'); const iNome = h.indexOf('mck-cab-nome'); const iDoc = h.indexOf('mck-cab-doc');
    expect(iLogo).toBeGreaterThan(-1); expect(iNome).toBeGreaterThan(iLogo); expect(iDoc).toBeGreaterThan(iNome);
    expect(h).toContain('<div class="mck-cab-titulo">Pedido de venda nº 12</div><div class="mck-cab-sub">26/11/2026 10:30</div>');
    expect(h).toContain('CNPJ 12.345.678/0001-95 · IE 123');
    expect(h).toContain('Tel. 1133334444 · WhatsApp 11999990000 · a@b.com · loja.com.br');
    // sem posição salva → Esquerda; valor estranho também cai na Esquerda
    expect(posicaoLogoValida(undefined)).toBe('ESQUERDA');
    expect(posicaoLogoValida('<b>')).toBe('ESQUERDA');
    expect(cabecalhoHtml({ ...CFG, posicaoLogo: 'xx' as any }, 'a4')).toContain('mck-cab-esq');
    const css = cssDocumento('a4');
    expect(css).toContain('.mck-cab-esq .mck-logo{max-height:18mm');
    expect(css).toContain('.mck-cab-dados{font-size:8.5pt');
    expect(css).toContain('.mck-cab-nome{font-size:10pt;font-weight:bold');
    expect(css).toContain('.mck-cab-esq .mck-cab-doc{text-align:right');
    expect(css).toContain('border-bottom:.6pt solid');
  });

  it('Centro: logo e dados centralizados e o título centralizado abaixo', () => {
    const h = cabecalhoHtml({ ...CFG, posicaoLogo: 'CENTRO' }, 'a4', '', { titulo: 'Lista de clientes' });
    expect(h).toContain('mck-cab-centro');
    expect(h).not.toContain('mck-cab-esq');
    expect(h.indexOf('mck-cab-titulo')).toBeGreaterThan(h.indexOf('mck-cab-dados'));
    expect(cssDocumento('a4')).toContain('.mck-cab-centro{text-align:center}');
  });

  it('sem logo: só o texto no mesmo estilo; recibo 80 mm sempre centralizado e sem a faixa do título', () => {
    const h = cabecalhoHtml({ ...CFG, logo: null }, 'a4', '', { titulo: 'X' });
    expect(h).not.toContain('<img');
    expect(h).toContain('mck-cab-esq'); expect(h).toContain('Loja Exemplo');
    const r = cabecalhoHtml({ ...CFG, posicaoLogo: 'ESQUERDA' }, 'recibo', '', { titulo: 'Recibo nº 1' });
    expect(r).toContain('mck-cab-recibo mck-cab-centro');
    expect(r).not.toContain('mck-cab-titulo');
  });

  it('campos vazios não deixam separador sobrando', () => {
    const h = cabecalhoHtml({ nomeExibicao: 'Só Nome', cnpj: '', ie: '7', telefone: '', whatsapp: '', email: 'x@y.com', site: '', logradouro: '', numero: '', bairro: '', cidade: 'Osasco', uf: '', cep: '' }, 'a4');
    expect(h).toContain('<div>IE 7</div>');
    expect(h).toContain('<div>Osasco</div>');
    expect(h).toContain('<div>x@y.com</div>');
    expect(h).not.toMatch(/· ·|>\s*·|·\s*</);
    expect(cabecalhoHtml({}, 'a4')).toBe('');
  });

  it('tudo escapado: nome, título e subtítulo maliciosos', () => {
    const h = cabecalhoHtml({ ...CFG, nomeExibicao: XSS }, 'a4', '', { titulo: XSS, subtitulo: '"><img src=x onerror=1>' });
    expect(h).not.toContain('<script>'); expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;script&gt;');
  });
});

describe('Exportar PDF e Imprimir / PDF de listas e fichas (v1.55.0)', () => {
  it('lista: título, filtros, data de geração, tabela com thead, rodapé fixo e escape', () => {
    const d = htmlTabela({ titulo: 'Lista de clientes', filtros: ['Busca: “ana”', ''], colunas: [{ titulo: 'Nome', valor: (x: any) => x.n }, { titulo: 'Valor', valor: (x: any) => x.v, dir: true }], linhas: [{ n: XSS, v: 'R$ 1,00' }, { n: 'Ana', v: '' }] }, agora);
    expect(d.titulo).toBe('Lista de clientes');
    expect(d.subtitulo).toBe('Busca: “ana” · 2 registro(s) · Gerado em 26/11/2026 11:05');
    expect(d.orientacao).toBe('retrato');
    const h = pagina(d);
    expect(h).toContain('<thead><tr><th>Nome</th><th class="dir">Valor</th></tr></thead>');
    expect(h).toContain('<td>—</td>'.replace('<td>', '<td class="dir">')); // vazio vira traço
    expect(h).toContain('thead{display:table-header-group}');
    expect(h).toContain(RODAPE_DOCUMENTO);
    expect(h).not.toContain('<script>'); expect(h).toContain('&lt;script&gt;');
    expect(htmlTabela({ titulo: 't', colunas: [{ titulo: 'a', valor: () => 1 }], linhas: [] }).corpo).toContain('Nada para mostrar');
  });

  it('tabela larga sai em paisagem e com letra menor', () => {
    expect(orientacaoPara(7)).toBe('retrato'); expect(orientacaoPara(8)).toBe('paisagem');
    const d = listaSaldos([{ produto: { sku: '1', nome: 'P' }, lote: { numero: 'L1', status: 'LIBERADO' }, endereco: { deposito: 'D', codigo: 'A1' }, fisicoMil: 2000, reservadoMil: 0, disponivelMil: 2000 }], { deposito: 'Central' });
    expect(d.orientacao).toBe('paisagem');
    const h = pagina(d);
    expect(h).toContain('@page{size:A4 landscape');
    expect(h).toContain('body{font-size:10px');
    expect(h).toContain('Central');
  });

  it('ficha: só campos preenchidos, observações e tabelas; nada de outra empresa entra (só o objeto passado)', () => {
    const d = fichaParceiro({ nome: 'Fornecedor X LTDA', fantasia: 'Forn X', documento: '12345678000195', ehFornecedor: true, ehCliente: false, email: XSS, telefone: '', status: 'ATIVO', prazoEntregaDias: 5, contatos: [{ nome: 'Bia', principal: true, cargo: 'Compras', email: 'b@x.com' }], oportunidades: [], observacoes: 'linha 1\nlinha 2' }, agora);
    expect(d.titulo).toBe('Ficha do fornecedor · Forn X');
    const h = pagina(d);
    expect(h).toContain('<th>Razão social / nome</th><td>Fornecedor X LTDA</td>');
    expect(h).toContain('12.345.678/0001-95');
    expect(h).toContain('5 dia(s)');
    expect(h).not.toContain('<th>Telefone / WhatsApp</th>');
    expect(h).toContain('Bia (principal)');
    expect(h).toContain('linha 1<br>linha 2');
    expect(h).not.toContain('<script>');
    expect(h).not.toContain('Oportunidades');
  });

  it('listas de cadastro e operação carregam o filtro atual', () => {
    const c = listaParceiros([{ nome: 'A', documento: '11144477735', municipio: 'Osasco', uf: 'SP', status: 'BLOQUEADO' }], 'cliente', 'osa', 10);
    expect(c.subtitulo).toContain('Busca: “osa”'); expect(c.subtitulo).toContain('mostrando 1 de 10');
    expect(pagina(c)).toContain('111.444.777-35'); expect(pagina(c)).toContain('Bloqueado');
    const p = listaPedidos([{ numero: 3, parceiro: { nome: 'Cli' }, statusOperacional: 'RASCUNHO', totalCents: 1500 }], 'Orçamentos', { RASCUNHO: 'Orçamento' });
    expect(p.subtitulo).toContain('Filtro: Orçamentos');
    expect(pagina(p)).toContain('Total R$');
    const b = relatorioBi({ vendas: { receitaCents: 100, curvaAbc: [], topClientes: [] }, estoque: {}, financeiro: {}, compras: {}, producao: {}, crm: {} }, { de: '2026-11-01', ate: '2026-11-26' });
    expect(b.subtitulo).toContain('Período: 01/11/2026 a 26/11/2026');
  });

  it('PDF do export: mesmo conteúdo do CSV (blocos, cabeçalho, aspas, anti-fórmula), filtros, data e rodapé', () => {
    const csv = '\uFEFFRelatório do dia;2026-11-25\r\nEmpresa;"Loja; Exemplo"\r\n\r\nForma;Recebido;Pago\r\nPIX;10,00;0,00\r\n"Di""nheiro";\'=1+1;<b>x</b>\r\n';
    expect(lerCsv(csv)[1]).toEqual(['Empresa', 'Loja; Exemplo']);
    const d = htmlDeCsv({ titulo: 'Relatório do dia', filtros: ['Dia 25/11/2026'], csv }, agora);
    expect(d.subtitulo).toBe('Dia 25/11/2026 · 2 registro(s) · Gerado em 26/11/2026 11:05');
    const h = pagina(d, { ...CFG, posicaoLogo: 'CENTRO' });
    expect(h).toContain('<th>Empresa</th><td>Loja; Exemplo</td>');
    expect(h).toContain('<thead><tr><th>Forma</th><th>Recebido</th><th>Pago</th></tr></thead>');
    expect(h).toContain('<td>Di&quot;nheiro</td><td>=1+1</td><td>&lt;b&gt;x&lt;/b&gt;</td>');
    expect(h).toContain('mck-cab-centro');
    expect(h).toContain(RODAPE_DOCUMENTO);
    // CSV largo (muitas colunas) → paisagem
    const largo = htmlDeCsv({ titulo: 'Inventário', csv: `${Array.from({ length: 12 }, (_, i) => `C${i}`).join(';')}\n${Array.from({ length: 12 }, () => 'x').join(';')}` });
    expect(largo.orientacao).toBe('paisagem');
    expect(htmlDeCsv({ titulo: 'Vazio', csv: '' }).corpo).toContain('veio vazio');
  });

  it('linha de filtros ignora vazios e sempre termina com a data de geração em São Paulo', () => {
    expect(linhaFiltros(['', null, 'A', false, ' B '], agora)).toBe('A · B · Gerado em 26/11/2026 11:05');
  });
});
