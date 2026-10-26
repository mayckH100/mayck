import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post } from '../api';
import { Field, Loading } from '../ui';
import { fmtBRL, type Cycle, type PlanProduct } from '../billing';

export type AppKind = 'mckbot' | 'mensagem';
type Wrap = (p: { children: ReactNode }) => JSX.Element;

export interface PublicPlan { id: PlanProduct; label: string; desc: string; features: string[]; prices: Record<Cycle, number>; annualSavings: number }
export interface PublicPlans { trialDays: number; plans: PublicPlan[] }

/** Vitrine de planos (sem login), lida de /api/public/plans — a mesma fonte de preços que o Master edita. */
export function PlansShowcase({ registerTo = '/cadastro', highlight, title = 'Planos e preços' }: { registerTo?: string; highlight?: PlanProduct; title?: string }) {
  const [data, setData] = useState<PublicPlans | null>(null);
  const [err, setErr] = useState(false);
  const [cycle, setCycle] = useState<Cycle>('MENSAL');
  useEffect(() => { get<PublicPlans>('/public/plans').then(setData).catch(() => setErr(true)); }, []);
  if (err) return null;
  if (!data) return <Loading text="Carregando planos…" />;
  return (
    <section className="public-plans" aria-label="Planos">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {data.trialDays > 0 && <p className="small muted" style={{ margin: '4px 0 0' }}>Comece com {data.trialDays} dia{data.trialDays === 1 ? '' : 's'} de teste grátis. Sem cartão no cadastro.</p>}
        </div>
        <div className="seg" role="group" aria-label="Ciclo de cobrança">
          {(['MENSAL', 'ANUAL'] as Cycle[]).map((c) => (
            <button key={c} type="button" className={`btn sm ${cycle === c ? 'primary' : ''}`} aria-pressed={cycle === c} onClick={() => setCycle(c)}>{c === 'MENSAL' ? 'Mensal' : 'Anual'}</button>
          ))}
        </div>
      </div>
      <div className="grid g3" style={{ marginTop: 12 }}>
        {data.plans.map((p) => (
          <div key={p.id} className="card stack plan-card" style={p.id === (highlight ?? 'COMBO') ? { borderColor: 'var(--brand)' } : undefined}>
            <div className="row between"><h3 style={{ margin: 0 }}>{p.label}</h3>{p.id === 'COMBO' && <span className="badge red">Melhor custo</span>}</div>
            <p className="small muted" style={{ margin: 0 }}>{p.desc}</p>
            <div>
              <span style={{ fontSize: 26, fontWeight: 800 }}>{fmtBRL(p.prices[cycle])}</span>
              <span className="small muted"> /{cycle === 'MENSAL' ? 'mês' : 'ano'}</span>
              {cycle === 'ANUAL' && p.annualSavings > 0 && <div className="small" style={{ color: 'var(--brand)' }}>Economize {fmtBRL(p.annualSavings)} por ano</div>}
            </div>
            <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
            <Link to={`${registerTo}?plano=${p.id}&ciclo=${cycle}`} className="btn primary" style={{ color: '#fff', textDecoration: 'none', textAlign: 'center', marginTop: 'auto' }}>Começar</Link>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ForgotPassword({ app, Wrap, Brand }: { app: AppKind; Wrap: Wrap; Brand: () => JSX.Element }) {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { const r = await post<{ message: string }>('/auth/forgot', { email, app }); setMsg(r.message); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Wrap>
      <form className="card stack" onSubmit={submit}>
        <Brand />
        <h2 style={{ textAlign: 'center' }}>Esqueci minha senha</h2>
        {msg ? <div className="alert ok" role="status">{msg}</div> : <p className="muted small" style={{ textAlign: 'center' }}>Informe o e-mail da sua conta. Enviaremos um link para criar uma nova senha (válido por 1 hora).</p>}
        {error && <div className="alert err" role="alert">{error}</div>}
        {!msg && (
          <>
            <Field label="E-mail"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <button className="btn primary" disabled={busy}>{busy ? 'Enviando…' : 'Enviar link'}</button>
          </>
        )}
        <p className="small muted" style={{ textAlign: 'center' }}><Link to="/login">Voltar para o login</Link></p>
      </form>
    </Wrap>
  );
}

export function ResetPassword({ app, Wrap, Brand }: { app: AppKind; Wrap: Wrap; Brand: () => JSX.Element }) {
  const [sp] = useSearchParams();
  const [token] = useState(() => sp.get('token') ?? '');
  const [valid, setValid] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Tira o token da barra de endereço (não fica no histórico nem em capturas de tela).
    if (token) window.history.replaceState(null, '', window.location.pathname);
    if (!token) { setValid(false); return; }
    get<{ valid: boolean }>(`/auth/reset/${encodeURIComponent(token)}`).then((r) => setValid(r.valid)).catch(() => setValid(false));
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError('As senhas não conferem.'); return; }
    setBusy(true); setError('');
    try { await post('/auth/reset', { token, password, app }); setDone(true); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Wrap>
      <form className="card stack" onSubmit={submit}>
        <Brand />
        <h2 style={{ textAlign: 'center' }}>Definir nova senha</h2>
        {valid === null && <Loading />}
        {valid === false && !done && (
          <>
            <div className="alert err" role="alert">Este link é inválido, já foi usado ou expirou.</div>
            <Link to="/esqueci-senha" className="btn primary" style={{ color: '#fff', textDecoration: 'none', textAlign: 'center' }}>Pedir um novo link</Link>
          </>
        )}
        {done && (
          <>
            <div className="alert ok" role="status">Senha alterada! Por segurança, encerramos as sessões abertas. Entre com a nova senha.</div>
            <Link to="/login" className="btn primary" style={{ color: '#fff', textDecoration: 'none', textAlign: 'center' }}>Ir para o login</Link>
          </>
        )}
        {valid && !done && (
          <>
            {error && <div className="alert err" role="alert">{error}</div>}
            <Field label="Nova senha" hint="Mínimo de 8 caracteres"><input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Field label="Repita a nova senha"><input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
          </>
        )}
        <p className="small muted" style={{ textAlign: 'center' }}><Link to="/login">Voltar para o login</Link></p>
      </form>
    </Wrap>
  );
}

export function VerifyEmail({ Wrap, Brand }: { Wrap: Wrap; Brand: () => JSX.Element }) {
  const [sp] = useSearchParams();
  const [state, setState] = useState<'loading' | 'ok' | 'err'>('loading');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const token = sp.get('token') ?? '';
    if (token) window.history.replaceState(null, '', window.location.pathname);
    if (!token) { setState('err'); setMsg('Link de confirmação inválido.'); return; }
    post('/auth/verify-email', { token }).then(() => setState('ok')).catch((e) => { setState('err'); setMsg((e as Error).message); });
  }, []);
  return (
    <Wrap>
      <div className="card stack" style={{ textAlign: 'center' }}>
        <Brand />
        <h2>Confirmação de e-mail</h2>
        {state === 'loading' && <Loading />}
        {state === 'ok' && <div className="alert ok" role="status">E-mail confirmado. Obrigado!</div>}
        {state === 'err' && <div className="alert err" role="alert">{msg}</div>}
        <Link to="/" className="btn primary" style={{ color: '#fff', textDecoration: 'none' }}>Continuar</Link>
      </div>
    </Wrap>
  );
}
