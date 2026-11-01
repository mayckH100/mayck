import { useState } from 'react';
import { post, patch, del } from './api';
import { useAuth } from './auth';
import { useAction, fmtDate, useApi, Loading } from './ui';

/** Painel do contato: notas para a IA (editar/remover: autor, Proprietário ou Administrador). */
export function AiNotesPanel({ contactId, notes, onChange, onClose }: { contactId: string; notes: any[]; onChange: () => void; onClose?: () => void }) {
  const { me, can } = useAuth();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [novo, setNovo] = useState('');
  const canEdit = (n: any) => n.authorUserId === me?.user.id || can('OWNER', 'ADMIN');
  const save = async (n: any) => { const r = await run(() => patch(`/contacts/${contactId}/ai-notes/${n.id}`, { text: draft }), 'Nota atualizada'); if (r) { setEditing(null); onChange(); } };
  const remove = async (n: any) => { if (!confirm('Remover esta nota para a IA?')) return; const r = await run(() => del(`/contacts/${contactId}/ai-notes/${n.id}`), 'Nota removida'); if (r) onChange(); };
  const add = async () => { const r = await run(() => post(`/contacts/${contactId}/ai-notes`, { text: novo }), 'Nota para a IA salva no contato'); if (r) { setNovo(''); onChange(); } };
  return (
    <div className="ai-notes-panel" role="region" aria-label="Notas para a IA">
      <div className="row between">
        <strong>🧠 Notas para a IA sobre este contato</strong>
        {onClose && <button className="btn sm" onClick={onClose} aria-label="Fechar notas para a IA">Fechar</button>}
      </div>
      <p className="small muted" style={{ margin: '4px 0 8px' }}>A IA considera estas observações ao responder este contato, em qualquer conversa ou número. O cliente nunca as vê. As 10 mais recentes entram na resposta da IA.</p>
      {notes.length === 0 && <div className="small muted">Nenhuma nota ainda.</div>}
      <div className="stack" style={{ gap: 6 }}>
        {notes.map((n) => (
          <div key={n.id} className="ai-note-item">
            {editing === n.id ? (
              <>
                <textarea value={draft} maxLength={1000} onChange={(e) => setDraft(e.target.value)} aria-label="Editar nota para a IA" />
                <div className="row"><button className="btn sm primary" disabled={busy || !draft.trim()} onClick={() => save(n)}>Salvar</button><button className="btn sm" onClick={() => setEditing(null)}>Cancelar</button></div>
              </>
            ) : (
              <>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                <div className="row between small muted">
                  <span>{n.authorName ?? '—'} · {fmtDate(n.createdAt)}</span>
                  {canEdit(n) && <span className="row"><button className="btn sm" onClick={() => { setEditing(n.id); setDraft(n.body); }}>Editar</button><button className="btn sm danger" disabled={busy} onClick={() => remove(n)}>Remover</button></span>}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input placeholder="Nova nota para a IA (ex.: prefere contato à tarde; já recebeu proposta)" value={novo} maxLength={1000} onChange={(e) => setNovo(e.target.value)} aria-label="Nova nota para a IA" />
        <button className="btn sm primary" disabled={busy || !novo.trim()} onClick={add}>Adicionar</button>
      </div>
    </div>
  );
}

/** Versão autônoma (carrega as notas): usada nos detalhes do contato. */
export function ContactAiNotes({ contactId }: { contactId: string }) {
  const st = useApi<any>(`/contacts/${contactId}/ai-notes`, [contactId]);
  if (!st.data) return <Loading />;
  return <AiNotesPanel contactId={contactId} notes={st.data.items} onChange={st.reload} />;
}
