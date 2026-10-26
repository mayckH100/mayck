import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, ROLE_LABEL } from '../auth';
import { post } from '../api';
import { Loading, useToast } from '../ui';
import { STATUS_LABEL, fmtDay, subOf } from '../billing';
import { MCKBOT_URL } from './common';
import { MmLogin, MmRegister, MmNoOrg, MmBrand } from './pages/Auth';
import MmDashboard from './pages/Dashboard';
import MmLeads from './pages/Leads';
import MmCampaigns from './pages/Campaigns';
import MmSubscription from './pages/Subscription';

const NAV = [
  { to: '/', label: 'Painel', icon: '◔' },
  { to: '/contatos', label: 'Contatos', icon: '☺' },
  { to: '/campanhas', label: 'Campanhas', icon: '➤' },
  { to: '/assinatura', label: 'Assinatura', icon: '◈' },
];

/** Aviso quando o MCK Mensagens está vencido/bloqueado ou a API respondeu 402. */
function MmSubscriptionBanner() {
  const { me, refresh } = useAuth();
  const loc = useLocation();
  const [apiMsg, setApiMsg] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: Event) => { setApiMsg((e as CustomEvent).detail ?? 'Assinatura MCK Mensagens inativa'); refresh(); };
    window.addEventListener('mck:payment-required', h);
    return () => window.removeEventListener('mck:payment-required', h);
  }, []);
  if (loc.pathname.startsWith('/assinatura')) return null;
  const sub = subOf(me?.subscriptions, 'MCKMENSAGEM');
  const inactive = sub && !sub.active;
  if (!inactive && !apiMsg) return null;
  return (
    <div className="alert err row between mm-banner" role="alert">
      <span>
        {inactive
          ? sub!.status === 'BLOQUEADA'
            ? <>Sua assinatura do <strong>MCK Mensagens</strong> está <strong>bloqueada</strong>. Você ainda consulta e exporta seus contatos, mas não pode criar, importar nem disparar campanhas.</>
            : <>Sua assinatura do <strong>MCK Mensagens</strong> está <strong>{STATUS_LABEL[sub!.status].toLowerCase()}</strong> desde {fmtDay(sub!.validUntil)}. Consulta e exportação continuam liberadas; para criar, importar e disparar, renove.</>
          : <>{apiMsg}. Consulta e exportação continuam liberadas.</>}
      </span>
      <NavLink to="/assinatura" className="btn sm primary" style={{ color: '#fff', textDecoration: 'none' }}>{sub?.status === 'BLOQUEADA' ? 'Ver assinatura' : 'Renovar agora'}</NavLink>
    </div>
  );
}

/** Retorno do Mercado Pago em outro caminho: leva para a tela de Assinatura. */
function BillingReturnRedirect() {
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    const q = new URLSearchParams(loc.search);
    if (loc.pathname !== '/assinatura' && (q.has('billing') || q.has('payment_id') || q.has('collection_id'))) nav(`/assinatura${loc.search}`, { replace: true });
  }, [loc.pathname, loc.search]);
  return null;
}

function Shell({ children }: { children: ReactNode }) {
  const { me, setMe, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const switchOrg = async (orgId: string) => {
    try { setMe(await post('/auth/switch-org', { orgId })); nav('/'); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const orgSelect = (id: string) => me && me.orgs.length > 1 && (
    <select id={id} aria-label="Organização" value={me.org?.id} onChange={(e) => switchOrg(e.target.value)}>
      {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
  const links = NAV.map((n) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}><span aria-hidden>{n.icon}</span>{n.label}</NavLink>
  ));
  return (
    <div className="mm-app">
      <header className="mm-top">
        <div className="mm-top-in">
          <NavLink to="/" className="mm-brand" style={{ textDecoration: 'none' }}>
            <img src="/mensagem-logo.svg" alt="" />
            <span>MCK Mensagens<small>{me?.org?.name}</small></span>
          </NavLink>
          <nav className="mm-nav" aria-label="Menu principal">{links}</nav>
          <div className="mm-right">
            <a href={MCKBOT_URL} className="mm-switch hide-sm">Ir para MCKBOT ↗</a>
            <span className="hide-sm">{orgSelect('mm-org')}</span>
            <span className="mm-user hide-sm" title={me?.user.email}>{me?.user.name}{me?.role ? ` · ${ROLE_LABEL[me.role]}` : ''}</span>
            <button className="btn sm hide-sm" onClick={async () => { await logout(); nav('/login'); }}>Sair</button>
            <button className="btn sm mm-burger" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Abrir menu">☰</button>
          </div>
        </div>
        <nav className={`mm-mobile ${open ? 'open' : ''}`} aria-label="Menu">
          {links}
          {orgSelect('mm-org-m')}
          <a href={MCKBOT_URL} className="mm-switch">Ir para MCKBOT ↗</a>
          <button className="btn sm" onClick={async () => { await logout(); nav('/login'); }}>Sair ({me?.user.name})</button>
        </nav>
      </header>
      <MmSubscriptionBanner />
      <BillingReturnRedirect />
      <main className="mm-content">{children}</main>
    </div>
  );
}

function AgentBlocked() {
  const { logout } = useAuth();
  return (
    <div className="mm-auth" style={{ gridTemplateColumns: '1fr' }}>
      <div className="form">
        <div className="card stack" style={{ textAlign: 'center' }}>
          <MmBrand />
          <h2>Acesso restrito</h2>
          <p className="muted">O MCK Mensagens é usado por proprietários e administradores da organização. Peça acesso ao responsável ou continue no MCKBOT.</p>
          <a className="btn primary" href={MCKBOT_URL} style={{ color: '#fff', textDecoration: 'none' }}>Ir para MCKBOT</a>
          <button className="btn" onClick={logout}>Sair</button>
        </div>
      </div>
    </div>
  );
}

export default function MensagemApp() {
  const { me, loading, can } = useAuth();
  if (loading) return <Loading text="Carregando MCK Mensagens…" />;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<MmLogin />} />
        <Route path="/cadastro" element={<MmRegister />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (!me.org) return <MmNoOrg />;
  if (!can('OWNER', 'ADMIN')) return <AgentBlocked />;
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/cadastro" element={<Navigate to="/" replace />} />
      <Route path="*" element={
        <Shell>
          <Routes>
            <Route path="/" element={<MmDashboard />} />
            <Route path="/contatos" element={<MmLeads />} />
            <Route path="/campanhas" element={<MmCampaigns />} />
            <Route path="/campanhas/:id" element={<MmCampaigns />} />
            <Route path="/assinatura" element={<MmSubscription />} />
            <Route path="/plano" element={<Navigate to="/assinatura" replace />} />
            <Route path="*" element={<div className="empty"><div className="t">Página não encontrada</div><NavLink to="/">Voltar para o painel</NavLink></div>} />
          </Routes>
        </Shell>
      } />
    </Routes>
  );
}
