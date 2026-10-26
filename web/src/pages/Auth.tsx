import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { post } from '../api';
import { useAuth } from '../auth';
import { Field, useApi, Loading, ErrorBox } from '../ui';
import { InstallButton } from '../pwa';
import { PlansShowcase, ForgotPassword, ResetPassword, VerifyEmail } from './PublicAuth';

export function Brand() {
  return <div className="brand"><img src="/logo.svg" alt="" /> MCKBOT</div>;
}

const AuthWrap = ({ children }: { children: React.ReactNode }) => <div className="auth">{children}</div>;
export const Forgot = () => <ForgotPassword app="mckbot" Wrap={AuthWrap} Brand={Brand} />;
export const Reset = () => <ResetPassword app="mckbot" Wrap={AuthWrap} Brand={Brand} />;
export const Verify = () => <VerifyEmail Wrap={AuthWrap} Brand={Brand} />;

const PLAN_NAME: Record<string, string> = { MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCK Mensagens', COMBO: 'Combo MCKBOT + MCK Mensagens' };

export function Login() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { setMe(await post('/auth/login', { email, password })); nav('/'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="auth auth-wide">
      <div className="auth-col">
        <form className="card stack" onSubmit={submit}>
          <Brand />
          <p className="muted" style={{ textAlign: 'center' }}>Atendimento no WhatsApp com fluxos e IA</p>
          {error && <div className="alert err" role="alert">{error}</div>}
          <Field label="E-mail"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Senha"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <div style={{ textAlign: 'right', marginTop: -6 }}><Link to="/esqueci-senha" className="small">Esqueci minha senha</Link></div>
          <button className="btn primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
          <p className="small muted" style={{ textAlign: 'center' }}>Ainda não tem conta? <Link to="/cadastro">Criar conta grátis</Link></p>
          <div className="row" style={{ justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
            <InstallButton appName="MCKBOT" />
            <a href="/mensagem/login" className="small">Ir para MCK Mensagens</a>
          </div>
        </form>
        <PlansShowcase />
      </div>
    </div>
  );
}

export function Register() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const plano = sp.get('plano');
  const [f, setF] = useState({ name: '', email: '', password: '', orgName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { setMe(await post('/auth/register', { ...f, app: 'mckbot' })); nav(plano && PLAN_NAME[plano] ? '/plano' : '/'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <Brand />
        <h2 style={{ textAlign: 'center' }}>Criar conta</h2>
        {plano && PLAN_NAME[plano] && <div className="alert info">Plano escolhido: <strong>{PLAN_NAME[plano]}</strong>. Você começa no teste grátis e assina quando quiser, na tela Plano.</div>}
        {error && <div className="alert err" role="alert">{error}</div>}
        <Field label="Seu nome"><input required minLength={2} value={f.name} onChange={set('name')} autoComplete="name" /></Field>
        <Field label="E-mail"><input type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></Field>
        <Field label="Senha" hint="Mínimo de 8 caracteres"><input type="password" required minLength={8} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        <Field label="Nome da empresa"><input required minLength={2} value={f.orgName} onChange={set('orgName')} /></Field>
        <button className="btn primary" disabled={busy}>{busy ? 'Criando…' : 'Criar conta'}</button>
        <p className="small muted" style={{ textAlign: 'center' }}>Já tem conta? <Link to="/login">Entrar</Link></p>
      </form>
    </div>
  );
}

export function AcceptInvite() {
  const { token } = useParams();
  const { me, setMe } = useAuth();
  const nav = useNavigate();
  const info = useApi<{ email: string; role: string; orgName: string; hasAccount: boolean }>(`/auth/invite/${token}`);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const accept = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { setMe(await post('/auth/accept-invite', info.data?.hasAccount ? { token } : { token, name, password })); nav('/'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="card stack" onSubmit={accept}>
        <Brand />
        {info.loading && <Loading />}
        {info.error && <ErrorBox error={info.error} />}
        {info.data && (
          <>
            <h2 style={{ textAlign: 'center' }}>Convite para {info.data.orgName}</h2>
            <p className="muted" style={{ textAlign: 'center' }}>Convite para <strong>{info.data.email}</strong></p>
            {error && <div className="alert err" role="alert">{error}</div>}
            {info.data.hasAccount ? (
              me?.user.email === info.data.email
                ? <button className="btn primary" disabled={busy}>Aceitar convite</button>
                : <div className="alert info">Você já tem conta com esse e-mail. <Link to={`/login`}>Entre com {info.data.email}</Link> e abra este link de novo.</div>
            ) : (
              <>
                <Field label="Seu nome"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <Field label="Crie uma senha" hint="Mínimo de 8 caracteres"><input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
                <button className="btn primary" disabled={busy}>{busy ? 'Entrando…' : 'Criar conta e entrar'}</button>
              </>
            )}
          </>
        )}
      </form>
    </div>
  );
}

export function NoOrg() {
  const { setMe, logout } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { setMe(await post('/auth/orgs', { name })); } catch (err) { setError((err as Error).message); }
  };
  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <Brand />
        <h2>Você não participa de nenhuma organização</h2>
        <p className="muted">Crie a sua ou peça um novo convite ao administrador.</p>
        {error && <div className="alert err">{error}</div>}
        <Field label="Nome da organização"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button className="btn primary">Criar organização</button>
        <button type="button" className="btn" onClick={logout}>Sair</button>
      </form>
    </div>
  );
}
