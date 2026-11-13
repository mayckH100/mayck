import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { get } from './api';
import { Loading, useApi } from './ui';
import { MODULOS, acaoDaRota, gruposComunsVisiveis, moduloDaRota, modulosVisiveis, rotaAtiva, secaoDaRota, type Modulo, type ModuloId, type NavItem } from './modulos';
import { AcaoDoTopo, MenuConta, ModuloTitulo } from './Topo';
import { Login, Register, AcceptInvite, NoOrg, Forgot, Reset, Verify, Completar } from './pages/Auth';
import { InstallButton } from './pwa';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Kanban from './pages/Kanban';
import Agenda from './pages/Agenda';
import Contacts from './pages/Contacts';
import Flows from './pages/Flows';
import FlowEditor from './pages/FlowEditor';
import Ai from './pages/Ai';
import Products from './pages/Products';
import Channels from './pages/Channels';
import Integrations from './pages/Integrations';
import Reports from './pages/Reports';
import Team from './pages/Team';
import RelatoriosErp from './erp/relatorios/Relatorios';
import Plan from './pages/Plan';
import Audit from './pages/Audit';
import Profile from './pages/Profile';
import Guide from './pages/Guide';
import Master from './pages/Master';
import ErpPainel from './erp/crm/Painel';
import ErpFunil from './erp/crm/Funil';
import ErpClientes from './erp/crm/Clientes';
import ErpCliente360 from './erp/crm/Cliente360';
import ErpProdutos from './erp/produtos/Produtos';
import ErpEstoque from './erp/estoque/Estoque';
import ErpPedidos from './erp/vendas/Pedidos';
import ErpRelatorioCaixa from './erp/vendas/Caixa';
import ErpPedido from './erp/vendas/Pedido';
import ErpCompras from './erp/compras/Compras';
import ErpProducao from './erp/producao/Producao';
import ErpFinanceiro from './erp/financeiro/Financeiro';
import ErpFiscal from './erp/fiscal/Fiscal';
import ErpMaquininhas from './erp/vendas/Maquininhas';
import ErpBi from './erp/bi/Bi';
import Sdr from './pages/Sdr';
import ErpAlertas from './erp/alertas/Alertas';
import { ErpAbas } from './erp/ErpNav';
import ErpGate from './erp/ErpGate';
import Tutorials from './Tutorials';
import SubscriptionGate from './SubscriptionGate';
import Announcements from './Announcements';
import WaDownBanner from './WaDownBanner';
import NovidadeBanner from './NovidadeBanner';
import { STATUS_LABEL, fmtDay } from './billing';
import { Versoes, VersaoRodape } from './Versao';

/** Menu lateral (☰ no celular): só os itens do módulo em uso, depois Gestão e Conta, e "Trocar módulo". */
function SideNav({ atual, modulos }: { atual: Modulo; modulos: Modulo[] }) {
  const { me, can, hasModule } = useAuth();
  const loc = useLocation();
  const grupos = gruposComunsVisiveis({ can, hasModule, superAdmin: !!me?.isSuperAdmin });
  const grupoAtual = grupos.find((g) => g.items.some((i) => rotaAtiva(i.to, i.end, loc.pathname)))?.id;
  const [abertos, setAbertos] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem('nav-abertos-comuns') ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } });
  useEffect(() => { if (grupoAtual && !abertos.includes(grupoAtual)) setAbertos((a) => [...a, grupoAtual]); }, [grupoAtual]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem('nav-abertos-comuns', JSON.stringify(abertos)); }, [abertos]);
  const alternar = (id: string) => setAbertos((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const link = (n: NavItem) => (
    <div key={n.to}>
      {n.sub && <div className="sep">{n.sub}</div>}
      {n.href
        ? <a href={n.href}><span aria-hidden>{n.icon}</span>{n.label}</a>
        : <NavLink to={n.to} end={n.end || n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>{n.icon && <span aria-hidden>{n.icon}</span>}{n.label}</NavLink>}
    </div>
  );
  const outros = modulos.filter((m) => m.id !== atual.id);
  return (
    <nav className="nav" aria-label={`Menu do ${atual.label}`}>
      <div className="nav-group current">
        <div className="nav-items nav-modulo">{atual.items.map(link)}</div>
      </div>
      {grupos.map((g) => {
        const aberto = abertos.includes(g.id);
        return (
          <div key={g.id} className={`nav-group ${g.id === grupoAtual ? 'current' : ''}`}>
            <button type="button" className="nav-cat" aria-expanded={aberto} onClick={(e) => { e.stopPropagation(); alternar(g.id); }}>
              <span aria-hidden>{g.icon}</span><span style={{ flex: 1 }}>{g.label}</span><span aria-hidden className="nav-caret">{aberto ? '▾' : '▸'}</span>
            </button>
            {aberto && <div className="nav-items">{g.items.map(link)}</div>}
          </div>
        );
      })}
      {outros.length > 0 && (
        <div className="nav-group nav-trocar">
          <div className="sep">Trocar módulo</div>
          {outros.map((m) => (m.href
            ? <a key={m.id} href={m.href}><span aria-hidden>{m.icon}</span><span>{m.label}</span></a>
            : <NavLink key={m.id} to={m.home} end={m.home === '/'}><span aria-hidden>{m.icon}</span><span>{m.label}</span></NavLink>))}
        </div>
      )}
    </nav>
  );
}

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

/** Pop-up em qualquer página: conversas "Aguardando atendente" (consulta a cada 15 s; cada uma aparece só uma vez). */
function WaitingAlerts() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [items, setItems] = useState<{ id: string; name: string; via: string | null }[]>([]);
  useEffect(() => {
    if (!me?.org?.id) return;
    const key = `mckbot:aguardando:${me.org.id}`;
    let stop = false;
    const seen = (): string[] => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
    const check = async () => {
      try {
        const r = await get<{ items: { id: string; waitingSince: string; contact: { name: string | null; phone: string } | null; channel: { via: string } | null }[] }>('/conversations/waiting');
        if (stop) return;
        const s = seen();
        const fresh = r.items.filter((i) => !s.includes(`${i.id}:${i.waitingSince}`));
        if (!fresh.length) return;
        localStorage.setItem(key, JSON.stringify([...s, ...fresh.map((i) => `${i.id}:${i.waitingSince}`)].slice(-200)));
        setItems((cur) => [...cur.filter((c) => !fresh.some((f) => f.id === c.id)), ...fresh.map((i) => ({ id: i.id, name: i.contact?.name || i.contact?.phone || 'Contato', via: i.channel?.via ?? null }))]);
      } catch { /* silencioso: tenta de novo no próximo ciclo */ }
    };
    check();
    const t = setInterval(check, 15_000);
    return () => { stop = true; clearInterval(t); };
  }, [me?.org?.id]);
  if (!items.length) return null;
  const close = (id: string) => setItems((cur) => cur.filter((c) => c.id !== id));
  return (
    <div className="toast-wrap" role="alert" style={{ top: 16, bottom: 'auto', zIndex: 110 }}>
      {items.slice(-3).map((i) => (
        <div key={i.id} className="toast" style={{ background: '#9a3412', display: 'grid', gap: 8 }}>
          <div><strong>Aguardando atendente</strong><br />{i.name} está esperando um atendente.{i.via && <><br /><span className="small">📲 Via: {i.via}</span></>}</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm primary" onClick={() => { close(i.id); nav(`/inbox/${i.id}`); }}>Abrir conversa</button>
            <button className="btn sm" onClick={() => close(i.id)}>Fechar</button>
          </div>
        </div>
      ))}
    </div>
  );
}


/** Tela de carregamento amigável enquanto o app abre (no Render grátis, o 1º acesso do dia pode levar ~1 min). */
function AppSplash() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 5000); return () => clearTimeout(t); }, []);
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
      <div style={{ maxWidth: 420 }} role="status" aria-live="polite">
        <img src="/logo-192.png" width={64} height={64} alt="" style={{ borderRadius: 14, display: 'block', margin: '0 auto 16px' }} />
        <Loading text="Abrindo o MCKBOT…" />
        {slow && <p className="small muted" style={{ marginTop: 12 }}>Está demorando um pouco mais que o normal. Na primeira vez do dia pode levar até 1 minuto. Não feche esta página.</p>}
      </div>
    </div>
  );
}

const MODULO_KEY = 'mck:modulo';

function Shell({ children }: { children: ReactNode }) {
  const { me, logout, can, hasModule } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const channels = useApi<any[]>('/channels', [me?.org?.id]);
  const connected = channels.data?.some((c) => c.status === 'CONNECTED');
  const acesso = { can, hasModule, superAdmin: !!me?.isSuperAdmin };
  const modulos = modulosVisiveis(acesso);
  // Páginas comuns (Plano, Perfil…) mantêm no topo o último módulo usado.
  const [ultimo, setUltimo] = useState<ModuloId | null>(() => { try { return localStorage.getItem(MODULO_KEY) as ModuloId | null; } catch { return null; } });
  const rota = moduloDaRota(loc.pathname, ultimo);
  useEffect(() => { if (!rota.comum && rota.id !== ultimo) { setUltimo(rota.id); try { localStorage.setItem(MODULO_KEY, rota.id); } catch { /* sem localStorage */ } } }, [rota.id, rota.comum]); // eslint-disable-line react-hooks/exhaustive-deps
  const atual = modulos.find((m) => m.id === rota.id) ?? { ...MODULOS.find((m) => m.id === rota.id)!, items: [] };
  const secao = secaoDaRota(loc.pathname);
  const naErp = loc.pathname === '/erp' || loc.pathname.startsWith('/erp/');
  useEffect(() => { setOpen(false); }, [loc.pathname]);
  return (
    <div className="app">
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        <div className="brand"><img src="/logo.svg" alt="" /> {atual.label}</div>
        <SideNav atual={atual} modulos={modulos} />
        <div className="side-foot" onClick={(e) => e.stopPropagation()}>
          <InstallButton appName="MCKBOT" />
          <button className="btn sm" data-sub-exempt onClick={async () => { await logout(); nav('/login'); }}>Sair</button>
          <VersaoRodape />
        </div>
      </aside>
      {open && <div className="side-veu" aria-hidden onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="btn sm menu-btn" data-sub-exempt onClick={() => setOpen(true)} aria-label="Abrir menu" aria-expanded={open}>☰</button>
          <ModuloTitulo atual={atual} secao={secao} modulos={modulos} />
          <div className="topo-dir">
            <AcaoDoTopo acao={acaoDaRota(loc.pathname, acesso)} />
            <MenuConta />
          </div>
        </header>
        {channels.data && !connected && !loc.pathname.startsWith('/canais') && !naErp && (
          <div className="alert warn" style={{ margin: '12px 24px 0', borderRadius: 10 }}>
            WhatsApp <strong>não conectado</strong>: nenhuma mensagem será enviada até você configurar a WhatsApp Cloud API. <NavLink to="/canais">Configurar canal →</NavLink>
          </div>
        )}
        <WaDownBanner reconnectHref="/canais" hideOnPath={loc.pathname.startsWith('/canais')} />
        <SubscriptionBanner />
        <BillingReturnRedirect />
        <WaitingAlerts />
        <SubscriptionGate app="mckbot" />
        <Announcements app="mckbot" />
        <NovidadeBanner />
        <main className="content">{naErp ? <ErpGate><ErpAbas />{children}</ErpGate> : children}</main>
      </div>
    </div>
  );
}

export default function App() {
  const { me, loading } = useAuth();
  if (loading) return <AppSplash />;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/entrar" element={<Login />} />
        <Route path="/cadastro" element={<Register />} />
        <Route path="/esqueci-senha" element={<Forgot />} />
        <Route path="/redefinir-senha" element={<Reset />} />
        <Route path="/verificar-email" element={<Verify />} />
        <Route path="/convite/:token" element={<AcceptInvite />} />
        <Route path="/versoes" element={<Versoes standalone />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  if (me.cadastroPendente) return <Completar />;
  if (!me.org) {
    return (
      <Routes>
        <Route path="/convite/:token" element={<AcceptInvite />} />
        <Route path="/redefinir-senha" element={<Reset />} />
        <Route path="/verificar-email" element={<Verify />} />
        <Route path="/versoes" element={<Versoes standalone />} />
        <Route path="*" element={<NoOrg />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/convite/:token" element={<AcceptInvite />} />
      <Route path="/redefinir-senha" element={<Reset />} />
      <Route path="/verificar-email" element={<Verify />} />
      <Route path="/esqueci-senha" element={<Navigate to="/perfil" replace />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/entrar" element={<Navigate to="/" replace />} />
      <Route path="/cadastro" element={<Navigate to="/" replace />} />
      <Route path="*" element={
        <Shell>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/inbox/:id" element={<Inbox />} />
            <Route path="/kanban" element={<Kanban />} />
            <Route path="/agenda" element={<Agenda />} />
            <Route path="/contatos" element={<Contacts />} />
            <Route path="/fluxos" element={<Flows />} />
            <Route path="/fluxos/:id" element={<FlowEditor />} />
            <Route path="/ia" element={<Ai />} />
            <Route path="/produtos" element={<Products />} />
            <Route path="/canais" element={<Channels />} />
            <Route path="/integracoes" element={<Integrations />} />
            <Route path="/sdr" element={<Sdr />} />
            <Route path="/erp" element={<ErpPainel />} />
            <Route path="/erp/funil" element={<ErpFunil />} />
            <Route path="/erp/clientes" element={<ErpClientes key="c" />} />
            <Route path="/erp/clientes/:id" element={<ErpCliente360 />} />
            <Route path="/erp/fornecedores" element={<ErpClientes key="f" papel="fornecedor" />} />
            <Route path="/erp/fornecedores/:id" element={<ErpCliente360 />} />
            <Route path="/erp/alertas" element={<ErpAlertas />} />
            <Route path="/erp/produtos" element={<ErpProdutos />} />
            <Route path="/erp/estoque" element={<ErpEstoque />} />
            <Route path="/erp/pedidos" element={<ErpPedidos key="pedidos" />} />
            <Route path="/erp/balcao" element={<ErpPedidos key="balcao" balcao />} />
            <Route path="/erp/pedidos/:id" element={<ErpPedido />} />
            <Route path="/erp/caixa/:id" element={<ErpRelatorioCaixa />} />
            <Route path="/erp/compras" element={<ErpCompras />} />
            <Route path="/erp/producao" element={<ErpProducao />} />
            <Route path="/erp/financeiro" element={<ErpFinanceiro />} />
            <Route path="/erp/fiscal" element={<ErpFiscal />} />
            <Route path="/erp/maquininhas" element={<ErpMaquininhas />} />
            <Route path="/erp/bi" element={<ErpBi />} />
            <Route path="/relatorios" element={<Reports />} />
            <Route path="/equipe" element={<Team />} />
            <Route path="/erp/funcionarios" element={<Team erp />} />
            <Route path="/erp/relatorios" element={<RelatoriosErp />} />
            <Route path="/plano" element={<Plan />} />
            <Route path="/assinatura" element={<Navigate to="/plano" replace />} />
            <Route path="/master" element={<Master />} />
            <Route path="/master/clientes/:orgId" element={<Master />} />
            <Route path="/auditoria" element={<Audit />} />
            <Route path="/perfil" element={<Profile />} />
            <Route path="/boas-praticas" element={<Guide />} />
            <Route path="/versoes" element={<Versoes />} />
            <Route path="/tutoriais" element={<Tutorials app="mckbot" appName="MCKBOT" planPath="/plano" />} />
            <Route path="*" element={<div className="empty"><div className="t">Página não encontrada</div><NavLink to="/">Voltar para a visão geral</NavLink></div>} />
          </Routes>
        </Shell>
      } />
    </Routes>
  );
}
