import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { post, del, get } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, fmtDate, StatusBadge } from '../ui';

export default function Flows() {
  const state = useApi<any[]>('/flows');
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('novo') === '1');
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const { can } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (params.get('novo') === '1') { setCreating(true); setParams({}, { replace: true }); } }, [params]);
  const editor = can('OWNER', 'ADMIN');

  const exportFlow = async (f: any) => {
    const data = await run(() => get(`/flows/${f.id}/export`));
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `fluxo-${f.name.replace(/\W+/g, '-')}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const importFile = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      const r = await run(() => post('/flows/import', json), 'Fluxo importado como rascunho');
      if (r) state.reload();
    } catch {
      alert('Arquivo JSON inválido');
    }
  };
  return (
    <>
      <div className="page-head">
        <div><h1>Fluxos</h1><p className="muted">Automações acionadas por mensagem, palavra-chave, primeira mensagem ou horário.</p></div>
        <div className="row">
          <input placeholder="Buscar fluxos…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} aria-label="Buscar fluxos" />
          {editor && <><input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
            <button className="btn" onClick={() => fileRef.current?.click()}>Importar JSON</button>
            <button className="btn primary" onClick={() => setCreating(true)}>+ Novo fluxo</button></>}
        </div>
      </div>
      <Async state={state}>{(flows) => {
        const list = flows.filter((f) => f.name.toLowerCase().includes(q.toLowerCase()));
        if (!flows.length) return <div className="card"><Empty title="Nenhum fluxo ainda">{editor ? 'Crie seu primeiro fluxo para responder automaticamente.' : 'Peça a um administrador para criar fluxos.'}</Empty></div>;
        return (
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Nome</th><th>Status</th><th>Versão</th><th>Execuções</th><th>Última edição</th><th>Ações</th></tr></thead>
              <tbody>
                {list.map((f) => (
                  <tr key={f.id}>
                    <td><strong>{f.name}</strong>{f.description && <div className="small muted">{f.description}</div>}</td>
                    <td><StatusBadge status={f.status} /></td>
                    <td>v{f.currentVersion}</td>
                    <td className="small">{f.runs.total} · <span style={{ color: 'var(--brand)' }}>{f.runs.completed} ok</span> · <span style={{ color: 'var(--info)' }}>{f.runs.handoff} transf.</span> · <span style={{ color: 'var(--danger)' }}>{f.runs.failed} falhas</span></td>
                    <td>{fmtDate(f.updatedAt)}</td>
                    <td>
                      <div className="row">
                        <button className="btn sm primary" onClick={() => nav(`/fluxos/${f.id}`)}>{editor ? 'Abrir' : 'Ver'}</button>
                        {editor && <>
                          {f.status === 'ACTIVE'
                            ? <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/flows/${f.id}/status`, { status: 'PAUSED' }), 'Fluxo pausado').then(state.reload)}>Pausar</button>
                            : <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/flows/${f.id}/status`, { status: 'ACTIVE' }), 'Fluxo ativado').then(state.reload)}>Ativar</button>}
                          <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/flows/${f.id}/duplicate`), 'Fluxo duplicado').then(state.reload)}>Duplicar</button>
                          <button className="btn sm" disabled={busy} onClick={() => exportFlow(f)}>Exportar</button>
                          <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm(`Excluir o fluxo "${f.name}"?`)) run(() => del(`/flows/${f.id}`), 'Fluxo excluído').then(state.reload); }}>Excluir</button>
                        </>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.length === 0 && <Empty title="Nenhum fluxo corresponde à busca" />}
          </div>
        );
      }}</Async>
      {creating && (
        <Modal title="Novo fluxo" onClose={() => setCreating(false)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const f = await run(() => post('/flows', { name }), 'Fluxo criado');
            if (f) nav(`/fluxos/${f.id}`);
          }}>
            <Field label="Nome do fluxo"><input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Boas-vindas" autoFocus /></Field>
            <p className="small muted">O fluxo começa como rascunho com um gatilho de exemplo. Ative quando estiver pronto.</p>
            <button className="btn primary" disabled={busy}>Criar e abrir editor</button>
          </form>
        </Modal>
      )}
    </>
  );
}
