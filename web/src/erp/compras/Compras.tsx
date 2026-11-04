/** Compras: solicitações (aprovação), cotações (mapa e vencedoras) e pedidos de compra (alçada, envio ao fornecedor). */
import { useState } from 'react';
import { get, post, put } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, fmtDate } from '../../ui';
import ErpNav from '../ErpNav';
import { brl, qtd, toMil, toCents, fromCents } from '../format';
import { BuscaParceiro, EditorItens, type LinhaItem } from '../comum';

const ST: Record<string, string> = { RASCUNHO: 'Rascunho', EM_APROVACAO: 'Em aprovação', APROVADA: 'Aprovada', APROVADO: 'Aprovado', REPROVADA: 'Reprovada', ATENDIDA: 'Atendida', CANCELADA: 'Cancelada', CANCELADO: 'Cancelado', ENVIADO: 'Enviado ao fornecedor', RECEBIDO_PARCIAL: 'Recebido em parte', RECEBIDO: 'Recebido', ABERTA: 'Aberta', ENCERRADA: 'Encerrada' };
const ACAO: Record<string, string> = { ENVIAR: 'Enviar para aprovação', APROVAR: 'Aprovar', REPROVAR: 'Reprovar', CANCELAR: 'Cancelar', REABRIR: 'Reabrir', ATENDER: 'Marcar atendida', ENVIAR_FORNECEDOR: 'Marcar enviado ao fornecedor' };
const precisaMotivo = (a: string) => ['REPROVAR', 'CANCELAR'].includes(a);

export default function Compras() {
  const [aba, setAba] = useState<'sol' | 'cot' | 'ped'>('ped');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Compras</h1><p className="muted">Solicitação → cotação → pedido com alçada → recebimento pela NF-e (conferido contra o pedido).</p></div></div>
      <ErpNav />
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {(['ped', 'sol', 'cot'] as const).map((a) => <button key={a} className={`btn sm ${aba === a ? 'primary' : ''}`} onClick={() => setAba(a)}>{{ ped: 'Pedidos de compra', sol: 'Solicitações', cot: 'Cotações' }[a]}</button>)}
      </div>
      {aba === 'sol' && <Solicitacoes />}
      {aba === 'cot' && <Cotacoes />}
      {aba === 'ped' && <PedidosCompra />}
    </div>
  );
}

function Solicitacoes() {
  const l = useApi<any[]>('/erp/compras/solicitacoes');
  const [nova, setNova] = useState(false); const [cotar, setCotar] = useState<any>(null);
  const [itens, setItens] = useState<LinhaItem[]>([]); const [just, setJust] = useState('');
  const { busy, run } = useAction();
  const acao = async (id: string, evento: string) => { const motivo = precisaMotivo(evento) ? prompt('Motivo') : undefined; if (precisaMotivo(evento) && !motivo) return; if (await run(() => post(`/erp/compras/solicitacoes/${id}/acao`, { evento, motivo }), 'Feito')) l.reload(); };
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => { setItens([]); setJust(''); setNova(true); }}>+ Solicitação</button>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma solicitação">Quem precisa de material pede aqui; o MRP também cria solicitações.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Nº</th><th>Itens</th><th>Origem</th><th>Status</th><th></th></tr></thead>
          <tbody>{d.map((s) => <tr key={s.id}><td>{s.numero}</td><td className="small">{s.itens.map((i: any) => `${i.produto?.sku} ${qtd(i.qtdMil)}`).join(', ')}</td><td>{s.origem}</td><td>{ST[s.status] ?? s.status}</td>
            <td className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{s.status === 'APROVADA' && <button className="btn sm primary" onClick={() => setCotar(s)}>Cotar</button>}{s.acoes.map((a: string) => <button key={a} className="btn sm" onClick={() => acao(s.id, a)}>{ACAO[a] ?? a}</button>)}</td></tr>)}</tbody></table></div>
      )}</Async>
      {nova && <Modal title="Nova solicitação de compra" onClose={() => setNova(false)}>
        <EditorItens itens={itens} setItens={setItens} />
        <Field label="Justificativa"><input value={just} onChange={(e) => setJust(e.target.value)} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !itens.length} onClick={async () => { if (await run(() => post('/erp/compras/solicitacoes', { justificativa: just || null, enviar: true, itens: itens.map((i) => ({ produtoId: i.produto.id, qtdMil: toMil(i.qtd) })) }), 'Solicitação enviada para aprovação')) { setNova(false); l.reload(); } }}>Enviar para aprovação</button></div>
      </Modal>}
      {cotar && <NovaCotacao solicitacao={cotar} onClose={() => setCotar(null)} onDone={() => { setCotar(null); l.reload(); }} />}
    </>
  );
}

function NovaCotacao({ solicitacao, onClose, onDone }: { solicitacao?: any; onClose: () => void; onDone: () => void }) {
  const [forn, setForn] = useState<any[]>([]); const [itens, setItens] = useState<LinhaItem[]>([]);
  const { busy, run } = useAction();
  return (
    <Modal title={solicitacao ? `Cotar solicitação ${solicitacao.numero}` : 'Nova cotação'} onClose={onClose}>
      {!solicitacao && <EditorItens itens={itens} setItens={setItens} />}
      <Field label="Fornecedores convidados">
        <BuscaParceiro tipo="fornecedor" onPick={(p) => !forn.some((f) => f.id === p.id) && setForn([...forn, p])} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 4 }}>{forn.map((f) => <span key={f.id} className="badge">{f.fantasia || f.nome} <button className="btn ghost sm" onClick={() => setForn(forn.filter((x) => x.id !== f.id))} aria-label="Remover">✕</button></span>)}</div>
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !forn.length || (!solicitacao && !itens.length)} onClick={async () => { if (await run(() => post('/erp/compras/cotacoes', { solicitacaoId: solicitacao?.id ?? null, itens: solicitacao ? undefined : itens.map((i) => ({ produtoId: i.produto.id, qtdMil: toMil(i.qtd) })), fornecedores: forn.map((f) => f.id) }), 'Cotação aberta')) onDone(); }}>Abrir cotação</button></div>
    </Modal>
  );
}

function Cotacoes() {
  const l = useApi<any[]>('/erp/compras/cotacoes');
  const [nova, setNova] = useState(false); const [aberta, setAberta] = useState<string | null>(null);
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setNova(true)}>+ Cotação</button>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma cotação">Convide fornecedores, lance as propostas e o mapa escolhe a melhor por item.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Nº</th><th>Itens</th><th>Propostas</th><th>Status</th><th>Aberta</th><th></th></tr></thead>
          <tbody>{d.map((c) => <tr key={c.id}><td>{c.numero}</td><td>{c._count.itens}</td><td>{c._count.respostas}</td><td>{ST[c.status]}</td><td>{fmtDate(c.createdAt)}</td><td><button className="btn sm" onClick={() => setAberta(c.id)}>Abrir</button></td></tr>)}</tbody></table></div>
      )}</Async>
      {nova && <NovaCotacao onClose={() => setNova(false)} onDone={() => { setNova(false); l.reload(); }} />}
      {aberta && <Cotacao id={aberta} onClose={() => { setAberta(null); l.reload(); }} />}
    </>
  );
}

function Cotacao({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useApi<any>(`/erp/compras/cotacoes/${id}`, [id]);
  const [lancar, setLancar] = useState<any>(null); const [precos, setPrecos] = useState<Record<string, { preco: string; prazo: string }>>({}); const [cond, setCond] = useState('');
  const [esc, setEsc] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  return (
    <Modal title="Mapa de cotação" onClose={onClose}>
      <Async state={st}>{(c) => {
        const resp = (itemId: string, parceiroId: string) => c.respostas.find((r: any) => r.itemId === itemId && r.parceiroId === parceiroId);
        const texto = `Olá! Pedimos cotação dos itens abaixo (cotação nº ${c.numero}):\n${c.itens.map((i: any) => `• ${i.produto?.nome} (${i.produto?.sku}): ${qtd(i.qtdMil)} ${i.produto?.unidade}`).join('\n')}\nInforme preço unitário, prazo de entrega e condição de pagamento. Obrigado!`;
        return (
          <>
            <div className="table-wrap"><table><thead><tr><th>Item</th>{c.fornecedores.map((f: any) => <th key={f.id}>{f.fantasia || f.nome}</th>)}</tr></thead>
              <tbody>{c.itens.map((i: any) => <tr key={i.id}><td className="small">{i.produto?.sku} · {qtd(i.qtdMil)}</td>{c.fornecedores.map((f: any) => {
                const r = resp(i.id, f.id); const melhor = i.melhorParceiroId === f.id;
                return <td key={f.id} style={{ background: melhor ? 'rgba(22,163,74,.12)' : undefined }}>{r ? <label className="small">{c.status === 'ABERTA' && <input type="radio" name={i.id} checked={(esc[i.id] ?? i.melhorParceiroId) === f.id} onChange={() => setEsc({ ...esc, [i.id]: f.id })} />} {brl(r.precoUnitCents)}<div className="muted">{r.prazoEntregaDias} d{r.vencedora ? ' · vencedora' : ''}</div></label> : '—'}</td>;
              })}</tr>)}</tbody></table></div>
            {c.status === 'ABERTA' && <>
              <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 8 }}>{c.fornecedores.map((f: any) => <button key={f.id} className="btn sm" onClick={() => { setLancar(f); setPrecos({}); setCond(''); }}>Lançar proposta: {f.fantasia || f.nome}</button>)}
                <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(texto)}>Copiar pedido de cotação</button></div>
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn primary" disabled={busy || !c.respostas.length} onClick={async () => { const r = await run(() => post<any>(`/erp/compras/cotacoes/${id}/encerrar`, { escolhas: esc }), 'Cotação encerrada'); if (r) { alert(`Pedidos de compra gerados: ${r.pedidos.map((p: any) => p.numero).join(', ')}`); st.reload(); } }}>Encerrar e gerar pedidos</button></div>
            </>}
            {lancar && <Modal title={`Proposta de ${lancar.fantasia || lancar.nome}`} onClose={() => setLancar(null)}>
              <table><thead><tr><th>Item</th><th>Preço un. (R$)</th><th>Prazo (dias)</th></tr></thead><tbody>{c.itens.map((i: any) => { const r = resp(i.id, lancar.id); const v = precos[i.id] ?? { preco: r ? fromCents(r.precoUnitCents) : '', prazo: r ? String(r.prazoEntregaDias) : '' }; return <tr key={i.id}><td className="small">{i.produto?.sku}</td><td><input style={{ width: 90 }} value={v.preco} inputMode="decimal" aria-label="Preço" onChange={(e) => setPrecos({ ...precos, [i.id]: { ...v, preco: e.target.value } })} /></td><td><input style={{ width: 60 }} value={v.prazo} inputMode="numeric" aria-label="Prazo" onChange={(e) => setPrecos({ ...precos, [i.id]: { ...v, prazo: e.target.value } })} /></td></tr>; })}</tbody></table>
              <Field label="Condição de pagamento"><input value={cond} onChange={(e) => setCond(e.target.value)} placeholder="28 dias" /></Field>
              <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={async () => { const respostas = Object.entries(precos).filter(([, v]) => v.preco).map(([itemId, v]) => ({ itemId, precoUnitCents: toCents(v.preco), prazoEntregaDias: Number(v.prazo) || 0 })); if (!respostas.length) return; if (await run(() => put(`/erp/compras/cotacoes/${id}/respostas`, { parceiroId: lancar.id, condicao: cond || null, respostas }), 'Proposta lançada')) { setLancar(null); st.reload(); } }}>Salvar proposta</button></div>
            </Modal>}
          </>
        );
      }}</Async>
    </Modal>
  );
}

function PedidosCompra() {
  const l = useApi<any[]>('/erp/compras/pedidos');
  const [novo, setNovo] = useState(false); const [aberto, setAberto] = useState<string | null>(null);
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setNovo(true)}>+ Pedido de compra</button>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhum pedido de compra">Crie direto aqui ou gere pela cotação.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Nº</th><th>Fornecedor</th><th>Total</th><th>Previsão</th><th>Status</th><th></th></tr></thead>
          <tbody>{d.map((p) => <tr key={p.id}><td>{p.numero}</td><td>{p.parceiro?.fantasia || p.parceiro?.nome}</td><td>{brl(p.totalCents)}</td><td>{p.previsaoEntrega ? new Date(p.previsaoEntrega).toLocaleDateString('pt-BR') : '—'}</td><td>{ST[p.status] ?? p.status}</td><td><button className="btn sm" onClick={() => setAberto(p.id)}>Abrir</button></td></tr>)}</tbody></table></div>
      )}</Async>
      {novo && <NovoPedidoCompra onClose={() => setNovo(false)} onDone={(id) => { setNovo(false); l.reload(); setAberto(id); }} />}
      {aberto && <PedidoCompra id={aberto} onClose={() => { setAberto(null); l.reload(); }} />}
    </>
  );
}

function NovoPedidoCompra({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [forn, setForn] = useState<any>(null); const [itens, setItens] = useState<LinhaItem[]>([]);
  const [f, setF] = useState({ frete: '0', previsao: '', condicao: '', obs: '' });
  const { busy, run } = useAction();
  const total = itens.reduce((a, i) => a + Math.round((toMil(i.qtd) * toCents(i.preco ?? '0')) / 1000), 0) + toCents(f.frete);
  return (
    <Modal title="Novo pedido de compra" onClose={onClose}>
      <Field label="Fornecedor">{forn ? <div className="row between"><strong>{forn.fantasia || forn.nome}</strong><button className="btn ghost sm" onClick={() => setForn(null)}>Trocar</button></div> : <BuscaParceiro tipo="fornecedor" onPick={setForn} />}</Field>
      <EditorItens itens={itens} setItens={setItens} comPreco />
      <div className="grid g2">
        <Field label="Frete (R$)"><input value={f.frete} onChange={(e) => setF({ ...f, frete: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Previsão de entrega"><input type="date" value={f.previsao} onChange={(e) => setF({ ...f, previsao: e.target.value })} /></Field>
        <Field label="Condição de pagamento"><input value={f.condicao} onChange={(e) => setF({ ...f, condicao: e.target.value })} /></Field>
      </div>
      <Field label="Observações"><input value={f.obs} onChange={(e) => setF({ ...f, obs: e.target.value })} /></Field>
      <div className="row between"><strong>Total {brl(total)}</strong><button className="btn primary" disabled={busy || !forn || !itens.length} onClick={async () => { const r = await run(() => post<any>('/erp/compras/pedidos', { parceiroId: forn.id, freteCents: toCents(f.frete), previsaoEntrega: f.previsao || null, condicao: f.condicao || null, observacoes: f.obs || null, itens: itens.map((i) => ({ produtoId: i.produto.id, qtdMil: toMil(i.qtd), precoUnitCents: toCents(i.preco ?? '0') })) }), 'Pedido criado'); if (r) onDone(r.id); }}>Criar pedido</button></div>
    </Modal>
  );
}

function PedidoCompra({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useApi<any>(`/erp/compras/pedidos/${id}`, [id]);
  const { busy, run } = useAction(); const { can } = useAuth();
  const acao = async (evento: string) => { const motivo = precisaMotivo(evento) ? prompt('Motivo') : undefined; if (precisaMotivo(evento) && !motivo) return; if (await run(() => post(`/erp/compras/pedidos/${id}/acao`, { evento, motivo }), 'Feito')) st.reload(); };
  function imprimir(p: any) {
    const w = window.open('', '_blank', 'width=800,height=900'); if (!w) return;
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    w.document.write(`<!doctype html><html><head><title>Pedido de compra ${p.numero}</title><style>body{font-family:Arial;margin:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px;text-align:left}</style></head><body><h2>Pedido de compra nº ${p.numero}</h2><p>Fornecedor: <b>${esc(p.parceiro?.nome)}</b> · CNPJ ${esc(p.parceiro?.documento)}</p><p>Previsão de entrega: ${p.previsaoEntrega ? new Date(p.previsaoEntrega).toLocaleDateString('pt-BR') : '—'} · Condição: ${esc(p.condicao ?? '—')}</p><table><tr><th>Produto</th><th>Qtd</th><th>Preço un.</th><th>Total</th></tr>${p.itens.map((i: any) => `<tr><td>${esc(i.produto?.sku)} · ${esc(i.descricao)}</td><td>${qtd(i.qtdMil)} ${esc(i.produto?.unidade)}</td><td>${brl(i.precoUnitCents)}</td><td>${brl(i.totalCents)}</td></tr>`).join('')}</table><p>Frete: ${brl(p.freteCents)} · <b>Total: ${brl(p.totalCents)}</b></p><p>${esc(p.observacoes ?? '')}</p><p>Informe o número deste pedido na nota fiscal.</p></body></html>`);
    w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 400);
  }
  return (
    <Modal title="Pedido de compra" onClose={onClose}>
      <Async state={st}>{(p) => (
        <>
          <p className="small"><b>Nº {p.numero}</b> · {p.parceiro?.fantasia || p.parceiro?.nome} · {ST[p.status] ?? p.status} · {brl(p.totalCents)}{p.precisaGestor && p.status === 'EM_APROVACAO' && <span className="badge red">acima da alçada</span>}</p>
          <table><thead><tr><th>Produto</th><th>Qtd</th><th>Recebido</th><th>Preço</th><th>Total</th></tr></thead>
            <tbody>{p.itens.map((i: any) => <tr key={i.id}><td className="small">{i.produto?.sku} · {i.descricao}</td><td>{qtd(i.qtdMil)}</td><td>{qtd(i.recebidoMil)}</td><td>{brl(i.precoUnitCents)}</td><td>{brl(i.totalCents)}</td></tr>)}</tbody></table>
          {p.nfes.length > 0 && <p className="small">Notas: {p.nfes.map((n: any) => `${n.numero}/${n.serie} (${n.status === 'LANCADA' ? 'lançada' : 'pendente'})`).join(', ')}</p>}
          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <button className="btn ghost" onClick={() => imprimir(p)}>Imprimir / PDF</button>
            {p.acoes.filter((a: string) => a !== 'APROVAR' || !p.precisaGestor || can('OWNER', 'ADMIN')).map((a: string) => <button key={a} className={`btn ${a === 'APROVAR' || a === 'ENVIAR' ? 'primary' : ''}`} disabled={busy} onClick={() => acao(a)}>{ACAO[a] ?? a}</button>)}
          </div>
        </>
      )}</Async>
    </Modal>
  );
}
