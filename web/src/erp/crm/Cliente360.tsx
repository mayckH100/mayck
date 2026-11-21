/** Visão 360º do cliente: dados, indicadores, oportunidades e linha do tempo com envio por WhatsApp/e-mail. */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { post, patch, put, del } from '../../api';
import { useApi, Async, useAction, fmtDate, Field, Modal } from '../../ui';
import { brl, fmtDoc } from '../format';
import { ParceiroForm } from './Clientes';
import { Voltar } from '../Voltar';

const ICONE: Record<string, string> = { WHATSAPP: '💬', EMAIL: '✉', LIGACAO: '☏', NOTA: '📝', CHAMADO: '🎫', SISTEMA: '⚙' };

export default function Cliente360() {
  const { id } = useParams();
  const state = useApi<any>(`/erp/crm/parceiros/${id}`, [id]);
  const [editando, setEditando] = useState(false);
  return (
    <>
      <Async state={state}>{(p) => (
        <>
          <div className="page-head">
            <div>
              <div className="erp-titulo"><Voltar /><h1>{p.fantasia || p.nome}</h1></div>
              <p className="muted">{fmtDoc(p.documento)} · {p.municipio ? `${p.municipio}/${p.uf}` : 'sem endereço'} · <span className={`badge ${p.status === 'ATIVO' ? 'green' : p.status === 'BLOQUEADO' ? 'red' : ''}`}>{p.status}</span></p>
            </div>
            <div className="row"><button className="btn" onClick={() => setEditando(true)}>Editar</button>{p.ehCliente && p.status !== 'BLOQUEADO' && <Link className="btn primary" to={`/erp/pedidos?parceiroId=${p.id}`}>+ Orçamento</Link>}</div>
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
              <Contatos parceiroId={p.id} contatos={p.contatos} onMudou={state.reload} />
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

/** v1.33.0: contatos do cliente/fornecedor: incluir, editar e excluir (fica no histórico de alterações). */
function Contatos({ parceiroId, contatos, onMudou }: { parceiroId: string; contatos: any[]; onMudou: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const { busy, run } = useAction();
  const salvar = async () => {
    const body = { nome: edit.nome, cargo: edit.cargo || null, email: edit.email || null, telefone: edit.telefone || null, principal: !!edit.principal };
    if (await run(() => (edit.id ? put(`/erp/crm/parceiros/${parceiroId}/contatos/${edit.id}`, body) : post(`/erp/crm/parceiros/${parceiroId}/contatos`, body)), 'Contato salvo')) { setEdit(null); onMudou(); }
  };
  return (
    <>
      {contatos.length === 0 && <div className="small muted">Nenhum contato.</div>}
      {contatos.map((c: any) => (
        <div key={c.id} className="row between small" style={{ padding: '4px 0', gap: 6, flexWrap: 'wrap' }}>
          <span><b>{c.nome}</b>{c.principal ? ' ⭐' : ''}{c.cargo ? ` · ${c.cargo}` : ''}<br />{[c.email, c.telefone].filter(Boolean).join(' · ')}</span>
          <span className="row" style={{ gap: 4 }}>
            <button className="btn sm ghost" onClick={() => setEdit({ ...c, cargo: c.cargo ?? '', email: c.email ?? '', telefone: c.telefone ?? '' })} aria-label={`Editar ${c.nome}`}>✏️</button>
            <button className="btn sm ghost" disabled={busy} onClick={async () => { if (confirm(`Excluir o contato ${c.nome}?`) && await run(() => del(`/erp/crm/parceiros/${parceiroId}/contatos/${c.id}`), 'Contato excluído')) onMudou(); }} aria-label={`Excluir ${c.nome}`}>🗑️</button>
          </span>
        </div>
      ))}
      <button className="btn sm" style={{ marginTop: 4 }} onClick={() => setEdit({ nome: '', cargo: '', email: '', telefone: '', principal: contatos.length === 0 })}>+ Contato</button>
      {edit && <Modal title={edit.id ? 'Editar contato' : 'Novo contato'} onClose={() => setEdit(null)}>
        <Field label="Nome *"><input autoFocus value={edit.nome} onChange={(e) => setEdit({ ...edit, nome: e.target.value })} /></Field>
        <div className="grid g2">
          <Field label="Cargo"><input value={edit.cargo} onChange={(e) => setEdit({ ...edit, cargo: e.target.value })} /></Field>
          <Field label="Telefone / WhatsApp"><input value={edit.telefone} onChange={(e) => setEdit({ ...edit, telefone: e.target.value })} inputMode="tel" /></Field>
        </div>
        <Field label="E-mail"><input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} inputMode="email" /></Field>
        <label className="row small"><input type="checkbox" checked={!!edit.principal} onChange={(e) => setEdit({ ...edit, principal: e.target.checked })} /> Contato principal</label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" disabled={busy || !edit.nome.trim()} onClick={salvar}>Salvar</button></div>
      </Modal>}
    </>
  );
}
