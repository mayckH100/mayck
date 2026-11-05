import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../api';
import { useAuth, type Me } from '../auth';
import { Field } from '../ui';
import { storedReferral } from '../billing';
import { maskDocumento, maskCelular, isValidDocumento, isValidCelular, onlyDigits, normalizeDocumento } from '../lib/documento';

type App = 'mckbot' | 'mensagem';
interface Pending { signupToken: string; email: string; message: string; resendInSec: number }

/**
 * Cadastro compartilhado pelos dois apps: dados (com CPF/CNPJ e celular) → código de 6 dígitos enviado ao e-mail.
 * A conta só é criada quando o código é confirmado.
 */
export function SignupFlow({ app, Brand, notices, onDone }: { app: App; Brand: () => JSX.Element; notices?: ReactNode; onDone: (me: Me) => void }) {
  const [f, setF] = useState({ name: '', email: '', password: '', orgName: '', documento: '', celular: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [indica] = useState(() => storedReferral());
  const set = (k: keyof typeof f, mask?: (v: string) => string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: mask ? mask(e.target.value) : e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!isValidDocumento(f.documento)) return setError('CPF/CNPJ inválido. Confira os números digitados.');
    if (!isValidCelular(f.celular)) return setError('Celular inválido. Informe DDD + número, ex.: (11) 91234-5678.');
    setBusy(true);
    try { setPending(await post<Pending>('/auth/register', { ...f, app, ...(indica ? { indica } : {}) })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  if (pending) return <SignupCode pending={pending} Brand={Brand} onBack={() => setPending(null)} onDone={onDone} />;
  const docLen = normalizeDocumento(f.documento).length;
  return (
    <form className="card stack" onSubmit={submit}>
      <Brand />
      <h2 style={{ textAlign: 'center' }}>Criar conta</h2>
      {notices}
      {indica && <div className="alert info" data-testid="aviso-indicacao">Você chegou por uma indicação. Crie sua conta e comece o teste grátis.</div>}
      {error && <div className="alert err" role="alert">{error}</div>}
      <Field label="Seu nome"><input required minLength={2} value={f.name} onChange={set('name')} autoComplete="name" /></Field>
      <Field label="E-mail" hint="Enviaremos um código para confirmar que o e-mail é seu"><input type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></Field>
      <Field label="CPF ou CNPJ do titular" hint={docLen > 11 || /[A-Z]/i.test(f.documento) ? 'CNPJ da empresa' : 'CPF (ou CNPJ, se for empresa)'}>
        <input required inputMode="text" autoCapitalize="characters" value={f.documento} onChange={set('documento', maskDocumento)} placeholder="000.000.000-00" autoComplete="off" aria-label="CPF ou CNPJ" />
      </Field>
      <Field label="Celular (WhatsApp)" hint="Com DDD. Também serve para entrar na conta">
        <input required type="tel" inputMode="tel" value={f.celular} onChange={set('celular', maskCelular)} placeholder="(11) 91234-5678" autoComplete="tel-national" aria-label="Celular" />
      </Field>
      <Field label="Senha" hint="Mínimo de 8 caracteres"><input type="password" required minLength={8} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
      <Field label="Nome da empresa"><input required minLength={2} value={f.orgName} onChange={set('orgName')} /></Field>
      <button className="btn primary" disabled={busy}>{busy ? 'Enviando código…' : 'Continuar'}</button>
      <p className="small muted" style={{ textAlign: 'center' }}>Já tem conta? <Link to="/login">Entrar</Link></p>
    </form>
  );
}

function SignupCode({ pending, Brand, onBack, onDone }: { pending: Pending; Brand: () => JSX.Element; onBack: () => void; onDone: (me: Me) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState(pending.message);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(pending.resendInSec);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const confirm = async (e?: FormEvent) => {
    e?.preventDefault();
    if (code.length !== 6) return setError('Digite os 6 números do código.');
    setBusy(true); setError('');
    try { onDone(await post<Me>('/auth/register/confirm', { signupToken: pending.signupToken, code })); } catch (err) { setError((err as Error).message); setCode(''); } finally { setBusy(false); }
  };
  const resend = async () => {
    setError('');
    try {
      const r = await post<{ message: string; resendInSec: number }>('/auth/register/resend', { signupToken: pending.signupToken });
      setInfo('Enviamos um novo código. ' + r.message); setWait(r.resendInSec);
    } catch (err) { setError((err as Error).message); }
  };
  return (
    <form className="card stack" onSubmit={confirm}>
      <Brand />
      <h2 style={{ textAlign: 'center' }}>Confirme seu e-mail</h2>
      <p className="muted small" style={{ textAlign: 'center' }}>Código enviado para <strong>{pending.email}</strong>. Ele vale por 15 minutos.</p>
      {info && !error && <div className="alert info" role="status">{info}</div>}
      {error && <div className="alert err" role="alert">{error}</div>}
      <Field label="Código de 6 dígitos">
        <input ref={input} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} aria-label="Código de confirmação"
          style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center', fontFamily: 'monospace' }}
          onChange={(e) => setCode(onlyDigits(e.target.value).slice(0, 6))} />
      </Field>
      <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? 'Confirmando…' : 'Confirmar e criar conta'}</button>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn" onClick={resend} disabled={wait > 0}>{wait > 0 ? `Reenviar código em ${wait}s` : 'Reenviar código'}</button>
        <button type="button" className="btn" onClick={onBack}>Corrigir dados</button>
      </div>
      <p className="small muted" style={{ textAlign: 'center' }}>Não chegou? Confira o spam e se o e-mail está certo.</p>
    </form>
  );
}

/** Tela única para contas antigas: o titular informa CPF/CNPJ e/ou celular antes de continuar. */
export function CompleteCadastro({ Brand, Wrap }: { Brand: () => JSX.Element; Wrap: (p: { children: ReactNode }) => JSX.Element }) {
  const { me, setMe, logout } = useAuth();
  const need = me?.cadastroPendente ?? { documento: false, celular: false };
  const [documento, setDocumento] = useState('');
  const [celular, setCelular] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (need.documento && !isValidDocumento(documento)) return setError('CPF/CNPJ inválido. Confira os números digitados.');
    if (need.celular && !isValidCelular(celular)) return setError('Celular inválido. Informe DDD + número, ex.: (11) 91234-5678.');
    setBusy(true);
    try { setMe(await post<Me>('/auth/complete-cadastro', { ...(need.documento ? { documento } : {}), ...(need.celular ? { celular } : {}) })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Wrap>
      <form className="card stack" onSubmit={submit}>
        <Brand />
        <h2 style={{ textAlign: 'center' }}>Complete seu cadastro</h2>
        <p className="muted small" style={{ textAlign: 'center' }}>
          Para proteger sua conta, precisamos {need.documento && need.celular ? 'do CPF (ou CNPJ) do titular e do seu celular' : need.documento ? 'do CPF (ou CNPJ) do titular' : 'do seu celular'}. É só uma vez.
          {need.celular && ' Depois, você também poderá entrar usando o celular.'}
        </p>
        {error && <div className="alert err" role="alert">{error}</div>}
        {need.documento && (
          <Field label="CPF ou CNPJ do titular"><input required inputMode="text" autoCapitalize="characters" value={documento} onChange={(e) => setDocumento(maskDocumento(e.target.value))} placeholder="000.000.000-00" autoComplete="off" aria-label="CPF ou CNPJ" /></Field>
        )}
        {need.celular && (
          <Field label="Celular (WhatsApp)"><input required type="tel" inputMode="tel" value={celular} onChange={(e) => setCelular(maskCelular(e.target.value))} placeholder="(11) 91234-5678" autoComplete="tel-national" aria-label="Celular" /></Field>
        )}
        <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar e continuar'}</button>
        <button type="button" className="btn" onClick={logout}>Sair</button>
        <p className="small muted" style={{ textAlign: 'center' }}>Seus dados são protegidos e aparecem mascarados no sistema.</p>
      </form>
    </Wrap>
  );
}
