import { useState } from 'react';
import { patch, post } from '../api';
import { useAuth } from '../auth';
import { useAction, Field } from '../ui';
import { SecuritySection } from './Security';

export default function Profile() {
  const { me, refresh, can } = useAuth();
  const [name, setName] = useState(me?.user.name ?? '');
  const [phone, setPhone] = useState(me?.user.phone ?? '');
  const [org, setOrg] = useState({ name: me?.org?.name ?? '', timezone: me?.org?.timezone ?? 'America/Sao_Paulo' });
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const { busy, run } = useAction();
  return (
    <>
      <div className="page-head"><div><h1>Perfil e conta</h1><p className="muted">Seus dados, segurança e dados da organização.</p></div></div>
      <div className="grid g2">
        <form className="card stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => patch('/profile', { name, phone }), 'Dados salvos')) refresh(); }}>
          <h2>Dados pessoais</h2>
          <Field label="E-mail" hint="O e-mail de login não pode ser alterado aqui"><input value={me?.user.email} readOnly /></Field>
          <Field label="Nome"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="WhatsApp para contato"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <button className="btn primary" disabled={busy}>Salvar dados</button>
        </form>
        <form className="card stack" onSubmit={async (e) => {
          e.preventDefault();
          if (pw.next !== pw.confirm) { alert('A confirmação não confere com a nova senha'); return; }
          if (await run(() => post('/profile/password', { current: pw.current, next: pw.next }), 'Senha alterada. Outras sessões foram encerradas.')) setPw({ current: '', next: '', confirm: '' });
        }}>
          <h2>Alterar senha</h2>
          <Field label="Senha atual"><input type="password" required autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="Nova senha" hint="Mínimo de 8 caracteres"><input type="password" required minLength={8} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <Field label="Confirmar nova senha"><input type="password" required minLength={8} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          <button className="btn primary" disabled={busy}>Alterar senha</button>
        </form>
        {can('OWNER', 'ADMIN') && (
          <form className="card stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => patch('/org', org), 'Organização atualizada')) refresh(); }}>
            <h2>Organização</h2>
            <Field label="Nome"><input required minLength={2} value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} /></Field>
            <Field label="Fuso horário" hint="Usado nos gatilhos de horário e relatórios"><select value={org.timezone} onChange={(e) => setOrg({ ...org, timezone: e.target.value })}>
              {['America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Cuiaba', 'America/Rio_Branco', 'America/Noronha', 'Europe/Lisbon'].map((t) => <option key={t}>{t}</option>)}
            </select></Field>
            <button className="btn primary" disabled={busy}>Salvar organização</button>
          </form>
        )}
      </div>
      <h2 id="seguranca" style={{ marginTop: 24 }}>Segurança</h2>
      <SecuritySection />
    </>
  );
}
