/** Produtos: cadastro com NCM, lote/validade, FEFO/FIFO, mínimo e ponto de pedido; regras comerciais (alçada). */
import { useState } from 'react';
import { post, put } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction } from '../../ui';
import ErpNav from '../ErpNav';
import { brl, qtd, toCents, fromCents, toMil } from '../format';

export default function Produtos() {
  const [q, setQ] = useState(''); const [query, setQuery] = useState('');
  const state = useApi<any>(`/erp/produtos?q=${encodeURIComponent(query)}`, [query]);
  const [edit, setEdit] = useState<any>(null);
  const [regras, setRegras] = useState(false);
  const { can } = useAuth();
  return (
    <>
      <div className="page-head">
        <div><h1>Produtos</h1><p className="muted">Cadastro com dados fiscais, controle de lote e validade, e alertas de estoque mínimo.</p></div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><input placeholder="Nome, SKU ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 230 }} aria-label="Pesquisar" /></form>
          {can('OWNER', 'ADMIN') && <button className="btn" onClick={() => setRegras(true)}>Regras comerciais</button>}
          <button className="btn primary" onClick={() => setEdit({})}>+ Produto</button>
        </div>
      </div>
      <ErpNav />
      <Async state={state}>{(d) => d.items.length === 0 ? <div className="card"><Empty title="Nenhum produto ainda">Cadastre o primeiro produto para começar a vender e controlar estoque.</Empty></div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>SKU</th><th>Produto</th><th>Preço</th><th>Disponível</th><th>Reservado</th><th>Custo médio</th><th></th></tr></thead>
          <tbody>{d.items.map((p: any) => (
            <tr key={p.id} style={{ opacity: p.ativo ? 1 : 0.5 }}>
              <td><code>{p.sku}</code></td>
              <td><strong>{p.nome}</strong><div className="small muted">{p.unidade}{p.ncm ? ` · NCM ${p.ncm}` : ''}{p.controlaLote ? ` · lote ${p.regraSaida}` : ''}</div></td>
              <td>{brl(p.precoBaseCents)}</td>
              <td>{p.tipo === 'SERVICO' ? '—' : <>{qtd(p.saldo.disponivelMil)} {p.abaixoMinimo && <span className="badge red">abaixo do mínimo</span>}{!p.abaixoMinimo && p.noPontoPedido && <span className="badge">repor</span>}</>}</td>
              <td>{p.tipo === 'SERVICO' ? '—' : qtd(p.saldo.reservadoMil)}</td>
              <td>{brl(p.custoMedioCents)}</td>
              <td><button className="btn sm" onClick={() => setEdit(p)}>Editar</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}</Async>
      {edit && <ProdutoForm inicial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); state.reload(); }} />}
      {regras && <RegrasComerciais onClose={() => setRegras(false)} />}
    </>
  );
}

function ProdutoForm({ inicial, onClose, onSaved }: { inicial: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({
    sku: inicial.sku ?? '', nome: inicial.nome ?? '', unidade: inicial.unidade ?? 'UN', codigoBarras: inicial.codigoBarras ?? '', ncm: inicial.ncm ?? '', cest: inicial.cest ?? '',
    origem: inicial.origem ?? 0, tipo: inicial.tipo ?? 'REVENDA', controlaLote: !!inicial.controlaLote, controlaValidade: !!inicial.controlaValidade, regraSaida: inicial.regraSaida ?? 'FIFO',
    preco: fromCents(inicial.precoBaseCents), minimo: qtd(inicial.estoqueMinimoMil).replace(/\./g, ''), ponto: qtd(inicial.pontoPedidoMil).replace(/\./g, ''), ativo: inicial.ativo ?? true,
  });
  const { busy, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function salvar() {
    const body = { sku: f.sku, nome: f.nome, unidade: f.unidade, codigoBarras: f.codigoBarras || null, ncm: f.ncm || null, cest: f.cest || null, origem: Number(f.origem), tipo: f.tipo,
      controlaLote: f.controlaLote || f.controlaValidade, controlaValidade: f.controlaValidade, regraSaida: f.controlaValidade ? 'FEFO' : f.regraSaida,
      precoBaseCents: toCents(f.preco), estoqueMinimoMil: toMil(f.minimo), pontoPedidoMil: toMil(f.ponto), ativo: f.ativo };
    if (await run(() => (inicial.id ? put(`/erp/produtos/${inicial.id}`, body) : post('/erp/produtos', body)), 'Produto salvo')) onSaved();
  }
  return (
    <Modal title={inicial.id ? 'Editar produto' : 'Novo produto'} onClose={onClose}>
      <div className="grid g2">
        <Field label="SKU"><input value={f.sku} onChange={set('sku')} autoFocus /></Field>
        <Field label="Tipo"><select value={f.tipo} onChange={set('tipo')}><option value="REVENDA">Revenda</option><option value="PRODUZIDO">Produzido</option><option value="INSUMO">Insumo / matéria-prima</option><option value="SERVICO">Serviço</option></select></Field>
      </div>
      <Field label="Nome"><input value={f.nome} onChange={set('nome')} /></Field>
      <div className="grid g2">
        <Field label="Unidade"><input value={f.unidade} onChange={set('unidade')} maxLength={6} /></Field>
        <Field label="Preço base (R$)"><input value={f.preco} onChange={set('preco')} inputMode="decimal" /></Field>
        <Field label="NCM" hint="8 dígitos, obrigatório para nota fiscal"><input value={f.ncm} onChange={set('ncm')} /></Field>
        <Field label="Código de barras (EAN)"><input value={f.codigoBarras} onChange={set('codigoBarras')} /></Field>
        <Field label="CEST"><input value={f.cest} onChange={set('cest')} /></Field>
        <Field label="Origem (SEFAZ)"><select value={f.origem} onChange={set('origem')}>{['0 Nacional', '1 Estrangeira (importação direta)', '2 Estrangeira (mercado interno)', '3 Nacional >40% importado', '4 Nacional (PPB)', '5 Nacional ≤40% importado', '6 Estrangeira sem similar (direta)', '7 Estrangeira sem similar (interno)', '8 Nacional >70% importado'].map((o, i) => <option key={i} value={i}>{o}</option>)}</select></Field>
      </div>
      {f.tipo !== 'SERVICO' && <>
        <div className="row">
          <label className="row small"><input type="checkbox" checked={f.controlaLote} onChange={set('controlaLote')} /> Controla lote</label>
          <label className="row small"><input type="checkbox" checked={f.controlaValidade} onChange={set('controlaValidade')} /> Controla validade (usa FEFO)</label>
          {!f.controlaValidade && <select value={f.regraSaida} onChange={set('regraSaida')} aria-label="Regra de saída"><option value="FIFO">FIFO</option><option value="FEFO">FEFO</option></select>}
        </div>
        <div className="grid g2">
          <Field label="Estoque mínimo"><input value={f.minimo} onChange={set('minimo')} inputMode="decimal" /></Field>
          <Field label="Ponto de pedido"><input value={f.ponto} onChange={set('ponto')} inputMode="decimal" /></Field>
        </div>
      </>}
      <label className="row small"><input type="checkbox" checked={f.ativo} onChange={set('ativo')} /> Ativo</label>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !f.sku || f.nome.length < 2} onClick={salvar}>Salvar</button></div>
    </Modal>
  );
}

function RegrasComerciais({ onClose }: { onClose: () => void }) {
  const state = useApi<any>('/erp/produtos/config');
  const { busy, run } = useAction();
  const [f, setF] = useState<any>(null);
  const v = f ?? (state.data && { desconto: String(state.data.descontoMaxBp / 100).replace('.', ','), credito: state.data.bloquearSemCredito, validade: String(state.data.validadeOrcamentoDias) });
  return (
    <Modal title="Regras comerciais" onClose={onClose}>
      {!v ? null : <>
        <Field label="Desconto máximo sem aprovação (%)" hint="Acima disso o pedido espera o proprietário ou um administrador"><input value={v.desconto} onChange={(e) => setF({ ...v, desconto: e.target.value })} inputMode="decimal" /></Field>
        <label className="row small"><input type="checkbox" checked={v.credito} onChange={(e) => setF({ ...v, credito: e.target.checked })} /> Bloquear pedido que passa do limite de crédito do cliente</label>
        <Field label="Validade do orçamento (dias)"><input value={v.validade} onChange={(e) => setF({ ...v, validade: e.target.value })} inputMode="numeric" /></Field>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => put('/erp/produtos/config', { descontoMaxBp: Math.round(Number(v.desconto.replace(',', '.')) * 100) || 0, bloquearSemCredito: v.credito, validadeOrcamentoDias: Number(v.validade) || 15 }), 'Regras salvas')) onClose(); }}>Salvar</button>
        </div>
      </>}
    </Modal>
  );
}
