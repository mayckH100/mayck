import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, patch, del } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, useAction, initials, fmtDate, Modal, Field } from '../ui';
import { AppointmentModal, newDraft, type ApptDraft } from './Agenda';

export default function Kanban() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('last_desc');
  const state = useApi<any>(`/kanban?sort=${sort}&q=${encodeURIComponent(query)}`, [sort, query]);
  const { run } = useAction();
  const { can, me } = useAuth();
  const [over, setOver] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const [task, setTask] = useState<ApptDraft | null>(null);
  const move = async (contactId: string, stageId: string | null) => {
    if (!state.data) return;
    state.setData({ ...state.data, contacts: state.data.contacts.map((c: any) => (c.id === contactId ? { ...c, stageId } : c)) });
    const ok = await run(() => post('/kanban/move', { contactId, stageId }));
    if (!ok) state.reload();
  };
  return (
    <>
      <div className="page-head">
        <div><h1>Kanban</h1><p className="muted">Arraste os cartões entre as colunas para atualizar a etapa do contato.</p></div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><input placeholder="Pesquisar contatos" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} /></form>
          <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 210 }} aria-label="Ordenar contatos">
            <option value="last_desc">Última mensagem (recentes)</option><option value="last_asc">Última mensagem (antigas)</option>
            <option value="name_asc">Nome A→Z</option><option value="name_desc">Nome Z→A</option>
            <option value="created_desc">Criação (recentes)</option><option value="created_asc">Criação (antigos)</option>
          </select>
          {can('OWNER', 'ADMIN') && <button className="btn" onClick={() => setEdit({ name: '', color: '#3b82f6' })}>+ Coluna</button>}
        </div>
      </div>
      <Async state={state}>{(d) => {
        const cols = [{ id: null, name: 'Sem etapa', color: '#94a3b8' }, ...d.stages];
        return (
          <div className="board">
            {cols.map((s: any) => {
              const cards = d.contacts.filter((c: any) => (c.stageId ?? null) === s.id);
              return (
                <div key={s.id ?? 'none'} className={`col ${over === (s.id ?? 'none') ? 'over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setOver(s.id ?? 'none'); }} onDragLeave={() => setOver(null)}
                  onDrop={(e) => { e.preventDefault(); setOver(null); move(e.dataTransfer.getData('text/plain'), s.id); }}>
                  <div className="col-head">
                    <span className="row"><span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, display: 'inline-block' }} />{s.name} <span className="badge">{cards.length}</span></span>
                    {s.id && can('OWNER', 'ADMIN') && <button className="btn ghost sm" aria-label={`Editar coluna ${s.name}`} onClick={() => setEdit(s)}>⋯</button>}
                  </div>
                  {cards.map((c: any) => (
                    <div key={c.id} className="kcard" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', c.id)}>
                      <div className="row between">
                        <span className="row"><span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initials(c.name ?? c.phone)}</span><strong>{c.name ?? c.phone}</strong></span>
                        {c.unread > 0 && <span className="badge green">{c.unread}</span>}
                      </div>
                      <div className="small muted">{c.phone}</div>
                      <div className="row" style={{ marginTop: 4 }}>{c.tags.length ? c.tags.map((t: string) => <span key={t} className="badge">{t}</span>) : <span className="small muted">Sem etiquetas</span>}</div>
                      <div className="row between small" style={{ marginTop: 6 }}>
                        <span className="muted">{fmtDate(c.lastMessageAt)}</span>
                        <span className="row" style={{ gap: 6 }}>
                          <button type="button" className="btn ghost sm" title="Agendar reunião ou tarefa com prazo (vai para a agenda do celular)" onClick={() => setTask(newDraft({ kind: 'TASK', title: `Retornar para ${c.name ?? c.phone}`, contactId: c.id, contactLabel: c.name ? `${c.name} (${c.phone})` : c.phone, assignedUserId: me?.user.id ?? null, notifyContact: false, source: 'KANBAN' }))}>📅 Agendar</button>
                          {c.conversationId && <Link to={`/inbox/${c.conversationId}`}>Abrir conversa</Link>}
                        </span>
                      </div>
                      <select aria-label="Mover para" className="small" style={{ marginTop: 6, padding: 4 }} value={c.stageId ?? ''} onChange={(e) => move(c.id, e.target.value || null)}>
                        {cols.map((o: any) => <option key={o.id ?? 'none'} value={o.id ?? ''}>{o.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        );
      }}</Async>
      {task && <AppointmentModal draft={task} onClose={() => setTask(null)} onSaved={() => setTask(null)} />}
      {edit && (
        <Modal title={edit.id ? 'Editar coluna' : 'Nova coluna'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => (edit.id ? patch(`/kanban/stages/${edit.id}`, { name: edit.name, color: edit.color }) : post('/kanban/stages', { name: edit.name, color: edit.color })), 'Coluna salva');
            if (ok) { setEdit(null); state.reload(); }
          }}>
            <Field label="Nome"><input required maxLength={40} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Cor"><input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} style={{ height: 38 }} /></Field>
            <div className="row between">
              {edit.id ? <button type="button" className="btn danger" onClick={async () => { if (confirm('Excluir esta coluna? Os contatos voltam para "Sem etapa".')) { await run(() => del(`/kanban/stages/${edit.id}`), 'Coluna excluída'); setEdit(null); state.reload(); } }}>Excluir coluna</button> : <span />}
              <button className="btn primary">Salvar</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
