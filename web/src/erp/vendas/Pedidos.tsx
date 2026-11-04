/** Pedidos de venda: lista por status e criação de orçamento com preço da tabela e faixa de volume. */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post } from '../../api';
import { useApi, Async, Empty, Modal, Field, useAction, fmtDate } from '../../ui';
import ErpNav from '../ErpNav';
import VendaBalcao from './Balcao';
import { brl, toCents, toMil, qtd, STATUS_PEDIDO } from '../format';

const GRUPOS: { label: string; status: string }[] = [
  { label: 'Todos', status: '' },
  { label: 'Orçamentos', status: 'RASCUNHO' },
  { label: 'Aprovação', status: 'EM_APROVACAO,BLOQUEADO' },
  { label: 'Aguardando estoque', status: 'AGUARDANDO_SUPRIMENTO' },
  { label: 'Separação', status: 'APROVADO,RESERVADO,EM_SEPARACAO,SEPARADO' },
  { label: 'Faturados e em transporte', status: 'FATURADO,EM_TRANSPORTE,ENTREGA_PARCIAL' },
  { label: 'Encerrados', status: 'ENTREGUE,DEVOLVIDO,CANCELADO' },
];

export function badgeStatus(s: string) {
  const cor = ['CANCELADO', 'DEVOLVIDO', 'BLOQUEADO'].includes(s) ? 'red' : ['ENTREGUE', 'FATURADO'].includes(s) ? 'green' : s === 'AGUARDANDO_SUPRIMENTO' ? 'blue' : '';
  return <span className={`badge ${cor}`}>{STATUS_PEDIDO[s] ?? s}</span>;
}

export default function Pedidos() {
  const [sp] = useSearchParams();
  const [grupo, setGrupo] = useState('');
  const state = useApi<any[]>(`/erp/vendas/pedidos?status=${grupo}`, [grupo]);
  const [novo, setNovo] = useState(!!sp.get('parceiroId'));
  const [balcao, setBalcao] = useState(false);
  const nav = useNavigate();
  return (
    <>
      <div className="page-head">
        <div><h1>Pedidos de venda</h1><p className="muted">Do orçamento à entrega: aprovação, reserva de estoque, separação por QR e faturamento.</p></div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn" onClick={() => setNovo(true)}>+ Orçamento</button>
          <button className="btn primary" onClick={() => setBalcao(true)}>Venda balcão</button>
        </div>
      </div>
      <ErpNav />
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>{GRUPOS.map((g) => <button key={g.label} className={`btn sm ${grupo === g.status ? 'primary' : ''}`} onClick={() => setGrupo(g.status)}>{g.label}</button>)}</div>
      <Async state={state}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhum pedido aqui">Crie um orçamento para um cliente.</Empty></div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Nº</th><th>Cliente</th><th>Status</th><th>Total</th><th>Criado</th><th></th></tr></thead>
          <tbody>{d.map((p) => (
            <tr key={p.id}><td><strong>{p.numero}</strong></td><td>{p.parceiro?.fantasia || p.parceiro?.nome}</td><td>{badgeStatus(p.statusOperacional)}</td><td>{brl(p.totalCents)}</td><td>{fmtDate(p.createdAt)}</td><td><button className="btn sm" onClick={() => nav(`/erp/pedidos/${p.id}`)}>Abrir</button></td></tr>
          ))}</tbody>
        </table></div>
      )}</Async>
      {novo && <NovoPedido parceiroId={sp.get('parceiroId')} oportunidadeId={sp.get('oportunidadeId')} onClose={() => setNovo(false)} onSaved={(p) => nav(`/erp/pedidos/${p.id}`)} />}
      {balcao && <VendaBalcao onClose={() => setBalcao(false)} onDone={() => { setBalcao(false); state.reload(); }} />}
    </>
  );
}

function NovoPedido({ parceiroId, oportunidadeId, onClose, onSaved }: { parceiroId: string | null; oportunidadeId: string | null; onClose: () => void; onSaved: (p: any) => void }) {
  const tabelas = useApi<any[]>('/erp/produtos/tabelas');
  const condicoes = useApi<any[]>('/erp/produtos/condicoes');
  const deps = useApi<any[]>('/erp/estoque/depositos');
  const preCliente = useApi<any>(parceiroId ? `/erp/crm/parceiros/${parceiroId}` : null);
  const [cliente, setCliente] = useState<any>(null);
  const [busca, setBusca] = useState(''); const [opcoes, setOpcoes] = useState<any[]>([]);
  const [prodBusca, setProdBusca] = useState(''); const [prodOpcoes, setProdOpcoes] = useState<any[]>([]);
  const [itens, setItens] = useState<any[]>([]);
  const [f, setF] = useState({ tabelaPrecoId: '', condicaoPagamentoId: '', depositoId: '', desconto: '', frete: '', observacoes: '' });
  const { busy, run } = useAction();
  const cli = cliente ?? preCliente.data;

  async function precoDe(produtoId: string, qtdMil: number) { return (await get<any>(`/erp/produtos/preco?produtoId=${produtoId}&qtdMil=${qtdMil}${f.tabelaPrecoId ? `&tabelaId=${f.tabelaPrecoId}` : ''}`)).precoCents as number; }
  async function addProduto(p: any) { setProdBusca(''); setProdOpcoes([]); setItens([...itens, { produto: p, qtd: '1', preco: ((await precoDe(p.id, 1000)) / 100).toFixed(2).replace('.', ','), desconto: '' }]); }
  const mudarItem = (i: number, k: string, v: string) => setItens(itens.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const linha = (x: any) => Math.round((toMil(x.qtd) * toCents(x.preco)) / 1000 * (1 - (Number(x.desconto.replace(',', '.')) || 0) / 100));
  const total = itens.reduce((a, x) => a + linha(x), 0) - toCents(f.desconto) + toCents(f.frete);

  async function salvar() {
    const body = { parceiroId: cli.id, oportunidadeId, tabelaPrecoId: f.tabelaPrecoId || null, condicaoPagamentoId: f.condicaoPagamentoId || null, depositoId: f.depositoId || null, descontoCents: toCents(f.desconto), freteCents: toCents(f.frete), observacoes: f.observacoes || null,
      itens: itens.map((x) => ({ produtoId: x.produto.id, qtdMil: toMil(x.qtd), precoUnitCents: toCents(x.preco), descontoBp: Math.round((Number(x.desconto.replace(',', '.')) || 0) * 100) })) };
    const p = await run(() => post('/erp/vendas/pedidos', body), 'Orçamento criado');
    if (p) onSaved(p);
  }
  return (
    <Modal title="Novo orçamento" onClose={onClose}>
      {cli ? <div className="row between"><strong>{cli.fantasia || cli.nome}</strong>{!parceiroId && <button className="btn ghost sm" onClick={() => setCliente(null)}>Trocar</button>}</div> : (
        <Field label="Cliente"><input value={busca} autoFocus placeholder="Nome ou CNPJ" onChange={async (e) => { setBusca(e.target.value); setOpcoes(e.target.value.length >= 2 ? (await get<any>(`/erp/crm/parceiros?q=${encodeURIComponent(e.target.value)}&tipo=cliente`)).items.slice(0, 8) : []); }} />
          {opcoes.map((o) => <button key={o.id} type="button" className="btn ghost sm" style={{ display: 'block' }} onClick={() => setCliente(o)}>{o.fantasia || o.nome}</button>)}</Field>
      )}
      <div className="grid g2">
        <Field label="Tabela de preço"><select value={f.tabelaPrecoId} onChange={(e) => setF({ ...f, tabelaPrecoId: e.target.value })}><option value="">Preço base</option>{(tabelas.data ?? []).filter((t) => t.ativa).map((t) => <option key={t.id} value={t.id}>{t.nome}{t.uf ? ` (${t.uf})` : ''}</option>)}</select></Field>
        <Field label="Condição de pagamento"><select value={f.condicaoPagamentoId} onChange={(e) => setF({ ...f, condicaoPagamentoId: e.target.value })}><option value="">—</option>{(condicoes.data ?? []).filter((c) => c.ativa).map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>
        <Field label="Sai do depósito"><select value={f.depositoId} onChange={(e) => setF({ ...f, depositoId: e.target.value })}><option value="">Qualquer</option>{(deps.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}</select></Field>
      </div>
      <Field label="Adicionar produto"><input value={prodBusca} placeholder="Nome, SKU ou código de barras" onChange={async (e) => { setProdBusca(e.target.value); setProdOpcoes(e.target.value.length >= 2 ? (await get<any>(`/erp/produtos?q=${encodeURIComponent(e.target.value)}&ativos=1`)).items.slice(0, 8) : []); }} />
        {prodOpcoes.map((o) => <button key={o.id} type="button" className="btn ghost sm" style={{ display: 'block' }} onClick={() => addProduto(o)}>{o.sku} · {o.nome} · disp. {qtd(o.saldo.disponivelMil)}</button>)}</Field>
      {itens.map((x, i) => (
        <div key={i} className="row" style={{ gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ flex: 2 }} className="small">{x.produto.sku} · {x.produto.nome}</span>
          <input style={{ width: 70 }} aria-label="Quantidade" value={x.qtd} onChange={(e) => mudarItem(i, 'qtd', e.target.value)} onBlur={async () => { if (f.tabelaPrecoId) mudarItem(i, 'preco', ((await precoDe(x.produto.id, toMil(x.qtd))) / 100).toFixed(2).replace('.', ',')); }} />
          <input style={{ width: 80 }} aria-label="Preço" value={x.preco} onChange={(e) => mudarItem(i, 'preco', e.target.value)} />
          <input style={{ width: 55 }} aria-label="Desconto %" placeholder="%" value={x.desconto} onChange={(e) => mudarItem(i, 'desconto', e.target.value)} />
          <strong className="small" style={{ width: 80, textAlign: 'right' }}>{brl(linha(x))}</strong>
          <button className="btn ghost sm" aria-label="Remover" onClick={() => setItens(itens.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="grid g2">
        <Field label="Desconto geral (R$)"><input value={f.desconto} onChange={(e) => setF({ ...f, desconto: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Frete (R$)"><input value={f.frete} onChange={(e) => setF({ ...f, frete: e.target.value })} inputMode="decimal" /></Field>
      </div>
      <Field label="Observações"><textarea rows={2} value={f.observacoes} onChange={(e) => setF({ ...f, observacoes: e.target.value })} /></Field>
      <div className="row between" style={{ marginTop: 10 }}><strong>Total {brl(Math.max(0, total))}</strong>
        <span className="row"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !cli || !itens.length} onClick={salvar}>Criar orçamento</button></span></div>
    </Modal>
  );
}
