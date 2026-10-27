import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { post, del, get, put } from '../api';
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
      <MenuReturnSettings flows={state.data ?? []} editor={editor} />
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

/** Configuração do comando "Voltar ao menu" (vale para todos os fluxos da organização). */
function MenuReturnSettings({ flows, editor }: { flows: any[]; editor: boolean }) {
  const cfg = useApi<any>('/flows/menu-settings');
  const [f, setF] = useState<any>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (cfg.data) setF(cfg.data); }, [cfg.data]);
  if (!f) return null;
  return (
    <form className="card stack" style={{ marginTop: 16 }} aria-label="Voltar ao menu" onSubmit={async (e) => {
      e.preventDefault();
      const r = await run(() => put('/flows/menu-settings', f), 'Configuração do "Voltar ao menu" salva');
      if (r) setF(r);
    }}>
      <div>
        <h2 style={{ margin: 0 }}>↩️ Voltar ao menu</h2>
        <p className="small muted" style={{ margin: '4px 0 0' }}>Em qualquer etapa, o cliente digita uma das palavras abaixo (ou toca no botão “Voltar ao menu”) e o robô cancela a etapa atual e reenvia o menu inteiro, desde o primeiro bloco. Durante o atendimento humano o comando não interfere: a mensagem vai para o atendente.</p>
      </div>
      <fieldset disabled={!editor} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <label className="row"><input type="checkbox" checked={f.menuCommandEnabled} onChange={(e) => setF({ ...f, menuCommandEnabled: e.target.checked })} /> Ativar o comando “Voltar ao menu”</label>
        <div className="grid g2">
          <Field label="Palavras que voltam ao menu" hint="Separe por vírgula. Maiúsculas e acentos não importam."><input value={f.menuCommandWords} maxLength={300} onChange={(e) => setF({ ...f, menuCommandWords: e.target.value })} placeholder="0, menu, voltar" /></Field>
          <Field label="Fluxo do menu" hint="Automático: fluxo com a palavra-chave digitada, senão o último fluxo da conversa, senão o fluxo de boas-vindas (primeira mensagem).">
            <select value={f.menuFlowId ?? ''} onChange={(e) => setF({ ...f, menuFlowId: e.target.value || null })}>
              <option value="">Automático</option>
              {flows.map((fl) => <option key={fl.id} value={fl.id}>{fl.name}{fl.status !== 'ACTIVE' ? ' (inativo)' : ''}</option>)}
            </select>
          </Field>
        </div>
        <label className="row"><input type="checkbox" checked={f.menuFooterEnabled} onChange={(e) => setF({ ...f, menuFooterEnabled: e.target.checked })} /> Acrescentar uma linha de rodapé às mensagens que esperam resposta</label>
        <Field label="Texto do rodapé"><input value={f.menuFooterText} maxLength={200} onChange={(e) => setF({ ...f, menuFooterText: e.target.value })} /></Field>
        <label className="row"><input type="checkbox" checked={f.menuButtonEnabled} onChange={(e) => setF({ ...f, menuButtonEnabled: e.target.checked })} /> Mostrar o botão “Voltar ao menu” na API oficial (Cloud API). No QR code usamos o texto, porque lá os botões não são confiáveis.</label>
        {editor && <div><button className="btn primary" disabled={busy}>Salvar</button></div>}
      </fieldset>
    </form>
  );
}
