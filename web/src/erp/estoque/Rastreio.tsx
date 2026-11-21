/**
 * Rastreio de lote (v1.33.0): um campo só aceita código/nome/código de barras do produto, lote interno, lote do
 * fornecedor, número ou chave da NF (entrada ou saída) e número de pedido (venda ou compra). Mostra os lotes ligados
 * e, ao abrir um lote, a linha do tempo completa, onde está hoje, para onde foi, de onde veio e os clientes alcançados.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi, Async, Empty } from '../../ui';
import { qtdUn } from '../../../../server/erp/shared/unidade';
import { LoteCard, CampoLeitura, dataBr } from './lotes';
import { Ajuda } from '../pagina';

const COR: Record<string, string> = { entrada: '#16a34a', producao: '#16a34a', devolucao: '#16a34a', saida: '#dc2626', consumo: '#b45309', baixa: '#dc2626', inventario: '#7c3aed', transferencia: '#2563eb', reserva: '#64748b', separacao: '#0891b2', qualidade: '#64748b' };
const hora = (d: string) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

export default function Rastreio() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? ''; const loteId = sp.get('lote'); const pedidoId = sp.get('pedido');
  const ir = (p: Record<string, string>) => setSp(p);
  return (
    <>
      <div className="page-head erp-cab">
        <div className="erp-titulo"><h1>Rastreio de lote</h1><Ajuda>Digite ou leia: código do produto, lote, lote do fornecedor, número/chave da nota ou número do pedido.</Ajuda></div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <CampoLeitura continuo={false} autoFocus={!loteId && !pedidoId} placeholder="Ex.: MCK0001, L2611-0001, ABC123, 1234, pedido 15" onCodigo={(c) => ir({ q: c })} />
        {q && !loteId && <div className="small muted" style={{ marginTop: 4 }}>Procurando por <b>{q.replace(/[\x00-\x1f]/g, ' ')}</b></div>}
      </div>
      {loteId ? <LoteDetalhe id={loteId} onVoltar={q ? () => ir({ q }) : undefined} /> : pedidoId ? <PedidoDetalhe id={pedidoId} /> : q ? <Busca q={q} /> : (
        <div className="card"><Empty title="Encontre qualquer lote">Para saber onde está, de onde veio e para quem foi. Útil para recall: comece pelo lote do fornecedor ou pelo produto.</Empty></div>
      )}
    </>
  );
}

function Busca({ q }: { q: string }) {
  const st = useApi<any>(`/erp/estoque/rastreio?q=${encodeURIComponent(q)}`, [q]);
  return (
    <Async state={st}>{(d) => d.grupos.length === 0 ? <div className="card"><Empty title="Nada encontrado">Confira o código. A busca aceita produto, lote, lote do fornecedor, nota fiscal (número ou chave) e pedido.</Empty></div> : (
      <>{d.grupos.map((g: any, i: number) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 6, margin: '4px 0 6px' }}>
            <div><span className="badge">{g.rotulo}</span> <b>{g.titulo}</b>{g.detalhe && <span className="small muted"> · {g.detalhe}</span>}</div>
            {g.pedidoVendaId && <Link className="btn sm" to={`/erp/rastreio?pedido=${g.pedidoVendaId}`}>De onde vieram os lotes deste pedido</Link>}
          </div>
          {g.lotes.length === 0 ? <div className="small muted">Nenhum lote ligado a isto ainda.</div> : g.lotes.map((l: any) => <LoteCard key={l.id} l={l} />)}
        </div>
      ))}</>
    )}</Async>
  );
}

function LoteDetalhe({ id, onVoltar }: { id: string; onVoltar?: () => void }) {
  const st = useApi<any>(`/erp/estoque/rastreio/lote/${id}`, [id]);
  const [todos, setTodos] = useState(false);
  return (
    <Async state={st}>{(r) => {
      const un = r.unidade;
      const eventos = todos ? r.eventos : r.eventos.slice(-30);
      return (
        <>
          <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {onVoltar && <button className="btn sm" onClick={onVoltar}>← Voltar à busca</button>}
            <a className="btn sm" href={`/api/erp/estoque/rastreio/lote/${id}/csv`}>⬇️ Exportar (planilha CSV)</a>
            <button className="btn sm" onClick={() => window.print()}>🖨️ Imprimir / salvar PDF</button>
          </div>
          <LoteCard l={r.lote} unidade={un} acoes={false} />

          {r.reservadoPara.length > 0 && <div className="card" style={{ marginBottom: 8 }}>
            <h3 style={{ marginTop: 0 }}>📌 Parte do saldo já tem dono</h3>
            {r.reservadoPara.map((x: any, i: number) => <div key={i} className="small">{qtdUn(x.qtdMil, un)} reservado para <DocLink d={x.doc} texto={x.para} /> · {x.local}{x.separadoMil ? ` (${qtdUn(x.separadoMil, un)} já separado)` : ''}</div>)}
          </div>}

          <div className="card" style={{ marginBottom: 8 }}>
            <h3 style={{ marginTop: 0 }}>➡️ Para onde foi</h3>
            {r.destinos.length === 0 ? <div className="small muted">Nada saiu deste lote ainda.</div> : r.destinos.map((d: any, i: number) => (
              <div key={i} style={{ borderTop: i ? '1px solid #e5e7eb' : undefined, padding: '6px 0' }}>
                <div><b>{qtdUn(d.qtdMil, un)}</b> · {d.tipo === 'cliente' ? '🚚 ' : d.tipo === 'producao' ? '🏭 ' : '📉 '}{d.tipo === 'cliente' && d.clienteId ? <Link to={`/erp/clientes/${d.clienteId}`}>{d.para}</Link> : d.para}</div>
                <div className="small muted">{d.doc ? <DocLink d={d.doc} /> : null} · {dataBr(d.quando)}</div>
                {d.lotesGerados?.length > 0 && <div className="small">Virou: {d.lotesGerados.map((g: any) => <Link key={g.id} to={`/erp/rastreio?lote=${g.id}`} style={{ marginRight: 8 }}>{g.produto} lote {g.numero}</Link>)}</div>}
              </div>
            ))}
          </div>

          {r.clientesAlcancados.some((c: any) => c.via) && <div className="card" style={{ marginBottom: 8 }}>
            <h3 style={{ marginTop: 0 }}>👥 Clientes que receberam no produto pronto (recall)</h3>
            {r.clientesAlcancados.filter((c: any) => c.via).map((c: any, i: number) => <div key={i} className="small" style={{ padding: '3px 0' }}><b>{c.cliente}</b> · {qtdUn(c.qtdMil, c.unidade)} de {c.produto} (lote <Link to={`/erp/rastreio?lote=${c.lote.id}`}>{c.lote.numero}</Link>) · <DocLink d={c.pedido} />{c.nf ? ` · ${c.nf}` : ''} · {dataBr(c.quando)}<div className="muted">{c.via}</div></div>)}
          </div>}

          {r.origem.length > 0 && <div className="card" style={{ marginBottom: 8 }}>
            <h3 style={{ marginTop: 0 }}>⬅️ De onde veio (insumos usados)</h3>
            {r.origem.map((o: any) => <div key={o.lote.id} className="small" style={{ padding: '3px 0', paddingLeft: (o.nivel - 1) * 14 }}>
              <Link to={`/erp/rastreio?lote=${o.lote.id}`}><b>{o.lote.produto?.nome} · lote {o.lote.numero}</b></Link>{o.qtdMil != null ? ` · ${qtdUn(o.qtdMil, o.lote.produto?.unidade)}` : ''}
              <div className="muted">{o.lote.loteFornecedor ? `Lote do fornecedor ${o.lote.loteFornecedor} · ` : ''}{o.lote.fornecedor?.nome ?? ''} · {o.lote.documentoEntrada.rotulo}{o.via ? ` · usado na ${o.via}` : ''}</div>
            </div>)}
          </div>}

          <div className="card">
            <h3 style={{ marginTop: 0 }}>🕒 Linha do tempo</h3>
            {!todos && r.eventos.length > 30 && <button className="btn sm ghost" onClick={() => setTodos(true)}>Ver tudo ({r.eventos.length})</button>}
            {eventos.map((e: any, i: number) => (
              <div key={i} style={{ borderLeft: `3px solid ${COR[e.categoria] ?? '#64748b'}`, padding: '4px 0 4px 10px', margin: '6px 0' }}>
                <div className="small muted">{hora(e.quando)}{e.quem ? ` · por ${e.quem}` : ''}</div>
                <div>{e.icone} {e.texto}</div>
                {e.qtdMil != null && <div className="small"><b style={{ color: e.categoria === 'reserva' ? undefined : e.qtdMil < 0 ? '#dc2626' : '#16a34a' }}>{e.categoria !== 'reserva' && e.qtdMil > 0 ? '+' : ''}{qtdUn(e.qtdMil, un)}</b>{e.saldoLoteMil != null ? <span className="muted"> · ficou {qtdUn(e.saldoLoteMil, un)} no lote</span> : null}{e.doc ? <> · <DocLink d={e.doc} /></> : null}</div>}
              </div>
            ))}
          </div>
        </>
      );
    }}</Async>
  );
}

function PedidoDetalhe({ id }: { id: string }) {
  const st = useApi<any>(`/erp/estoque/rastreio/pedido/${id}`, [id]);
  return (
    <Async state={st}>{(r) => (
      <>
        <div className="card" style={{ marginBottom: 8 }}>
          <h3 style={{ marginTop: 0 }}><Link to={`/erp/pedidos/${r.pedido.id}`}>{r.pedido.rotulo}</Link></h3>
          <div className="small">{r.pedido.cliente}{r.pedido.nf ? ` · ${r.pedido.nf}` : ''} · {dataBr(r.pedido.criadoEm)}</div>
        </div>
        {r.lotes.length === 0 ? <div className="card"><Empty title="Nenhum lote ainda">Os lotes aparecem quando o pedido é reservado ou faturado.</Empty></div> : r.lotes.map((x: any) => (
          <div key={x.lote.id} style={{ marginBottom: 10 }}>
            <div className="small" style={{ margin: '2px 0' }}>{x.saiuMil ? <>Saiu <b>{qtdUn(x.saiuMil, x.lote.produto?.unidade)}</b> deste lote</> : null}{x.reservadoMil ? <> · reservado {qtdUn(x.reservadoMil, x.lote.produto?.unidade)}</> : null}</div>
            <LoteCard l={x.lote} />
            {x.origem.length > 0 && <div className="small" style={{ marginLeft: 12 }}>Feito com: {x.origem.map((o: any) => <span key={o.lote.id} style={{ marginRight: 10 }}><Link to={`/erp/rastreio?lote=${o.lote.id}`}>{o.lote.produto?.nome} lote {o.lote.numero}</Link>{o.lote.fornecedor ? ` (${o.lote.fornecedor.nome})` : ''}</span>)}</div>}
          </div>
        ))}
      </>
    )}</Async>
  );
}

function DocLink({ d, texto }: { d: any; texto?: string }) {
  if (!d) return <>{texto ?? ''}</>;
  const t = texto ?? d.rotulo;
  if (d.tipo === 'pedido_venda' && d.id) return <Link to={`/erp/pedidos/${d.id}`}>{t}</Link>;
  return <>{t}</>;
}
