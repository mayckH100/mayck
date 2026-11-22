/**
 * v1.44.0 — Links de origem (wa.me com código) e cartão "Origem dos leads" em Relatórios.
 */
import { useState } from 'react';
import { post, del } from '../api';
import { useApi, useAction, Modal, Field, useToast, copy, fmtNum } from '../ui';
import { useAuth } from '../auth';

export function LinksOrigemModal({ onClose }: { onClose: () => void }) {
  const state = useApi<any>('/origens');
  const { can } = useAuth();
  const admin = can('OWNER', 'ADMIN');
  const [f, setF] = useState({ name: '', code: '', text: 'Olá!', channelId: '' });
  const { busy, run } = useAction();
  const toast = useToast();
  const criar = async () => {
    if (await run(() => post('/origens', { ...f, channelId: f.channelId || null }), 'Link criado')) { setF({ name: '', code: '', text: 'Olá!', channelId: '' }); state.reload(); }
  };
  return (
    <Modal title="📍 Links de origem" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>Crie um link de WhatsApp para cada lugar onde você divulga (bio do Instagram, anúncio, panfleto, Google). O código vai no texto da mensagem; quando o cliente chama, o MCKBOT registra de onde ele veio e tira o código da conversa. Anúncios de clique para o WhatsApp da API oficial são marcados sozinhos.</p>
      {admin && (
        <div className="stack" style={{ marginBottom: 12 }}>
          <div className="grid g2">
            <Field label="Nome"><input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Bio do Instagram" /></Field>
            <Field label="Código (opcional)" hint="Letras, números e -. Vazio = gerado pelo nome."><input value={f.code} maxLength={40} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="instagram-bio" /></Field>
            <Field label="Texto da mensagem"><input value={f.text} maxLength={300} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
            <Field label="WhatsApp"><select value={f.channelId} onChange={(e) => setF({ ...f, channelId: e.target.value })}><option value="">Primeiro número conectado</option>{(state.data?.canais ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.numero ? ` (${c.numero})` : ''}</option>)}</select></Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !f.name.trim()} onClick={criar}>Criar link</button></div>
        </div>
      )}
      <div className="table-wrap"><table className="small"><thead><tr><th>Nome</th><th>Código</th><th>Link</th><th /></tr></thead>
        <tbody>
          {(state.data?.items ?? []).map((l: any) => (
            <tr key={l.id}>
              <td>{l.name}</td><td><code>{l.code}</code></td>
              <td>{l.link ? <button className="btn sm" onClick={() => copy(l.link, toast)} title={l.link}>📋 Copiar link</button> : <span className="muted" title="Conecte um número de WhatsApp para gerar o link">sem número</span>}
                <button className="btn sm" style={{ marginLeft: 4 }} onClick={() => copy(l.textoCompleto, toast)} title="Para anúncios: cole como mensagem pronta">Copiar texto</button></td>
              <td>{admin && <button className="btn sm" disabled={busy} onClick={async () => { if (confirm(`Excluir o link ${l.name}? As conversas já registradas continuam com a origem.`) && await run(() => del(`/origens/${l.id}`), 'Link excluído')) state.reload(); }}>Excluir</button>}</td>
            </tr>
          ))}
          {state.data && !state.data.items.length && <tr><td colSpan={4} className="muted">Nenhum link ainda.</td></tr>}
        </tbody></table></div>
    </Modal>
  );
}

export function OrigemCard({ origens }: { origens: { origem: string | null; rotulo: string; conversas: number; leads: number }[] }) {
  const [show, setShow] = useState(false);
  const max = Math.max(1, ...origens.map((o) => o.conversas));
  return (
    <div className="card">
      <div className="row between"><h2 style={{ margin: 0 }}>Origem dos leads</h2><button className="btn sm" onClick={() => setShow(true)}>📍 Links de origem</button></div>
      {!origens.length ? <p className="small muted">Nenhuma conversa no período.</p> : (
        <table className="small" style={{ marginTop: 8 }}><thead><tr><th>Origem</th><th>Conversas</th><th title="Contatos novos (primeiro contato) no período">Leads novos</th></tr></thead>
          <tbody>{origens.map((o) => (
            <tr key={o.origem ?? 'sem'}>
              <td>{o.rotulo}<div className="bar" style={{ marginTop: 2 }}><span style={{ width: `${(o.conversas / max) * 100}%`, background: o.origem ? '#2f6fde' : '#94a3b8' }} /></div></td>
              <td>{fmtNum(o.conversas)}</td><td>{fmtNum(o.leads)}</td>
            </tr>
          ))}</tbody></table>
      )}
      {show && <LinksOrigemModal onClose={() => setShow(false)} />}
    </div>
  );
}
