import { useState, type FormEvent } from 'react';
import { del, post } from '../api';
import { useAuth, type Me } from '../auth';
import { Field, useApi, Async, fmtDate, useToast, useAction } from '../ui';

/** Etapa do código (2FA) no login. Usada pelo MCKBOT e pelo MCK Mensagens. */
export function MfaLoginStep({ mfaToken, app, onDone, onCancel }: { mfaToken: string; app: 'mckbot' | 'mensagem'; onDone: (me: Me) => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { onDone(await post<Me>('/auth/login/mfa', { mfaToken, code, app })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h2 style={{ textAlign: 'center', margin: 0 }}>Verificação em duas etapas</h2>
      <p className="muted small" style={{ textAlign: 'center' }}>
        {useRecovery ? 'Digite um dos seus códigos de recuperação (cada um funciona uma única vez).' : 'Abra o app autenticador no celular e digite o código de 6 dígitos da MCK.'}
      </p>
      {error && <div className="alert err" role="alert">{error}</div>}
      <Field label={useRecovery ? 'Código de recuperação' : 'Código do app'}>
        <input autoFocus required value={code} onChange={(e) => setCode(e.target.value)} inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code"
          placeholder={useRecovery ? 'XXXXX-XXXXX' : '000000'} maxLength={useRecovery ? 12 : 7} style={{ letterSpacing: 4, textAlign: 'center', fontSize: 20 }} />
      </Field>
      <button className="btn primary" disabled={busy}>{busy ? 'Verificando…' : 'Confirmar'}</button>
      <div className="row between small">
        <button type="button" className="btn sm" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(''); }}>{useRecovery ? 'Usar código do app' : 'Perdi o celular: usar código de recuperação'}</button>
        <button type="button" className="btn sm" onClick={onCancel}>Voltar</button>
      </div>
    </form>
  );
}

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const toast = useToast();
  const text = `Códigos de recuperação MCK (cada um vale uma vez)\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'codigos-recuperacao-mck.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="stack">
      <div className="alert warn"><strong>Guarde estes códigos agora.</strong> Eles só aparecem esta vez e permitem entrar se você perder o celular. Cada um funciona uma única vez.</div>
      <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, fontSize: 16 }}>{codes.map((c) => <span key={c}>{c}</span>)}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" onClick={download}>Baixar .txt</button>
        <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(text).then(() => toast('Códigos copiados'))}>Copiar</button>
        <button type="button" className="btn primary" onClick={onClose}>Já guardei</button>
      </div>
    </div>
  );
}

interface MfaState { enabled: boolean; enabledAt: string | null; required: boolean; recoveryCodesLeft: number }

/** Cartão da verificação em duas etapas (ativar, novos códigos, desativar). */
export function TwoFactorCard({ onChange }: { onChange?: () => void }) {
  const state = useApi<MfaState>('/auth/2fa');
  const { refresh } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; qr: string; otpauthUrl: string } | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'idle' | 'disable' | 'regen'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const done = async () => { state.reload(); await refresh(); onChange?.(); };
  return (
    <div className="card stack">
      <h2>Verificação em duas etapas</h2>
      <Async state={state}>{(s) => (
        <>
          <p className="muted small">Além da senha, o login pede um código do app autenticador do celular (Google Authenticator, Microsoft Authenticator, Authy ou 2FAS). Mesmo que alguém descubra sua senha, não entra sem o seu celular.</p>
          {s.required && !s.enabled && <div className="alert warn">Obrigatória para o administrador da plataforma: ative para liberar o Painel Master.</div>}
          {error && <div className="alert err" role="alert">{error}</div>}
          {codes ? <RecoveryCodes codes={codes} onClose={() => setCodes(null)} /> : s.enabled ? (
            <>
              <div className="alert ok">Ativa desde {fmtDate(s.enabledAt)} · {s.recoveryCodesLeft} código(s) de recuperação restantes.</div>
              {mode === 'idle' && (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={() => { setMode('regen'); setCode(''); }}>Gerar novos códigos de recuperação</button>
                  {!s.required && <button className="btn" onClick={() => { setMode('disable'); setCode(''); setPassword(''); }}>Desativar</button>}
                </div>
              )}
              {mode !== 'idle' && (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); act(async () => {
                  if (mode === 'regen') { const r = await post<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { code }); setCodes(r.recoveryCodes); }
                  else { await post('/auth/2fa/disable', { password, code }); toast('Verificação em duas etapas desativada'); }
                  setMode('idle'); await done();
                }); }}>
                  {mode === 'disable' && <Field label="Senha atual"><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>}
                  <Field label="Código do app (ou de recuperação)"><input required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" /></Field>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn primary" disabled={busy}>{mode === 'regen' ? 'Gerar códigos' : 'Desativar'}</button>
                    <button type="button" className="btn" onClick={() => setMode('idle')}>Cancelar</button>
                  </div>
                </form>
              )}
            </>
          ) : setup ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); act(async () => {
              const r = await post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code });
              setSetup(null); setCode(''); setCodes(r.recoveryCodes); toast('Verificação em duas etapas ativada'); await done();
            }); }}>
              <p className="small"><strong>1.</strong> No app autenticador, toque em “+” e leia o QR code:</p>
              <img src={setup.qr} alt="QR code para o app autenticador" width={200} height={200} style={{ alignSelf: 'center', background: '#fff', padding: 6, borderRadius: 8 }} />
              <p className="small muted">Não consegue ler? Digite a chave manualmente: <span className="mono" style={{ wordBreak: 'break-all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span></p>
              <p className="small"><strong>2.</strong> Digite o código de 6 dígitos que aparece no app:</p>
              <Field label="Código"><input required inputMode="numeric" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" style={{ letterSpacing: 4, fontSize: 18 }} /></Field>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" disabled={busy}>{busy ? 'Ativando…' : 'Ativar'}</button>
                <button type="button" className="btn" onClick={() => setSetup(null)}>Cancelar</button>
              </div>
            </form>
          ) : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); act(async () => { setSetup(await post('/auth/2fa/setup', { password })); setPassword(''); }); }}>
              <Field label="Confirme sua senha para começar"><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              <button className="btn primary" disabled={busy}>Ativar verificação em duas etapas</button>
            </form>
          )}
        </>
      )}</Async>
    </div>
  );
}

interface SessionItem { id: string; current: boolean; ip: string | null; device: string; createdAt: string; lastSeenAt: string; expiresAt: string }

/** Tela "Sessões ativas": onde a conta está aberta, com encerrar uma ou todas. */
export function SessionsCard() {
  const state = useApi<SessionItem[]>('/auth/sessions');
  const { logout } = useAuth();
  const toast = useToast();
  const end = async (s: SessionItem) => {
    if (!confirm(s.current ? 'Encerrar esta sessão? Você sairá deste aparelho.' : `Encerrar a sessão de ${s.device}?`)) return;
    try {
      await del(`/auth/sessions/${s.id}`);
      if (s.current) { await logout(); return; }
      toast('Sessão encerrada'); state.reload();
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const endAll = async (includeCurrent: boolean) => {
    if (!confirm(includeCurrent ? 'Encerrar TODAS as sessões, inclusive esta?' : 'Encerrar todas as outras sessões? Você continua conectado aqui.')) return;
    try {
      const r = await post<{ count: number }>('/auth/sessions/revoke-all', { includeCurrent });
      if (includeCurrent) { await logout(); return; }
      toast(`${r.count} sessão(ões) encerrada(s)`); state.reload();
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="card stack">
      <div className="row between"><h2>Sessões ativas</h2><button className="btn sm" onClick={state.reload}>Atualizar</button></div>
      <p className="muted small">Aparelhos onde sua conta está aberta agora. Se não reconhecer algum, encerre e troque a senha.</p>
      <Async state={state}>{(list) => (
        <>
          <div className="table-wrap">
            <table><thead><tr><th>Aparelho</th><th>IP</th><th>Entrou</th><th>Último uso</th><th></th></tr></thead>
              <tbody>{list.map((s) => (
                <tr key={s.id}>
                  <td>{s.device} {s.current && <span className="badge">este aparelho</span>}</td>
                  <td className="small mono">{s.ip ?? '—'}</td>
                  <td className="small">{fmtDate(s.createdAt)}</td>
                  <td className="small">{fmtDate(s.lastSeenAt)}</td>
                  <td><button className="btn sm" onClick={() => end(s)}>Encerrar</button></td>
                </tr>
              ))}</tbody></table>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" disabled={list.length < 2} onClick={() => endAll(false)}>Encerrar todas as outras</button>
            <button className="btn" onClick={() => endAll(true)}>Encerrar todas (inclusive esta)</button>
          </div>
        </>
      )}</Async>
    </div>
  );
}

/** Trocar senha (sabendo a atual) ou receber link de redefinição no e-mail (para quem esqueceu a atual). */
export function PasswordCard({ app = 'mckbot' }: { app?: 'mckbot' | 'mensagem' }) {
  const { me } = useAuth();
  const toast = useToast();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [sent, setSent] = useState('');
  const { busy, run } = useAction();
  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      if (pw.next !== pw.confirm) { toast('A confirmação não confere com a nova senha', 'err'); return; }
      if (await run(() => post('/profile/password', { current: pw.current, next: pw.next }), 'Senha alterada. Outras sessões foram encerradas.')) setPw({ current: '', next: '', confirm: '' });
    }}>
      <h2>Trocar senha</h2>
      <Field label="Senha atual"><input type="password" required autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
      <Field label="Nova senha" hint="Mínimo de 8 caracteres"><input type="password" required minLength={8} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
      <Field label="Confirmar nova senha"><input type="password" required minLength={8} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
      <button className="btn primary" disabled={busy}>Trocar senha</button>
      <div className="small muted" style={{ borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 12 }}>
        Não lembra a senha atual? Enviamos um link de redefinição para <strong>{me?.user.email}</strong>.
      </div>
      <button type="button" className="btn" disabled={busy} onClick={async () => {
        const r = await run(() => post<{ message: string }>('/profile/password-reset-link', { app }));
        if (r) { setSent(r.message); toast(r.message); }
      }}>Receber link de redefinição por e-mail</button>
      {sent && <div className="alert ok" role="status">{sent}</div>}
    </form>
  );
}

/** Seção completa de segurança da conta. */
export function SecuritySection() {
  return (
    <div className="grid g2" style={{ marginTop: 16 }}>
      <TwoFactorCard />
      <SessionsCard />
    </div>
  );
}

/** Página "Segurança" (MCK Mensagens). */
export default function SecurityPage() {
  return (
    <>
      <div className="page-head"><div><h1>Segurança da conta</h1><p className="muted">Senha, verificação em duas etapas e sessões abertas. Vale para MCKBOT e MCK Mensagens (mesma conta).</p></div></div>
      <div className="grid g2"><PasswordCard app="mensagem" /></div>
      <SecuritySection />
    </>
  );
}

