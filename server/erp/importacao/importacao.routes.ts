/**
 * Importar e exportar planilhas (CSV) do ERP: clientes, fornecedores e produtos.
 * Modelo para download com cabeçalho e exemplos; separador ';' (ou ','), UTF-8 com BOM ou Windows-1252 (Excel PT-BR).
 * Importação em duas fases: ?simular=1 só valida e mostra erros por linha; sem ele grava (cria ou atualiza pela chave:
 * CPF/CNPJ nos parceiros, SKU nos produtos). Escrita: OWNER/ADMIN.
 */
import express, { Router } from 'express';
import { prisma } from '../../db.js';
import { ah, badRequest } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { decodeCsv, detectDelimiter, parseCsv, sanitizeText } from '../../lib/contacts-import.js';
import { parceiroSchema } from '../crm/parceiros.routes.js';
import { produtoSchema, gerarCodigoBarras, comEntradaXml } from '../produtos/produtos.routes.js';
import { auditar } from '../shared/auditoria.js';

export const importacaoRouter = Router();
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_LINHAS = 5000;

type Entidade = 'clientes' | 'fornecedores' | 'produtos';
interface Coluna { titulo: string; campo: string; obrigatoria?: boolean; tipo?: 'texto' | 'dinheiro' | 'qtd' | 'int' | 'simnao' }

const COL_PARCEIRO: Coluna[] = [
  { titulo: 'CPF/CNPJ', campo: 'documento', obrigatoria: true }, { titulo: 'Nome / Razão social', campo: 'nome', obrigatoria: true },
  { titulo: 'Nome fantasia', campo: 'fantasia' }, { titulo: 'Inscrição estadual', campo: 'inscricaoEstadual' },
  { titulo: 'E-mail', campo: 'email' }, { titulo: 'Telefone', campo: 'telefone' }, { titulo: 'CEP', campo: 'cep' },
  { titulo: 'Endereço', campo: 'logradouro' }, { titulo: 'Número', campo: 'numero' }, { titulo: 'Complemento', campo: 'complemento' },
  { titulo: 'Bairro', campo: 'bairro' }, { titulo: 'Cidade', campo: 'municipio' }, { titulo: 'UF', campo: 'uf' },
  { titulo: 'Observações', campo: 'observacoes' },
];
const DEF: Record<Entidade, { colunas: Coluna[]; exemplos: string[][] }> = {
  clientes: {
    colunas: [...COL_PARCEIRO.slice(0, 13), { titulo: 'Limite de crédito (R$)', campo: 'limiteCreditoCents', tipo: 'dinheiro' }, COL_PARCEIRO[13]],
    exemplos: [
      ['11.222.333/0001-81', 'Mercado Exemplo LTDA', 'Mercado Exemplo', 'ISENTO', 'compras@exemplo.com.br', '(11) 98888-7777', '06300-000', 'Rua das Flores', '100', 'Sala 2', 'Centro', 'Carapicuíba', 'SP', '5000,00', 'Entrega pela manhã'],
      ['123.456.789-09', 'Maria da Silva', '', '', 'maria@exemplo.com', '11 97777-6666', '', '', '', '', '', '', 'SP', '0', ''],
    ],
  },
  fornecedores: {
    colunas: COL_PARCEIRO,
    exemplos: [['11.444.777/0001-61', 'Distribuidora Exemplo LTDA', 'Distribuidora Exemplo', '123456789110', 'vendas@distribuidora.com.br', '(11) 3333-4444', '06000-000', 'Av. Industrial', '2000', '', 'Distrito', 'Osasco', 'SP', 'Prazo 28 dias']],
  },
  produtos: {
    colunas: [
      { titulo: 'SKU', campo: 'sku', obrigatoria: true }, { titulo: 'Nome', campo: 'nome', obrigatoria: true }, { titulo: 'Descrição', campo: 'descricao' },
      { titulo: 'Código de barras', campo: 'codigoBarras' }, { titulo: 'Unidade', campo: 'unidade' }, { titulo: 'NCM', campo: 'ncm' },
      { titulo: 'Preço de venda (R$)', campo: 'precoBaseCents', tipo: 'dinheiro' }, { titulo: 'Custo (R$)', campo: 'custoMedioCents', tipo: 'dinheiro' },
      { titulo: 'Estoque mínimo', campo: 'estoqueMinimoMil', tipo: 'qtd' }, { titulo: 'Estimativa de compra', campo: 'pontoPedidoMil', tipo: 'qtd' },
      { titulo: 'Prazo do fornecedor (dias)', campo: 'leadTimeDias', tipo: 'int' }, { titulo: 'Controla lote (S/N)', campo: 'controlaLote', tipo: 'simnao' },
      { titulo: 'Controla validade (S/N)', campo: 'controlaValidade', tipo: 'simnao' }, { titulo: 'Tipo (REVENDA, PRODUZIDO, INSUMO, SERVICO)', campo: 'tipo' },
      { titulo: 'CNPJ do fornecedor padrão', campo: 'fornecedorDoc' },
    ],
    exemplos: [
      ['CAFE500', 'Café torrado 500g', 'Pacote 500 g', '', 'UN', '09012100', '24,90', '15,50', '20', '40', '7', 'S', 'S', 'REVENDA', '11.444.777/0001-61'],
      ['SERV-ENT', 'Taxa de entrega', '', '', 'UN', '', '10,00', '0', '0', '0', '0', 'N', 'N', 'SERVICO', ''],
    ],
  },
};

const cel = (v: string) => (/[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (linhas: string[][]) => '\uFEFF' + linhas.map((l) => l.map((c) => cel(c ?? '')).join(';')).join('\r\n') + '\r\n';
const entidadeDe = (s: string): Entidade => { if (s === 'clientes' || s === 'fornecedores' || s === 'produtos') return s; throw badRequest('Planilha desconhecida'); };
const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const reais = (c: number | null | undefined) => (c ? (c / 100).toFixed(2).replace('.', ',') : '0,00');
const qtd = (m: number | null | undefined) => (m ? String(m / 1000).replace('.', ',') : '0');

/** "1.234,56" | "1234.56" | "R$ 10" → centavos (ou NaN). */
export function paraCentavos(v: string): number {
  let s = v.replace(/[R$\s]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}
const paraMil = (v: string) => { const c = paraCentavos(v); return Number.isNaN(c) ? NaN : c * 10; };

importacaoRouter.get('/:entidade/modelo', ah(async (req, res) => {
  const e = entidadeDe(req.params.entidade);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="modelo-${e}.csv"`);
  res.send(csv([DEF[e].colunas.map((c) => c.titulo + (c.obrigatoria ? ' *' : '')), ...DEF[e].exemplos]));
}));

importacaoRouter.get('/:entidade/exportar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const e = entidadeDe(req.params.entidade);
  const cab = DEF[e].colunas.map((c) => c.titulo);
  let linhas: string[][];
  if (e === 'produtos') {
    const ps = await prisma.erpProduto.findMany({ where: { orgId }, orderBy: { nome: 'asc' } });
    const forn = new Map((await prisma.erpParceiro.findMany({ where: { orgId, id: { in: ps.map((p) => p.fornecedorPadraoId).filter((x): x is string => !!x) } }, select: { id: true, documento: true } })).map((f) => [f.id, f.documento]));
    linhas = ps.map((p) => [p.sku, p.nome, p.descricao ?? '', p.codigoBarras ?? '', p.unidade, p.ncm ?? '', reais(p.precoBaseCents), reais(p.custoMedioCents), qtd(p.estoqueMinimoMil), qtd(p.pontoPedidoMil), String(p.leadTimeDias), p.controlaLote ? 'S' : 'N', p.controlaValidade ? 'S' : 'N', p.tipo, (p.fornecedorPadraoId && forn.get(p.fornecedorPadraoId)) || '']);
  } else {
    const ps = await prisma.erpParceiro.findMany({ where: { orgId, documento: { not: '00000000000' }, ...(e === 'clientes' ? { ehCliente: true } : { ehFornecedor: true }) }, orderBy: { nome: 'asc' } });
    linhas = ps.map((p) => { const base = [p.documento, p.nome, p.fantasia, p.inscricaoEstadual, p.email, p.telefone, p.cep, p.logradouro, p.numero, p.complemento, p.bairro, p.municipio, p.uf].map((v) => v ?? ''); return e === 'clientes' ? [...base, reais(p.limiteCreditoCents), p.observacoes ?? ''] : [...base, p.observacoes ?? '']; });
  }
  // Exportação também passa pela limpeza anti-fórmula (= + - @ no início).
  const seguro = linhas.map((l) => l.map((c) => (/^[=+@]/.test(c) ? `'${c}` : c)));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${e}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv([cab, ...seguro]));
}));

const corpo = express.raw({ type: (req) => !String(req.headers['content-type'] ?? '').includes('application/json'), limit: MAX_BYTES });

importacaoRouter.post('/:entidade/importar', requireRole('OWNER', 'ADMIN'), corpo, ah(async (req, res) => {
  const orgId = orgOf(req);
  const e = entidadeDe(req.params.entidade);
  const simular = req.query.simular === '1';
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Envie a planilha em CSV (no Excel: Salvar como → CSV).');
  const texto = decodeCsv(req.body);
  const linhas = parseCsv(texto, detectDelimiter(texto)).filter((l) => l.some((c) => c.trim()));
  if (linhas.length < 2) throw badRequest('A planilha está vazia: preencha a partir da 2ª linha, abaixo do cabeçalho.');
  if (linhas.length - 1 > MAX_LINHAS) throw badRequest(`Máximo de ${MAX_LINHAS} linhas por planilha`);
  const cols = DEF[e].colunas;
  const idx = new Map(linhas[0].map((t, i) => [norm(t.replace('*', '')), i]));
  const pos = cols.map((c) => idx.get(norm(c.titulo)) ?? idx.get(norm(c.titulo.replace(/\s*\(.*\)$/, ''))));
  const faltando = cols.filter((c, i) => c.obrigatoria && pos[i] === undefined).map((c) => c.titulo);
  if (faltando.length) throw badRequest(`Coluna obrigatória não encontrada: ${faltando.join(', ')}. Baixe o modelo e use o mesmo cabeçalho.`);

  const fornPorDoc = e === 'produtos' ? new Map((await prisma.erpParceiro.findMany({ where: { orgId, ehFornecedor: true }, select: { id: true, documento: true } })).map((f) => [f.documento, f.id])) : new Map<string, string>();
  const erros: { linha: number; erro: string }[] = [];
  const validos: { linha: number; dados: any }[] = [];
  const chaves = new Set<string>();
  linhas.slice(1).forEach((l, k) => {
    const n = k + 2;
    const bruto: Record<string, any> = {};
    let erro: string | null = null;
    cols.forEach((c, i) => {
      const v = pos[i] === undefined ? '' : sanitizeText(l[pos[i]!], 2000);
      if (!v) return;
      if (c.tipo === 'dinheiro') { const x = paraCentavos(v); if (Number.isNaN(x)) erro ??= `${c.titulo}: valor inválido "${v}"`; else bruto[c.campo] = x; }
      else if (c.tipo === 'qtd') { const x = paraMil(v); if (Number.isNaN(x)) erro ??= `${c.titulo}: quantidade inválida "${v}"`; else bruto[c.campo] = x; }
      else if (c.tipo === 'int') { const x = Number(v); if (!Number.isInteger(x) || x < 0) erro ??= `${c.titulo}: número inválido "${v}"`; else bruto[c.campo] = x; }
      else if (c.tipo === 'simnao') bruto[c.campo] = /^(s|sim|1|x|true)$/i.test(v);
      else bruto[c.campo] = v;
    });
    if (erro) return void erros.push({ linha: n, erro });
    let dados: any;
    if (e === 'produtos') {
      const fornecedorDoc = String(bruto.fornecedorDoc ?? '').replace(/\D/g, ''); delete bruto.fornecedorDoc;
      if (bruto.tipo) bruto.tipo = String(bruto.tipo).toUpperCase();
      if (fornecedorDoc) { const id = fornPorDoc.get(fornecedorDoc); if (!id) return void erros.push({ linha: n, erro: `Fornecedor ${fornecedorDoc} não cadastrado: importe os fornecedores primeiro` }); bruto.fornecedorPadraoId = id; }
      const r = produtoSchema.safeParse(bruto);
      if (!r.success) return void erros.push({ linha: n, erro: r.error.issues.map((i) => `${i.path.join('.') || 'linha'}: ${i.message}`).join('; ') });
      dados = r.data; dados._chave = dados.sku; dados._campos = Object.keys(bruto);
    } else {
      const r = parceiroSchema.safeParse({ ...bruto, ehCliente: e === 'clientes', ehFornecedor: e === 'fornecedores' });
      if (!r.success) return void erros.push({ linha: n, erro: r.error.issues.map((i) => `${i.path.join('.') || 'linha'}: ${i.message}`).join('; ') });
      dados = r.data; dados._chave = dados.documento; dados._campos = Object.keys(bruto);
    }
    if (chaves.has(dados._chave)) return void erros.push({ linha: n, erro: `${e === 'produtos' ? 'SKU' : 'CPF/CNPJ'} repetido na planilha` });
    chaves.add(dados._chave);
    validos.push({ linha: n, dados });
  });

  const existentes = e === 'produtos'
    ? new Map((await prisma.erpProduto.findMany({ where: { orgId, sku: { in: [...chaves] } }, select: { id: true, sku: true, codigoBarras: true } })).map((p) => [p.sku, p]))
    : new Map((await prisma.erpParceiro.findMany({ where: { orgId, documento: { in: [...chaves] } }, select: { id: true, documento: true } })).map((p) => [p.documento, p]));
  if (e === 'produtos') {
    // Custo que veio de NF-e (XML) não muda por planilha: só na tela do produto, com senha (fica no log).
    const xml = await comEntradaXml(orgId, [...existentes.values()].map((p: any) => p.id));
    for (const v of validos) {
      const atual: any = existentes.get(v.dados._chave);
      if (atual && xml.has(atual.id) && v.dados._campos.includes('custoMedioCents')) { v.dados._campos = v.dados._campos.filter((c: string) => c !== 'custoMedioCents'); erros.push({ linha: v.linha, erro: 'Custo ignorado: veio da nota fiscal (XML). Altere na tela do produto, com senha. O resto da linha foi importado.' }); }
    }
  }
  const novos = validos.filter((v) => !existentes.has(v.dados._chave)).length;
  const resumo = { total: linhas.length - 1, validos: validos.length, novos, atualizados: validos.length - novos, erros: erros.slice(0, 200), qtdErros: erros.length };
  if (simular) return res.json({ ...resumo, simulacao: true });

  for (const { dados } of validos) {
    const { _chave, _campos, ...d } = dados;
    const atual: any = existentes.get(_chave);
    if (e === 'produtos') {
      if (atual) {
        // Produto existente: só as colunas preenchidas (não zera custos extras, lote, ativo...).
        const parcial = Object.fromEntries(Object.entries(d).filter(([k]) => (_campos as string[]).includes(k)));
        await prisma.erpProduto.update({ where: { id: atual.id }, data: { ...parcial, codigoBarras: d.codigoBarras || atual.codigoBarras || await gerarCodigoBarras(orgId) } });
      }
      else await prisma.erpProduto.create({ data: { orgId, ...d, codigoBarras: d.codigoBarras || await gerarCodigoBarras(orgId) } });
    } else {
      const base = { ...d, tipoPessoa: d.documento.length === 14 ? 'PJ' : 'PF', tags: JSON.stringify(d.tags ?? []), regimeTributario: d.regimeTributario ?? null };
      if (atual) {
        // Atualiza só as colunas preenchidas na planilha e acrescenta o papel (cliente/fornecedor); não apaga o que já existe.
        const parcial = Object.fromEntries(Object.entries(base).filter(([k]) => (_campos as string[]).includes(k)));
        await prisma.erpParceiro.update({ where: { id: atual.id }, data: { ...parcial, ...(e === 'clientes' ? { ehCliente: true } : { ehFornecedor: true }) } });
      } else await prisma.erpParceiro.create({ data: { orgId, ...base } });
    }
  }
  await auditar(req, 'importacao.planilha', 'erp_importacao', orgId, null, { entidade: e, novos: resumo.novos, atualizados: resumo.atualizados, erros: resumo.qtdErros });
  res.json(resumo);
}));
