import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, ROLE_LABEL, type Role } from './auth';
import { post } from './api';
import { Loading, useApi, useToast } from './ui';
import { Login, Register, AcceptInvite, NoOrg } from './pages/Auth';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Kanban from './pages/Kanban';
import Contacts from './pages/Contacts';
import Flows from './pages/Flows';
import FlowEditor from './pages/FlowEditor';
import Ai from './pages/Ai';
import Channels from './pages/Channels';
import Integrations from './pages/Integrations';
import Reports from './pages/Reports';
import Team from './pages/Team';
import Plan from './pages/Plan';
import Audit from './pages/Audit';
import Profile from './pages/Profile';
import Guide from './pages/Guide';
import Master from './pages/Master';
import { STATUS_LABEL, fmtDay } from './billing';

const NAV: { to: string; label: string; icon: string; roles?: Role[]; sep?: string; superAdmin?: boolean }[] = [
  { to: '/', label: 'Visão geral', icon: '◧' },
  { to: '/inbox', label: 'Inbox', icon: '✉', sep: 'Atendimento' },
  { to: '/kanban', label: 'Kanban', icon: '▦' },
  { to: '/contatos', label: 'Contatos', icon: '☺' },
  { to: '/fluxos', label: 'Fluxos', icon: '⇄', sep: 'Automação' },
  { to: '/ia', label: 'Inteligência artificial', icon: '✦' },
  { to: '/canais', label: 'Canais WhatsApp', icon: '☏' },
  { to: '/integracoes', label: 'Integrações', icon: '⚙', roles: ['OWNER', 'ADMIN'] },
  { to: '/relatorios', label: 'Relatórios', icon: '▤', sep: 'Gestão' },
  { to: '/equipe', label: 'Equipe', icon: '♟' },
  { to: '/plano', label: 'Plano', icon: '◈' },
  { to: '/auditoria', label: 'Auditoria', icon: '☰', roles: ['OWNER', 'ADMIN'] },
  { to: '/perfil', label: 'Perfil', icon: '☻', sep: 'Conta' },
  { to: '/boas-praticas', label: 'Boas práticas', icon: '?' },
  { to: '/master', label: 'Painel Master', icon: '♛', sep: 'Plataforma', superAdmin: true },
];

/** Aviso quando o MCKBOT está vencido/bloqueado ou a API respondeu 402. */
function SubscriptionBanner() {
  const { me, refresh } = useAuth();
  const loc = useLocation();
  const [apiMsg, setApiMsg] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: Event) => { setApiMsg((e as CustomEvent).detail ?? 'Sua assinatura está inativa.'); refresh(); };
    window.addEventListener('mck:payment-required', h);
    return () => window.removeEventListener('mck:payment-required', h);
  }, []);
  if (loc.pathname.startsWith('/plano') || loc.pathname.startsWith('/master')) return null;
  const sub = me?.subscriptions?.find((s) => s.product === 'MCKBOT');
  const inactive = sub && !sub.active;
  if (!inactive && !apiMsg) return null;
  const text = inactive
    ? sub!.status === 'BLOQUEADA'
      ? <>Sua assinatura do <strong>MCKBOT</strong> está <strong>bloqueada</strong>. Os robôs e fluxos ficam parados até a regularização.</>
      : <>Sua assinatura do <strong>MCKBOT</strong> está <strong>{STATUS_LABEL[sub!.status].toLowerCase()}</strong> desde {fmtDay(sub!.validUntil)}. Renove para continuar usando os robôs e fluxos.</>
    : <>{apiMsg}</>;
  return (
    <div className="alert err row between" role="alert" style={{ margin: '12px 24px 0', borderRadius: 10 }}>
      <span>{text}</span>
      <NavLink to="/plano" className="btn sm primary" style={{ color: '#fff', textDecoration: 'none' }}>{sub?.status === 'BLOQUEADA' ? 'Ver assinatura' : 'Renovar agora'}</NavLink>
    </div>
  );
}

/** O Mercado Pago devolve para "/?billing=…&payment_id=…": leva para a tela de Assinatura. */
function BillingReturnRedirect() {
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    const q = new URLSearchParams(loc.search);
    if (loc.pathname !== '/plano' && (q.has('billing') || q.has('payment_id') || q.has('collection_id'))) nav(`/plano${loc.search}`, { replace: true });
  }, [loc.pathname, loc.search]);
  return null;
}

function Shell({ children }: { children: ReactNode }) {
  const { me, setMe, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const loc = useLocation();
  const channels = useApi<any[]>('/channels', [me?.org?.id]);
  const connected = channels.data?.some((c) => c.status === 'CONNECTED');
  const switchOrg = async (orgId: string) => {
    try {
      setMe(await post('/auth/switch-org', { orgId }));
      nav('/');
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="app">
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        <div className="brand"><img src="/logo.svg" alt="" /> MCKBOT</div>
        <nav className="nav">
          {NAV.filter((n) => (!n.roles || can(...n.roles)) && (!n.superAdmin || me?.isSuperAdmin)).map((n) => (
            <div key={n.to}>
              {n.sep && <div className="sep">{n.sep}</div>}
              <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}><span aria-hidden>{n.icon}</span>{n.label}</NavLink>
            </div>
          ))}
        </nav>
        <div className="side-foot" onClick={(e) => e.stopPropagation()}>
          {can('OWNER', 'ADMIN') && <a href="/mensagem/" className="btn sm" style={{ background: '#5b3fd6', borderColor: '#5b3fd6', color: '#fff', textDecoration: 'none' }}>Ir para MCK Mensagens ↗</a>}
          <label className="small" htmlFor="org-sel">Organização</label>
          <select id="org-sel" value={me?.org?.id} onChange={(e) => switchOrg(e.target.value)}>
            {me?.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button className="btn sm" onClick={async () => { await logout(); nav('/login'); }}>Sair</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row">
            <button className="btn sm menu-btn" onClick={() => setOpen(true)} aria-label="Abrir menu">☰</button>
            <strong>{me?.org?.name}</strong>
            <span className="badge">{me?.role ? ROLE_LABEL[me.role] : ''}</span>
          </div>
          <div className="row">
            {can('OWNER', 'ADMIN') && <button className="btn primary sm" onClick={() => nav('/fluxos?novo=1')}>+ Criar fluxo</button>}
            <NavLink to="/perfil" className="small">{me?.user.name}</NavLink>
          </div>
        </header>
        {channels.data && !connected && !loc.pathname.startsWith('/canais') && (
          <div className="alert warn" style={{ margin: '12px 24px 0', borderRadius: 10 }}>
            WhatsApp <strong>não conectado</strong>: nenhuma mensagem será enviada até você configurar a WhatsApp Cloud API. <NavLink to="/canais">Configurar canal →</NavLink>
          </div>
        )}
        <SubscriptionBanner />
        <BillingReturnRedirect />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const { me, loading } = useAuth();
  if (loading) return <Loading text="Carregando MCKBOT…" />;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/cadastro" element={<Register />} />
        <Route path="/convite/:token" element={<AcceptInvite />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (!me.org) {
    return (
      <Routes>
        <Route path="/convite/:token" element={<AcceptInvite />} />
        <Route path="*" element={<NoOrg />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/convite/:token" element={<AcceptInvite />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/cadastro" element={<Navigate to="/" replace />} />
      <Route path="*" element={
        <Shell>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/inbox/:id" element={<Inbox />} />
            <Route path="/kanban" element={<Kanban />} />
            <Route path="/contatos" element={<Contacts />} />
            <Route path="/fluxos" element={<Flows />} />
            <Route path="/fluxos/:id" element={<FlowEditor />} />
            <Route path="/ia" element={<Ai />} />
            <Route path="/canais" element={<Channels />} />
            <Route path="/integracoes" element={<Integrations />} />
            <Route path="/relatorios" element={<Reports />} />
            <Route path="/equipe" element={<Team />} />
            <Route path="/plano" element={<Plan />} />
            <Route path="/assinatura" element={<Navigate to="/plano" replace />} />
            <Route path="/master" element={<Master />} />
            <Route path="/master/clientes/:orgId" element={<Master />} />
            <Route path="/auditoria" element={<Audit />} />
            <Route path="/perfil" element={<Profile />} />
            <Route path="/boas-praticas" element={<Guide />} />
            <Route path="*" element={<div className="empty"><div className="t">Página não encontrada</div><NavLink to="/">Voltar para a visão geral</NavLink></div>} />
          </Routes>
        </Shell>
      } />
    </Routes>
  );
}
