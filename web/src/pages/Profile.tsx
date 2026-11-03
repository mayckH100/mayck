import { useState } from 'react';
import { patch, put } from '../api';
import { useAuth } from '../auth';
import { useAction, Field } from '../ui';
import { SecuritySection, PasswordCard, RenewalRemindersCard } from './Security';

export default function Profile() {
  const { me, refresh, can } = useAuth();
  const [name, setName] = useState(me?.user.name ?? '');
  const [phone, setPhone] = useState(me?.user.phone ?? '');
  const [org, setOrg] = useState({ name: me?.org?.name ?? '', timezone: me?.org?.timezone ?? 'America/Sao_Paulo', backupPhone: me?.org?.backupPhone ?? '', handoffAlertMinutes: me?.org?.handoffAlertMinutes ?? 5 });
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
        <PasswordCard app="mckbot" />
        <RenewalRemindersCard />
        {can('OWNER', 'ADMIN') && (
          <div className="card stack">
            <h2>Alertas</h2>
            <label className="row small" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={me?.user.waDownEmail !== false}
                disabled={busy}
                onChange={async (e) => { const v = e.target.checked; if (await run(() => put('/profile/alertas', { waDownEmail: v }), v ? 'Você vai receber o alerta por e-mail' : 'Alerta por e-mail desligado')) refresh(); }}
              />
              <span>
                <strong>Avisar por e-mail quando um WhatsApp desconectar</strong>
                <span className="muted" style={{ display: 'block' }}>Depois de 5 minutos fora do ar (reconexões rápidas e reinícios do servidor não contam), com o link para reconectar e um lembrete se continuar fora depois de 24 h. O aviso no app aparece sempre.</span>
              </span>
            </label>
          </div>
        )}
        {can('OWNER', 'ADMIN') && (
          <form className="card stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => patch('/org', org), 'Organização atualizada')) refresh(); }}>
            <h2>Organização</h2>
            <Field label="Nome"><input required minLength={2} value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} /></Field>
            <Field label="Fuso horário" hint="Usado nos gatilhos de horário e relatórios"><select value={org.timezone} onChange={(e) => setOrg({ ...org, timezone: e.target.value })}>
              {['America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Cuiaba', 'America/Rio_Branco', 'America/Noronha', 'Europe/Lisbon'].map((t) => <option key={t}>{t}</option>)}
            </select></Field>
            <Field label="WhatsApp reserva (Aguardando atendente)" hint="Recebe um aviso quando um contato espera um atendente. Formato +55 DDD número; deixe vazio para não avisar"><input type="tel" placeholder="+5511999998888" value={org.backupPhone} onChange={(e) => setOrg({ ...org, backupPhone: e.target.value })} /></Field>
            <Field label="Avisar após (minutos)" hint="Tempo de espera sem resposta do atendente antes do aviso (1 a 120)"><input type="number" min={1} max={120} required value={org.handoffAlertMinutes} onChange={(e) => setOrg({ ...org, handoffAlertMinutes: Number(e.target.value) })} /></Field>
            <button className="btn primary" disabled={busy}>Salvar organização</button>
          </form>
        )}
      </div>
      <h2 id="seguranca" style={{ marginTop: 24 }}>Segurança</h2>
      <SecuritySection />
    </>
  );
}
