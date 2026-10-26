import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { Field } from '../../ui';
import { MCKBOT_URL } from '../common';

export function MmBrand() {
  return <div className="mm-brand"><img src="/mensagem-logo.svg" alt="" /> MCK Mensagens</div>;
}

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mm-auth">
      <div className="side">
        <div className="mm-brand"><img src="/mensagem-logo.svg" alt="" /> MCK Mensagens</div>
        <h1>Campanhas no WhatsApp, com quem quer receber.</h1>
        <p style={{ opacity: .9 }}>Organize contatos, dispare campanhas personalizadas e acompanhe respostas e conversões, sempre com consentimento.</p>
        <ul>
          <li>Contatos com origem do consentimento registrada</li>
          <li>Mensagens personalizadas com {'{nome}'}</li>
          <li>Limites seguros de envio e janela de horário</li>
          <li>Opt-out automático quando o contato pede para sair</li>
        </ul>
        <p className="small" style={{ opacity: .75 }}>Use a mesma conta do MCKBOT.</p>
      </div>
      <div className="form">{children}</div>
    </div>
  );
}

export function MmLogin() {
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
    <AuthLayout>
      <form className="card stack" onSubmit={submit}>
        <MmBrand />
        <p className="muted" style={{ textAlign: 'center' }}>Entre com a sua conta MCK (a mesma do MCKBOT)</p>
        {error && <div className="alert err" role="alert">{error}</div>}
        <Field label="E-mail"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Senha"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="btn primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <p className="small muted" style={{ textAlign: 'center' }}>Ainda não tem conta? <Link to="/cadastro">Criar conta grátis</Link></p>
        <p className="small" style={{ textAlign: 'center' }}><a href={MCKBOT_URL}>Ir para MCKBOT</a></p>
      </form>
    </AuthLayout>
  );
}

export function MmRegister() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', orgName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { setMe(await post('/auth/register', f)); nav('/'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <AuthLayout>
      <form className="card stack" onSubmit={submit}>
        <MmBrand />
        <h2 style={{ textAlign: 'center' }}>Criar conta</h2>
        {error && <div className="alert err" role="alert">{error}</div>}
        <Field label="Seu nome"><input required minLength={2} value={f.name} onChange={set('name')} autoComplete="name" /></Field>
        <Field label="E-mail"><input type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></Field>
        <Field label="Senha" hint="Mínimo de 8 caracteres"><input type="password" required minLength={8} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        <Field label="Nome da empresa"><input required minLength={2} value={f.orgName} onChange={set('orgName')} /></Field>
        <button className="btn primary" disabled={busy}>{busy ? 'Criando…' : 'Criar conta'}</button>
        <p className="small muted" style={{ textAlign: 'center' }}>Já tem conta? <Link to="/login">Entrar</Link></p>
      </form>
    </AuthLayout>
  );
}

export function MmNoOrg() {
  const { setMe, logout } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { setMe(await post('/auth/orgs', { name })); } catch (err) { setError((err as Error).message); }
  };
  return (
    <AuthLayout>
      <form className="card stack" onSubmit={submit}>
        <MmBrand />
        <h2>Você não participa de nenhuma organização</h2>
        <p className="muted">Crie a sua ou peça um novo convite ao administrador.</p>
        {error && <div className="alert err">{error}</div>}
        <Field label="Nome da organização"><input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button className="btn primary">Criar organização</button>
        <button type="button" className="btn" onClick={logout}>Sair</button>
      </form>
    </AuthLayout>
  );
}
