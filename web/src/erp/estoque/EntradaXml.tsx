/** Entrada por XML de NF-e: importa, vincula itens a produtos (fator de conversão), lança com lote interno e imprime etiquetas. */
import { useState } from 'react';
import { get, post, put } from '../../api';
import { useApi, Async, Empty, Modal, Field, useAction, useToast, fmtDate } from '../../ui';
import { brl, qtd, toMil } from '../format';
import { imprimirZebra, imprimirComum } from './impressao';

export default function EntradaXml({ depositos, onLancada }: { depositos: any[]; onLancada: () => void }) {
  const lista = useApi<any[]>('/erp/estoque/nfe');
  const [aberta, setAberta] = useState<string | null>(null);
  const { run } = useAction();
  async function arquivos(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      const xml = await f.text();
      const r = await run(() => post<any>('/erp/estoque/nfe/importar', { xml }), `${f.name} importado`);
      if (r?.avisos?.length) alert(r.avisos.join('\n'));
      if (r?.id && (files?.length ?? 0) === 1) setAberta(r.id);
    }
    lista.reload();
  }
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <label className="btn primary">Importar XML da NF-e<input type="file" accept=".xml,text/xml" multiple hidden onChange={(e) => { arquivos(e.target.files); e.target.value = ''; }} /></label>
        <span className="small muted" style={{ marginLeft: 10 }}>O fornecedor é cadastrado pelo XML e os itens já vinculados entram sozinhos nas próximas notas.</span>
      </div>
      <Async state={lista}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma NF-e importada">Importe o XML que o fornecedor enviou.</Empty></div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>NF-e</th><th>Fornecedor</th><th>Emissão</th><th>Valor</th><th>Status</th><th></th></tr></thead>
          <tbody>{d.map((n) => <tr key={n.id}><td>{n.numero}/{n.serie}{!n.autorizada && <span className="badge red">sem protocolo</span>}</td><td>{n.emitenteNome}</td><td>{n.dataEmissao ? new Date(n.dataEmissao).toLocaleDateString('pt-BR') : '—'}</td><td>{brl(n.valorTotalCents)}</td><td><span className={`badge ${n.status === 'LANCADA' ? 'green' : ''}`}>{n.status === 'LANCADA' ? 'Lançada' : 'Pendente'}</span></td><td><button className="btn sm" onClick={() => setAberta(n.id)}>Abrir</button></td></tr>)}</tbody>
        </table></div>
      )}</Async>
      {aberta && <NfeDetalhe id={aberta} depositos={depositos} onClose={() => { setAberta(null); lista.reload(); }} onLancada={onLancada} />}
    </>
  );
}

function NfeDetalhe({ id, depositos, onClose, onLancada }: { id: string; depositos: any[]; onClose: () => void; onLancada: () => void }) {
  const st = useApi<any>(`/erp/estoque/nfe/${id}`, [id]);
  const [vinc, setVinc] = useState<any>(null);
  const [f, setF] = useState({ enderecoId: '', quarentena: false, usarLoteFornecedor: false });
  const [manuais, setManuais] = useState<Record<string, { numero: string; qtd: string; validade: string }>>({});
  const { busy, run } = useAction();
  const toast = useToast();
  const enderecos = depositos.flatMap((d) => d.enderecos.map((e: any) => ({ id: e.id, label: `${d.nome} · ${e.codigo}` })));
  async function lancar(n: any) {
    const lotesManuais: Record<string, any[]> = {};
    for (const i of n.itens) { const m = manuais[i.id]; if (m?.numero || m?.validade) lotesManuais[i.id] = [{ numero: m.numero || 'S/N', qtdMil: Math.round((i.qtdMil * i.fatorMil) / 1000), validade: m.validade || null }]; }
    const r = await run(() => post<any>(`/erp/estoque/nfe/${id}/lancar`, { ...f, lotesManuais }), 'NF-e lançada no estoque');
    if (r) { st.reload(); onLancada(); }
  }
  async function etiquetas(n: any, zebra: boolean) {
    const itens = n.itens.flatMap((i: any) => i.lotesGerados.map((l: any) => ({ loteId: l.id, copias: 1 })));
    if (zebra) { const { zpl } = await post<any>('/erp/estoque/etiquetas/zpl', { itens }); toast((await imprimirZebra(zpl)) === 'impresso' ? 'Enviado para a Zebra' : 'Zebra Browser Print não encontrado: arquivo .zpl baixado'); }
    else imprimirComum(await post<any>('/erp/estoque/etiquetas', { itens }), 'a4');
  }
  return (
    <Modal title="NF-e de entrada" onClose={onClose}>
      <Async state={st}>{(n) => (
        <>
          <p className="small"><strong>{n.emitenteNome}</strong> · NF {n.numero}/{n.serie} · {brl(n.valorTotalCents)} · chave <code style={{ fontSize: 10 }}>{n.chave}</code></p>
          <table><thead><tr><th>#</th><th>Item do fornecedor</th><th>Qtd</th><th>Produto interno</th><th>Lotes</th></tr></thead>
            <tbody>{n.itens.map((i: any) => (
              <tr key={i.id}>
                <td>{i.nItem}</td>
                <td><div className="small">{i.codigo} · {i.descricao}</div><div className="small muted">custo {brl(i.custoTotalCents)}</div></td>
                <td>{qtd(i.qtdMil)} {i.unidade}{i.fatorMil !== 1000 && i.produto && <div className="small muted">= {qtd(Math.round((i.qtdMil * i.fatorMil) / 1000))} {i.produto.unidade}</div>}</td>
                <td>{i.produto ? <span className="small">{i.produto.sku} · {i.produto.nome}</span> : <span className="badge red">sem vínculo</span>}{n.status === 'PENDENTE' && <button className="btn ghost sm" onClick={() => setVinc(i)}>{i.produto ? 'Trocar' : 'Vincular'}</button>}</td>
                <td className="small">
                  {i.lotesGerados.length ? i.lotesGerados.map((l: any) => <div key={l.id}><b>{l.numero}</b>{l.loteFornecedor ? ` ← ${l.loteFornecedor}` : ''}</div>)
                    : i.lotes.length ? i.lotes.map((l: any) => <div key={l.numero}>{l.numero}{l.validade ? ` · val ${l.validade.split('-').reverse().join('/')}` : ''}</div>)
                    : i.produto?.controlaLote && n.status === 'PENDENTE' ? <>
                      <input placeholder="Lote do fornecedor" style={{ width: 120 }} value={manuais[i.id]?.numero ?? ''} onChange={(e) => setManuais({ ...manuais, [i.id]: { ...manuais[i.id], numero: e.target.value } as any })} />
                      {i.produto.controlaValidade && <input type="date" aria-label="Validade" value={manuais[i.id]?.validade ?? ''} onChange={(e) => setManuais({ ...manuais, [i.id]: { ...manuais[i.id], validade: e.target.value } as any })} />}
                    </> : '—'}
                </td>
              </tr>
            ))}</tbody></table>
          {n.status === 'PENDENTE' ? <>
            <div className="grid g2" style={{ marginTop: 10 }}>
              <Field label="Guardar no endereço"><select value={f.enderecoId} onChange={(e) => setF({ ...f, enderecoId: e.target.value })}><option value="">Escolha…</option>{enderecos.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
            </div>
            <label className="row small"><input type="checkbox" checked={f.quarentena} onChange={(e) => setF({ ...f, quarentena: e.target.checked })} /> Entrar em quarentena (inspeção de qualidade)</label>
            <label className="row small"><input type="checkbox" checked={f.usarLoteFornecedor} onChange={(e) => setF({ ...f, usarLoteFornecedor: e.target.checked })} /> Usar o lote do fornecedor como lote interno (sem gerar novo)</label>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !f.enderecoId} onClick={() => lancar(n)}>Lançar no estoque</button></div>
          </> : (
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              <span className="small muted">Lançada {fmtDate(n.lancadaEm)}</span>
              <button className="btn" onClick={() => etiquetas(n, false)}>Etiquetas (impressora comum)</button>
              <button className="btn primary" onClick={() => etiquetas(n, true)}>Etiquetas Zebra</button>
            </div>
          )}
          {vinc && <Vincular nfeId={n.id} item={vinc} onClose={() => setVinc(null)} onDone={() => { setVinc(null); st.reload(); }} />}
        </>
      )}</Async>
    </Modal>
  );
}

function Vincular({ nfeId, item, onClose, onDone }: { nfeId: string; item: any; onClose: () => void; onDone: () => void }) {
  const [busca, setBusca] = useState(''); const [ops, setOps] = useState<any[]>([]);
  const [prod, setProd] = useState<any>(null); const [criar, setCriar] = useState(false);
  const [f, setF] = useState({ fator: '1', sku: item.codigo.toUpperCase().slice(0, 40), lote: false, validade: false });
  const { busy, run } = useAction();
  async function salvar() {
    const body = { fatorMil: toMil(f.fator), lembrar: true, ...(criar ? { criarProduto: { sku: f.sku, controlaLote: f.lote, controlaValidade: f.validade } } : { produtoId: prod.id }) };
    if (await run(() => put(`/erp/estoque/nfe/${nfeId}/itens/${item.id}`, body), 'Item vinculado')) onDone();
  }
  return (
    <Modal title={`Vincular: ${item.descricao}`} onClose={onClose}>
      <div className="row"><button className={`btn sm ${!criar ? 'primary' : ''}`} onClick={() => setCriar(false)}>Produto existente</button><button className={`btn sm ${criar ? 'primary' : ''}`} onClick={() => setCriar(true)}>Criar produto com este item</button></div>
      {!criar ? (prod ? <div className="row between"><strong>{prod.sku} · {prod.nome}</strong><button className="btn ghost sm" onClick={() => setProd(null)}>Trocar</button></div> : (
        <Field label="Produto"><input autoFocus value={busca} onChange={async (e) => { setBusca(e.target.value); setOps(e.target.value.length >= 2 ? (await get<any>(`/erp/produtos?q=${encodeURIComponent(e.target.value)}`)).items.slice(0, 8) : []); }} />
          {ops.map((o) => <button key={o.id} type="button" className="btn ghost sm" style={{ display: 'block' }} onClick={() => setProd(o)}>{o.sku} · {o.nome}</button>)}</Field>
      )) : <>
        <Field label="SKU do novo produto"><input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <label className="row small"><input type="checkbox" checked={f.lote} onChange={(e) => setF({ ...f, lote: e.target.checked })} /> Controla lote</label>
        <label className="row small"><input type="checkbox" checked={f.validade} onChange={(e) => setF({ ...f, validade: e.target.checked })} /> Controla validade (FEFO)</label>
      </>}
      <Field label={`1 ${item.unidade} do fornecedor = quantas unidades suas?`} hint="Ex.: caixa com 12 → 12"><input value={f.fator} onChange={(e) => setF({ ...f, fator: e.target.value })} inputMode="decimal" /></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || (!criar && !prod) || toMil(f.fator) <= 0} onClick={salvar}>Salvar vínculo</button></div>
    </Modal>
  );
}
