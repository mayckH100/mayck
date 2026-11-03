import { useState } from 'react';
import { post, patch, del } from '../api';
import { useAuth, ROLE_LABEL } from '../auth';
import { useApi, Async, useAction, Field, fmtDate, useToast, copy } from '../ui';

type Mod = { id: string; label: string; app: string };
type Perms = { catalog: Mod[]; defaults: Record<'ADMIN' | 'AGENT', string[]>; roleModules: Record<string, string[]>; mine: string[]; myChannelIds: string[] | null };
type Channel = { id: string; label: string };
type InviteResult = { email: string; link: string; emailSent: boolean; message: string };

/** Caixas por módulo + canais WhatsApp. Só mostra o que o papel permite e o que quem concede tem. */
function PermissionPicker({ perms, role, channels, modules, setModules, channelIds, setChannelIds }: {
  perms: Perms; role: 'ADMIN' | 'AGENT'; channels: Channel[];
  modules: string[]; setModules: (m: string[]) => void; channelIds: string[] | null; setChannelIds: (c: string[] | null) => void;
}) {
  const avail = perms.catalog.filter((m) => perms.roleModules[role]?.includes(m.id));
  const myCh = perms.myChannelIds;
  const selectable = myCh ? channels.filter((c) => myCh.includes(c.id)) : channels;
  const toggle = (id: string) => setModules(modules.includes(id) ? modules.filter((x) => x !== id) : [...modules, id]);
  const toggleCh = (id: string) => { const cur = channelIds ?? []; setChannelIds(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]); };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small"><strong>O que pode acessar</strong></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 4 }}>
        {avail.map((m) => {
          const canGrant = perms.mine.includes(m.id);
          return (
            <label key={m.id} className="small row" style={{ gap: 6, opacity: canGrant ? 1 : 0.5 }} title={canGrant ? '' : 'Você não tem este acesso, então não pode liberá-lo'}>
              <input type="checkbox" checked={modules.includes(m.id)} disabled={!canGrant} onChange={() => toggle(m.id)} /> {m.label}
            </label>
          );
        })}
      </div>
      {selectable.length > 0 && <>
        <div className="small"><strong>Canais WhatsApp que pode atender</strong></div>
        <label className="small row" style={{ gap: 6 }}>
          <input type="checkbox" checked={channelIds === null} disabled={!!myCh} onChange={(e) => setChannelIds(e.target.checked ? null : [])} /> Todos os canais
        </label>
        {channelIds !== null && selectable.map((c) => (
          <label key={c.id} className="small row" style={{ gap: 6, marginLeft: 18 }}>
            <input type="checkbox" checked={channelIds.includes(c.id)} onChange={() => toggleCh(c.id)} /> {c.label}
          </label>
        ))}
        {channelIds !== null && channelIds.length === 0 && <span className="small muted">Nenhum canal marcado: a pessoa não verá conversas.</span>}
      </>}
    </div>
  );
}

function ResultBox({ r, toast }: { r: InviteResult; toast: (t: string) => void }) {
  return (
    <div className={`alert ${r.emailSent ? 'ok' : 'warn'} small stack`} style={{ gap: 6 }}>
      <div>{r.message}</div>
      <div className="muted">{r.emailSent ? 'Se preferir, você também pode copiar o link:' : 'Link do convite:'}</div>
      <div className="mono" style={{ wordBreak: 'break-all' }}>{r.link}</div>
      <div><button type="button" className="btn sm" onClick={() => copy(r.link, toast)}>Copiar link</button></div>
    </div>
  );
}

function MemberPerms({ m, perms, channels, onSaved }: { m: any; perms: Perms; channels: Channel[]; onSaved: () => void }) {
  const [modules, setModules] = useState<string[]>(m.modules ?? []);
  const [channelIds, setChannelIds] = useState<string[] | null>(m.channelIds ?? null);
  const { busy, run } = useAction();
  return (
    <div className="card stack" style={{ marginTop: 6 }}>
      <PermissionPicker perms={perms} role={m.role} channels={channels} modules={modules} setModules={setModules} channelIds={channelIds} setChannelIds={setChannelIds} />
      <div><button className="btn sm primary" disabled={busy} onClick={async () => { const r = await run(() => patch(`/team/members/${m.id}`, { modules, channelIds }), 'Permissões atualizadas'); if (r) onSaved(); }}>Salvar permissões</button></div>
    </div>
  );
}

export default function Team() {
  const state = useApi<any>('/team');
  const chState = useApi<any[]>('/channels');
  const { me, can } = useAuth();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'AGENT'>('AGENT');
  const [modules, setModules] = useState<string[] | null>(null); // null = ainda no padrão do papel
  const [channelIds, setChannelIds] = useState<string[] | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const admin = can('OWNER', 'ADMIN');
  const perms: Perms | null = state.data?.permissions ?? null;
  const channels: Channel[] = (chState.data ?? []).map((c: any) => ({ id: c.id, label: c.label ?? c.name }));
  const defaultsFor = (r: 'ADMIN' | 'AGENT') => (perms ? perms.defaults[r].filter((x) => perms.mine.includes(x)) : []);
  const mods = modules ?? defaultsFor(role);
  const isOwner = me?.role === 'OWNER';
  const canEditMember = (m: any) => admin && perms && m.role !== 'OWNER' && m.user.id !== me?.user.id && (m.role !== 'ADMIN' || isOwner);
  return (
    <>
      <div className="page-head"><div><h1>Equipe</h1><p className="muted">Papéis: Proprietário (tudo), Administrador (fluxos, IA, canais, equipe) e Atendente (Inbox, Kanban e contatos). Em cada pessoa você escolhe os módulos e os canais WhatsApp que ela pode acessar.</p></div></div>
      <div className="grid g2">
        {admin && perms && (
          <form className="card stack" onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => post<InviteResult>('/team/invites', { email, role, modules: mods, channelIds }));
            if (r) {
              setResult(r); toast(r.emailSent ? 'Convite enviado' : 'Convite criado');
              setEmail(''); setModules(null); setChannelIds(null); state.reload();
            }
          }}>
            <h2>Convidar membro</h2>
            <Field label="E-mail"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colega@empresa.com" /></Field>
            <Field label="Papel"><select value={role} onChange={(e) => { setRole(e.target.value as 'ADMIN' | 'AGENT'); setModules(null); }}><option value="AGENT">Atendente</option><option value="ADMIN">Administrador</option></select></Field>
            <PermissionPicker perms={perms} role={role} channels={channels} modules={mods} setModules={setModules} channelIds={channelIds} setChannelIds={setChannelIds} />
            <button className="btn primary" disabled={busy}>Enviar convite</button>
            <p className="small muted">A pessoa recebe o convite por e-mail. O link vale 7 dias e só pode ser usado uma vez.</p>
            {result && <ResultBox r={result} toast={toast} />}
          </form>
        )}
        <Async state={state}>{(d) => (
          <div className="card stack">
            <h2>Membros ({d.members.length})</h2>
            {d.members.map((m: any) => (
              <div key={m.id}>
                <div className="row between">
                  <div><strong>{m.user.name}</strong>{m.user.id === me?.user.id && <span className="badge" style={{ marginLeft: 6 }}>você</span>}<div className="small muted">{m.user.email} · desde {fmtDate(m.createdAt)}</div>
                    {m.role !== 'OWNER' && m.modules && perms && <div className="small muted">Acessa: {m.modules.map((id: string) => perms.catalog.find((c) => c.id === id)?.label ?? id).join(', ') || 'nenhum módulo'}{m.channelIds ? ` · ${m.channelIds.length} canal(is) WhatsApp` : ''}</div>}
                  </div>
                  <div className="row">
                    {m.role === 'OWNER' || !can('OWNER') ? <span className="badge">{ROLE_LABEL[m.role as 'OWNER']}</span> : (
                      <select value={m.role} style={{ width: 150 }} aria-label="Papel" onChange={(e) => run(() => patch(`/team/members/${m.id}`, { role: e.target.value }), 'Papel atualizado').then(state.reload)}>
                        <option value="ADMIN">Administrador</option><option value="AGENT">Atendente</option>
                      </select>)}
                    {canEditMember(m) && <button className="btn sm" onClick={() => setEditing(editing === m.id ? null : m.id)}>{editing === m.id ? 'Fechar' : 'Permissões'}</button>}
                    {admin && m.role !== 'OWNER' && m.user.id !== me?.user.id && (m.role !== 'ADMIN' || can('OWNER')) && (
                      <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm(`Remover ${m.user.name} da equipe?`)) run(() => del(`/team/members/${m.id}`), 'Membro removido').then(state.reload); }}>Remover</button>)}
                  </div>
                </div>
                {editing === m.id && perms && <MemberPerms key={m.id + m.role} m={m} perms={perms} channels={channels} onSaved={() => { setEditing(null); state.reload(); }} />}
              </div>
            ))}
            {d.invites.length > 0 && <>
              <h3>Convites pendentes</h3>
              {d.invites.map((i: any) => (
                <div key={i.id} className="row between small"><span>{i.email} · {ROLE_LABEL[i.role as 'AGENT']} · expira {fmtDate(i.expiresAt)}{i.lastSentAt ? ` · último envio ${fmtDate(i.lastSentAt)}` : ' · e-mail não enviado'}</span>
                  <div className="row">
                    {(i.role !== 'ADMIN' || isOwner) && <button className="btn sm" disabled={busy} onClick={async () => { const r = await run(() => post<InviteResult>(`/team/invites/${i.id}/resend`)); if (r) { setResult(r); toast(r.emailSent ? 'Convite reenviado' : 'Novo link gerado'); state.reload(); } }}>Reenviar convite</button>}
                    <button className="btn sm" disabled={busy} onClick={() => run(() => del(`/team/invites/${i.id}`), 'Convite cancelado').then(state.reload)}>Cancelar</button>
                  </div>
                </div>
              ))}
            </>}
          </div>
        )}</Async>
      </div>
    </>
  );
}
