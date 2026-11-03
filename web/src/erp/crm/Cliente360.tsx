/** Visão 360º do cliente: dados, indicadores, oportunidades e linha do tempo com envio por WhatsApp/e-mail. */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { post, patch } from '../../api';
import { useApi, Async, useAction, fmtDate, Field } from '../../ui';
import ErpNav from '../ErpNav';
import { brl, fmtDoc } from '../format';
import { ParceiroForm } from './Clientes';

const ICONE: Record<string, string> = { WHATSAPP: '💬', EMAIL: '✉', LIGACAO: '☏', NOTA: '📝', CHAMADO: '🎫', SISTEMA: '⚙' };

export default function Cliente360() {
  const { id } = useParams();
  const state = useApi<any>(`/erp/crm/parceiros/${id}`, [id]);
  const [editando, setEditando] = useState(false);
  return (
    <>
      <ErpNav />
      <Async state={state}>{(p) => (
        <>
          <div className="page-head">
            <div>
              <h1>{p.fantasia || p.nome}</h1>
              <p className="muted">{fmtDoc(p.documento)} · {p.municipio ? `${p.municipio}/${p.uf}` : 'sem endereço'} · <span className={`badge ${p.status === 'ATIVO' ? 'green' : p.status === 'BLOQUEADO' ? 'red' : ''}`}>{p.status}</span></p>
            </div>
            <div className="row"><Link className="btn" to="/erp/clientes">Voltar</Link><button className="btn" onClick={() => setEditando(true)}>Editar</button>{p.ehCliente && p.status !== 'BLOQUEADO' && <Link className="btn primary" to={`/erp/pedidos?parceiroId=${p.id}`}>+ Orçamento</Link>}</div>
          </div>
          <div className="grid g4">
            <div className="card stat"><div className="l">Total comprado</div><div className="v">{brl(p.resumo.totalGanhoCents)}</div><div className="small muted">{p.resumo.negociosGanhos} negócio(s)</div></div>
            <div className="card stat"><div className="l">Ticket médio</div><div className="v">{brl(p.resumo.ticketMedioCents)}</div></div>
            <div className="card stat"><div className="l">Em negociação</div><div className="v">{brl(p.resumo.emAbertoCents)}</div></div>
            <div className="card stat"><div className="l">Crédito disponível</div><div className="v">{brl(p.resumo.creditoDisponivelCents)}</div><div className="small muted">score {p.score}</div></div>
          </div>
          <div className="grid g2" style={{ marginTop: 14 }}>
            <div className="card">
              <h3>Linha do tempo</h3>
              <NovaInteracao parceiro={p} onDone={state.reload} />
              {p.interacoes.length === 0 && <div className="small muted">Nada registrado ainda.</div>}
              {p.interacoes.map((i: any) => (
                <div key={i.id} style={{ borderTop: '1px solid var(--line, #e5e7eb)', padding: '8px 0' }}>
                  <div className="row between small"><span>{ICONE[i.tipo] ?? '•'} <strong>{i.assunto || i.tipo}</strong>{i.status && <span className={`badge ${i.status === 'FALHOU' ? 'red' : ''}`} style={{ marginLeft: 6 }}>{i.status}</span>}</span><span className="muted">{fmtDate(i.createdAt)}</span></div>
                  {i.conteudo && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{i.conteudo}</div>}
                  {i.tipo === 'CHAMADO' && i.status === 'ABERTO' && <button className="btn ghost sm" onClick={async () => { await patch(`/erp/crm/interacoes/${i.id}/chamado`, { status: 'RESOLVIDO' }); state.reload(); }}>Marcar resolvido</button>}
                </div>
              ))}
            </div>
            <div className="card">
              <h3>Oportunidades</h3>
              {p.oportunidades.length === 0 && <div className="small muted">Nenhuma ainda. Crie pelo <Link to="/erp/funil">funil</Link>.</div>}
              {p.oportunidades.map((o: any) => (
                <div key={o.id} className="row between" style={{ borderTop: '1px solid var(--line, #e5e7eb)', padding: '6px 0' }}>
                  <span>{o.titulo} <span className="badge">{o.status}</span></span><strong>{brl(o.valorCents)}</strong>
                </div>
              ))}
              <h3 style={{ marginTop: 16 }}>Contatos</h3>
              {p.contatos.map((c: any) => <div key={c.id} className="small">{c.nome}{c.cargo ? ` · ${c.cargo}` : ''} {c.email ?? ''} {c.telefone ?? ''}</div>)}
              <div className="small muted" style={{ marginTop: 10 }}>{p.email ?? 'sem e-mail'} · {p.telefone ?? 'sem telefone'}{p.cnaeDescricao ? ` · ${p.cnaeDescricao}` : ''}</div>
            </div>
          </div>
          {editando && <ParceiroForm inicial={p} onClose={() => setEditando(false)} onSaved={() => { setEditando(false); state.reload(); }} />}
        </>
      )}</Async>
    </>
  );
}

function NovaInteracao({ parceiro, onDone }: { parceiro: any; onDone: () => void }) {
  const [tipo, setTipo] = useState('NOTA');
  const [assunto, setAssunto] = useState('');
  const [texto, setTexto] = useState('');
  const { busy, run } = useAction();
  const envio = tipo === 'WHATSAPP' || tipo === 'EMAIL';
  async function salvar() {
    const r = await run(() => envio
      ? post('/erp/crm/interacoes/enviar', { parceiroId: parceiro.id, canal: tipo, assunto: assunto || undefined, texto })
      : post('/erp/crm/interacoes', { parceiroId: parceiro.id, tipo, assunto: assunto || null, conteudo: texto }), envio ? 'Enviado' : 'Registrado');
    if (r) { setTexto(''); setAssunto(''); }
    onDone();
  }
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row">
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo">
          <option value="NOTA">Nota</option><option value="LIGACAO">Ligação</option><option value="CHAMADO">Chamado</option>
          <option value="WHATSAPP" disabled={!parceiro.telefone}>Enviar WhatsApp</option><option value="EMAIL" disabled={!parceiro.email}>Enviar e-mail</option>
        </select>
        {tipo !== 'WHATSAPP' && <input placeholder="Assunto" value={assunto} onChange={(e) => setAssunto(e.target.value)} style={{ flex: 1 }} />}
      </div>
      <Field label=""><textarea rows={2} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={envio ? 'Mensagem para o cliente' : 'O que aconteceu?'} /></Field>
      <button className="btn sm primary" disabled={busy || !texto.trim()} onClick={salvar}>{envio ? 'Enviar' : 'Registrar'}</button>
    </div>
  );
}
