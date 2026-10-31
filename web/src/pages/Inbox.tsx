import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { post, patch } from '../api';
import { useApi, Async, Empty, Loading, ErrorBox, fmtDate, initials, StatusBadge, useAction, Modal, Field } from '../ui';

const TABS = [['open', 'Abertas'], ['pending', 'Aguardando humano'], ['closed', 'Encerradas']] as const;
const SENDER: Record<string, string> = { contact: '', bot: 'Automação', ai: 'IA', agent: 'Atendente', system: 'Sistema' };

export default function Inbox() {
  const { id } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState<string>('open');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useApi<any>(`/conversations?status=${tab}&q=${encodeURIComponent(query)}`, [tab, query]);
  useEffect(() => {
    const t = setInterval(() => list.reload(), 8000);
    return () => clearInterval(t);
  }, [list.reload]);
  return (
    <>
      <div className="page-head"><div><h1>Inbox</h1><p className="muted">Atendimento compartilhado. Atualiza automaticamente a cada 8 segundos.</p></div></div>
      <div className="inbox">
        <div className="list">
          <form className="row" style={{ padding: 10 }} onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
            <input placeholder="Pesquisar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Pesquisar conversas" />
          </form>
          <div className="tabs" style={{ padding: '0 8px', marginBottom: 0 }}>
            {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{list.data?.counts && ` (${list.data.counts[k.toUpperCase()] ?? 0})`}</button>)}
          </div>
          <div className="items">
            {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
            {!list.data && list.loading && <Loading />}
            {list.data?.items.length === 0 && <Empty title="Nenhuma conversa aqui">As conversas aparecem quando um contato envia mensagem para o seu número.</Empty>}
            {list.data?.items.map((c: any) => (
              <button key={c.id} className={`conv-item ${c.id === id ? 'on' : ''}`} onClick={() => nav(`/inbox/${c.id}`)}>
                <span className="avatar">{initials(c.contact?.name ?? c.contact?.phone)}</span>
                <span style={{ minWidth: 0 }}>
                  <strong>{c.contact?.name ?? c.contact?.phone}</strong>
                  <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.lastMessage?.direction === 'OUT' ? 'Você: ' : ''}{c.lastMessage?.body ?? '—'}</div>
                </span>
                <span className="small muted" style={{ textAlign: 'right' }}>
                  {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : ''}
                  {c.unreadCount > 0 && <div><span className="badge green">{c.unreadCount}</span></div>}
                  {c.mode === 'HUMAN' && <div><span className="badge blue">humano</span></div>}
                  {c.waitingSince && <div><span className="badge" style={{ background: '#ffedd5', color: '#9a3412' }}>Aguardando atendente</span></div>}
                </span>
              </button>
            ))}
          </div>
        </div>
        {id ? <Chat id={id} onChange={list.reload} /> : <div className="chat"><Empty title="Selecione uma conversa">Escolha uma conversa à esquerda para ver as mensagens.</Empty></div>}
      </div>
    </>
  );
}

function Chat({ id, onChange }: { id: string; onChange: () => void }) {
  const state = useApi<any>(`/conversations/${id}`, [id]);
  const stages = useApi<any>('/kanban');
  const flows = useApi<any[]>('/flows');
  const [text, setText] = useState('');
  const [note, setNote] = useState(false);
  const [showFlow, setShowFlow] = useState(false);
  const [showTpl, setShowTpl] = useState(false);
  const [tpl, setTpl] = useState({ name: '', language: 'pt_BR' });
  const { busy, run } = useAction();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => state.reload(), 5000);
    return () => clearInterval(t);
  }, [state.reload]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [state.data?.messages.length]);
  const refresh = () => { state.reload(); onChange(); };
  const send = async () => {
    if (!text.trim()) return;
    if (note) {
      const r = await run(() => post(`/conversations/${id}/notes`, { text }), 'Nota interna adicionada');
      if (r) setText('');
    } else {
      try {
        await post(`/conversations/${id}/messages`, { type: 'text', text });
        setText('');
      } catch (e) {
        // Mensagem fica registrada como FAILED com o motivo — mostramos na conversa.
      }
    }
    refresh();
  };
  const action = (action: string, msg: string) => run(() => post(`/conversations/${id}/action`, { action }), msg).then(refresh);
  return (
    <div className="chat">
      <Async state={state}>{(d) => (
        <>
          <div className="chat-head">
            <span className="avatar">{initials(d.contact?.name ?? d.contact?.phone)}</span>
            <div style={{ flex: 1, minWidth: 140 }}>
              <strong>{d.contact?.name ?? d.contact?.phone}</strong>
              <div className="small muted">{d.contact?.phone} · <StatusBadge status={d.conversation.status} /> · {d.conversation.mode === 'HUMAN' ? 'Atendimento humano' : 'Robô'}</div>
            </div>
            <select aria-label="Etapa do Kanban" style={{ width: 170 }} value={d.contact?.stageId ?? ''} onChange={(e) => run(() => patch(`/contacts/${d.contact.id}`, { stageId: e.target.value || null }), 'Etapa atualizada').then(refresh)}>
              <option value="">Sem etapa</option>
              {stages.data?.stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {d.conversation.mode === 'BOT' && d.conversation.status !== 'CLOSED' && <button className="btn sm" disabled={busy} onClick={() => action('take', 'Você assumiu a conversa')}>Assumir</button>}
            {d.conversation.mode === 'HUMAN' && d.conversation.status !== 'CLOSED' && <button className="btn sm" disabled={busy} onClick={() => action('to_bot', 'Conversa devolvida ao robô')}>Devolver ao robô</button>}
            {d.conversation.status !== 'CLOSED'
              ? <button className="btn sm" disabled={busy} onClick={() => action('close', 'Conversa encerrada')}>Encerrar</button>
              : <button className="btn sm" disabled={busy} onClick={() => action('reopen', 'Conversa reaberta')}>Reabrir</button>}
          </div>
          {d.activeRun && <div className="alert info" style={{ margin: 8 }}>Fluxo em execução ({d.activeRun.status === 'WAITING' ? 'aguardando resposta do contato' : 'executando'}).</div>}
          <div className="msgs">
            {d.messages.length === 0 && <Empty title="Sem mensagens ainda" />}
            {d.messages.map((m: any) => (
              <div key={m.id} className={`bubble ${m.direction === 'INTERNAL' ? 'note' : m.direction === 'OUT' ? 'out' : ''} ${m.status === 'FAILED' ? 'failed' : ''}`}>
                {m.direction !== 'IN' && <div className="small" style={{ fontWeight: 700 }}>{m.direction === 'INTERNAL' ? (m.sender === 'agent' ? `Nota interna · ${m.authorName ?? ''}` : 'Sistema') : m.sender === 'agent' ? m.authorName ?? 'Atendente' : SENDER[m.sender]}</div>}
                {m.mediaUrl && <div><a href={m.mediaUrl} target="_blank" rel="noreferrer">[{m.type}] abrir mídia</a></div>}
                {m.body}
                {m.status === 'FAILED' && <div className="small" style={{ color: 'var(--danger)' }}>Não enviada: {m.error}</div>}
                <div className="meta"><span>{fmtDate(m.createdAt)}</span>{m.direction === 'OUT' && <StatusBadge status={m.status} />}</div>
              </div>
            ))}
            <div ref={end} />
          </div>
          {d.conversation.status !== 'CLOSED' && (
            <div className="composer">
              {!d.conversation.withinWindow && !note && (
                <div className="alert warn small">Fora da janela de 24 horas: o WhatsApp só permite enviar um <strong>modelo aprovado</strong>. <button className="btn sm" onClick={() => setShowTpl(true)}>Enviar modelo</button></div>
              )}
              <textarea placeholder={note ? 'Nota interna (o contato não vê)' : 'Mensagem…'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Mensagem" />
              <div className="row between">
                <div className="row">
                  <label className="row small"><input type="checkbox" checked={note} onChange={(e) => setNote(e.target.checked)} /> Nota interna</label>
                  <button className="btn sm" onClick={() => setShowFlow(true)}>Enviar fluxo</button>
                </div>
                <button className="btn primary" disabled={!text.trim() || busy} onClick={send}>{note ? 'Salvar nota' : 'Enviar'}</button>
              </div>
            </div>
          )}
          {showFlow && (
            <Modal title="Enviar fluxo para este contato" onClose={() => setShowFlow(false)}>
              {!flows.data ? <Loading /> : flows.data.length === 0 ? <Empty title="Nenhum fluxo criado" /> : (
                <div className="stack">
                  {flows.data.map((f) => (
                    <div key={f.id} className="row between">
                      <span>{f.name} <StatusBadge status={f.status} /></span>
                      <button className="btn sm primary" disabled={busy} onClick={async () => { const r = await run(() => post(`/flows/${f.id}/start`, { conversationId: id }), 'Fluxo iniciado'); if (r) { setShowFlow(false); refresh(); } }}>Iniciar</button>
                    </div>
                  ))}
                </div>
              )}
            </Modal>
          )}
          {showTpl && (
            <Modal title="Enviar modelo (template) aprovado" onClose={() => setShowTpl(false)}>
              <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await post(`/conversations/${id}/messages`, { type: 'template', ...tpl }); } catch { /* falha fica registrada */ } setShowTpl(false); refresh(); }}>
                <Field label="Nome do modelo" hint="Exatamente como aprovado no Gerenciador do WhatsApp (ex.: hello_world)"><input required pattern="[a-z0-9_]+" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} /></Field>
                <Field label="Idioma"><input required value={tpl.language} onChange={(e) => setTpl({ ...tpl, language: e.target.value })} /></Field>
                <button className="btn primary">Enviar modelo</button>
              </form>
            </Modal>
          )}
        </>
      )}</Async>
    </div>
  );
}
