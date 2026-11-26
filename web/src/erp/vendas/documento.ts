/**
 * Pedido impresso, romaneio e recibo do balcão (v1.34.0). Cada um sai com o QR e o código de barras do pedido
 * ("PV-123"): depois, é só ler em "Ler código" ou em "Localizar pedido" para abrir o pedido.
 *  - recibo: bobina de 80 mm (impressora térmica comum) ou qualquer impressora; não é documento fiscal;
 *  - pedido: A4 com preços (rascunho = "Orçamento nº X" com "Válido até");  - romaneio: A4 sem preços, com endereço, lote, validade e conferência.
 * v1.54.0: todos com o cabeçalho da empresa (logo e dados) e o rodapé da MCK (ver ../impressao/modelo.ts).
 */
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { get } from '../../api';
import { imprimir } from '../impressao/cabecalho';
import { diaSP, esc, tituloPedido } from '../impressao/modelo';

export type TipoDocumento = 'recibo' | 'pedido' | 'romaneio';
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const q = (m: number) => (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const dt = (d: string | null) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '');
const dia = (d: string | null) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const FORMA: Record<string, string> = { DINHEIRO: 'Dinheiro', PIX: 'Pix', CARTAO: 'Cartão', BOLETO: 'Boleto', TED: 'Transferência' };
const doc = (d: string | null) => (!d ? '' : d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d);

function barras(valor: string, altura = 40) {
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svg, valor, { format: 'CODE128', displayValue: false, height: altura, width: 1.6, margin: 0 });
    svg.setAttribute('style', 'max-width:100%;height:auto;display:block');
    return svg.outerHTML;
  } catch { return ''; }
}

/** Abre a janela já no clique (sem bloqueio de pop-up), monta o documento com cabeçalho/rodapé da empresa e chama a impressão. */
export async function imprimirDocumento(tipo: TipoDocumento, pedidoId: string) {
  return imprimir(async () => {
    const d = await get<any>(`/erp/vendas/localizar/documento/${pedidoId}`);
    const p = d.pedido;
    const qr = await QRCode.toDataURL(p.codigo, { margin: 1, width: 180 });
    // v1.54.0: rascunho sai como "Orçamento nº X" com a validade (o romaneio continua romaneio).
    const titulo = tituloPedido(tipo, p);
    const orc = tipo !== 'romaneio' && p.orcamento;
    const codigoBloco = `<div class="cod"><img src="${qr}" alt="QR do pedido"><div style="flex:1;min-width:0">${barras(p.codigo)}<div class="c">${esc(p.codigo)}</div><div class="small">Leia este código no MCK ERP (Ler código / Localizar pedido) para abrir o pedido.</div></div></div>`;
    // v1.55.0: no A4 o título e a data/vendedor vão na faixa do cabeçalho; no recibo 80 mm continuam no corpo.
    const sub = `${dt(p.createdAt)}${p.vendedor ? ` · ${p.vendedor}` : ''} · ${p.codigo}`;
    const cab = `${tipo === 'recibo' ? `<h2>${esc(titulo)}</h2><div class="small">${esc(sub)}</div>` : ''}
      ${orc && p.validoAte ? `<div class="validade"><b>Válido até ${diaSP(p.validoAte)}</b></div>` : ''}
      <div>Cliente: <b>${esc(p.cliente.nome)}</b>${p.cliente.documento ? ` · ${esc(doc(p.cliente.documento))}` : ''}</div>`;
    let corpo = '';
    if (tipo === 'romaneio') {
      corpo = `<table><thead><tr><th>Endereço</th><th>Item</th><th>Lote</th><th>Validade</th><th>Qtd</th><th>Conferido</th></tr></thead><tbody>${p.itens.flatMap((i: any) => (i.lotes.length ? i.lotes : [{ numero: '—', validade: null, endereco: '—', qtdMil: i.qtdMil, separadoMil: 0 }]).map((l: any) => `<tr><td><b>${esc(l.endereco ?? '—')}</b></td><td>${esc(i.descricao)}</td><td>${esc(l.numero)}</td><td>${dia(l.validade)}</td><td>${q(l.qtdMil)} ${esc(i.unidade)}</td><td>${l.separadoMil >= l.qtdMil ? '✔' : '☐'}</td></tr>`)).join('')}</tbody></table>
        ${p.transportadora || p.rastreio ? `<p>Transporte: ${esc(p.transportadora ?? '')} ${p.rastreio ? `· rastreio ${esc(p.rastreio)}` : ''}</p>` : ''}
        <p style="margin-top:28px">Separado por: ____________________ &nbsp; Conferido por: ____________________ &nbsp; Recebido por: ____________________</p>`;
    } else {
      corpo = `<table><thead><tr><th>Item</th><th>Qtd</th><th>Preço</th><th>Total</th></tr></thead><tbody>${p.itens.map((i: any) => `<tr><td>${esc(i.descricao)}${i.lotes.length ? `<div class="small">Lote ${i.lotes.map((l: any) => `${esc(l.numero)}${l.validade ? ` (val. ${dia(l.validade)})` : ''}`).join(', ')}</div>` : ''}</td><td>${q(i.qtdMil)} ${esc(i.unidade)}</td><td>${brl(i.precoUnitCents)}${i.descontoBp ? ` −${i.descontoBp / 100}%` : ''}</td><td>${brl(i.totalCents)}</td></tr>`).join('')}</tbody></table>
        <div class="tot">Subtotal ${brl(p.subtotalCents)}${p.descontoCents ? ` · Desconto ${brl(p.descontoCents)}` : ''}${p.freteCents ? ` · Frete ${brl(p.freteCents)}` : ''}<br><b style="font-size:1.25em">Total ${brl(p.totalCents)}</b></div>
        ${p.pagamentos.length ? `<div>Pagamento: ${p.pagamentos.map((x: any) => `${FORMA[x.forma] ?? esc(x.forma)} ${brl(x.valorCents)}`).join(' · ')}</div>` : ''}
        ${p.nf ? `<div class="small">NF-e nº ${p.nf.numero}/${p.nf.serie} (${esc(p.nf.status.toLowerCase())})<br>Chave ${esc(p.nf.chave.replace(/(\d{4})/g, '$1 '))}</div>` : p.nfNumero ? `<div class="small">Nota fiscal ${esc(p.nfNumero)}</div>` : ''}
        ${orc ? '<p class="small">Orçamento sujeito à disponibilidade de estoque até a confirmação do pedido.</p>' : ''}
        ${tipo === 'recibo' ? '<p class="small">Este recibo não é documento fiscal.</p>' : ''}`;
    }
    const css = (tipo === 'recibo'
      ? '.cod img{width:26mm;height:26mm}table th:nth-child(3),table td:nth-child(3){display:none}'
      : '.cod img{width:30mm;height:30mm}')
      + '.cod{display:flex;gap:3mm;align-items:center;margin:8px 0;padding:2mm;border:1px dashed #999}.c{font:bold 1.2em monospace;text-align:center}.validade{margin:4px 0;padding:3px 6px;border:1px solid #000;display:inline-block}';
    const obs = tipo !== 'recibo' && p.observacoes ? `<p class="small">Obs.: ${esc(p.observacoes).replace(/\n/g, '<br>')}</p>` : '';
    return { titulo, subtitulo: sub, arquivo: `${titulo} ${p.codigo}`, corpo: `${cab}${codigoBloco}${corpo}${obs}`, formato: tipo === 'recibo' ? 'recibo' as const : 'a4' as const, css, nomeReserva: d.empresa?.nome ?? '' };
  }, 'width=900,height=700');
}
