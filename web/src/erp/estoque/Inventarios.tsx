/** Inventário geral ou cíclico com contagem cega por leitura de QR (endereço + lote), aprovação e ajuste. */
import { useState, useRef } from 'react';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, useToast, fmtDate } from '../../ui';
import { qtd, toMil } from '../format';

export default function Inventarios({ depositos, onAjustado }: { depositos: any[]; onAjustado: () => void }) {
  const lista = useApi<any[]>('/erp/estoque/inventarios');
  const [novo, setNovo] = useState(false); const [aberto, setAberto] = useState<string | null>(null);
  const [f, setF] = useState({ descricao: '', depositoId: '', cego: true });
  const { busy, run } = useAction();
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setNovo(true)}>+ Inventário</button>
      <Async state={lista}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhum inventário">Abra um inventário para conferir o estoque físico.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Descrição</th><th>Status</th><th>Aberto</th><th></th></tr></thead>
          <tbody>{d.map((i) => <tr key={i.id}><td>{i.descricao}{i.cego && <span className="badge">cego</span>}</td><td>{i.status}</td><td>{fmtDate(i.createdAt)}</td><td><button className="btn sm" onClick={() => setAberto(i.id)}>Abrir</button></td></tr>)}</tbody></table></div>
      )}</Async>
      {novo && <Modal title="Novo inventário" onClose={() => setNovo(false)}>
        <Field label="Descrição"><input autoFocus value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} placeholder="Inventário geral novembro" /></Field>
        <Field label="Depósito"><select value={f.depositoId} onChange={(e) => setF({ ...f, depositoId: e.target.value })}><option value="">Todos</option>{depositos.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}</select></Field>
        <label className="row small"><input type="checkbox" checked={f.cego} onChange={(e) => setF({ ...f, cego: e.target.checked })} /> Contagem cega (contador não vê o saldo do sistema)</label>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || f.descricao.length < 2} onClick={async () => { const r = await run(() => post<any>('/erp/estoque/inventarios', { ...f, depositoId: f.depositoId || null }), 'Inventário aberto'); if (r) { setNovo(false); lista.reload(); setAberto(r.id); } }}>Abrir</button></div>
      </Modal>}
      {aberto && <Inventario id={aberto} onClose={() => { setAberto(null); lista.reload(); }} onAjustado={onAjustado} />}
    </>
  );
}

function Inventario({ id, onClose, onAjustado }: { id: string; onClose: () => void; onAjustado: () => void }) {
  const st = useApi<any>(`/erp/estoque/inventarios/${id}`, [id]);
  const [c, setC] = useState({ endereco: '', codigo: '', qtd: '' });
  const codRef = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction(); const toast = useToast(); const { can } = useAuth();
  const acao = async (acao: string) => { if (await run(() => post(`/erp/estoque/inventarios/${id}/acao`, { acao }), 'Feito')) { st.reload(); if (acao === 'APROVAR') onAjustado(); } };
  async function contar() {
    try { await post(`/erp/estoque/inventarios/${id}/contar`, { endereco: c.endereco, codigo: c.codigo, qtdMil: toMil(c.qtd || '0') }); toast('Contado'); setC({ ...c, codigo: '', qtd: '' }); codRef.current?.focus(); st.reload(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }
  return (
    <Modal title="Inventário" onClose={onClose}>
      <Async state={st}>{(inv) => (
        <>
          <p className="small"><b>{inv.descricao}</b> · {inv.status}{inv.cego ? ' · cego' : ''}</p>
          {inv.status === 'CONTANDO' && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); contar(); }} style={{ marginBottom: 8 }}>
              <input placeholder="Endereço (QR)" value={c.endereco} onChange={(e) => setC({ ...c, endereco: e.target.value })} style={{ width: 110 }} aria-label="Endereço" />
              <input ref={codRef} placeholder="Lote / SKU (QR)" value={c.codigo} onChange={(e) => setC({ ...c, codigo: e.target.value })} style={{ flex: 1 }} aria-label="Código" />
              <input placeholder="Qtd" value={c.qtd} onChange={(e) => setC({ ...c, qtd: e.target.value })} style={{ width: 70 }} inputMode="decimal" aria-label="Quantidade" />
              <button className="btn primary">Contar</button>
            </form>
          )}
          <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}><table>
            <thead><tr><th>Endereço</th><th>Produto</th><th>Lote</th><th>Sistema</th><th>Contado</th><th>Diferença</th></tr></thead>
            <tbody>{inv.contagens.map((x: any) => <tr key={x.id}><td>{x.endereco}</td><td className="small">{x.produto?.sku} · {x.produto?.nome}</td><td>{x.lote ?? '—'}</td><td>{x.sistemaMil == null ? '•••' : qtd(x.sistemaMil)}</td><td>{x.contadoMil == null ? '—' : qtd(x.contadoMil)}</td><td style={{ color: x.diferencaMil ? (x.diferencaMil < 0 ? '#dc2626' : '#16a34a') : undefined }}>{x.diferencaMil == null ? '' : `${x.diferencaMil > 0 ? '+' : ''}${qtd(x.diferencaMil)}`}</td></tr>)}</tbody>
          </table></div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            {inv.status === 'CONTANDO' && <button className="btn primary" disabled={busy} onClick={() => confirm('Linhas não contadas serão consideradas zero. Enviar para aprovação?') && acao('ENVIAR')}>Encerrar contagem</button>}
            {inv.status === 'EM_APROVACAO' && can('OWNER', 'ADMIN') && <><button className="btn" onClick={() => acao('RECONTAR')}>Recontar</button><button className="btn primary" disabled={busy} onClick={() => acao('APROVAR')}>Aprovar e ajustar estoque</button></>}
            {['CONTANDO', 'EM_APROVACAO'].includes(inv.status) && can('OWNER', 'ADMIN') && <button className="btn ghost" onClick={() => acao('CANCELAR')}>Cancelar</button>}
          </div>
        </>
      )}</Async>
    </Modal>
  );
}
