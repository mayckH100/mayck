/**
 * v1.54.0 — modelo único dos documentos impressos do MCK ERP (puro, sem DOM: testado em tests/unit/documento-impresso.test.ts).
 * Cabeçalho = logo + dados que o cliente configura em MCK ERP › Documentos impressos.
 * Rodapé = "Gerado pelo MCK ERP · MCK DESENVOLVIMENTO · site", fixo no código (o cliente não altera nem desliga).
 * A4: rodapé preso ao pé de cada página na impressão (position: fixed em @media print). Recibo 80 mm: rodapé no fim.
 */
import { LOGO_DATA_URL, RODAPE_DOCUMENTO, posicaoLogoValida, type ConfigDocumento } from '../../../../server/erp/shared/documento';

export type Formato = 'a4' | 'recibo';
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const fmtDoc = (d: string) => {
  const n = d.replace(/\D/g, '');
  if (n.length === 14) return n.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (n.length === 11) return n.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return d;
};
const fmtCep = (c: string) => { const n = c.replace(/\D/g, ''); return n.length === 8 ? `${n.slice(0, 5)}-${n.slice(5)}` : c; };

/** Linhas de texto do cabeçalho (sem HTML), na ordem em que aparecem. */
export function linhasCabecalho(c: Partial<ConfigDocumento>, nomeReserva = '') {
  const v = (k: keyof ConfigDocumento) => String(c[k] ?? '').trim();
  const nome = v('nomeExibicao') || nomeReserva;
  const docs = [v('cnpj') && `CNPJ ${fmtDoc(v('cnpj'))}`, v('ie') && `IE ${v('ie')}`].filter(Boolean).join(' · ');
  const rua = [v('logradouro'), v('numero')].filter(Boolean).join(', ');
  const cidade = [v('cidade'), v('uf')].filter(Boolean).join('/');
  const endereco = [rua, v('bairro'), cidade, v('cep') && `CEP ${fmtCep(v('cep'))}`].filter(Boolean).join(' · ');
  const contato = [v('telefone') && `Tel. ${v('telefone')}`, v('whatsapp') && `WhatsApp ${v('whatsapp')}`, v('email'), v('site')].filter(Boolean).join(' · ');
  return { nome, docs, endereco, contato, texto: v('textoLivre') };
}

/** Faixa do documento (título e número/data) que vai no cabeçalho do A4. */
export interface FaixaDocumento { titulo?: string; subtitulo?: string }

/**
 * v1.55.0 — cabeçalho profissional em dois layouts (MCK ERP › Documentos impressos › Posição do logo):
 *  - ESQUERDA (padrão): logo no canto superior esquerdo (máx. ~18 mm de altura) e, logo abaixo, os dados em letra pequena;
 *    título do documento e número/data à direita na mesma faixa; linha fina separando do conteúdo.
 *  - CENTRO: logo centralizado, dados centralizados embaixo e o título centralizado abaixo deles.
 * Sem logo: só o texto, no mesmo estilo. Recibo 80 mm: sempre centralizado e compacto (o título fica no corpo).
 * Tudo escapado; logo só se for data URL de imagem PNG/JPEG/WEBP. Campos vazios não deixam separador sobrando.
 */
export function cabecalhoHtml(c: Partial<ConfigDocumento> | null, formato: Formato = 'a4', nomeReserva = '', faixa: FaixaDocumento = {}) {
  const l = linhasCabecalho(c ?? {}, nomeReserva);
  const logo = c?.logo && LOGO_DATA_URL.test(c.logo) ? `<img class="mck-logo" src="${esc(c.logo)}" alt="Logo">` : '';
  const linhas = [l.docs, l.endereco, l.contato].filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join('');
  const dados = `${l.nome ? `<div class="mck-cab-nome">${esc(l.nome)}</div>` : ''}${linhas}${l.texto ? `<div class="mck-cab-texto">${esc(l.texto).replace(/\n/g, '<br>')}</div>` : ''}`;
  const titulo = formato === 'a4' ? String(faixa.titulo ?? '').trim() : '';
  const sub = formato === 'a4' ? String(faixa.subtitulo ?? '').trim() : '';
  const doc = titulo || sub ? `<div class="mck-cab-doc">${titulo ? `<div class="mck-cab-titulo">${esc(titulo)}</div>` : ''}${sub ? `<div class="mck-cab-sub">${esc(sub)}</div>` : ''}</div>` : '';
  if (!logo && !dados && !doc) return '';
  const empresa = logo || dados ? `<div class="mck-cab-emp">${logo}${dados ? `<div class="mck-cab-dados">${dados}</div>` : ''}</div>` : '';
  const layout = formato === 'recibo' || posicaoLogoValida(c?.posicaoLogo) === 'CENTRO' ? 'centro' : 'esq';
  return `<header class="mck-cab mck-cab-${formato} mck-cab-${layout}">${empresa}${doc}</header>`;
}

/** Rodapé da MCK: sempre o mesmo texto, sem parâmetro que mude ou desligue. */
export function rodapeHtml() {
  return `<footer class="mck-rodape">${esc(RODAPE_DOCUMENTO)}</footer>`;
}

export type Orientacao = 'retrato' | 'paisagem';

/** CSS comum. A4 (retrato ou paisagem) com margem para o rodapé fixo; recibo 80 mm com logo pequeno e dados compactos. */
export function cssDocumento(formato: Formato = 'a4', orientacao: Orientacao = 'retrato') {
  const base = '*{box-sizing:border-box;font-family:Arial,Helvetica,sans-serif}body{margin:0;color:#000}h1{font-size:1.3em;margin:0}h2{font-size:1.1em;margin:6px 0 2px}.small{font-size:.85em;color:#333}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{text-align:left;padding:3px 4px;border-bottom:1px solid #ccc;vertical-align:top}.dir{text-align:right}.tot{text-align:right;margin:6px 0}'
    // Quebra de página: o cabeçalho da tabela (thead) se repete e nenhuma linha é cortada ao meio.
    + 'thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}th{background:#f3f4f6}'
    + '.mck-cab{color:#333;border-bottom:.6pt solid #9ca3af;padding-bottom:2.5mm;margin-bottom:4mm}.mck-cab-emp{min-width:0}.mck-logo{display:block;width:auto;height:auto;object-fit:contain}'
    + '.mck-cab-dados{font-size:8.5pt;line-height:1.3;color:#374151;overflow-wrap:anywhere}.mck-cab-nome{font-size:10pt;font-weight:bold;color:#111;line-height:1.25}.mck-cab-texto{margin-top:1px;font-style:italic}'
    + '.mck-cab-titulo{font-size:13pt;font-weight:bold;color:#111;line-height:1.2}.mck-cab-sub{font-size:8.5pt;color:#4b5563;margin-top:1mm}'
    + '.mck-cab-esq{display:flex;justify-content:space-between;align-items:flex-start;gap:6mm}.mck-cab-esq .mck-cab-emp{flex:1}.mck-cab-esq .mck-logo{max-height:18mm;max-width:60mm;margin-bottom:1.5mm}.mck-cab-esq .mck-cab-doc{text-align:right;max-width:48%;flex:0 1 auto}'
    + '.mck-cab-centro{text-align:center}.mck-cab-centro .mck-logo{margin:0 auto 1.5mm;max-height:18mm;max-width:60mm}.mck-cab-centro .mck-cab-doc{margin-top:2.5mm}'
    + '.mck-rodape{font-size:9px;color:#555;text-align:center;border-top:1px solid #bbb;padding-top:3px;margin-top:12px}';
  if (formato === 'recibo') {
    return `@page{size:80mm auto;margin:3mm}body{width:74mm;max-width:100%;font-size:11px}${base}.mck-cab{padding-bottom:2mm;margin-bottom:2mm}.mck-cab-centro .mck-logo{max-width:40mm;max-height:14mm;margin-bottom:1mm}.mck-cab-dados{font-size:8pt}.mck-cab-nome{font-size:9.5pt}`;
  }
  const larga = orientacao === 'paisagem';
  return `@page{size:A4${larga ? ' landscape' : ''};margin:12mm 12mm 16mm}body{font-size:${larga ? 10 : 12}px;padding:10px}${base}`
    + (larga ? 'th,td{padding:2px 3px}' : '')
    + '.mck-pag{margin:0}.mck-pag>tbody>tr>td,.mck-pag>tfoot>tr>td{border:0;padding:0}.mck-pag>thead{display:none}.mck-espaco{height:0}'
    // Impressão: rodapé preso ao pé de cada página; o <tfoot> vazio (repetido pelo navegador em cada página) reserva o espaço dele.
    + '@media print{body{padding:0}.mck-espaco{height:9mm}.mck-rodape{position:fixed;left:0;right:0;bottom:0;margin:0;background:#fff}}'
    + '@media (max-width:560px){body{font-size:11px;padding:6px}.mck-cab-esq{flex-direction:column;gap:2mm}.mck-cab-esq .mck-cab-doc{text-align:left;max-width:none}.mck-logo{max-height:16mm}th,td{padding:2px 3px}}';
}

/**
 * Documento completo (cabeçalho + corpo + rodapé). `corpo` já deve vir escapado por quem o monta.
 * No A4 o `titulo` (e o `subtitulo`, ex.: número/data/filtros) vai na faixa do cabeçalho; `arquivo` vira o <title> (nome do PDF).
 */
export function paginaHtml(o: { titulo: string; corpo: string; config: Partial<ConfigDocumento> | null; formato?: Formato; css?: string; nomeReserva?: string; subtitulo?: string; orientacao?: Orientacao; arquivo?: string }) {
  const f = o.formato ?? 'a4';
  const conteudo = `${cabecalhoHtml(o.config, f, o.nomeReserva, { titulo: o.titulo, subtitulo: o.subtitulo })}<main>${o.corpo}</main>`;
  const miolo = f === 'a4' ? `<table class="mck-pag"><tbody><tr><td>${conteudo}</td></tr></tbody><tfoot><tr><td><div class="mck-espaco"></div></td></tr></tfoot></table>` : conteudo;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.arquivo ?? o.titulo)}</title><style>${cssDocumento(f, o.orientacao)}${o.css ?? ''}</style></head><body>${miolo}${rodapeHtml()}</body></html>`;
}

/** Título do pedido impresso: rascunho = orçamento. */
export function tituloPedido(tipo: 'recibo' | 'pedido' | 'romaneio', p: { numero: number | string; orcamento?: boolean }) {
  if (tipo === 'romaneio') return `Romaneio de separação / entrega nº ${p.numero}`;
  if (p.orcamento) return `Orçamento nº ${p.numero}`;
  return `${tipo === 'recibo' ? 'Recibo de venda' : 'Pedido de venda'} nº ${p.numero}`;
}

/** "dd/mm/aaaa" no fuso de São Paulo. */
export const diaSP = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
