/** Visão 360º do cliente: dados, indicadores, oportunidades e linha do tempo com envio por WhatsApp/e-mail. */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { post, patch, put, del } from '../../api';
import { useApi, Async, useAction, fmtDate, Field, Modal } from '../../ui';
import { brl, fmtDoc } from '../format';
import { ParceiroForm } from './Clientes';
import { BotaoImprimir } from '../impressao/BotaoPdf';
import { fichaParceiro } from '../impressao/cadastros';
import { classeStatus, statusScore, StatusBadge, ROTULO_FAIXA_SCORE } from '../status';

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
              <h1>{p.fantasia || p.nome}</h1>
              <p className="muted">{fmtDoc(p.documento)} · {p.municipio ? `${p.municipio}/${p.uf}` : 'sem endereço'} · <span className={`badge ${p.status === 'ATIVO' ? 'green' : p.status === 'BLOQUEADO' ? 'red' : ''}`}>{p.status}</span></p>
            </div>
            <div className="row"><Link className="btn" to={p.ehFornecedor && !p.ehCliente ? '/erp/fornecedores' : '/erp/clientes'}>Voltar</Link><button className="btn" onClick={() => setEditando(true)}>Editar</button><BotaoImprimir title="Imprime a ficha com os dados salvos" montar={() => fichaParceiro(p)} />{p.ehCliente && p.status !== 'BLOQUEADO' && <Link className="btn primary" to={`/erp/pedidos?parceiroId=${p.id}`}>+ Orçamento</Link>}</div>
          </div>
          <div className="grid g4">
            <div className="card stat"><div className="l">Total comprado</div><div className="v">{brl(p.resumo.totalGanhoCents)}</div><div className="small muted">{p.resumo.negociosGanhos} negócio(s)</div></div>
            <div className="card stat"><div className="l">Ticket médio</div><div className="v">{brl(p.resumo.ticketMedioCents)}</div></div>
            <div className="card stat"><div className="l">Em negociação</div><div className="v">{brl(p.resumo.emAbertoCents)}</div></div>
            <div className="card stat"><div className="l">Crédito disponível</div><div className="v">{brl(p.resumo.creditoDisponivelCents)}</div><div className="small muted">score <StatusBadge status={statusScore(p.score, p.scoreFaixa)}>{p.score}</StatusBadge></div></div>
          </div>
          {/* v1.56.0: score calculado pelas contas a receber e compras do cliente, com o porquê de cada ponto. */}
          {p.ehCliente && (
            <div className={`card st-card ${classeStatus(statusScore(p.score, p.scoreFaixa))}`} style={{ marginTop: 14 }} data-testid="score-cliente">
              <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
                <h3 style={{ margin: 0 }}>Score do cliente: {p.score} <span className="small muted">de 1000</span></h3>
                <StatusBadge status={statusScore(p.score, p.scoreFaixa)}>{ROTULO_FAIXA_SCORE[p.scoreFaixa] ?? ''}</StatusBadge>
              </div>
              <ul className="score-motivos">
                <li><span>Ponto de partida</span><span>500</span></li>
                {(p.scoreMotivos ?? []).filter((m: any) => m.pontos !== 0).map((m: any) => (
                  <li key={m.texto}><span>{m.texto}</span><strong className={m.pontos > 0 ? 'st-ok' : 'st-problema'}>{m.pontos > 0 ? `+${m.pontos}` : m.pontos}</strong></li>
                ))}
                {p.scoreFaixa === 'NOVO' && <li className="muted"><span>Sem compras nem contas ainda.</span></li>}
              </ul>
              <div className="small muted" style={{ marginTop: 4 }}>Sobe com contas pagas em dia e compras frequentes; desce com contas vencidas ou pagas com atraso.</div>
            </div>
          )}
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
