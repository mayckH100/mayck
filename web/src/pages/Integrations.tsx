import { useState } from 'react';
import { post, patch, del } from '../api';
import { useApi, Async, Empty, useAction, Modal, Field, fmtDate } from '../ui';

export default function Integrations() {
  const state = useApi<any[]>('/integrations');
  const [edit, setEdit] = useState<any>(null);
  const { busy, run } = useAction();
  return (
    <>
      <div className="page-head">
        <div><h1>Integrações de parceiros</h1><p className="muted">Conecte a API do seu sistema (painel, loja, ERP, CRM). A credencial fica cifrada e é usada pelo bloco "Webhook HTTP" dos fluxos, sem expor a chave no fluxo.</p></div>
        <button className="btn primary" onClick={() => setEdit({ name: '', baseUrl: '', authHeaderName: 'Authorization', authValue: '' })}>+ Nova integração</button>
      </div>
      <Async state={state}>{(list) => list.length === 0 ? <div className="card"><Empty title="Nenhuma integração">Exemplo: "Minha loja" com URL base https://api.minhaloja.com/v1 e cabeçalho Authorization: Bearer ….</Empty></div> : (
        <div className="card table-wrap">
          <table><thead><tr><th>Nome</th><th>URL base</th><th>Credencial</th><th>Último teste</th><th></th></tr></thead>
            <tbody>{list.map((i) => (
              <tr key={i.id}>
                <td><strong>{i.name}</strong><div className="small muted mono">{i.slug}</div></td>
                <td className="mono">{i.baseUrl}</td>
                <td className="small">{i.authHeaderName ? `${i.authHeaderName}: ${i.authPreview ?? '(vazio)'}` : 'Sem autenticação'}</td>
                <td className="small">{i.lastTestStatus ? <span className={`badge ${i.lastTestStatus === 'ok' ? 'green' : 'red'}`}>{i.lastTestStatus}</span> : '—'} {fmtDate(i.lastTestAt)}</td>
                <td><div className="row">
                  <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/integrations/${i.id}/test`)).then((r) => { state.reload(); if (r) alert(`Resultado: ${r.detail}`); })}>Testar</button>
                  <button className="btn sm" onClick={() => setEdit({ ...i, authValue: '' })}>Editar</button>
                  <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm('Excluir integração? Blocos HTTP que a usam passarão a falhar.')) run(() => del(`/integrations/${i.id}`), 'Integração excluída').then(state.reload); }}>Excluir</button>
                </div></td>
              </tr>
            ))}</tbody></table>
        </div>
      )}</Async>
      {edit && (
        <Modal title={edit.id ? 'Editar integração' : 'Nova integração'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const body: any = { name: edit.name, baseUrl: edit.baseUrl, authHeaderName: edit.authHeaderName ?? '' };
            if (edit.authValue) body.authValue = edit.authValue;
            const ok = await run(() => (edit.id ? patch(`/integrations/${edit.id}`, body) : post('/integrations', body)), 'Integração salva');
            if (ok) { setEdit(null); state.reload(); }
          }}>
            <Field label="Nome"><input required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="URL base" hint="HTTPS público. Endereços internos são bloqueados."><input required type="url" value={edit.baseUrl} onChange={(e) => setEdit({ ...edit, baseUrl: e.target.value })} /></Field>
            <Field label="Cabeçalho de autenticação (opcional)"><input value={edit.authHeaderName ?? ''} onChange={(e) => setEdit({ ...edit, authHeaderName: e.target.value })} placeholder="Authorization" /></Field>
            <Field label="Valor do cabeçalho" hint={edit.id ? 'Preencha só para trocar' : 'Ex.: Bearer sua-chave — guardado cifrado'}><input type="password" autoComplete="off" value={edit.authValue} onChange={(e) => setEdit({ ...edit, authValue: e.target.value })} /></Field>
            <button className="btn primary" disabled={busy}>Salvar</button>
          </form>
        </Modal>
      )}
    </>
  );
}
