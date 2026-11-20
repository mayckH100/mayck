/**
 * Compras › O que comprar (v1.32.0): só produtos zerados ou abaixo do mínimo, mais urgentes primeiro, agrupados por
 * fornecedor, com a quantidade sugerida pelo histórico de saídas (editável), custo unitário, total da linha e total
 * geral. "Gerar pedido de compra" cria um pedido em rascunho por fornecedor (sem fornecedor vira solicitação).
 * A conta é a mesma do alerta diário do WhatsApp (server/erp/compras/sugestao.ts).
 */
import { useEffect, useMemo, useState } from 'react';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, useAction } from '../../ui';
import { brl } from '../format';
import { BuscaParceiro } from '../comum';
import { nomeUnidade, numeroQtd } from '../../../../server/erp/shared/unidade';
import { aceitaDecimal, baseParaEmbalagens, embalagensParaBase, linhaCompra, lerQtdMil, precoPorEmbalagem } from '../../../../server/erp/shared/embalagem';
import { saidaMediaTexto } from '../../../../server/erp/compras/sugestao';

interface Item {
  produtoId: string; sku: string; nome: string; unidade: string; unidadeCompra: string; fatorCompraMil: number; embalagem: string; temEmbalagem: boolean;
  saldoMil: number; minimoMil: number; aCaminhoMil: number; sugeridaMil: number; motivo: string;
  calculo: { consumoDiaMil: number; duraDias: number | null; base: string; zerado: boolean };
  custoUnitCents: number; custoEmbalagemCents: number | null; custoOrigem: string | null; totalCents: number;
  fornecedorId: string | null; fornecedorNome: string | null; ultimaCompraMil: number | null;
}
interface Resposta { coberturaDias: number; janelaDias: number; itens: Item[]; totalCents: number }

const ORIGEM: Record<string, string> = { entrada: 'última entrada', compra: 'último pedido', medio: 'custo do cadastro' };
const COBERTURAS = [15, 30, 45, 60, 90];
const un = (mil: number, u: string) => `${numeroQtd(mil)} ${nomeUnidade(u, mil / 1000)}`;
const qtdTexto = (mil: number) => (mil / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3, useGrouping: false });
const SEM = '__sem';

/** Quantidade digitada na tela: em embalagens quando o produto tem embalagem, senão na unidade de estoque. */
function baseDoDigitado(i: Item, texto: string) {
  const mil = lerQtdMil(texto);
  return i.temEmbalagem ? embalagensParaBase(mil, i.fatorCompraMil) : mil;
}

export default function OQueComprar({ onPedidos }: { onPedidos?: () => void }) {
  const [cobertura, setCobertura] = useState<number | null>(null);
  const st = useApi<Resposta>(`/erp/compras/o-que-comprar${cobertura ? `?cobertura=${cobertura}` : ''}`, [cobertura]);
  const { hasModule } = useAuth();
  const podeComprar = hasModule('erp_compras');
  return (
    <Async state={st}>{(d) => d.itens.length === 0
      ? <div className="card"><Empty title="Nada para comprar agora">Nenhum produto está zerado ou abaixo do estoque mínimo. Defina o estoque mínimo em Produtos para o sistema avisar.</Empty></div>
      : <Lista d={d} cobertura={cobertura ?? d.coberturaDias} setCobertura={setCobertura} podeComprar={podeComprar} onGerado={() => { st.reload(); onPedidos?.(); }} />}
    </Async>
  );
}

function Lista({ d, cobertura, setCobertura, podeComprar, onGerado }: { d: Resposta; cobertura: number; setCobertura: (n: number) => void; podeComprar: boolean; onGerado: () => void }) {
  // Estado editável por produto: quantidade digitada (texto), marcado e fornecedor escolhido (para quem não tem).
  const inicial = () => Object.fromEntries(d.itens.map((i) => [i.produtoId, i.temEmbalagem ? qtdTexto(baseParaEmbalagens(i.sugeridaMil, i.fatorCompraMil)) : qtdTexto(i.sugeridaMil)]));
  const [qtd, setQtd] = useState<Record<string, string>>(inicial);
  const [marcado, setMarcado] = useState<Record<string, boolean>>(() => Object.fromEntries(d.itens.map((i) => [i.produtoId, i.sugeridaMil > 0])));
  const [fornSem, setFornSem] = useState<any>(null);
  const [gerados, setGerados] = useState<any[] | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { setQtd(inicial()); setMarcado(Object.fromEntries(d.itens.map((i) => [i.produtoId, i.sugeridaMil > 0]))); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const linha = (i: Item) => { const base = baseDoDigitado(i, qtd[i.produtoId] ?? '0'); return { base, lc: linhaCompra(base, i.custoUnitCents, i) }; };
  const grupos = useMemo(() => {
    const m = new Map<string, { id: string | null; nome: string; itens: Item[] }>();
    for (const i of d.itens) { const k = i.fornecedorId ?? SEM; if (!m.has(k)) m.set(k, { id: i.fornecedorId, nome: i.fornecedorNome ?? 'Sem fornecedor definido', itens: [] }); m.get(k)!.itens.push(i); }
    return [...m.values()].sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1)); // "sem fornecedor" por último
  }, [d]);
  const escolhidos = d.itens.filter((i) => marcado[i.produtoId] && linha(i).base > 0);
  const total = escolhidos.reduce((a, i) => a + linha(i).lc.totalCents, 0);
  const zerados = d.itens.filter((i) => i.saldoMil <= 0).length;

  async function gerar() {
    if (!escolhidos.length) return;
    const semPreco = escolhidos.filter((i) => !i.custoUnitCents).length;
    const nForn = new Set(escolhidos.map((i) => i.fornecedorId ?? (fornSem?.id || SEM))).size;
    if (!confirm(`Gerar ${nForn === 1 ? '1 pedido' : `${nForn} pedidos`} de compra em rascunho com ${escolhidos.length === 1 ? '1 produto' : `${escolhidos.length} produtos`}, total ${brl(total)}?${semPreco ? `\n\n${semPreco === 1 ? '1 produto está' : `${semPreco} produtos estão`} sem custo: informe o preço no pedido antes de enviar.` : ''}\n\nNada é enviado ao fornecedor agora.`)) return;
    const r = await run(() => post<any>('/erp/compras/o-que-comprar/gerar', { itens: escolhidos.map((i) => ({ produtoId: i.produtoId, qtdMil: linha(i).base, precoUnitCents: i.custoUnitCents, parceiroId: i.fornecedorId ?? fornSem?.id ?? null })) }), 'Pedido de compra gerado');
    if (r) { setGerados(r.documentos); onGerado(); }
  }

  return (
    <div className="oqc">
      <div className="oqc-resumo">
        <div className="card stat"><div className="l">Produtos para comprar</div><div className="v">{d.itens.length}</div></div>
        <div className="card stat"><div className="l">Sem nenhuma unidade</div><div className="v" style={{ color: zerados ? 'var(--danger)' : undefined }}>{zerados}</div></div>
        <div className="card stat"><div className="l">Total da compra</div><div className="v">{brl(total)}</div></div>
        <label className="card stat"><div className="l">Comprar para</div>
          <select value={cobertura} onChange={(e) => setCobertura(Number(e.target.value))} aria-label="Dias de cobertura">{[...new Set([...COBERTURAS, cobertura])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} dias</option>)}</select>
        </label>
      </div>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>
        Quantidade sugerida = saída média por dia (vendas e baixas dos últimos {d.janelaDias} dias; sem saída, 90 dias) × {cobertura} dias (+ prazo do fornecedor) − o que tem hoje − o que já foi pedido. Nunca menos que o necessário para voltar ao mínimo; arredonda para embalagem inteira.
      </p>
      {gerados && <div className="card" style={{ marginBottom: 10, borderColor: '#9fd4b2' }}>
        <strong>Pronto.</strong> {gerados.map((g) => g.tipo === 'pedido' ? `Pedido de compra nº ${g.numero}` : `Solicitação nº ${g.numero} (sem fornecedor, para cotar)`).join(' · ')}. Ficaram em rascunho em Pedidos de compra: confira e envie ao fornecedor.
      </div>}

      {grupos.map((g) => {
        const sub = g.itens.filter((i) => marcado[i.produtoId]).reduce((a, i) => a + linha(i).lc.totalCents, 0);
        return (
          <section key={g.id ?? SEM} className="card oqc-grupo">
            <div className="oqc-grupo-cab">
              <div><div className="small muted">Fornecedor</div><strong>{g.nome}</strong> <span className="small muted">· {g.itens.length === 1 ? '1 produto' : `${g.itens.length} produtos`}</span></div>
              <div className="oqc-sub"><span className="small muted">Subtotal</span> <strong>{brl(sub)}</strong></div>
            </div>
            {!g.id && podeComprar && <div className="small" style={{ margin: '6px 0' }}>
              {fornSem ? <span>Comprar estes de <strong>{fornSem.fantasia || fornSem.nome}</strong> <button className="btn ghost sm" onClick={() => setFornSem(null)}>Trocar</button></span>
                : <><span className="muted">Escolha um fornecedor para estes itens (ou deixe sem: vira uma solicitação para cotar).</span><BuscaParceiro tipo="fornecedor" onPick={setFornSem} /></>}
            </div>}
            <div className="table-wrap oqc-tabela">
              <table>
                <thead><tr>
                  <th aria-label="Comprar?"></th><th>Produto</th><th className="num">Tem hoje</th><th className="num">Mínimo</th><th className="num">Saída média</th><th className="num">Dura</th>
                  <th className="num">Comprar</th><th className="num">Custo unitário</th><th className="num">Total</th>
                </tr></thead>
                <tbody>{g.itens.map((i) => {
                  const { base, lc } = linha(i);
                  return (
                    <tr key={i.produtoId} className={i.saldoMil <= 0 ? 'oqc-zerado' : undefined}>
                      <td><input type="checkbox" checked={!!marcado[i.produtoId]} onChange={(e) => setMarcado({ ...marcado, [i.produtoId]: e.target.checked })} aria-label={`Comprar ${i.nome}`} /></td>
                      <td data-l="Produto"><div><span className="muted small">{i.sku}</span> <strong>{i.nome}</strong> {i.saldoMil <= 0 && <span className="badge red">acabou</span>}</div>
                        <div className="small muted oqc-motivo">{i.motivo}</div>
                        {i.embalagem && <div className="small muted">Compra em {i.embalagem}</div>}
                      </td>
                      <td data-l="Tem hoje" className="num">{un(Math.max(0, i.saldoMil), i.unidade)}</td>
                      <td data-l="Mínimo" className="num">{un(i.minimoMil, i.unidade)}</td>
                      <td data-l="Saída média" className="num">{i.calculo.consumoDiaMil > 0 ? saidaMediaTexto(i.calculo.consumoDiaMil, i.unidade).replace(/^~/, '') : 'sem vendas'}</td>
                      <td data-l="Dura" className="num">{i.saldoMil <= 0 ? <span style={{ color: 'var(--danger)' }}>acabou</span> : i.calculo.duraDias === null ? '—' : i.calculo.duraDias <= 0 ? 'acaba hoje' : `${i.calculo.duraDias} ${i.calculo.duraDias === 1 ? 'dia' : 'dias'}`}</td>
                      <td data-l="Comprar" className="num">
                        <div className="oqc-qtd"><input value={qtd[i.produtoId] ?? ''} inputMode={i.temEmbalagem || !aceitaDecimal(i.unidade) ? 'numeric' : 'decimal'} onChange={(e) => setQtd({ ...qtd, [i.produtoId]: e.target.value })} aria-label={`Quantidade de ${i.nome}`} />
                          <span className="small">{nomeUnidade(i.temEmbalagem ? i.unidadeCompra : i.unidade, lerQtdMil(qtd[i.produtoId] ?? '0') / 1000)}</span></div>
                        {i.temEmbalagem && <div className="small muted">= {un(base, i.unidade)}</div>}
                        {base !== i.sugeridaMil && <button type="button" className="btn ghost sm" onClick={() => setQtd({ ...qtd, [i.produtoId]: i.temEmbalagem ? qtdTexto(baseParaEmbalagens(i.sugeridaMil, i.fatorCompraMil)) : qtdTexto(i.sugeridaMil) })}>Sugerido: {un(i.temEmbalagem ? baseParaEmbalagens(i.sugeridaMil, i.fatorCompraMil) : i.sugeridaMil, i.temEmbalagem ? i.unidadeCompra : i.unidade)}</button>}
                        {i.aCaminhoMil > 0 && <div className="small muted">Já pedido: {un(i.aCaminhoMil, i.unidade)}</div>}
                      </td>
                      <td data-l="Custo unitário" className="num">{i.custoUnitCents > 0 ? <>
                        {i.temEmbalagem && <div>{brl(precoPorEmbalagem(i.custoUnitCents, i.fatorCompraMil))} <span className="small muted">por {nomeUnidade(i.unidadeCompra, 1)}</span></div>}
                        <div className={i.temEmbalagem ? 'small' : undefined}>{brl(i.custoUnitCents)} <span className="small muted">por {nomeUnidade(i.unidade, 1)}</span></div>
                        {i.custoOrigem && <div className="small muted">{ORIGEM[i.custoOrigem]}</div>}
                      </> : <span className="small" style={{ color: 'var(--warn)' }}>sem custo</span>}</td>
                      <td data-l="Total" className="num"><strong>{brl(lc.totalCents)}</strong></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </section>
        );
      })}

      <div className="oqc-rodape card">
        <div><div className="small muted">Total geral ({escolhidos.length === 1 ? '1 produto marcado' : `${escolhidos.length} produtos marcados`})</div><div className="oqc-total">{brl(total)}</div></div>
        {podeComprar
          ? <button className="btn primary" disabled={busy || !escolhidos.length} onClick={gerar}>Gerar pedido de compra</button>
          : <span className="small muted">Para gerar o pedido, peça acesso a ERP › Compras.</span>}
      </div>
    </div>
  );
}
