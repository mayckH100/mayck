import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, patch, del, get } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, fmtDate, StatusBadge, Loading } from '../ui';

export default function Contacts() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const state = useApi<any>(`/contacts?q=${encodeURIComponent(query)}&page=${page}`, [query, page]);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { can } = useAuth();
  return (
    <>
      <div className="page-head">
        <div><h1>Contatos</h1><p className="muted">CRM com etiquetas, notas, campos coletados pelos fluxos e ferramentas de LGPD.</p></div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q); }}><input placeholder="Nome, telefone ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 230 }} aria-label="Pesquisar contatos" /></form>
          {can('OWNER', 'ADMIN') && <button className="btn" onClick={() => setImporting(true)}>Importar</button>}
          <button className="btn primary" onClick={() => setCreating(true)}>+ Novo contato</button>
        </div>
      </div>
      <Async state={state}>{(d) => d.items.length === 0 ? (
        <div className="card"><Empty title={query ? 'Nenhum contato encontrado' : 'Nenhum contato ainda'}>Contatos são criados automaticamente quando alguém envia mensagem, ou manualmente aqui.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>Telefone</th><th>Etiquetas</th><th>Última mensagem</th><th></th></tr></thead>
            <tbody>
              {d.items.map((c: any) => (
                <tr key={c.id}>
                  <td><strong>{c.name ?? '—'}</strong>{c.optOut && <span className="badge red" style={{ marginLeft: 6 }}>opt-out</span>}<div className="small muted">{c.email}</div></td>
                  <td>{c.phone}</td>
                  <td><div className="row">{c.tags.map((t: string) => <span key={t} className="badge">{t}</span>)}</div></td>
                  <td>{fmtDate(c.lastMessageAt)}</td>
                  <td><button className="btn sm" onClick={() => setOpenId(c.id)}>Abrir</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row between" style={{ marginTop: 10 }}>
            <span className="small muted">{d.total} contato(s)</span>
            <div className="row">
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
              <button className="btn sm" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>Próxima</button>
            </div>
          </div>
        </div>
      )}</Async>
      {creating && <ContactForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); state.reload(); }} />}
      {importing && <ImportForm onClose={() => setImporting(false)} onDone={state.reload} />}
      {openId && <ContactDetail id={openId} onClose={() => setOpenId(null)} onChanged={state.reload} />}
    </>
  );
}

function ContactForm({ onClose, onSaved, initial }: { onClose: () => void; onSaved: () => void; initial?: any }) {
  const [f, setF] = useState({ name: initial?.name ?? '', phone: initial?.phone ?? '', email: initial?.email ?? '', tags: (initial?.tags ?? []).join(', '), notes: initial?.notes ?? '' });
  const { busy, run } = useAction();
  return (
    <Modal title={initial ? 'Editar contato' : 'Novo contato'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: f.name || null, phone: f.phone, email: f.email || '', tags: f.tags.split(',').map((t: string) => t.trim()).filter(Boolean), notes: f.notes || null };
        const ok = await run(() => (initial ? patch(`/contacts/${initial.id}`, body) : post('/contacts', body)), 'Contato salvo');
        if (ok) onSaved();
      }}>
        <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="WhatsApp" hint="Com DDD. Ex.: 11999998888 ou +55 11 99999-8888"><input required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="E-mail"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Etiquetas" hint="Separadas por vírgula"><input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        <Field label="Notas"><textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
      </form>
    </Modal>
  );
}

function ImportForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <Modal title="Importar contatos" onClose={onClose}>
      <div className="stack">
        <p className="small muted">Uma linha por contato: <code>telefone;nome;email</code> (nome e e-mail opcionais). Separador ; , ou tab.</p>
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'11999998888;Maria;maria@email.com\n5521988887777;João'} />
        {result && <div className="alert ok">{result.created} criado(s), {result.updated} atualizado(s).{result.errors.length > 0 && <div>{result.errors.join(' · ')}</div>}</div>}
        <button className="btn primary" disabled={busy || !text.trim()} onClick={async () => { const r = await run(() => post('/contacts/import', { text })); if (r) { setResult(r); onDone(); } }}>{busy ? 'Importando…' : 'Importar'}</button>
      </div>
    </Modal>
  );
}

function ContactDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const state = useApi<any>(`/contacts/${id}`, [id]);
  const [editing, setEditing] = useState(false);
  const { can } = useAuth();
  const { busy, run } = useAction();
  const exportData = async () => {
    const data = await run(() => get(`/contacts/${id}/export`), 'Exportação gerada');
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `contato-${id}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Modal title="Contato" onClose={onClose}>
      {!state.data ? <Loading /> : (
        <div className="stack">
          <div><strong style={{ fontSize: 16 }}>{state.data.name ?? state.data.phone}</strong><div className="muted">{state.data.phone} {state.data.email && `· ${state.data.email}`}</div></div>
          <div className="row">{state.data.tags.map((t: string) => <span key={t} className="badge">{t}</span>)}</div>
          {state.data.notes && <div className="alert info">{state.data.notes}</div>}
          <label className="row small"><input type="checkbox" checked={state.data.optOut} onChange={(e) => run(() => patch(`/contacts/${id}`, { optOut: e.target.checked }), 'Preferência salva').then(() => { state.reload(); onChanged(); })} /> Não enviar mensagens automáticas (opt-out)</label>
          <div>
            <h3>Dados coletados pelos fluxos</h3>
            {Object.keys(state.data.vars).length === 0 ? <p className="small muted">Nenhum.</p> : (
              <table><tbody>{Object.entries(state.data.vars).map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td>{String(v)}</td></tr>)}</tbody></table>
            )}
          </div>
          <div>
            <h3>Conversas</h3>
            {state.data.conversations.length === 0 ? <p className="small muted">Nenhuma.</p> : state.data.conversations.map((c: any) => (
              <div key={c.id} className="row between small"><Link to={`/inbox/${c.id}`}>{fmtDate(c.createdAt)}</Link><StatusBadge status={c.status} /></div>
            ))}
          </div>
          <div className="row between">
            <button className="btn" onClick={() => setEditing(true)}>Editar</button>
            {can('OWNER', 'ADMIN') && (
              <div className="row">
                <button className="btn" disabled={busy} onClick={exportData}>Exportar dados (LGPD)</button>
                <button className="btn danger" disabled={busy} onClick={async () => {
                  if (!confirm('Apagar definitivamente este contato, suas conversas e mensagens? Esta ação não pode ser desfeita.')) return;
                  const ok = await run(() => del(`/contacts/${id}`), 'Dados do contato apagados');
                  if (ok) { onChanged(); onClose(); }
                }}>Apagar dados (LGPD)</button>
              </div>
            )}
          </div>
        </div>
      )}
      {editing && state.data && <ContactForm initial={state.data} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); state.reload(); onChanged(); }} />}
    </Modal>
  );
}
