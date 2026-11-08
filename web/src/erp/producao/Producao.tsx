/** Produção: ordens de produção (liberação, apontamento, encerramento), estrutura/roteiro com custo padrão e MRP. */
import { useState } from 'react';
import { get, post, put } from '../../api';
import { useApi, Async, Empty, Modal, Field, useAction, fmtDate } from '../../ui';
import { brl, qtd, toMil, toCents, fromCents } from '../format';
import { BuscaProduto } from '../comum';

const ST: Record<string, string> = { PLANEJADA: 'Planejada', LIBERADA: 'Liberada', EM_PRODUCAO: 'Em produção', ENCERRADA: 'Encerrada', CANCELADA: 'Cancelada' };
const ACAO: Record<string, string> = { LIBERAR: 'Liberar (reserva componentes)', INICIAR: 'Iniciar', ENCERRAR: 'Encerrar', CANCELAR: 'Cancelar', ESTORNAR_LIBERACAO: 'Estornar liberação' };

export default function Producao() {
  const [aba, setAba] = useState<'ops' | 'estr' | 'mrp'>('ops');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Produção</h1><p className="muted">Estrutura → ordem de produção → consumo e lote com rastreio → MRP do que comprar e produzir.</p></div></div>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {(['ops', 'estr', 'mrp'] as const).map((a) => <button key={a} className={`btn sm ${aba === a ? 'primary' : ''}`} onClick={() => setAba(a)}>{{ ops: 'Ordens de produção', estr: 'Estruturas e roteiros', mrp: 'MRP' }[a]}</button>)}
      </div>
      {aba === 'ops' && <Ops />}
      {aba === 'estr' && <Estruturas />}
      {aba === 'mrp' && <Mrp />}
    </div>
  );
}

function Ops() {
  const l = useApi<any[]>('/erp/producao/ops');
  const [nova, setNova] = useState(false); const [aberta, setAberta] = useState<string | null>(null);
  const [f, setF] = useState<any>({ produto: null, qtd: '', inicio: '', fim: '' });
  const { busy, run } = useAction();
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => { setF({ produto: null, qtd: '', inicio: '', fim: '' }); setNova(true); }}>+ Ordem de produção</button>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma OP">Cadastre a estrutura do produto e abra uma ordem, ou aplique o MRP.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Nº</th><th>Produto</th><th>Planejado</th><th>Produzido</th><th>Origem</th><th>Status</th><th></th></tr></thead>
          <tbody>{d.map((o) => <tr key={o.id}><td>{o.numero}</td><td>{o.produto?.sku} · {o.produto?.nome}</td><td>{qtd(o.qtdPlanejadaMil)}</td><td>{qtd(o.qtdProduzidaMil)}{o.qtdRefugoMil > 0 && <span className="small muted"> (+{qtd(o.qtdRefugoMil)} refugo)</span>}</td><td>{o.origem}</td><td>{ST[o.status]}</td><td><button className="btn sm" onClick={() => setAberta(o.id)}>Abrir</button></td></tr>)}</tbody></table></div>
      )}</Async>
      {nova && <Modal title="Nova ordem de produção" onClose={() => setNova(false)}>
        <Field label="Produto">{f.produto ? <div className="row between"><strong>{f.produto.sku} · {f.produto.nome}</strong><button className="btn ghost sm" onClick={() => setF({ ...f, produto: null })}>Trocar</button></div> : <BuscaProduto filtro={(p) => p.tipo === 'PRODUZIDO'} onPick={(p) => setF({ ...f, produto: p })} />}</Field>
        <div className="grid g2">
          <Field label="Quantidade"><input value={f.qtd} onChange={(e) => setF({ ...f, qtd: e.target.value })} inputMode="decimal" /></Field>
          <Field label="Início previsto"><input type="date" value={f.inicio} onChange={(e) => setF({ ...f, inicio: e.target.value })} /></Field>
          <Field label="Fim previsto"><input type="date" value={f.fim} onChange={(e) => setF({ ...f, fim: e.target.value })} /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !f.produto || toMil(f.qtd) <= 0} onClick={async () => { const r = await run(() => post<any>('/erp/producao/ops', { produtoId: f.produto.id, qtdPlanejadaMil: toMil(f.qtd), inicioPrevisto: f.inicio || null, fimPrevisto: f.fim || null }), 'OP criada'); if (r) { setNova(false); l.reload(); setAberta(r.id); } }}>Criar OP</button></div>
      </Modal>}
      {aberta && <Op id={aberta} onClose={() => { setAberta(null); l.reload(); }} />}
    </>
  );
}

function Op({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useApi<any>(`/erp/producao/ops/${id}`, [id]);
  const deps = useApi<any[]>('/erp/estoque/depositos');
  const [ap, setAp] = useState({ boa: '', refugo: '0', enderecoId: '', validade: '', encerrar: false });
  const { busy, run } = useAction();
  const enderecos = (deps.data ?? []).flatMap((d: any) => d.enderecos.map((e: any) => ({ id: e.id, label: `${d.nome} · ${e.codigo}` })));
  const acao = async (evento: string) => { const motivo = evento === 'CANCELAR' ? prompt('Motivo do cancelamento') : undefined; if (evento === 'CANCELAR' && !motivo) return; if (await run(() => post(`/erp/producao/ops/${id}/acao`, { evento, motivo }), 'Feito')) st.reload(); };
  return (
    <Modal title="Ordem de produção" onClose={onClose}>
      <Async state={st}>{(o) => (
        <>
          <p className="small"><b>OP {o.numero}</b> · {o.produto?.sku} · {o.produto?.nome} · {ST[o.status]} · planejado {qtd(o.qtdPlanejadaMil)} · produzido {qtd(o.qtdProduzidaMil)}</p>
          <table><thead><tr><th>Componente</th><th>Previsto</th><th>Reservado</th><th>Consumido</th></tr></thead>
            <tbody>{o.componentes.map((c: any) => <tr key={c.id}><td className="small">{c.produto?.sku} · {c.produto?.nome}</td><td>{qtd(c.qtdPrevistaMil)}</td><td>{qtd(c.qtdReservadaMil)}</td><td>{qtd(c.qtdConsumidaMil)}</td></tr>)}</tbody></table>
          {(o.custoMaterialCents > 0 || o.custoOperacaoCents > 0) && <p className="small">Custo real: materiais {brl(o.custoMaterialCents)} + operações {brl(o.custoOperacaoCents)}{o.qtdProduzidaMil > 0 && ` = ${brl(Math.round(((o.custoMaterialCents + o.custoOperacaoCents) * 1000) / o.qtdProduzidaMil))} por unidade`}</p>}
          {['LIBERADA', 'EM_PRODUCAO'].includes(o.status) && <div className="card" style={{ marginTop: 8 }}>
            <strong className="small">Apontar produção</strong>
            <div className="grid g2">
              <Field label="Quantidade boa"><input value={ap.boa} onChange={(e) => setAp({ ...ap, boa: e.target.value })} inputMode="decimal" /></Field>
              <Field label="Refugo"><input value={ap.refugo} onChange={(e) => setAp({ ...ap, refugo: e.target.value })} inputMode="decimal" /></Field>
              <Field label="Guardar em"><select value={ap.enderecoId} onChange={(e) => setAp({ ...ap, enderecoId: e.target.value })}><option value="">Escolha…</option>{enderecos.map((e: any) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
              {o.produto?.controlaValidade && <Field label="Validade do lote"><input type="date" value={ap.validade} onChange={(e) => setAp({ ...ap, validade: e.target.value })} /></Field>}
            </div>
            <label className="row small"><input type="checkbox" checked={ap.encerrar} onChange={(e) => setAp({ ...ap, encerrar: e.target.checked })} /> Encerrar a OP neste apontamento (libera as reservas que sobrarem)</label>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !ap.enderecoId || toMil(ap.boa) + toMil(ap.refugo) <= 0} onClick={async () => { if (await run(() => post(`/erp/producao/ops/${id}/apontar`, { qtdBoaMil: toMil(ap.boa), qtdRefugoMil: toMil(ap.refugo), enderecoId: ap.enderecoId, validade: ap.validade || null, encerrar: ap.encerrar }), 'Produção apontada')) { setAp({ ...ap, boa: '', refugo: '0' }); st.reload(); } }}>Apontar</button></div>
          </div>}
          {o.apontamentos.length > 0 && <table style={{ marginTop: 8 }}><thead><tr><th>Quando</th><th>Boa</th><th>Refugo</th><th>Lote</th><th>Custo un.</th></tr></thead><tbody>{o.apontamentos.map((a: any) => <tr key={a.id}><td>{fmtDate(a.createdAt)}</td><td>{qtd(a.qtdBoaMil)}</td><td>{qtd(a.qtdRefugoMil)}</td><td>{a.lote ?? '—'}</td><td>{brl(a.custoUnitCents)}</td></tr>)}</tbody></table>}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>{o.acoes.map((a: string) => <button key={a} className={`btn ${a === 'LIBERAR' ? 'primary' : ''}`} disabled={busy} onClick={() => acao(a)}>{ACAO[a] ?? a}</button>)}</div>
        </>
      )}</Async>
    </Modal>
  );
}

function Estruturas() {
  const [prod, setProd] = useState<any>(null);
  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}><Field label="Produto a estruturar (vira tipo Produzido ao salvar)">{prod ? <div className="row between"><strong>{prod.sku} · {prod.nome}</strong><button className="btn ghost sm" onClick={() => setProd(null)}>Trocar</button></div> : <BuscaProduto filtro={(p) => p.tipo !== 'SERVICO'} onPick={setProd} />}</Field></div>
      {prod && <EditorEstrutura key={prod.id} produtoId={prod.id} />}
    </>
  );
}

function EditorEstrutura({ produtoId }: { produtoId: string }) {
  const st = useApi<any>(`/erp/producao/estruturas/${produtoId}`, [produtoId]);
  const [itens, setItens] = useState<any[] | null>(null); const [ops, setOps] = useState<any[] | null>(null);
  const { busy, run } = useAction();
  return (
    <Async state={st}>{(d) => {
      const I = itens ?? d.itens.map((i: any) => ({ componente: i.componente, qtd: qtd(i.qtdMil).replace(/\./g, ''), perda: String(i.perdaBp / 100).replace('.', ',') }));
      const O = ops ?? d.operacoes.map((o: any) => ({ descricao: o.descricao, centro: o.centroTrabalho, seg: String(o.segundosPorUn), setup: String(o.setupMinutos), custoHora: fromCents(o.custoHoraCents) }));
      return (
        <div className="card">
          <p className="small">Custo padrão atual: <b>{brl(d.custoPadraoCents)}</b> por {d.produto.unidade}{d.usadoEm.length > 0 && ` · usado em ${d.usadoEm.map((p: any) => p.sku).join(', ')}`}</p>
          <strong className="small">Componentes (por 1 {d.produto.unidade})</strong>
          <table><thead><tr><th>Componente</th><th>Qtd</th><th>Perda %</th><th></th></tr></thead><tbody>{I.map((i: any, n: number) => <tr key={i.componente.id}><td className="small">{i.componente.sku} · {i.componente.nome}</td>
            <td><input style={{ width: 80 }} value={i.qtd} inputMode="decimal" aria-label="Quantidade" onChange={(e) => setItens(I.map((x: any, k: number) => (k === n ? { ...x, qtd: e.target.value } : x)))} /></td>
            <td><input style={{ width: 60 }} value={i.perda} inputMode="decimal" aria-label="Perda" onChange={(e) => setItens(I.map((x: any, k: number) => (k === n ? { ...x, perda: e.target.value } : x)))} /></td>
            <td><button className="btn ghost sm" aria-label="Remover" onClick={() => setItens(I.filter((_: any, k: number) => k !== n))}>✕</button></td></tr>)}</tbody></table>
          <BuscaProduto placeholder="Adicionar componente" filtro={(p) => p.id !== produtoId && p.tipo !== 'SERVICO' && !I.some((i: any) => i.componente.id === p.id)} onPick={(p) => setItens([...I, { componente: p, qtd: '1', perda: '0' }])} />
          <strong className="small" style={{ display: 'block', marginTop: 10 }}>Roteiro (operações)</strong>
          <table><thead><tr><th>Operação</th><th>Centro de trabalho</th><th>Seg/un</th><th>Setup (min)</th><th>R$/hora</th><th></th></tr></thead><tbody>{O.map((o: any, n: number) => <tr key={n}>
            {(['descricao', 'centro', 'seg', 'setup', 'custoHora'] as const).map((k) => <td key={k}><input style={{ width: k === 'descricao' || k === 'centro' ? 130 : 70 }} value={o[k]} aria-label={k} onChange={(e) => setOps(O.map((x: any, j: number) => (j === n ? { ...x, [k]: e.target.value } : x)))} /></td>)}
            <td><button className="btn ghost sm" aria-label="Remover" onClick={() => setOps(O.filter((_: any, j: number) => j !== n))}>✕</button></td></tr>)}</tbody></table>
          <button className="btn sm ghost" onClick={() => setOps([...O, { descricao: '', centro: '', seg: '0', setup: '0', custoHora: '0,00' }])}>+ Operação</button>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn primary" disabled={busy} onClick={async () => {
            const body = { itens: I.map((i: any) => ({ componenteId: i.componente.id, qtdMil: toMil(i.qtd), perdaBp: Math.round(Number(String(i.perda).replace(',', '.')) * 100) || 0 })), operacoes: O.filter((o: any) => o.descricao && o.centro).map((o: any) => ({ descricao: o.descricao, centroTrabalho: o.centro, segundosPorUn: Number(o.seg) || 0, setupMinutos: Number(o.setup) || 0, custoHoraCents: toCents(o.custoHora) })) };
            if (await run(() => put(`/erp/producao/estruturas/${produtoId}`, body), 'Estrutura salva')) { setItens(null); setOps(null); st.reload(); }
          }}>Salvar estrutura</button></div>
        </div>
      );
    }}</Async>
  );
}

function Mrp() {
  const st = useApi<any[]>('/erp/producao/mrp');
  const [sel, setSel] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  return (
    <Async state={st}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nada a comprar ou produzir">Pedidos aprovados, OPs abertas, estoque mínimo e estimativa de compra estão cobertos.</Empty></div> : (
      <>
        <div className="card table-wrap"><table><thead><tr><th></th><th>Ação</th><th>Produto</th><th>Necessidade</th><th>Sugerido</th><th>Fornecedor padrão</th><th>Cálculo</th></tr></thead>
          <tbody>{d.map((s) => { const v = sel[s.produtoId]; return <tr key={s.produtoId}>
            <td><input type="checkbox" aria-label="Aplicar" checked={v !== undefined} onChange={(e) => { const n = { ...sel }; if (e.target.checked) n[s.produtoId] = qtd(s.qtdMil).replace(/\./g, ''); else delete n[s.produtoId]; setSel(n); }} /></td>
            <td><span className={`badge ${s.acao === 'PRODUZIR' ? '' : 'green'}`}>{s.acao === 'PRODUZIR' ? 'Produzir' : 'Comprar'}</span></td>
            <td>{s.sku} · {s.nome}</td><td>{qtd(s.necessidadeMil)} {s.unidade}</td>
            <td>{v !== undefined ? <input style={{ width: 80 }} value={v} inputMode="decimal" aria-label="Quantidade" onChange={(e) => setSel({ ...sel, [s.produtoId]: e.target.value })} /> : `${qtd(s.qtdMil)} ${s.unidade}`}</td>
            <td>{s.fornecedor ?? '—'}</td><td className="small muted">{s.motivo}</td></tr>; })}</tbody></table></div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn" onClick={() => setSel(Object.fromEntries(d.map((s) => [s.produtoId, qtd(s.qtdMil).replace(/\./g, '')])))}>Marcar todas</button>
          <button className="btn primary" disabled={busy || !Object.keys(sel).length} onClick={async () => {
            const itens = d.filter((s) => sel[s.produtoId] !== undefined).map((s) => ({ produtoId: s.produtoId, acao: s.acao, qtdMil: toMil(sel[s.produtoId]) })).filter((i) => i.qtdMil > 0);
            const r = await run(() => post<any>('/erp/producao/mrp/aplicar', { itens }), 'Sugestões aplicadas');
            if (r) { alert(`${r.ops.length ? `OPs criadas: ${r.ops.map((o: any) => o.numero).join(', ')}. ` : ''}${r.solicitacao ? `Solicitação de compra nº ${r.solicitacao.numero} enviada para aprovação.` : ''}`); setSel({}); st.reload(); }
          }}>Gerar OPs e solicitação de compra</button>
        </div>
      </>
    )}</Async>
  );
}
