import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, patch, del, get, upload } from '../api';
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
          {can('OWNER', 'ADMIN') && <button className="btn" onClick={() => setImporting(true)}>Importar planilha</button>}
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

type PreviewRow = { line: number; status: 'ok' | 'error' | 'duplicate'; messages: string[]; name: string; phone: string; email: string; empresa: string; tags: string[]; existing: boolean };
type Preview = { total: number; ok: number; errors: number; duplicates: number; rows: PreviewRow[] };
type ImportResult = { total: number; created: number; updated: number; skipped: number; errors: number };

const STATUS_LABEL: Record<PreviewRow['status'], [string, string]> = { ok: ['Pronto', 'green'], error: ['Erro', 'red'], duplicate: ['Duplicado', 'amber'] };

function ImportForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [filter, setFilter] = useState<'all' | PreviewRow['status']>('all');
  const [result, setResult] = useState<ImportResult | null>(null);
  const { busy, run } = useAction();
  const MAX = 2 * 1024 * 1024;

  const pick = async (f: File | null) => {
    setFile(f); setPreview(null); setResult(null); setFilter('all');
    if (!f) return;
    if (f.size > MAX) { setFile(null); alert('O arquivo passa de 2 MB. Divida a planilha em arquivos menores.'); return; }
    const p = await run(() => upload<Preview>('/contacts/import/preview', f));
    if (p) setPreview(p);
  };
  const confirmImport = async () => {
    if (!file) return;
    const r = await run(() => upload<ImportResult>(`/contacts/import/confirm${updateExisting ? '?updateExisting=1' : ''}`, file), 'Importação concluída');
    if (r) { setResult(r); onDone(); }
  };
  const importable = preview ? preview.ok + (updateExisting ? preview.rows.filter((r) => r.status === 'duplicate' && r.existing).length : 0) : 0;
  const shown = preview ? preview.rows.filter((r) => filter === 'all' || r.status === filter) : [];

  return (
    <Modal title="Importar planilha de contatos" onClose={onClose}>
      <div className="stack">
        {result ? (
          <>
            <div className="alert ok">
              <strong>Importação concluída.</strong>
              <div>{result.created} contato(s) criado(s){result.updated > 0 && `, ${result.updated} atualizado(s)`}.</div>
              {(result.skipped > 0 || result.errors > 0) && <div className="small">{result.skipped > 0 && `${result.skipped} duplicado(s) ignorado(s). `}{result.errors > 0 && `${result.errors} linha(s) com erro não importada(s).`}</div>}
            </div>
            <div className="row"><button className="btn" onClick={() => pick(null)}>Importar outra planilha</button><button className="btn primary" onClick={onClose}>Fechar</button></div>
          </>
        ) : (
          <>
            <p className="small muted">
              Use o modelo com as colunas <code>nome;telefone;email;empresa;tags;observacoes</code>. Nome e telefone são obrigatórios;
              etiquetas separadas por vírgula ou <code>|</code>. Arquivo CSV de até 2 MB e 5.000 linhas (no Excel: <em>Salvar como → CSV</em>).
            </p>
            <a className="btn sm" href="/api/contacts/import/template" download="modelo-contatos.csv">⬇ Baixar modelo da planilha</a>
            <Field label="Arquivo da planilha (.csv)">
              <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            </Field>
            {busy && !preview && <p className="small muted">Lendo planilha…</p>}
            {preview && (
              <>
                <div className="row">
                  {([['all', `Todas (${preview.total})`], ['ok', `Prontas (${preview.ok})`], ['error', `Com erro (${preview.errors})`], ['duplicate', `Duplicadas (${preview.duplicates})`]] as const).map(([k, label]) => (
                    <button key={k} className={'btn sm' + (filter === k ? ' primary' : '')} onClick={() => setFilter(k)}>{label}</button>
                  ))}
                </div>
                <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
                  <table>
                    <thead><tr><th>Linha</th><th>Situação</th><th>Nome</th><th>Telefone</th><th>E-mail</th><th>Etiquetas</th></tr></thead>
                    <tbody>
                      {shown.slice(0, 300).map((r) => (
                        <tr key={r.line}>
                          <td>{r.line}</td>
                          <td><span className={'badge ' + STATUS_LABEL[r.status][1]}>{STATUS_LABEL[r.status][0]}</span>{r.messages.length > 0 && <div className="small muted">{r.messages.join(' · ')}</div>}</td>
                          <td>{r.name || '—'}</td>
                          <td>{r.phone || '—'}</td>
                          <td>{r.email || '—'}</td>
                          <td>{r.tags.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {shown.length > 300 && <p className="small muted">Mostrando as primeiras 300 de {shown.length} linhas.</p>}
                </div>
                {preview.duplicates > 0 && (
                  <label className="row small"><input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} /> Atualizar contatos que já existem (dados preenchidos na planilha substituem os atuais; etiquetas são somadas)</label>
                )}
                <button className="btn primary" disabled={busy || importable === 0} onClick={confirmImport}>
                  {busy ? 'Importando…' : importable === 0 ? 'Nenhum contato para importar' : `Importar ${importable} contato(s)`}
                </button>
              </>
            )}
          </>
        )}
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
