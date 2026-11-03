import { useEffect, useState } from 'react';
import { get, patch, post, put } from '../api';
import { useAuth } from '../auth';
import { useAction, Field } from '../ui';
import { SecuritySection, PasswordCard, RenewalRemindersCard } from './Security';

export default function Profile() {
  const { me, refresh, can } = useAuth();
  const [name, setName] = useState(me?.user.name ?? '');
  const [phone, setPhone] = useState(me?.user.phone ?? '');
  const [org, setOrg] = useState({ name: me?.org?.name ?? '', timezone: me?.org?.timezone ?? 'America/Sao_Paulo', handoffAlertMinutes: me?.org?.handoffAlertMinutes ?? 5 });
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
            <Field label="Lembrete após (minutos)" hint="Se ninguém responder o contato transferido, os números de aviso recebem um lembrete depois deste tempo (1 a 120)"><input type="number" min={1} max={120} required value={org.handoffAlertMinutes} onChange={(e) => setOrg({ ...org, handoffAlertMinutes: Number(e.target.value) })} /></Field>
            <button className="btn primary" disabled={busy}>Salvar organização</button>
          </form>
        )}
        {can('OWNER', 'ADMIN') && <HandoffNotifyCard onSaved={refresh} />}
      </div>
      <h2 id="seguranca" style={{ marginTop: 24 }}>Segurança</h2>
      <SecuritySection />
    </>
  );
}

const samePhone = (a?: string | null, b?: string | null) => {
  const x = String(a ?? '').replace(/\D/g, ''), y = String(b ?? '').replace(/\D/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const br = (d: string) => (d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2, 4) + d.slice(-8) : null);
  return !!br(x) && br(x) === br(y);
};

/** Números que recebem no WhatsApp o aviso de cada transferência para atendimento humano (+ "Enviar teste"). */
function HandoffNotifyCard({ onSaved }: { onSaved: () => void }) {
  const [data, setData] = useState<any>(null);
  const [phones, setPhones] = useState<string[]>(['']);
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  const load = async () => {
    const d = await get('/org/handoff-notify').catch(() => null);
    if (!d) return;
    setData(d);
    setPhones(d.phones.length ? d.phones : ['']);
  };
  useEffect(() => { load(); }, []);
  const list = phones.map((p) => p.trim()).filter(Boolean);
  const selfOf = (p: string) => data?.channels?.find((c: any) => samePhone(c.phone, p));
  const st = data?.status;
  return (
    <form id="avisos-atendimento" className="card stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => patch('/org', { handoffNotifyPhones: list }), list.length ? 'Números de aviso salvos' : 'Avisos desligados')) { await load(); onSaved(); } }}>
      <h2>Números de aviso de atendimento</h2>
      <p className="muted small" style={{ margin: 0 }}>Quando um contato é transferido para atendimento humano (pedido do cliente, fluxo ou qualificação), estes números recebem na hora uma mensagem no WhatsApp com nome, telefone, motivo, WhatsApp de origem e o link da conversa. Use o celular de quem atende, não o número conectado no MCKBOT.</p>
      {data && !data.phones.length && (
        <div className="alert warn" role="alert">Nenhum número configurado: <strong>hoje ninguém é avisado</strong> quando um contato pede atendimento humano.</div>
      )}
      {phones.map((p, i) => {
        const self = p.trim() && selfOf(p.trim());
        return (
          <div key={i} className="stack" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 8 }}>
              <input type="tel" aria-label={`Número de aviso ${i + 1}`} placeholder="+5511999998888" value={p} onChange={(e) => setPhones(phones.map((x, j) => (j === i ? e.target.value : x)))} />
              {phones.length > 1 && <button type="button" className="btn sm" onClick={() => setPhones(phones.filter((_, j) => j !== i))} aria-label="Remover número">✕</button>}
            </div>
            {self && <span className="small" style={{ color: '#b45309' }}>Este é o número do {self.label}. O WhatsApp não envia notificação para o próprio número: o aviso não chegaria. Use outro celular (se não houver outro WhatsApp conectado, o aviso vai por e-mail para o Proprietário/Admin).</span>}
          </div>
        );
      })}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {phones.length < 5 && <button type="button" className="btn sm" onClick={() => setPhones([...phones, ''])}>+ Adicionar número</button>}
        {data?.suggestion && !list.some((x) => samePhone(x, data.suggestion)) && (
          <button type="button" className="btn sm" onClick={() => setPhones([...list, data.suggestion])}>Usar meu WhatsApp para contato ({data.suggestion})</button>
        )}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy}>Salvar números</button>
        <button type="button" className="btn" disabled={busy || !list.length} onClick={async () => { const r = await run(() => post('/org/handoff-notify/test', { phones: list })); if (r) { setResult(r); load(); } }}>Enviar teste</button>
      </div>
      {result && (
        <div className={`alert ${result.ok ? 'ok' : 'err'}`} role="status">
          {result.results.map((r: any) => <div key={r.phone}>{r.ok ? '✅' : '❌'} {r.phone}: {r.ok ? `enviado pelo ${r.via}` : r.error}</div>)}
          {!result.ok && <div>{result.emailed ? `Enviamos o aviso por e-mail para ${result.emailed} Proprietário/Admin.` : 'Nenhum e-mail de reserva foi enviado.'}</div>}
        </div>
      )}
      {st && <p className="small muted" style={{ margin: 0 }}>Último aviso ({new Date(st.at).toLocaleString('pt-BR')}): {st.ok ? '✅' : '⚠️'} {st.detail}</p>}
    </form>
  );
}
