/** Lotes e etiquetas: busca por lote interno ou do fornecedor, escolhe cópias e imprime na Zebra ou impressora comum. */
import { useState } from 'react';
import { post, put } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, useToast } from '../../ui';
import { imprimirZebra, imprimirComum } from './impressao';

export default function Etiquetas() {
  const [q, setQ] = useState(''); const [query, setQuery] = useState('');
  const lotes = useApi<any[]>(`/erp/estoque/lotes?q=${encodeURIComponent(query)}`, [query]);
  const [sel, setSel] = useState<Record<string, number>>({});
  const [cfg, setCfg] = useState(false);
  const toast = useToast(); const { can } = useAuth();
  const itens = Object.entries(sel).filter(([, c]) => c > 0).map(([loteId, copias]) => ({ loteId, copias }));
  return (
    <>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><input placeholder="Lote interno ou do fornecedor" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar lote" /></form>
        <button className="btn" disabled={!itens.length} onClick={async () => imprimirComum(await post<any>('/erp/estoque/etiquetas', { itens }), 'a4')}>Imprimir em folha A4</button>
        <button className="btn" disabled={!itens.length} onClick={async () => imprimirComum(await post<any>('/erp/estoque/etiquetas', { itens }), 'rolo')}>Impressora de rolo comum</button>
        <button className="btn primary" disabled={!itens.length} onClick={async () => { const { zpl } = await post<any>('/erp/estoque/etiquetas/zpl', { itens }); toast((await imprimirZebra(zpl)) === 'impresso' ? 'Enviado para a Zebra' : 'Zebra Browser Print não encontrado: arquivo .zpl baixado'); }}>Imprimir na Zebra</button>
        {can('OWNER', 'ADMIN') && <button className="btn ghost" onClick={() => setCfg(true)}>Tamanho e formato</button>}
      </div>
      <Async state={lotes}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhum lote">Lotes nascem na entrada por XML ou na entrada manual de produtos com lote.</Empty></div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Cópias</th><th>Lote</th><th>Lote do fornecedor</th><th>Produto</th><th>Validade</th><th>Status</th></tr></thead>
          <tbody>{d.map((l) => <tr key={l.id}><td><input type="number" min={0} max={999} style={{ width: 64 }} value={sel[l.id] ?? 0} onChange={(e) => setSel({ ...sel, [l.id]: Number(e.target.value) })} aria-label="Cópias" /></td><td><b>{l.numero}</b></td><td>{l.loteFornecedor ?? '—'}</td><td>{l.produto?.sku} · {l.produto?.nome}</td><td>{l.validade ? new Date(l.validade).toLocaleDateString('pt-BR') : '—'}</td><td>{l.status}</td></tr>)}</tbody>
        </table></div>
      )}</Async>
      <p className="small muted">Zebra: instale o Zebra Browser Print (gratuito, site da Zebra) no computador ligado à impressora. Sem ele, o sistema baixa o arquivo .zpl.</p>
      {cfg && <ConfigEtiqueta onClose={() => setCfg(false)} />}
    </>
  );
}

function ConfigEtiqueta({ onClose }: { onClose: () => void }) {
  const st = useApi<any>('/erp/produtos/config');
  const [f, setF] = useState<any>(null);
  const { busy, run } = useAction();
  const v = f ?? (st.data && { formatoLote: st.data.formatoLote, etiquetaLarguraMm: String(st.data.etiquetaLarguraMm), etiquetaAlturaMm: String(st.data.etiquetaAlturaMm), etiquetaDpi: String(st.data.etiquetaDpi) });
  return (
    <Modal title="Etiquetas e lote interno" onClose={onClose}>
      {v && <>
        <Field label="Formato do lote interno" hint="{AAAA} {AA} {MM} {DD} {SKU} {SEQ} — ex.: {AA}{MM}{DD}-{SEQ}"><input value={v.formatoLote} onChange={(e) => setF({ ...v, formatoLote: e.target.value })} /></Field>
        <div className="grid g2">
          <Field label="Largura (mm)"><input value={v.etiquetaLarguraMm} onChange={(e) => setF({ ...v, etiquetaLarguraMm: e.target.value })} inputMode="numeric" /></Field>
          <Field label="Altura (mm)"><input value={v.etiquetaAlturaMm} onChange={(e) => setF({ ...v, etiquetaAlturaMm: e.target.value })} inputMode="numeric" /></Field>
          <Field label="Resolução Zebra"><select value={v.etiquetaDpi} onChange={(e) => setF({ ...v, etiquetaDpi: e.target.value })}><option value="203">203 dpi</option><option value="300">300 dpi</option></select></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => put('/erp/produtos/config', { formatoLote: v.formatoLote, etiquetaLarguraMm: Number(v.etiquetaLarguraMm), etiquetaAlturaMm: Number(v.etiquetaAlturaMm), etiquetaDpi: Number(v.etiquetaDpi) }), 'Salvo')) onClose(); }}>Salvar</button></div>
      </>}
    </Modal>
  );
}
