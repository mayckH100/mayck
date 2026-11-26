/**
 * v1.54.1 — impressões de Relatórios e Produtos (puro, sem DOM: testado em tests/unit/impressao-relatorios.test.ts).
 * Cada gerador devolve { titulo, corpo } para o `imprimir` de ./cabecalho, que põe o cabeçalho da empresa e o rodapé fixo da MCK.
 * Tudo que vem do usuário/servidor passa por `esc`. Só usa os dados já carregados na tela (da própria organização).
 */
import { esc, type Formato } from './modelo';
import { brl, qtd } from '../format';
import { unidadeLegivel } from '../../../../server/erp/shared/unidade';
import { descricaoEmbalagem } from '../../../../server/erp/shared/embalagem';

export interface DocImpresso { titulo: string; corpo: string; formato?: Formato }

/** "dd/mm/aaaa hh:mm" no fuso de São Paulo. */
export const geradoEmSP = (d: Date = new Date()) =>
  `${d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`;
const diaBr = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('/') : iso);

/** Título + linha de filtros + data de geração, igual em todos os relatórios. */
export function tituloRelatorio(titulo: string, filtros: string[], agora: Date = new Date()) {
  const f = filtros.filter(Boolean);
  return `<h2>${esc(titulo)}</h2><div class="small">${f.length ? `${f.map(esc).join(' · ')} · ` : ''}Gerado em ${esc(geradoEmSP(agora))}</div>`;
}

const CSS_IND = '.mck-ind{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.mck-ind>div{flex:1 1 30%;min-width:110px;border:1px solid #ccc;border-radius:4px;padding:4px 6px}.mck-ind b{display:block;font-size:1.15em}code{font-size:.85em;overflow-wrap:anywhere}';

/** Relatório do dia (aba Relatórios): indicadores, recebido/pago por forma e alterações sensíveis. */
export function htmlRelatorioDia(r: any, dia: string, agora: Date = new Date()): DocImpresso & { css: string } {
  const titulo = `Relatório do dia ${diaBr(dia)}`;
  const ind = [
    ['Vendido', `${brl(r?.vendas?.totalCents)}`, `${Number(r?.vendas?.pedidos ?? 0)} pedido(s)${r?.vendas?.balcao ? ` · ${Number(r.vendas.balcao)} no balcão` : ''}`],
    ['Recebido', brl(r?.recebidoCents), ''], ['Pago', brl(r?.pagoCents), ''], ['CMV (custo do que saiu)', brl(r?.cmvCents), ''],
  ].map(([l, v, s]) => `<div><span class="small">${esc(l)}</span><b>${esc(v)}</b>${s ? `<span class="small">${esc(s)}</span>` : ''}</div>`).join('');
  const formas = Object.entries(r?.porForma ?? {}) as [string, any][];
  const tabFormas = formas.length ? `<h2>Por forma de pagamento</h2><table><thead><tr><th>Forma</th><th class="dir">Recebido</th><th class="dir">Pago</th></tr></thead><tbody>${formas.map(([f, v]) => `<tr><td>${esc(f)}</td><td class="dir">${esc(brl(v?.receber))}</td><td class="dir">${esc(brl(v?.pagar))}</td></tr>`).join('')}</tbody></table>` : '';
  const alt: any[] = r?.alteracoes ?? [];
  const tabAlt = `<h2>Alterações sensíveis</h2>${alt.length === 0 ? '<p class="small">Nenhuma alteração sensível neste dia.</p>' : `<table><thead><tr><th>Hora</th><th>Quem</th><th>Alteração</th><th>Antes</th><th>Depois</th></tr></thead><tbody>${alt.map((a) => `<tr><td>${esc(a.hora)}</td><td>${esc(a.quem)}</td><td>${esc(a.acao)}</td><td class="small"><code>${esc(a.antes)}</code></td><td class="small"><code>${esc(a.depois)}</code></td></tr>`).join('')}</tbody></table>`}`;
  return { titulo, css: CSS_IND, corpo: `${tituloRelatorio(titulo, [`Período: ${diaBr(dia)}`], agora)}<div class="mck-ind">${ind}</div>${tabFormas}${tabAlt}` };
}

const servico = (p: any) => p?.tipo === 'SERVICO';

/** Lista de produtos com a busca atual da tela. */
export function htmlListaProdutos(itens: any[], f: { busca?: string }, agora: Date = new Date()): DocImpresso {
  const titulo = 'Lista de produtos';
  const filtros = [f.busca?.trim() ? `Busca: “${f.busca.trim()}”` : 'Todos os produtos', `${itens.length} produto(s)`];
  const linhas = itens.map((p) => `<tr${p.ativo === false ? ' style="color:#777"' : ''}><td>${esc(p.sku)}</td><td>${esc(p.nome)}${p.ativo === false ? ' <span class="small">(arquivado)</span>' : ''}</td><td>${esc(unidadeLegivel(p.unidade))}</td><td class="dir">${esc(brl(p.precoBaseCents))}</td><td class="dir">${servico(p) || !p.saldo ? '—' : `${esc(qtd(p.saldo.disponivelMil))}${p.abaixoMinimo ? ' ⚠' : ''}`}</td></tr>`).join('');
  const aviso = itens.some((p) => p.abaixoMinimo) ? '<div class="small">⚠ abaixo do estoque mínimo</div>' : '';
  return { titulo, corpo: `${tituloRelatorio(titulo, filtros, agora)}<table><thead><tr><th>Código</th><th>Produto</th><th>Unidade</th><th class="dir">Preço</th><th class="dir">Estoque disponível</th></tr></thead><tbody>${linhas}</tbody></table>${aviso}` };
}

const TIPO: Record<string, string> = { REVENDA: 'Revenda', PRODUZIDO: 'Produzido', INSUMO: 'Insumo / matéria-prima', SERVICO: 'Serviço' };

/** Ficha de um produto (dados salvos, não o que está sendo digitado). `custoTotalCents` vem da tela. */
export function htmlFichaProduto(p: any, extra: { custoTotalCents?: number; fornecedor?: string } = {}, agora: Date = new Date()): DocImpresso {
  const titulo = `Ficha do produto ${p?.sku ? `${p.sku} · ` : ''}${p?.nome ?? ''}`.trim();
  const emb = descricaoEmbalagem(p ?? {});
  const campos: [string, string][] = [
    ['Código', p?.sku ?? ''], ['Nome', p?.nome ?? ''], ['Tipo', TIPO[p?.tipo] ?? p?.tipo ?? ''], ['Situação', p?.ativo === false ? 'Arquivado' : 'Ativo'],
    ['Unidade de estoque', unidadeLegivel(p?.unidade)], ['Embalagem de compra', emb],
    ['Preço base', brl(p?.precoBaseCents)], ['Custo', brl(p?.custoMedioCents)],
    ['Custo total (com adicionais)', extra.custoTotalCents != null && extra.custoTotalCents !== p?.custoMedioCents ? brl(extra.custoTotalCents) : ''],
    ['Fornecedor padrão', extra.fornecedor ?? ''], ['Código de barras', p?.codigoBarras ?? ''], ['NCM', p?.ncm ?? ''], ['CEST', p?.cest ?? ''],
  ];
  if (!servico(p)) {
    if (p?.saldo) campos.push(['Estoque disponível', qtd(p.saldo.disponivelMil)], ['Reservado', qtd(p.saldo.reservadoMil)]);
    campos.push(['Estoque mínimo', qtd(p?.estoqueMinimoMil)], ['Estimativa de compra', qtd(p?.pontoPedidoMil)], ['Prazo de compra/fabricação', `${Number(p?.leadTimeDias ?? 0)} dia(s)`],
      ['Controle', [p?.controlaValidade ? 'perecível (validade, FEFO)' : p?.controlaLote ? `lote (${p?.regraSaida ?? 'FIFO'})` : '', p?.exigeQualidade ? 'compra exige liberação da qualidade' : ''].filter(Boolean).join(' · ')]);
  }
  let extras: { nome: string; valorCents: number }[] = [];
  try { extras = JSON.parse(p?.custosAdicionais ?? '[]'); } catch { extras = []; }
  const tab = `<table><tbody>${campos.filter(([, v]) => String(v).trim()).map(([l, v]) => `<tr><th style="width:38%">${esc(l)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  const desc = p?.descricao ? `<h2>Descrição</h2><p>${esc(p.descricao).replace(/\n/g, '<br>')}</p>` : '';
  const tabExtras = extras.length ? `<h2>Outros custos por unidade</h2><table><tbody>${extras.map((c) => `<tr><td>${esc(c.nome)}</td><td class="dir">${esc(brl(c.valorCents))}</td></tr>`).join('')}</tbody></table>` : '';
  return { titulo, corpo: `${tituloRelatorio(titulo, [], agora)}${tab}${desc}${tabExtras}` };
}
