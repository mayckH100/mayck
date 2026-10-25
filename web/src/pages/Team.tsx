import { useState } from 'react';
import { post, patch, del } from '../api';
import { useAuth, ROLE_LABEL } from '../auth';
import { useApi, Async, useAction, Field, fmtDate, useToast, copy } from '../ui';

export default function Team() {
  const state = useApi<any>('/team');
  const { me, can } = useAuth();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('AGENT');
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const admin = can('OWNER', 'ADMIN');
  return (
    <>
      <div className="page-head"><div><h1>Equipe</h1><p className="muted">Papéis: Proprietário (tudo), Administrador (fluxos, IA, canais, equipe) e Atendente (Inbox, Kanban e contatos).</p></div></div>
      <div className="grid g2">
        {admin && (
          <form className="card stack" onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => post('/team/invites', { email, role }), 'Convite criado');
            if (r) { setLink(r.link); setEmail(''); state.reload(); }
          }}>
            <h2>Convidar membro</h2>
            <Field label="E-mail"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colega@empresa.com" /></Field>
            <Field label="Papel"><select value={role} onChange={(e) => setRole(e.target.value)}><option value="AGENT">Atendente</option><option value="ADMIN">Administrador</option></select></Field>
            <button className="btn primary" disabled={busy}>Gerar convite</button>
            <p className="small muted">O envio de e-mail não está configurado: copie o link e envie para a pessoa. O link vale 7 dias e só pode ser usado uma vez.</p>
            {link && <div className="alert ok small"><div className="mono">{link}</div><button type="button" className="btn sm" onClick={() => copy(link, toast)}>Copiar link</button></div>}
          </form>
        )}
        <Async state={state}>{(d) => (
          <div className="card stack">
            <h2>Membros ({d.members.length})</h2>
            {d.members.map((m: any) => (
              <div key={m.id} className="row between">
                <div><strong>{m.user.name}</strong>{m.user.id === me?.user.id && <span className="badge" style={{ marginLeft: 6 }}>você</span>}<div className="small muted">{m.user.email} · desde {fmtDate(m.createdAt)}</div></div>
                <div className="row">
                  {m.role === 'OWNER' || !can('OWNER') ? <span className="badge">{ROLE_LABEL[m.role as 'OWNER']}</span> : (
                    <select value={m.role} style={{ width: 150 }} aria-label="Papel" onChange={(e) => run(() => patch(`/team/members/${m.id}`, { role: e.target.value }), 'Papel atualizado').then(state.reload)}>
                      <option value="ADMIN">Administrador</option><option value="AGENT">Atendente</option>
                    </select>)}
                  {admin && m.role !== 'OWNER' && m.user.id !== me?.user.id && (m.role !== 'ADMIN' || can('OWNER')) && (
                    <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm(`Remover ${m.user.name} da equipe?`)) run(() => del(`/team/members/${m.id}`), 'Membro removido').then(state.reload); }}>Remover</button>)}
                </div>
              </div>
            ))}
            {d.invites.length > 0 && <>
              <h3>Convites pendentes</h3>
              {d.invites.map((i: any) => (
                <div key={i.id} className="row between small"><span>{i.email} · {ROLE_LABEL[i.role as 'AGENT']} · expira {fmtDate(i.expiresAt)}</span>
                  <button className="btn sm" disabled={busy} onClick={() => run(() => del(`/team/invites/${i.id}`), 'Convite cancelado').then(state.reload)}>Cancelar</button></div>
              ))}
            </>}
          </div>
        )}</Async>
      </div>
    </>
  );
}
