/**
 * v1.44.0 — Canais › Chat para o site: criar, configurar (cor, título, boas-vindas, domínios) e copiar o código.
 */
import { useState } from 'react';
import { post, put, del } from '../api';
import { useApi, useAction, Modal, Field, useToast, copy } from '../ui';

function Editor({ s, onClose, onSaved }: { s: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: s.name, color: s.color, title: s.title, welcome: s.welcome, allowedOrigins: s.allowedOrigins, askName: s.askName });
  const { busy, run } = useAction();
  return (
    <Modal title="Configurar chat do site" onClose={onClose}>
      <div className="stack">
        <div className="grid g2">
          <Field label="Nome (aparece no Inbox)"><input value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Cor"><input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></Field>
          <Field label="Título da janela"><input value={f.title} maxLength={60} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Pedir nome antes de conversar"><select value={f.askName ? '1' : '0'} onChange={(e) => setF({ ...f, askName: e.target.value === '1' })}><option value="1">Sim (nome e WhatsApp opcional)</option><option value="0">Não</option></select></Field>
        </div>
        <Field label="Mensagem de boas-vindas"><textarea rows={2} maxLength={300} value={f.welcome} onChange={(e) => setF({ ...f, welcome: e.target.value })} /></Field>
        <Field label="Sites autorizados (opcional)" hint="Um por linha, ex.: www.minhaloja.com.br ou *.minhaloja.com.br. Vazio = o código funciona em qualquer site."><textarea rows={3} value={f.allowedOrigins} onChange={(e) => setF({ ...f, allowedOrigins: e.target.value })} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !f.title.trim()} onClick={async () => { if (await run(() => put(`/channels/site/${s.id}`, f), 'Chat do site salvo')) { onSaved(); onClose(); } }}>Salvar</button>
        </div>
      </div>
    </Modal>
  );
}

export default function SiteChat({ admin }: { admin: boolean }) {
  const state = useApi<{ items: any[] }>('/channels/site');
  const [edit, setEdit] = useState<any>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const items = state.data?.items ?? [];
  return (
    <div className="card stack" style={{ marginTop: 16 }}>
      <div className="row between">
        <div><h2 style={{ margin: 0 }}>💬 Chat para o seu site</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Um botão de conversa no seu site. As mensagens chegam no Inbox como canal "Site" e passam pela IA, fluxos, distribuição e horário de atendimento, como no WhatsApp.</p></div>
        {admin && items.length < 3 && <button className="btn sm primary" disabled={busy} onClick={async () => { if (await run(() => post('/channels/site', { name: 'Site' }), 'Chat do site criado: copie o código para o seu site')) state.reload(); }}>+ Criar chat do site</button>}
      </div>
      {items.map((s) => (
        <div key={s.id} className="stack" style={{ borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 10 }}>
          <div className="row between"><strong><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 6, background: s.color, marginRight: 6 }} />{s.name}</strong>
            {admin && <span className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={() => setEdit(s)}>Configurar</button>
              <button className="btn sm" disabled={busy} onClick={async () => { if (confirm('Excluir este chat do site? O botão some do seu site; as conversas continuam no Inbox.') && await run(() => del(`/channels/site/${s.id}`), 'Chat do site excluído')) state.reload(); }}>Excluir</button>
            </span>}
          </div>
          <Field label="Código para colar no seu site" hint="Cole antes de </body> em todas as páginas (ou no campo de scripts do seu construtor de sites).">
            <textarea readOnly rows={2} value={s.embed} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </Field>
          <div className="row" style={{ gap: 6 }}><button className="btn sm" onClick={() => copy(s.embed, toast)}>📋 Copiar código</button>
            <span className="small muted">{s.allowedOrigins ? `Só funciona em: ${s.allowedOrigins.split('\n').join(', ')}` : 'Funciona em qualquer site'}</span></div>
        </div>
      ))}
      {!items.length && state.data && <p className="small muted" style={{ margin: 0 }}>{admin ? 'Nenhum chat de site ainda.' : 'Nenhum chat de site. O Proprietário ou Administrador pode criar aqui.'}</p>}
      {edit && <Editor s={edit} onClose={() => setEdit(null)} onSaved={state.reload} />}
    </div>
  );
}
