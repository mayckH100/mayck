import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { del, post, put, upload } from '../api';
import { useAuth, type SubscriptionView, type SubStatus } from '../auth';
import { useApi, Async, Empty, Field, Loading, Modal, fmtDate, fmtNum, useAction } from '../ui';
import { TwoFactorCard } from './Security';
import NovidadesTab from './MasterNovidades';
import MasterSdr from './MasterSdr';
import {
  CYCLES, CYCLE_LABEL, KIND_LABEL, PLAN_PRODUCTS, PRODUCTS, PRODUCT_LABEL, SOURCE_LABEL, STATUSES, STATUS_LABEL,
  SubBadge, centsToInput, daysLeft, fmtBRL, fmtDay, fmtMonth, parseBRL, toDateInput, type Cycle, type PlanProduct,
  MODULE_LABEL, PLAN_MODULES, type PlanModule,
} from '../billing';

// ---------- Tipos ----------
interface Payment {
  id: string; orgId: string; orgName: string | null; product: string; kind: string; cycle: string | null; amountCents: number | null;
  mpPaymentId: string | null; actorUserId: string | null; prevValidUntil: string | null; newValidUntil: string | null; createdAt: string;
}
interface Client {
  id: string; name: string; createdAt: string; owner: { id: string; name: string; email: string; disabled: boolean } | null;
  subscriptions: SubscriptionView[]; channels: number; messages: number; users: number; lastPayment: Payment | null;
}
interface AuditItem { id: string; orgId: string | null; userId: string | null; action: string; entity: string | null; entityId: string | null; meta: any; ip: string | null; createdAt: string; userEmail?: string | null; userName?: string | null; orgName?: string | null }
interface ClientDetail extends Client {
  timezone: string;
  members: { userId: string; name: string; email: string; role: string; isSuperAdmin: boolean; disabled: boolean; joinedAt: string }[];
  billingEvents: Payment[]; audit: AuditItem[];
}
interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }
type Counts = Record<SubStatus, number>;
interface Dash {
  totalClients: number; byProduct: Record<string, Counts>; totals: Counts; revenueMonthCents: number; revenueTotalCents: number; mrrCents: number;
  revenueByMonth: { month: string; amountCents: number }[]; lastPayments: Payment[];
}
/** Plano editável (v1.25.0): o código (MCKBOT/MCKMENSAGEM/COMBO) nunca muda; o resto é do Master. */
interface PlanCfg { name: string; desc: string; features: string[]; modules: Record<PlanModule, boolean>; visible: boolean }
interface Settings {
  plans?: Record<PlanProduct, PlanCfg>; planStats?: Record<PlanProduct, { pagantes: number; emTeste: number }>;
  prices: Record<PlanProduct, Record<Cycle, number>>; trialDays: number; mpWebhookSecret: string | null; mpWebhookSecretConfigured: boolean; mpConfigured: boolean;
  mpCheck?: { ok: boolean; message: string };
}

const TABS = [
  ['geral', 'Visão geral'], ['clientes', 'Clientes'], ['vencimentos', 'Vencimentos'], ['pagamentos', 'Pagamentos'], ['atividades', 'Atividades'], ['avisos', 'Avisos'], ['novidades', 'Novidades'], ['indicacoes', 'Indicações'], ['mckia', 'MCK IA'], ['sdr', 'SDR com IA'], ['configuracoes', 'Configurações'],
] as const;
type Tab = (typeof TABS)[number][0];

const ROLE: Record<string, string> = { OWNER: 'Proprietário', ADMIN: 'Administrador', AGENT: 'Atendente' };
const ACTION_LABEL: Record<string, string> = {
  'master.client.renew': 'Master: assinatura renovada', 'master.client.activate': 'Master: assinatura ativada', 'master.client.set-date': 'Master: vencimento definido',
  'master.client.block': 'Master: assinatura bloqueada', 'master.client.deactivate': 'Master: assinatura desativada', 'master.client.unblock': 'Master: assinatura desbloqueada',
  'master.user.update': 'Master: usuário alterado', 'master.settings.update': 'Master: configurações alteradas',
  'master.coupon.create': 'Master: cupom criado', 'master.coupon.update': 'Master: cupom editado', 'master.coupon.activate': 'Master: cupom ativado',
  'master.coupon.deactivate': 'Master: cupom desativado', 'master.coupon.delete': 'Master: cupom excluído', 'master.site.update': 'Master: site oficial alterado',
  'billing.checkout': 'Pagamento iniciado', 'billing.mp.renovado': 'Pagamento aprovado (renovação)', 'billing.mp.valor_divergente': 'Pagamento com valor divergente',
  'auth.login': 'Login', 'auth.login_failed': 'Login falhou', 'auth.register': 'Cadastro',
  'auth.mfa_enabled': '2FA ativada', 'auth.mfa_disabled': '2FA desativada', 'auth.mfa_failed': '2FA: código errado', 'auth.mfa_recovery_used': '2FA: código de recuperação usado',
  'auth.mfa_recovery_regenerated': '2FA: novos códigos de recuperação', 'auth.login_new_device': 'Login em aparelho novo', 'auth.account_locked': 'Conta bloqueada (senhas erradas)',
  'auth.login_locked': 'Tentativa com conta bloqueada', 'auth.session_revoked': 'Sessão encerrada', 'auth.sessions_revoked': 'Sessões encerradas',
  'master.announcement.create': 'Master: aviso criado', 'master.announcement.update': 'Master: aviso editado', 'master.announcement.image': 'Master: imagem do aviso enviada',
  'master.announcement.activate': 'Master: aviso ativado', 'master.announcement.deactivate': 'Master: aviso desativado', 'master.announcement.delete': 'Master: aviso excluído',
  'billing.renewal_reminder.sent': 'Lembrete de vencimento enviado (e-mail)', 'billing.renewal_reminder.failed': 'Lembrete de vencimento falhou',
  'profile.renewal_reminders': 'Lembretes de vencimento alterados',
  'report.weekly.sent': 'Resumo semanal enviado (e-mail)', 'profile.weekly_report': 'Resumo semanal por e-mail alterado',
  'master.social.connect': 'Master: rede social conectada', 'master.social.connect_failed': 'Master: falha ao conectar rede social', 'master.social.disconnect': 'Master: rede social desconectada',
  'master.social.post_create': 'Master: novidade criada', 'master.social.post_publish': 'Master: novidade aprovada e publicada', 'master.social.post_delete': 'Master: novidade excluída',
  'backup.success': 'Backup do banco concluído', 'backup.failed': 'Backup do banco falhou', 'backup.download': 'Backup baixado pelo Master',
};
const actionLabel = (a: string) => ACTION_LABEL[a] ?? a;
const metaText = (m: any) => {
  if (!m || typeof m !== 'object') return '';
  const parts = Object.entries(m).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return parts.join(' · ');
};

// ---------- Componentes comuns ----------
export function Forbidden() {
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <Empty title="Acesso restrito (403)">
        <p>O Painel Master é exclusivo do administrador da plataforma. Se você acredita que deveria ter acesso, fale com o suporte.</p>
        <Link to="/">Voltar para a visão geral</Link>
      </Empty>
    </div>
  );
}

function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="row between small" style={{ marginTop: 10 }}>
      <span className="muted">{fmtNum(total)} registro(s) · página {page} de {pages}</span>
      <div className="row">
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Anterior</button>
        <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima →</button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return <div className="card stat"><div className="l">{label}</div><div className="v">{value}</div>{sub && <div className="small muted">{sub}</div>}</div>;
}

function PaymentsTable({ items, showOrg = true }: { items: Payment[]; showOrg?: boolean }) {
  if (items.length === 0) return <Empty title="Nenhum registro de cobrança" />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Data</th>{showOrg && <th>Cliente</th>}<th>Produto</th><th>Tipo</th><th>Ciclo</th><th>Valor</th><th>Vencimento</th><th>ID MP</th></tr></thead>
        <tbody>{items.map((p) => (
          <tr key={p.id}>
            <td>{fmtDate(p.createdAt)}</td>
            {showOrg && <td><Link to={`/master/clientes/${p.orgId}`}>{p.orgName ?? p.orgId}</Link></td>}
            <td>{PRODUCT_LABEL[p.product as PlanProduct] ?? p.product}</td>
            <td>{KIND_LABEL[p.kind] ?? p.kind}</td>
            <td>{p.cycle ? CYCLE_LABEL[p.cycle] ?? p.cycle : '—'}</td>
            <td><strong>{p.amountCents !== null ? fmtBRL(p.amountCents) : '—'}</strong></td>
            <td className="small">{p.prevValidUntil || p.newValidUntil ? `${fmtDay(p.prevValidUntil)} → ${fmtDay(p.newValidUntil)}` : '—'}</td>
            <td className="mono">{p.mpPaymentId ?? '—'}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function AuditTable({ items, showOrg = true }: { items: AuditItem[]; showOrg?: boolean }) {
  if (items.length === 0) return <Empty title="Nenhuma atividade registrada" />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Quando</th><th>Quem</th>{showOrg && <th>Cliente</th>}<th>Ação</th><th>Detalhes</th><th>IP</th></tr></thead>
        <tbody>{items.map((a) => (
          <tr key={a.id}>
            <td>{fmtDate(a.createdAt)}</td>
            <td>{a.userName ?? a.userEmail ?? (a.userId ? a.userId : 'Sistema')}{a.userEmail && a.userName && <div className="small muted">{a.userEmail}</div>}</td>
            {showOrg && <td>{a.orgId ? <Link to={`/master/clientes/${a.orgId}`}>{a.orgName ?? a.orgId}</Link> : '—'}</td>}
            <td>{actionLabel(a.action)}</td>
            <td className="small" style={{ wordBreak: 'break-word', maxWidth: 360 }}>{metaText(a.meta)}</td>
            <td className="small">{a.ip ?? ''}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** Gráfico de barras simples (SVG, sem biblioteca). */
function RevenueChart({ data }: { data: { month: string; amountCents: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.amountCents));
  const W = 600, H = 180, pad = 22, bw = (W - pad) / Math.max(1, data.length);
  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} width="100%" role="img" aria-label="Faturamento dos últimos 12 meses" style={{ display: 'block' }}>
      <line x1={0} x2={W} y1={H} y2={H} stroke="var(--line)" />
      {data.map((d, i) => {
        const h = d.amountCents > 0 ? Math.max(3, (d.amountCents / max) * (H - pad)) : 0;
        const x = i * bw + pad / 2 + bw * 0.15;
        const w = bw * 0.7;
        return (
          <g key={d.month}>
            <title>{`${fmtMonth(d.month)}: ${fmtBRL(d.amountCents)}`}</title>
            <rect x={x} y={H - h} width={w} height={h} rx={3} fill={i === data.length - 1 ? 'var(--brand)' : 'var(--brand-2)'} />
            {d.amountCents > 0 && <text x={x + w / 2} y={H - h - 4} fontSize="9" textAnchor="middle" fill="var(--muted)">{(d.amountCents / 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}</text>}
            <text x={x + w / 2} y={H + 15} fontSize="10" textAnchor="middle" fill="var(--muted)">{fmtMonth(d.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------- Abas ----------
function Overview() {
  const state = useApi<Dash>('/master/dashboard');
  return (
    <Async state={state}>{(d) => (
      <div className="stack">
        <div className="grid g4">
          <Stat label="Faturamento do mês" value={fmtBRL(d.revenueMonthCents)} sub="Pagamentos aprovados no Mercado Pago" />
          <Stat label="Faturamento total" value={fmtBRL(d.revenueTotalCents)} />
          <Stat label="MRR (receita recorrente mensal)" value={fmtBRL(d.mrrCents)} sub="Assinaturas ativas; anuais ÷ 12" />
          <Stat label="Clientes" value={fmtNum(d.totalClients)} sub={`${fmtNum(d.totals.ATIVA)} assinatura(s) ativa(s) · ${fmtNum(d.totals.TRIAL)} em teste`} />
        </div>
        <div className="grid g2">
          {PRODUCTS.map((p) => {
            const c = d.byProduct[p] ?? { ATIVA: 0, TRIAL: 0, VENCIDA: 0, BLOQUEADA: 0 };
            return (
              <div key={p} className="card">
                <h2>{PRODUCT_LABEL[p]}</h2>
                <div className="grid g4" style={{ gap: 8 }}>
                  {STATUSES.map((s) => (
                    <div key={s} className="stat"><div className="l"><SubBadge status={s} /></div><div className="v">{fmtNum(c[s])}</div></div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="card">
          <div className="row between"><h2 style={{ margin: 0 }}>Faturamento — últimos 12 meses</h2><button className="btn sm" onClick={state.reload}>Atualizar</button></div>
          <RevenueChart data={d.revenueByMonth} />
        </div>
        <div className="card">
          <h2>Últimos pagamentos</h2>
          <PaymentsTable items={d.lastPayments} />
        </div>
      </div>
    )}</Async>
  );
}

function SubCell({ subs, product }: { subs: SubscriptionView[]; product: string }) {
  const s = subs.find((x) => x.product === product);
  if (!s) return <span className="muted">—</span>;
  return <div><SubBadge status={s.status} /><div className="small muted">até {fmtDay(s.validUntil)}</div></div>;
}

function Clients() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const status = sp.get('status') ?? '';
  const product = sp.get('produto') ?? '';
  const page = Math.max(1, Number(sp.get('p')) || 1);
  const [text, setText] = useState(q);
  const nav = useNavigate();
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    next.set('aba', 'clientes');
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setSp(next, { replace: true });
  };
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(product ? { product } : {}), page: String(page) }).toString();
  const state = useApi<Paged<Client>>(`/master/clients?${qs}`);
  const onSearch = (e: FormEvent) => { e.preventDefault(); set({ q: text.trim(), p: '' }); };
  return (
    <div className="stack">
      <form className="card row" onSubmit={onSearch} style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: '2 1 240px' }}><Field label="Buscar"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Nome da empresa, e-mail ou nome do usuário, ID" /></Field></div>
        <div style={{ flex: '1 1 150px' }}><Field label="Status">
          <select value={status} onChange={(e) => set({ status: e.target.value, p: '' })}>
            <option value="">Todos</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select></Field></div>
        <div style={{ flex: '1 1 150px' }}><Field label="Produto">
          <select value={product} onChange={(e) => set({ produto: e.target.value, p: '' })}>
            <option value="">Todos</option>{PRODUCTS.map((p) => <option key={p} value={p}>{PRODUCT_LABEL[p]}</option>)}
          </select></Field></div>
        <button className="btn primary">Buscar</button>
        {(q || status || product) && <button type="button" className="btn ghost" onClick={() => { setText(''); setSp(new URLSearchParams({ aba: 'clientes' }), { replace: true }); }}>Limpar</button>}
      </form>
      <Async state={state}>{(d) => (
        <div className="card">
          {d.items.length === 0 ? <Empty title="Nenhum cliente encontrado">Ajuste a busca ou os filtros.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Cliente</th><th>Responsável</th><th>MCKBOT</th><th>MCKMENSAGEM</th><th>Uso</th><th>Último pagamento</th><th>Cadastro</th></tr></thead>
                <tbody>{d.items.map((c) => (
                  <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/master/clientes/${c.id}`)}>
                    <td><Link to={`/master/clientes/${c.id}`} onClick={(e) => e.stopPropagation()}><strong>{c.name}</strong></Link></td>
                    <td>{c.owner ? <>{c.owner.name}{c.owner.disabled && <span className="badge red" style={{ marginLeft: 4 }}>desativado</span>}<div className="small muted">{c.owner.email}</div></> : '—'}</td>
                    <td><SubCell subs={c.subscriptions} product="MCKBOT" /></td>
                    <td><SubCell subs={c.subscriptions} product="MCKMENSAGEM" /></td>
                    <td className="small">{fmtNum(c.users)} usuário(s)<br />{fmtNum(c.channels)} canal(is) · {fmtNum(c.messages)} msg</td>
                    <td className="small">{c.lastPayment ? <>{fmtBRL(c.lastPayment.amountCents)}<br /><span className="muted">{fmtDay(c.lastPayment.createdAt)}</span></> : '—'}</td>
                    <td className="small">{fmtDay(c.createdAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <Pager page={d.page} total={d.total} pageSize={d.pageSize} onPage={(p) => set({ p: String(p) })} />
        </div>
      )}</Async>
    </div>
  );
}

type ActionKind = 'activate' | 'renew-month' | 'renew-year' | 'set-date' | 'block' | 'unblock';
const ACTION_TITLE: Record<ActionKind, string> = {
  activate: 'Ativar assinatura', 'renew-month': 'Renovar +1 mês', 'renew-year': 'Renovar +1 ano', 'set-date': 'Definir vencimento', block: 'Bloquear assinatura', unblock: 'Desbloquear assinatura',
};

function ActionModal({ orgId, product, kind, current, onClose, onDone }: { orgId: string; product: PlanProduct; kind: ActionKind; current?: SubscriptionView; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [cycle, setCycle] = useState<Cycle>('MENSAL');
  const [date, setDate] = useState(current ? toDateInput(current.validUntil) : toDateInput(new Date(Date.now() + 30 * 86_400_000)));
  const { busy, run } = useAction();
  const danger = kind === 'block';
  const reasonRequired = kind === 'block' || kind === 'unblock';
  const desc: Record<ActionKind, string> = {
    activate: 'Ativa a assinatura manualmente pelo ciclo escolhido, a partir de hoje (ou do vencimento atual, se ainda válido).',
    'renew-month': 'Soma 1 mês ao vencimento atual (ou a partir de hoje, se já venceu).',
    'renew-year': 'Soma 1 ano ao vencimento atual (ou a partir de hoje, se já venceu).',
    'set-date': 'Define a nova data de vencimento. Vale até o fim do dia (horário de Brasília).',
    block: 'O cliente perde o acesso a este produto até ser desbloqueado, mesmo com a assinatura em dia.',
    unblock: 'Remove o bloqueio. O acesso volta se a assinatura estiver dentro da validade.',
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { product, reason: reason.trim() || undefined };
    if (kind === 'activate') Object.assign(body, { action: 'activate', cycle });
    else if (kind === 'renew-month') Object.assign(body, { action: 'renew', cycle: 'MENSAL' });
    else if (kind === 'renew-year') Object.assign(body, { action: 'renew', cycle: 'ANUAL' });
    else if (kind === 'set-date') Object.assign(body, { action: 'set-date', validUntil: date });
    else body.action = kind;
    const r = await run(() => post(`/master/clients/${orgId}/actions`, body), `${ACTION_TITLE[kind]}: feito`);
    if (r) { onDone(); onClose(); }
  };
  return (
    <Modal title={`${ACTION_TITLE[kind]} — ${PRODUCT_LABEL[product]}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">{desc[kind]}</p>
        {product === 'COMBO' && <div className="alert info small">Plano Completo: a ação vale para MCKBOT (com o MCK ERP) e MCKMENSAGEM ao mesmo tempo.</div>}
        {current && <p className="small">Situação atual: <SubBadge status={current.status} /> · vence em {fmtDay(current.validUntil)}</p>}
        {kind === 'activate' && <Field label="Ciclo"><select value={cycle} onChange={(e) => setCycle(e.target.value as Cycle)}>{CYCLES.map((c) => <option key={c} value={c}>{CYCLE_LABEL[c]}</option>)}</select></Field>}
        {kind === 'set-date' && <Field label="Novo vencimento"><input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>}
        <Field label={reasonRequired ? 'Motivo (obrigatório)' : 'Motivo (opcional)'} hint="Fica registrado na auditoria.">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required={reasonRequired} placeholder={danger ? 'Ex.: inadimplência, uso indevido…' : 'Ex.: cortesia, pagamento por fora…'} />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy}>{busy ? 'Enviando…' : `Confirmar: ${ACTION_TITLE[kind].toLowerCase()}`}</button>
        </div>
      </form>
    </Modal>
  );
}

function SubActions({ status, onAction }: { status?: SubStatus; onAction: (k: ActionKind) => void }) {
  return (
    <div className="row">
      <button className="btn sm primary" onClick={() => onAction('activate')}>Ativar</button>
      <button className="btn sm" onClick={() => onAction('renew-month')}>Renovar +1 mês</button>
      <button className="btn sm" onClick={() => onAction('renew-year')}>+1 ano</button>
      <button className="btn sm" onClick={() => onAction('set-date')}>Definir vencimento</button>
      {status === 'BLOQUEADA'
        ? <button className="btn sm" onClick={() => onAction('unblock')}>Desbloquear</button>
        : <button className="btn sm danger" onClick={() => onAction('block')}>Bloquear</button>}
    </div>
  );
}

function ClientDetailView({ orgId }: { orgId: string }) {
  const state = useApi<ClientDetail>(`/master/clients/${orgId}`);
  const { me } = useAuth();
  const [modal, setModal] = useState<{ product: PlanProduct; kind: ActionKind } | null>(null);
  const [tab, setTab] = useState<'cobranca' | 'auditoria'>('cobranca');
  const { busy, run } = useAction();
  const userAction = async (userId: string, body: { disabled?: boolean; isSuperAdmin?: boolean }, label: string, okMsg: string) => {
    if (!confirm(label)) return;
    const r = await run(() => post(`/master/users/${userId}`, body), okMsg);
    if (r) state.reload();
  };
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Link to="/master?aba=clientes">← Voltar para clientes</Link></div>
      <Async state={state}>{(c) => {
        const myId = me?.user.id;
        const bothBlocked = c.subscriptions.length > 0 && c.subscriptions.every((s) => s.status === 'BLOQUEADA');
        return (
          <div className="stack">
            <div className="card">
              <div className="row between">
                <div>
                  <h2 style={{ margin: 0 }}>{c.name}</h2>
                  <div className="small muted">ID {c.id} · cadastro {fmtDay(c.createdAt)} · fuso {c.timezone}</div>
                  {c.owner && <div className="small">Responsável: <strong>{c.owner.name}</strong> ({c.owner.email}){c.owner.disabled && <span className="badge red" style={{ marginLeft: 4 }}>desativado</span>}</div>}
                </div>
                <div className="row small muted">{fmtNum(c.users)} usuário(s) · {fmtNum(c.channels)} canal(is) · {fmtNum(c.messages)} mensagens</div>
              </div>
            </div>

            <div className="grid g2">
              {PRODUCTS.map((p) => {
                const s = c.subscriptions.find((x) => x.product === p);
                const left = s ? daysLeft(s.validUntil) : 0;
                return (
                  <div key={p} className="card stack">
                    <div className="row between"><h2 style={{ margin: 0 }}>{PRODUCT_LABEL[p]}</h2>{s && <SubBadge status={s.status} />}</div>
                    {s ? (
                      <div className="small">
                        Vencimento: <strong>{fmtDay(s.validUntil)}</strong> {s.status !== 'BLOQUEADA' && (left > 0 ? <span className="muted">({left} dia(s) restantes)</span> : <span className="muted">(vencida)</span>)}
                        <br />Ciclo: {CYCLE_LABEL[s.cycle] ?? s.cycle} · Origem: {SOURCE_LABEL[s.source] ?? s.source}
                      </div>
                    ) : <p className="muted small">Sem assinatura registrada.</p>}
                    <SubActions status={s?.status} onAction={(kind) => setModal({ product: p, kind })} />
                  </div>
                );
              })}
            </div>
            <div className="card stack">
              <div className="row between"><h2 style={{ margin: 0 }}>Plano Completo (ERP + MCKBOT + Mensagens)</h2><span className="small muted">Aplica a ação em MCKBOT e MCKMENSAGEM juntos</span></div>
              <SubActions status={bothBlocked ? 'BLOQUEADA' : undefined} onAction={(kind) => setModal({ product: 'COMBO', kind })} />
            </div>

            <div className="card">
              <h2>Membros ({c.members.length})</h2>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Usuário</th><th>Papel</th><th>Desde</th><th>Situação</th><th>Ações</th></tr></thead>
                  <tbody>{c.members.map((m) => {
                    const self = m.userId === myId;
                    return (
                      <tr key={m.userId}>
                        <td><strong>{m.name}</strong>{self && <span className="badge" style={{ marginLeft: 4 }}>você</span>}{m.isSuperAdmin && <span className="badge blue" style={{ marginLeft: 4 }}>superadmin</span>}<div className="small muted">{m.email}</div></td>
                        <td>{ROLE[m.role] ?? m.role}</td>
                        <td className="small">{fmtDay(m.joinedAt)}</td>
                        <td>{m.disabled ? <span className="badge red">Desativado</span> : <span className="badge green">Ativo</span>}</td>
                        <td>
                          <div className="row">
                            {m.disabled
                              ? <button className="btn sm" disabled={busy} onClick={() => userAction(m.userId, { disabled: false }, `Reativar o acesso de ${m.name}?`, 'Usuário reativado')}>Reativar</button>
                              : <button className="btn sm danger" disabled={busy || self} title={self ? 'Você não pode desativar a sua própria conta' : undefined} onClick={() => userAction(m.userId, { disabled: true }, `Desativar ${m.name}? A pessoa será desconectada e não conseguirá entrar.`, 'Usuário desativado')}>Desativar</button>}
                            {m.isSuperAdmin
                              ? <button className="btn sm" disabled={busy || self} title={self ? 'Você não pode remover o seu próprio acesso' : undefined} onClick={() => userAction(m.userId, { isSuperAdmin: false }, `Remover o acesso de superadmin de ${m.name}?`, 'Acesso de superadmin removido')}>Remover superadmin</button>
                              : <button className="btn sm" disabled={busy} onClick={() => userAction(m.userId, { isSuperAdmin: true }, `Tornar ${m.name} superadmin? A pessoa terá acesso total ao Painel Master.`, 'Usuário agora é superadmin')}>Tornar superadmin</button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="tabs">
                <button className={tab === 'cobranca' ? 'on' : ''} onClick={() => setTab('cobranca')}>Histórico de cobrança ({c.billingEvents.length})</button>
                <button className={tab === 'auditoria' ? 'on' : ''} onClick={() => setTab('auditoria')}>Auditoria ({c.audit.length})</button>
              </div>
              {tab === 'cobranca' ? <PaymentsTable items={c.billingEvents} showOrg={false} /> : <AuditTable items={c.audit} showOrg={false} />}
            </div>

            {modal && (
              <ActionModal orgId={c.id} product={modal.product} kind={modal.kind}
                current={modal.product === 'COMBO' ? undefined : c.subscriptions.find((x) => x.product === modal.product)}
                onClose={() => setModal(null)} onDone={state.reload} />
            )}
          </div>
        );
      }}</Async>
    </>
  );
}

function Payments() {
  const [page, setPage] = useState(1);
  const state = useApi<Paged<Payment>>(`/master/payments?page=${page}`);
  return (
    <Async state={state}>{(d) => (
      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>Pagamentos e eventos de cobrança</h2><button className="btn sm" onClick={state.reload}>Atualizar</button></div>
        <PaymentsTable items={d.items} />
        <Pager page={d.page} total={d.total} pageSize={d.pageSize} onPage={setPage} />
      </div>
    )}</Async>
  );
}

function Activity() {
  const [page, setPage] = useState(1);
  const state = useApi<Paged<AuditItem>>(`/master/activity?page=${page}`);
  return (
    <Async state={state}>{(d) => (
      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>Atividades da plataforma</h2><button className="btn sm" onClick={state.reload}>Atualizar</button></div>
        <AuditTable items={d.items} />
        <Pager page={d.page} total={d.total} pageSize={d.pageSize} onPage={setPage} />
      </div>
    )}</Async>
  );
}

/** Rascunho do cartão de um plano (textos como digitados). */
interface PlanDraft { name: string; desc: string; features: string; modules: Record<PlanModule, boolean>; visible: boolean; MENSAL: string; ANUAL: string }
const MODULE_HINT: Record<PlanModule, string> = { MCKBOT: 'Atendimento, fluxos, IA, Inbox e Kanban', MCKMENSAGEM: 'Campanhas e SDR de respostas', ERP: 'Vendas, estoque, compras, financeiro, fiscal e BI' };

/** Validação do cartão (a mesma regra do servidor): nome, pelo menos um app, preços ≥ 0. */
export function planDraftError(code: PlanProduct, d: PlanDraft): string | null {
  const label = d.name.trim() || PRODUCT_LABEL[code];
  if (!d.name.trim()) return `Informe o nome do plano (${PRODUCT_LABEL[code]}).`;
  if (!PLAN_MODULES.some((m) => d.modules[m])) return `Escolha pelo menos um módulo em ${label}.`;
  if (!d.modules.MCKBOT && !d.modules.MCKMENSAGEM) return `${label}: marque o MCKBOT ou o MCK Mensagens (o MCK ERP vem junto com um deles).`;
  for (const c of CYCLES) {
    const v = parseBRL(d[c]);
    if (v === null) return `Preço inválido em ${label} (${CYCLE_LABEL[c]}). Use, por exemplo, 39,90 (0 = ciclo fora de venda).`;
  }
  return null;
}

function PlatformSettingsForm() {
  const state = useApi<Settings>('/master/settings');
  const [plans, setPlans] = useState<Record<string, PlanDraft>>({});
  const [trial, setTrial] = useState('');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ body: Record<string, unknown>; avisos: string[] } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!state.data) return;
    const d = state.data;
    const p: Record<string, PlanDraft> = {};
    for (const pr of PLAN_PRODUCTS) {
      const cfg = d.plans?.[pr];
      p[pr] = {
        name: cfg?.name ?? PRODUCT_LABEL[pr], desc: cfg?.desc ?? '', features: (cfg?.features ?? []).join('\n'),
        modules: { ...(cfg?.modules ?? { MCKBOT: pr !== 'MCKMENSAGEM', MCKMENSAGEM: pr !== 'MCKBOT', ERP: pr === 'COMBO' }) },
        visible: cfg?.visible ?? true,
        MENSAL: centsToInput(d.prices[pr]?.MENSAL), ANUAL: centsToInput(d.prices[pr]?.ANUAL),
      };
    }
    setPlans(p);
    setTrial(String(d.trialDays));
  }, [state.data]);
  const setPlan = (pr: PlanProduct, patch: Partial<PlanDraft>) => setPlans((cur) => ({ ...cur, [pr]: { ...cur[pr], ...patch } }));
  const save = async (body: Record<string, unknown>) => {
    setConfirm(null);
    const r = await run(() => put<Settings>('/master/settings', body), 'Configurações salvas');
    if (r) { state.setData(r); setSecret(''); setClearSecret(false); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const prices: Record<string, Record<string, number>> = {};
    const outPlans: Record<string, unknown> = {};
    for (const pr of PLAN_PRODUCTS) {
      const d = plans[pr];
      if (!d) continue;
      const err = planDraftError(pr, d);
      if (err) { setError(err); return; }
      prices[pr] = { MENSAL: parseBRL(d.MENSAL)!, ANUAL: parseBRL(d.ANUAL)! };
      outPlans[pr] = { name: d.name.trim(), desc: d.desc.trim(), features: d.features.split('\n').map((x) => x.trim()).filter(Boolean), modules: d.modules, visible: d.visible };
    }
    const td = Number(trial);
    if (!Number.isInteger(td) || td < 0 || td > 365) { setError('Dias de teste deve ser um número inteiro entre 0 e 365.'); return; }
    const body: Record<string, unknown> = { prices, plans: outPlans, trialDays: td };
    if (clearSecret) body.mpWebhookSecret = null;
    else if (secret.trim()) body.mpWebhookSecret = secret.trim();
    // Tirar o MCK ERP de um plano com assinantes corta o ERP deles: pede confirmação (Modal, sem window.confirm).
    const avisos: string[] = [];
    for (const pr of PLAN_PRODUCTS) {
      const before = state.data?.plans?.[pr];
      const st = state.data?.planStats?.[pr];
      if (before?.modules.ERP && !plans[pr]?.modules.ERP && st && st.pagantes + st.emTeste > 0) {
        avisos.push(`${before.name}: ${st.pagantes} empresa(s) pagante(s) e ${st.emTeste} em teste perdem o acesso ao MCK ERP (os dados ficam guardados e podem ser baixados).`);
      }
    }
    if (avisos.length) { setConfirm({ body, avisos }); return; }
    await save(body);
  };
  return (
    <Async state={state}>{(s) => (
      <form className="stack" onSubmit={submit}>
        <div className="card row between">
          <div><h2 style={{ margin: 0 }}>Mercado Pago</h2><p className="small muted" style={{ margin: 0 }}>O token de acesso (MP_ACCESS_TOKEN) é definido nas variáveis de ambiente do servidor.</p></div>
          {s.mpCheck?.ok
            ? <span className="badge green">● Mercado Pago conectado</span>
            : <span className="badge amber">{s.mpConfigured ? 'Credencial recusada' : 'Mercado Pago não configurado'}</span>}
        </div>
        {!s.mpCheck?.ok && s.mpCheck?.message && (
          <div className="card small" role="alert" style={{ borderColor: 'var(--amber, #d97706)' }}>
            <strong>Mercado Pago:</strong> {s.mpCheck.message}
          </div>
        )}
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Planos e preços (R$)</h2>
          <p className="small muted" style={{ margin: 0 }}>Nome, descrição, o que está incluso, módulos, preços e se o plano está à venda. Plano fora de venda some do site e do checkout para novos clientes; quem já assina continua com o acesso e pode renovar.</p>
          <div className="grid g3" style={{ gap: 12 }}>
            {PLAN_PRODUCTS.map((pr) => {
              const d = plans[pr];
              if (!d) return null;
              const st = s.planStats?.[pr];
              return (
                <fieldset key={pr} className="card stack" data-testid={`plano-${pr}`} style={{ boxShadow: 'none', margin: 0, minWidth: 0, opacity: d.visible ? 1 : 0.85 }}>
                  <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
                    <span className="small muted mono">{pr}</span>
                    <label className="row small" style={{ gap: 6 }}>
                      <input type="checkbox" checked={d.visible} onChange={(e) => setPlan(pr, { visible: e.target.checked })} aria-label={`Visível para venda: ${d.name}`} />
                      Visível para venda
                    </label>
                  </div>
                  {!d.visible && <span className="badge amber" style={{ alignSelf: 'flex-start' }}>Fora de venda</span>}
                  <Field label="Nome"><input value={d.name} maxLength={80} required onChange={(e) => setPlan(pr, { name: e.target.value })} /></Field>
                  <Field label="Descrição curta"><textarea rows={2} maxLength={300} value={d.desc} onChange={(e) => setPlan(pr, { desc: e.target.value })} /></Field>
                  <Field label="O que está incluso" hint="Um item por linha (até 12).">
                    <textarea rows={4} value={d.features} onChange={(e) => setPlan(pr, { features: e.target.value })} />
                  </Field>
                  <div className="stack" style={{ gap: 4 }} role="group" aria-label={`Módulos de ${d.name}`}>
                    <strong className="small">Módulos liberados</strong>
                    {PLAN_MODULES.map((m) => (
                      <label key={m} className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
                        <input type="checkbox" checked={d.modules[m]} onChange={(e) => setPlan(pr, { modules: { ...d.modules, [m]: e.target.checked } })} />
                        <span><strong>{MODULE_LABEL[m]}</strong> <span className="muted">· {MODULE_HINT[m]}</span></span>
                      </label>
                    ))}
                  </div>
                  <div className="grid g2" style={{ gap: 8 }}>
                    {CYCLES.map((c) => (
                      <Field key={c} label={`${CYCLE_LABEL[c]} (R$)`}>
                        <input inputMode="decimal" aria-label={`${d.name} ${CYCLE_LABEL[c]}`} value={d[c]} onChange={(e) => setPlan(pr, { [c]: e.target.value } as Partial<PlanDraft>)} />
                      </Field>
                    ))}
                  </div>
                  {st && <p className="small muted" style={{ margin: 0 }}>Hoje: {st.pagantes} pagante(s), {st.emTeste} em teste.</p>}
                </fieldset>
              );
            })}
          </div>
          <p className="small muted" style={{ margin: 0 }}>Os novos preços valem para os próximos pagamentos; pagamentos já aprovados não mudam. Preço 0 deixa aquele ciclo fora de venda. Os códigos dos planos não mudam, então assinaturas, cupons e pagamentos continuam funcionando.</p>
        </div>
        <div className="grid g2">
          <div className="card stack">
            <h2>Período de teste</h2>
            <Field label="Dias de teste para novos clientes" hint="0 a 365. Vale para organizações criadas a partir de agora.">
              <input type="number" min={0} max={365} value={trial} onChange={(e) => setTrial(e.target.value)} />
            </Field>
          </div>
          <div className="card stack">
            <h2>Segredo do webhook</h2>
            <p className="small">Atual: {s.mpWebhookSecretConfigured ? <span className="mono">{s.mpWebhookSecret}</span> : <span className="muted">não definido</span>}</p>
            <Field label="Novo segredo" hint="Copie do painel do Mercado Pago (Webhooks → assinatura secreta). Deixe em branco para manter o atual.">
              <input type="password" autoComplete="off" value={secret} disabled={clearSecret} onChange={(e) => setSecret(e.target.value)} />
            </Field>
            {s.mpWebhookSecretConfigured && <label className="row small"><input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} /> Remover o segredo salvo</label>}
          </div>
        </div>
        {error && <div className="alert err" role="alert">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="btn" onClick={() => { setError(''); state.reload(); }}>Descartar alterações</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar configurações'}</button>
        </div>
        {confirm && (
          <Modal title="Tirar o MCK ERP do plano?" onClose={() => setConfirm(null)}>
            <div className="stack">
              {confirm.avisos.map((a) => <div key={a} className="alert warn small" style={{ margin: 0 }}>{a}</div>)}
              <p className="small muted" style={{ margin: 0 }}>Se a ideia é só parar de vender o plano, desmarque "Visível para venda" e mantenha o MCK ERP: quem já assina continua com tudo.</p>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn" onClick={() => setConfirm(null)}>Voltar</button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void save(confirm.body)}>Salvar mesmo assim</button>
              </div>
            </div>
          </Modal>
        )}
      </form>
    )}</Async>
  );
}

// ---------- Cupons de desconto ----------
interface Coupon {
  id: string; code: string; partner: string | null; type: 'PERCENT' | 'FIXED'; value: number; product: string; cycles: string;
  validUntil: string | null; maxUses: number | null; firstPaymentOnly?: boolean; active: boolean; state: 'ATIVO' | 'INATIVO' | 'EXPIRADO' | 'ESGOTADO';
  uses: number; revenueCents: number; discountCents: number; deletable: boolean; createdAt: string;
}
const COUPON_PRODUCT_LABEL: Record<string, string> = { ALL: 'Todos os planos', MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCK Mensagens', COMBO: 'Plano Completo' };
const COUPON_CYCLE_LABEL: Record<string, string> = { ALL: 'Mensal e anual', MENSAL: 'Só mensal', ANUAL: 'Só anual' };
const COUPON_STATE_CLS: Record<Coupon['state'], string> = { ATIVO: 'green', INATIVO: '', EXPIRADO: 'amber', ESGOTADO: 'amber' };
const COUPON_STATE_LABEL: Record<Coupon['state'], string> = { ATIVO: 'Ativo', INATIVO: 'Inativo', EXPIRADO: 'Expirado', ESGOTADO: 'Esgotado' };
const couponValue = (c: Pick<Coupon, 'type' | 'value'>) => (c.type === 'PERCENT' ? `${c.value}%` : fmtBRL(c.value));

function CouponModal({ coupon, onClose, onSaved }: { coupon: Coupon | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    code: coupon?.code ?? '', partner: coupon?.partner ?? '', type: coupon?.type ?? 'PERCENT', value: coupon ? (coupon.type === 'PERCENT' ? String(coupon.value) : centsToInput(coupon.value)) : '',
    product: coupon?.product ?? 'ALL', cycles: coupon?.cycles ?? 'ALL', validUntil: coupon?.validUntil ? toDateInput(coupon.validUntil) : '',
    maxUses: coupon?.maxUses ? String(coupon.maxUses) : '', firstPaymentOnly: coupon?.firstPaymentOnly ?? false, active: coupon?.active ?? true,
  });
  const [err, setErr] = useState('');
  const { busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const codeLocked = !!coupon && !coupon.deletable;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    const value = f.type === 'PERCENT' ? Number(f.value) : parseBRL(f.value);
    if (f.type === 'PERCENT' && (!Number.isInteger(value) || value! < 1 || value! > 99)) return setErr('Percentual: número inteiro de 1 a 99.');
    if (f.type === 'FIXED' && (value === null || value <= 0)) return setErr('Valor fixo inválido. Use, por exemplo, 10,00.');
    const maxUses = f.maxUses.trim() ? Number(f.maxUses) : null;
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return setErr('Limite de usos: número inteiro maior que zero, ou deixe em branco.');
    const body = { code: f.code.trim().toUpperCase(), partner: f.partner.trim() || null, type: f.type, value, product: f.product, cycles: f.cycles, validUntil: f.validUntil || null, maxUses, firstPaymentOnly: f.firstPaymentOnly, active: f.active };
    const r = await run(() => (coupon ? put(`/master/coupons/${coupon.id}`, body) : post('/master/coupons', body)), coupon ? 'Cupom salvo' : 'Cupom criado');
    if (r) { onSaved(); onClose(); }
  };
  return (
    <Modal title={coupon ? `Editar cupom ${coupon.code}` : 'Novo cupom'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {err && <div className="alert err small" role="alert">{err}</div>}
        <div className="grid g2">
          <Field label="Código" hint={codeLocked ? 'Cupom já usado: o código não muda.' : 'Maiúsculas, números, - e _. Ex.: INFLU10'}>
            <input required value={f.code} disabled={codeLocked} maxLength={30} pattern="[A-Za-z0-9_-]{3,30}" onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/\s+/g, '') })} />
          </Field>
          <Field label="Parceiro (opcional)" hint="Influenciador ou empresa"><input value={f.partner} maxLength={120} onChange={set('partner')} /></Field>
        </div>
        <div className="grid g2">
          <Field label="Tipo de desconto">
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as 'PERCENT' | 'FIXED', value: '' })}><option value="PERCENT">Percentual (%)</option><option value="FIXED">Valor fixo (R$)</option></select>
          </Field>
          <Field label={f.type === 'PERCENT' ? 'Desconto (%)' : 'Desconto (R$)'} hint="O valor final nunca fica abaixo de R$ 1,00.">
            <input required inputMode={f.type === 'PERCENT' ? 'numeric' : 'decimal'} value={f.value} onChange={set('value')} placeholder={f.type === 'PERCENT' ? '10' : '10,00'} />
          </Field>
        </div>
        <div className="grid g2">
          <Field label="Produto"><select value={f.product} onChange={set('product')}>{Object.entries(COUPON_PRODUCT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Ciclos de cobrança"><select value={f.cycles} onChange={set('cycles')}>{Object.entries(COUPON_CYCLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        </div>
        <div className="grid g2">
          <Field label="Validade (opcional)" hint="Vale até o fim do dia (Brasília). Em branco: sem prazo."><input type="date" value={f.validUntil} onChange={set('validUntil')} /></Field>
          <Field label="Limite de usos total (opcional)" hint="Conta só pagamentos confirmados."><input type="number" min={1} value={f.maxUses} onChange={set('maxUses')} /></Field>
        </div>
        <label className="row small"><input type="checkbox" checked={f.firstPaymentOnly} onChange={(e) => setF({ ...f, firstPaymentOnly: e.target.checked })} /> Só no primeiro pagamento da empresa (ex.: 1º mês de parceiro)</label>
        <label className="row small"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Cupom ativo</label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : coupon ? 'Salvar cupom' : 'Criar cupom'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CouponsSection() {
  const state = useApi<{ items: Coupon[] }>('/master/coupons');
  const [editing, setEditing] = useState<Coupon | null | 'new'>(null);
  const { run } = useAction();
  const toggle = async (c: Coupon) => { if (await run(() => post(`/master/coupons/${c.id}/active`, { active: !c.active }), c.active ? 'Cupom desativado' : 'Cupom ativado')) state.reload(); };
  const remove = async (c: Coupon) => {
    if (!confirm(`Excluir o cupom ${c.code}? Ele nunca foi usado.`)) return;
    if (await run(() => del(`/master/coupons/${c.id}`), 'Cupom excluído')) state.reload();
  };
  const link = (c: Coupon) => `${window.location.origin}/cadastro?cupom=${encodeURIComponent(c.code)}`;
  return (
    <div className="card stack">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div><h2 style={{ margin: 0 }}>Cupons de desconto</h2><p className="small muted" style={{ margin: 0 }}>Para parcerias com influenciadores e empresas. Link do parceiro: /cadastro?cupom=CODIGO (o cupom já entra aplicado na assinatura).</p></div>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>Novo cupom</button>
      </div>
      <Async state={state}>{(d) => d.items.length === 0 ? <Empty title="Nenhum cupom ainda">Crie o primeiro cupom em “Novo cupom”.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Código</th><th>Parceiro</th><th>Desconto</th><th>Vale para</th><th>Validade</th><th>Usos</th><th>Receita</th><th>Descontos</th><th>Situação</th><th></th></tr></thead>
            <tbody>{d.items.map((c) => (
              <tr key={c.id}>
                <td style={{ whiteSpace: 'nowrap' }}><strong className="mono">{c.code}</strong></td>
                <td>{c.partner ?? <span className="muted">—</span>}</td>
                <td>{couponValue(c)}</td>
                <td className="small">{COUPON_PRODUCT_LABEL[c.product] ?? c.product}<br /><span className="muted">{COUPON_CYCLE_LABEL[c.cycles] ?? c.cycles}{c.firstPaymentOnly ? ' · só 1º pagamento' : ''}</span></td>
                <td className="small">{c.validUntil ? fmtDay(c.validUntil) : <span className="muted">sem prazo</span>}</td>
                <td>{fmtNum(c.uses)}{c.maxUses ? <span className="muted"> / {fmtNum(c.maxUses)}</span> : null}</td>
                <td>{fmtBRL(c.revenueCents)}</td>
                <td>{fmtBRL(c.discountCents)}</td>
                <td><span className={`badge ${COUPON_STATE_CLS[c.state]}`}>{COUPON_STATE_LABEL[c.state]}</span></td>
                <td>
                  <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                    <button type="button" className="btn sm" onClick={() => setEditing(c)}>Editar</button>
                    <button type="button" className="btn sm" onClick={() => toggle(c)}>{c.active ? 'Desativar' : 'Ativar'}</button>
                    <button type="button" className="btn sm" title="Copiar link do parceiro" onClick={() => { void navigator.clipboard?.writeText(link(c)); }}>Link</button>
                    {c.deletable && <button type="button" className="btn sm danger" onClick={() => remove(c)}>Excluir</button>}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}</Async>
      <p className="small muted">Usos, receita e descontos contam só pagamentos confirmados pelo Mercado Pago (estornos saem da conta). Cupom já usado não pode ser excluído, apenas desativado.</p>
      {editing && <CouponModal coupon={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={state.reload} />}
    </div>
  );
}

// ---------- Site oficial (/empresa) ----------
interface SiteSettings { contactEmail: string; whatsapp: string; facebookUrl: string; tutorialsPublic: boolean; promoCoupon: string; promoText: string }
function SiteSettingsSection() {
  const state = useApi<SiteSettings>('/master/site');
  const [f, setF] = useState<SiteSettings | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (state.data) setF({ contactEmail: state.data.contactEmail, whatsapp: state.data.whatsapp, facebookUrl: state.data.facebookUrl, tutorialsPublic: state.data.tutorialsPublic, promoCoupon: state.data.promoCoupon, promoText: state.data.promoText }); }, [state.data]);
  const set = (k: keyof SiteSettings) => (e: React.ChangeEvent<HTMLInputElement>) => f && setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f) return;
    const r = await run(() => put<SiteSettings>('/master/site', { ...f, promoCoupon: f.promoCoupon.trim().toUpperCase() }), 'Site oficial atualizado');
    if (r) state.setData(r);
  };
  return (
    <Async state={state}>{() => f && (
      <form className="card stack" onSubmit={submit}>
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div><h2 style={{ margin: 0 }}>Site oficial</h2><p className="small muted" style={{ margin: 0 }}>O que aparece no site da empresa (/empresa). Os preços já vêm da tabela acima.</p></div>
          <a className="btn sm" href="/empresa/" target="_blank" rel="noopener">Abrir o site</a>
        </div>
        <div className="grid g2">
          <Field label="E-mail de contato"><input type="email" required value={f.contactEmail} onChange={set('contactEmail')} /></Field>
          <Field label="WhatsApp de contato (opcional)" hint="DDI + DDD + número, ex.: 5511999999999. Em branco: não aparece."><input inputMode="tel" value={f.whatsapp} onChange={set('whatsapp')} /></Field>
        </div>
        <Field label="Página do Facebook" hint="Link https://www.facebook.com/..."><input type="url" value={f.facebookUrl} onChange={set('facebookUrl')} /></Field>
        <label className="row small"><input type="checkbox" checked={f.tutorialsPublic} onChange={(e) => setF({ ...f, tutorialsPublic: e.target.checked })} /> Tutoriais completos públicos no site (desligado: só assinantes assistem, dentro dos apps)</label>
        <div className="grid g2">
          <Field label="Promoção em destaque: cupom (opcional)" hint="Aparece como faixa no site só enquanto o cupom estiver ativo e válido."><input value={f.promoCoupon} onChange={(e) => setF({ ...f, promoCoupon: e.target.value.toUpperCase() })} placeholder="Ex.: INFLU10" /></Field>
          <Field label="Texto da promoção (opcional)" hint="Até 200 caracteres."><input value={f.promoText} maxLength={200} onChange={set('promoText')} placeholder="Ex.: 10% de desconto no primeiro mês" /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={state.reload}>Descartar alterações</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar site oficial'}</button>
        </div>
      </form>
    )}</Async>
  );
}

interface BackupRunView { id: string; trigger: string; status: string; startedAt: string; finishedAt: string | null; sizeBytes: number | null; rows: number | null; destination: string | null; location: string | null; error: string | null }
interface BackupStatus { destinations: { github: boolean; githubRepo: string | null; email: boolean; emailTo: string | null }; runs: BackupRunView[]; lastOk: BackupRunView | null }

function BackupSection() {
  const state = useApi<BackupStatus>('/master/backups');
  const { busy, run } = useAction();
  const kb = (n: number | null) => (n === null ? '—' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return (
    <div className="card stack">
      <div className="row between"><h2>Backup do banco</h2>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" disabled={busy} onClick={async () => { if (await run(() => post('/master/backups/run'), 'Backup executado')) state.reload(); }}>{busy ? 'Fazendo backup…' : 'Fazer backup agora'}</button>
          <a className="btn" href="/api/master/backups/download">Baixar backup (cifrado)</a>
        </div>
      </div>
      <p className="muted small">Todo dia, a partir das 3h (Brasília), o banco inteiro é exportado, compactado e cifrado (AES-256). O arquivo só abre com a chave do servidor; para restaurar use scripts/backup-restore.mjs.</p>
      <Async state={state}>{(b) => (
        <>
          {!b.destinations.github && !b.destinations.email
            ? <div className="alert warn">Nenhum destino automático configurado. Defina no Render BACKUP_GITHUB_TOKEN + BACKUP_GITHUB_REPO (repositório PRIVADO) ou BACKUP_EMAIL. Enquanto isso, baixe o backup por aqui.</div>
            : <div className="alert ok">Destino: {[b.destinations.github && `GitHub privado ${b.destinations.githubRepo}`, b.destinations.email && `e-mail ${b.destinations.emailTo}`].filter(Boolean).join(' + ')}. Último backup bem-sucedido: {b.lastOk ? fmtDate(b.lastOk.startedAt) : 'nenhum ainda'}.</div>}
          {b.runs.length > 0 && (
            <div className="table-wrap"><table><thead><tr><th>Quando</th><th>Tipo</th><th>Status</th><th>Tamanho</th><th>Registros</th><th>Detalhes</th></tr></thead>
              <tbody>{b.runs.map((r) => (
                <tr key={r.id}><td className="small">{fmtDate(r.startedAt)}</td><td className="small">{r.trigger === 'AUTO' ? 'Automático' : 'Manual'}</td>
                  <td><span className={`badge ${r.status === 'OK' ? 'green' : r.status === 'FAILED' ? 'red' : 'amber'}`}>{r.status === 'OK' ? 'OK' : r.status === 'FAILED' ? 'Falhou' : 'Em andamento'}</span></td>
                  <td className="small">{kb(r.sizeBytes)}</td><td className="small">{fmtNum(r.rows)}</td><td className="small">{r.error ?? r.location ?? ''}</td></tr>
              ))}</tbody></table></div>
          )}
        </>
      )}</Async>
    </div>
  );
}

// ---------- Avisos (pop-up com imagem para os clientes) ----------
interface Announcement {
  id: string; title: string | null; body: string | null; linkUrl: string | null; linkLabel: string | null;
  app: 'MCKBOT' | 'MCKMENSAGEM' | 'AMBOS'; audience: 'TODOS' | 'TRIAL' | 'ATIVOS' | 'VENCIDOS';
  startsAt: string; endsAt: string; startsAtLocal: string; endsAtLocal: string; active: boolean;
  state: 'NO_AR' | 'AGENDADO' | 'ENCERRADO' | 'INATIVO' | 'SEM_IMAGEM'; imageUrl: string | null; imageMime: string | null; imageSize: number;
  stats: { views: number; viewers: number; dismissals: number };
}
const ANN_APP_LABEL: Record<Announcement['app'], string> = { AMBOS: 'MCKBOT e MCK Mensagens', MCKBOT: 'Só MCKBOT', MCKMENSAGEM: 'Só MCK Mensagens' };
const ANN_AUD_LABEL: Record<Announcement['audience'], string> = { TODOS: 'Todos os clientes', TRIAL: 'Só em teste grátis', ATIVOS: 'Só assinantes ativos', VENCIDOS: 'Só vencidos/bloqueados' };
const ANN_STATE_LABEL: Record<Announcement['state'], string> = { NO_AR: 'No ar', AGENDADO: 'Agendado', ENCERRADO: 'Encerrado', INATIVO: 'Inativo', SEM_IMAGEM: 'Sem imagem' };
const ANN_STATE_CLS: Record<Announcement['state'], string> = { NO_AR: 'green', AGENDADO: 'amber', ENCERRADO: '', INATIVO: '', SEM_IMAGEM: 'red' };
const ANN_MAX = 2 * 1024 * 1024;
const ANN_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** "AAAA-MM-DDTHH:mm" no horário de Brasília (para o campo datetime-local). */
function spLocal(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}`;
}
const fmtSp = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

function AnnouncementPreview({ img, title, body, linkUrl, linkLabel }: { img: string | null; title: string; body: string; linkUrl: string; linkLabel: string }) {
  return (
    <div className="aviso-preview" aria-label="Pré-visualização do aviso">
      <div className="aviso">
        {img ? <img className="aviso-img" src={img} alt={title || 'Aviso'} /> : <div className="muted small" style={{ padding: 30 }}>Escolha uma imagem para ver a prévia.</div>}
        {(title || body) && <div className="aviso-text">{title && <h2>{title}</h2>}{body && <p>{body}</p>}</div>}
        <div className="aviso-actions">
          {linkUrl && <span className="btn primary">{linkLabel || 'Saiba mais'}</span>}
          <span className="btn">Fechar</span>
        </div>
      </div>
    </div>
  );
}

function AnnouncementModal({ ann, onClose, onSaved }: { ann: Announcement | null; onClose: () => void; onSaved: () => void }) {
  const now = new Date();
  const [f, setF] = useState({
    title: ann?.title ?? '', body: ann?.body ?? '', linkUrl: ann?.linkUrl ?? '', linkLabel: ann?.linkLabel ?? 'Saiba mais',
    app: ann?.app ?? 'AMBOS', audience: ann?.audience ?? 'TODOS',
    startsAt: ann?.startsAtLocal ?? spLocal(now), endsAt: ann?.endsAtLocal ?? spLocal(new Date(now.getTime() + 7 * 86400000)), active: ann?.active ?? true,
  });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(ann?.imageUrl ?? null);
  const [err, setErr] = useState('');
  const { busy, run } = useAction();
  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    setErr('');
    const fl = e.target.files?.[0] ?? null;
    if (!fl) return;
    if (!ANN_TYPES.includes(fl.type)) { e.target.value = ''; return setErr('Use uma imagem PNG, JPG ou WEBP (SVG não é aceito).'); }
    if (fl.size > ANN_MAX) { e.target.value = ''; return setErr('Imagem maior que 2 MB. Reduza o tamanho e tente de novo.'); }
    setFile(fl);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (!ann?.imageUrl && !file) return setErr('Escolha a imagem do aviso.');
    if (!f.startsAt || !f.endsAt || f.endsAt <= f.startsAt) return setErr('O fim precisa ser depois do início.');
    const body = { title: f.title.trim() || null, body: f.body.trim() || null, linkUrl: f.linkUrl.trim() || null, linkLabel: f.linkUrl.trim() ? (f.linkLabel.trim() || 'Saiba mais') : null, app: f.app, audience: f.audience, startsAt: f.startsAt, endsAt: f.endsAt, active: f.active };
    const r = await run(async () => {
      const saved = ann ? await put<Announcement>(`/master/announcements/${ann.id}`, body) : await post<Announcement>('/master/announcements', body);
      if (file) await upload(`/master/announcements/${saved.id}/image`, file);
      return saved;
    }, ann ? 'Aviso salvo' : 'Aviso criado');
    if (r) { onSaved(); onClose(); } else onSaved();
  };
  return (
    <Modal title={ann ? 'Editar aviso' : 'Novo aviso'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {err && <div className="alert err small" role="alert">{err}</div>}
        <Field label="Imagem (PNG, JPG ou WEBP, até 2 MB)" hint={ann?.imageUrl ? 'Deixe em branco para manter a imagem atual.' : undefined}>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pick} />
        </Field>
        <div className="grid g2">
          <Field label="Título (opcional)"><input value={f.title} maxLength={120} onChange={set('title')} /></Field>
          <Field label="Texto do botão" hint="Aparece só com link."><input value={f.linkLabel} maxLength={40} onChange={set('linkLabel')} /></Field>
        </div>
        <Field label="Texto (opcional)"><textarea rows={3} value={f.body} maxLength={1000} onChange={set('body')} /></Field>
        <Field label="Link (opcional)" hint="https://… ou um caminho do app, ex.: /plano"><input value={f.linkUrl} maxLength={500} onChange={set('linkUrl')} placeholder="https://" /></Field>
        <div className="grid g2">
          <Field label="Onde aparece"><select value={f.app} onChange={set('app')}>{Object.entries(ANN_APP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Para quem"><select value={f.audience} onChange={set('audience')}>{Object.entries(ANN_AUD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        </div>
        <div className="grid g2">
          <Field label="Início (horário de Brasília)"><input type="datetime-local" required value={f.startsAt} onChange={set('startsAt')} /></Field>
          <Field label="Fim (horário de Brasília)"><input type="datetime-local" required value={f.endsAt} onChange={set('endsAt')} /></Field>
        </div>
        <label className="row small"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aviso ativo</label>
        <AnnouncementPreview img={preview} title={f.title.trim()} body={f.body.trim()} linkUrl={f.linkUrl.trim()} linkLabel={f.linkLabel.trim()} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : ann ? 'Salvar aviso' : 'Criar aviso'}</button>
        </div>
      </form>
    </Modal>
  );
}

function AnnouncementsSection() {
  const state = useApi<{ items: Announcement[] }>('/master/announcements');
  const [editing, setEditing] = useState<Announcement | null | 'new'>(null);
  const { run } = useAction();
  const toggle = async (a: Announcement) => { if (await run(() => post(`/master/announcements/${a.id}/active`, { active: !a.active }), a.active ? 'Aviso desativado' : 'Aviso ativado')) state.reload(); };
  const remove = async (a: Announcement) => {
    if (!confirm(`Excluir o aviso${a.title ? ` "${a.title}"` : ''}? Esta ação não pode ser desfeita.`)) return;
    if (await run(() => del(`/master/announcements/${a.id}`), 'Aviso excluído')) state.reload();
  };
  return (
    <div className="card stack">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div><h2 style={{ margin: 0 }}>Avisos</h2><p className="small muted" style={{ margin: 0 }}>Imagem que aparece no centro da tela dos clientes, no máximo uma vez por dia por pessoa. O pop-up de renovação da assinatura tem prioridade.</p></div>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>Novo aviso</button>
      </div>
      <Async state={state}>{(d) => d.items.length === 0 ? <Empty title="Nenhum aviso ainda">Crie o primeiro em “Novo aviso”.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Imagem</th><th>Aviso</th><th>Onde / para quem</th><th>Período (Brasília)</th><th>Visto por</th><th>Fechado</th><th>Situação</th><th></th></tr></thead>
            <tbody>{d.items.map((a) => (
              <tr key={a.id}>
                <td>{a.imageUrl ? <img src={a.imageUrl} alt="" style={{ width: 64, height: 40, objectFit: 'cover', borderRadius: 6 }} /> : <span className="muted">—</span>}</td>
                <td className="small"><strong>{a.title ?? <span className="muted">(sem título)</span>}</strong>{a.linkUrl && <><br /><span className="muted">{a.linkLabel}: {a.linkUrl}</span></>}</td>
                <td className="small">{ANN_APP_LABEL[a.app]}<br /><span className="muted">{ANN_AUD_LABEL[a.audience]}</span></td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtSp(a.startsAt)}<br />{fmtSp(a.endsAt)}</td>
                <td title={`${fmtNum(a.stats.views)} exibições (pessoa/dia)`}>{fmtNum(a.stats.viewers)}</td>
                <td>{fmtNum(a.stats.dismissals)}</td>
                <td><span className={`badge ${ANN_STATE_CLS[a.state]}`}>{ANN_STATE_LABEL[a.state]}</span></td>
                <td>
                  <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                    <button type="button" className="btn sm" onClick={() => setEditing(a)}>Editar</button>
                    <button type="button" className="btn sm" onClick={() => toggle(a)}>{a.active ? 'Desativar' : 'Ativar'}</button>
                    <button type="button" className="btn sm danger" onClick={() => remove(a)}>Excluir</button>
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}</Async>
      <p className="small muted">“Visto por” conta pessoas diferentes que viram o aviso; “Fechado” conta fechamentos (no máximo um por pessoa por dia).</p>
      {editing && <AnnouncementModal ann={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={state.reload} />}
    </div>
  );
}

interface RenewalItem { orgId: string; orgName: string | null; ownerName: string | null; ownerEmail: string | null; phone: string | null; product: string; status: SubStatus; validUntil: string; whatsappUrl: string | null }
interface RenewalCounts { ativas: number; emTeste: number; vencendo7d: number; vencidas: number; bloqueadas: number }
interface RenewalsData { generatedAt: string; counts: Record<string, RenewalCounts>; expiringThisWeek: RenewalItem[]; expiredLast7Days: RenewalItem[] }
const PRODUCT_NAME: Record<string, string> = { MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCK Mensagens' };

function RenewalTable({ items, empty }: { items: RenewalItem[]; empty: string }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Organização</th><th>E-mail do titular</th><th>Telefone</th><th>Produto</th><th>Status</th><th>Data</th><th>Contato</th></tr></thead>
        <tbody>{items.map((r) => (
          <tr key={`${r.orgId}-${r.product}`}>
            <td><Link to={`/master/clientes/${r.orgId}`}>{r.orgName ?? r.orgId}</Link></td>
            <td>{r.ownerEmail ?? '—'}</td>
            <td>{r.phone ?? '—'}</td>
            <td>{PRODUCT_NAME[r.product] ?? r.product}</td>
            <td><SubBadge status={r.status} /></td>
            <td>{fmtDay(r.validUntil)} <span className="small muted">({(() => { const n = daysLeft(r.validUntil); return n > 0 ? `em ${n} d` : n === 0 ? 'hoje' : `há ${-n} d`; })()})</span></td>
            <td>{r.whatsappUrl ? <a className="btn sm" href={r.whatsappUrl} target="_blank" rel="noopener noreferrer">WhatsApp</a> : <span className="small muted">sem telefone</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Renewals() {
  const state = useApi<RenewalsData>('/master/renewals');
  return (
    <Async state={state}>{(d) => (
      <div className="stack">
        <div className="grid g2">
          {PRODUCTS.map((p) => {
            const c = d.counts[p] ?? { ativas: 0, emTeste: 0, vencendo7d: 0, vencidas: 0, bloqueadas: 0 };
            return (
              <div key={p} className="card">
                <h2>{PRODUCT_NAME[p] ?? p}</h2>
                <div className="grid g4" style={{ gap: 8 }}>
                  <Stat label="Ativas" value={fmtNum(c.ativas)} />
                  <Stat label="Em teste" value={fmtNum(c.emTeste)} />
                  <Stat label="Vencendo em 7 dias" value={fmtNum(c.vencendo7d)} />
                  <Stat label="Vencidas" value={fmtNum(c.vencidas)} />
                  <Stat label="Bloqueadas" value={fmtNum(c.bloqueadas)} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="card">
          <div className="row between"><h2 style={{ margin: 0 }}>Vencendo esta semana (próximos 7 dias)</h2><button className="btn sm" onClick={state.reload}>Atualizar</button></div>
          <RenewalTable items={d.expiringThisWeek} empty="Nenhuma assinatura vence nos próximos 7 dias." />
        </div>
        <div className="card">
          <h2>Venceram nos últimos 7 dias</h2>
          <RenewalTable items={d.expiredLast7Days} empty="Nenhuma assinatura venceu nos últimos 7 dias." />
        </div>
      </div>
    )}</Async>
  );
}

function SettingsTab() {
  return (
    <div className="stack">
      <BackupSection />
      <PlatformSettingsForm />
      <CouponsSection />
      <SiteSettingsSection />
    </div>
  );
}


// ---------- Indique e ganhe ----------
interface ReferralRow { id: string; code: string; status: string; reason: string | null; rewardDays: number; referrerOrgId: string; referrerName: string | null; referredOrgId: string; referredName: string | null; createdAt: string; creditedAt: string | null; notifiedAt: string | null }
const REFERRAL_STATUS: Record<string, [string, string]> = { PENDENTE: ['Aguardando pagamento', 'amber'], CREDITADO: ['Mês creditado', 'green'], RECUSADO: ['Recusada', ''], ESTORNADO: ['Estornada', ''] };
const REFERRAL_REASON: Record<string, string> = { autoindicacao: 'autoindicação', pagamento_estornado: 'pagamento estornado' };
function ReferralsTab() {
  const state = useApi<{ totals: { total: number; pendentes: number; creditadas: number; recusadas: number; estornadas: number }; items: ReferralRow[] }>('/master/indicacoes');
  return (
    <Async state={state}>{(d) => (
      <div className="stack">
        <div className="grid g4">
          <Stat label="Indicações" value={fmtNum(d.totals.total)} />
          <Stat label="Aguardando pagamento" value={fmtNum(d.totals.pendentes)} />
          <Stat label="Meses creditados" value={fmtNum(d.totals.creditadas)} />
          <Stat label="Recusadas / estornadas" value={`${fmtNum(d.totals.recusadas)} / ${fmtNum(d.totals.estornadas)}`} />
        </div>
        <div className="card stack">
          <div><h2 style={{ margin: 0 }}>Indique e ganhe</h2><p className="small muted" style={{ margin: 0 }}>Cada cliente tem o link /cadastro?indica=CODIGO. Quando a indicada faz o 1º pagamento aprovado, quem indicou ganha 30 dias (uma vez por indicada). Autoindicação (mesmo e-mail, celular ou CPF/CNPJ) é recusada.</p></div>
          {d.items.length === 0 ? <Empty title="Nenhuma indicação ainda">As indicações aparecem aqui quando alguém se cadastra pelo link de um cliente.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Data</th><th>Quem indicou</th><th>Empresa indicada</th><th>Código</th><th>Situação</th><th>Crédito</th></tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{fmtDay(r.createdAt)}</td>
                    <td><Link to={`/master/clientes/${r.referrerOrgId}`}>{r.referrerName ?? r.referrerOrgId}</Link></td>
                    <td><Link to={`/master/clientes/${r.referredOrgId}`}>{r.referredName ?? r.referredOrgId}</Link></td>
                    <td className="mono small">{r.code}</td>
                    <td><span className={`badge ${REFERRAL_STATUS[r.status]?.[1] ?? ''}`}>{REFERRAL_STATUS[r.status]?.[0] ?? r.status}</span>{r.reason ? <div className="small muted">{REFERRAL_REASON[r.reason] ?? r.reason}</div> : null}</td>
                    <td className="small">{r.creditedAt ? `+${r.rewardDays} dias em ${fmtDay(r.creditedAt)}` : <span className="muted">—</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )}</Async>
  );
}

// ---------- MCK IA: uso por empresa (só superadmin; provedores aparecem apenas aqui) ----------
interface MckIaRow {
  orgId: string; orgName: string; usesMckIa: boolean; tierLabel: string; limit: number;
  today: { responses: number; failures: number; quotaBlocks: number; percent: number | null };
  week: { responses: number; failures: number; quotaBlocks: number };
  providers: Record<string, number>; lastError: string | null; lastAt: string | null;
}
function MckIaTab() {
  const state = useApi<{ providersActive: string[]; limits: { teste: number; pago: number; completo: number }; totals: { today: number; todayFailures: number; week: number; weekFailures: number; atLimit: number }; items: MckIaRow[] }>('/master/mck-ia');
  const lim = (n: number) => (n ? fmtNum(n) : 'sem limite');
  return (
    <Async state={state}>{(d) => (
      <div className="stack">
        <div className="grid g4">
          <Stat label="Respostas hoje" value={fmtNum(d.totals.today)} sub={`${fmtNum(d.totals.todayFailures)} falha(s)`} />
          <Stat label="Respostas (7 dias)" value={fmtNum(d.totals.week)} sub={`${fmtNum(d.totals.weekFailures)} falha(s)`} />
          <Stat label="Empresas no limite hoje" value={fmtNum(d.totals.atLimit)} />
          <Stat label="Provedores ativos" value={d.providersActive.length ? d.providersActive.join(' → ') : 'nenhum'} sub="Ordem de tentativa (só visível no Master)" />
        </div>
        <div className="card stack">
          <div><h2 style={{ margin: 0 }}>Uso da MCK IA por empresa</h2><p className="small muted" style={{ margin: 0 }}>Cota diária de respostas (zera à meia-noite de Brasília): teste {lim(d.limits.teste)} · plano pago {lim(d.limits.pago)} · Plano Completo {lim(d.limits.completo)}. Variáveis MCK_IA_DAILY_TRIAL, MCK_IA_DAILY_PAID e MCK_IA_DAILY_COMBO.</p></div>
          {d.items.length === 0 ? <Empty title="Nenhuma empresa usando a MCK IA">As empresas aparecem aqui quando escolhem a MCK IA em Configurações da IA.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Empresa</th><th>Plano</th><th>Hoje</th><th>% da cota</th><th>7 dias</th><th>Provedores (7 dias)</th><th>Última falha</th></tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={r.orgId}>
                    <td><Link to={`/master/clientes/${r.orgId}`}>{r.orgName}</Link>{!r.usesMckIa && <div className="small muted">não usa mais a MCK IA</div>}</td>
                    <td className="small">{r.tierLabel}<div className="muted">{r.limit ? `${fmtNum(r.limit)}/dia` : 'sem limite'}</div></td>
                    <td>{fmtNum(r.today.responses)} <span className="small muted">resp.</span>{r.today.failures ? <div className="small">{fmtNum(r.today.failures)} falha(s)</div> : null}{r.today.quotaBlocks ? <div className="small">{fmtNum(r.today.quotaBlocks)} bloqueada(s) pela cota</div> : null}</td>
                    <td>{r.today.percent === null ? <span className="muted">—</span> : <span className={`badge ${r.today.percent >= 100 ? 'red' : r.today.percent >= 80 ? 'amber' : 'green'}`}>{r.today.percent}%</span>}</td>
                    <td>{fmtNum(r.week.responses)} <span className="small muted">resp.</span>{r.week.failures ? <div className="small">{fmtNum(r.week.failures)} falha(s)</div> : null}</td>
                    <td className="small">{Object.keys(r.providers).length ? Object.entries(r.providers).map(([p, n]) => `${p}: ${fmtNum(n)}`).join(' · ') : <span className="muted">—</span>}</td>
                    <td className="small">{r.lastError ? <span title={r.lastError}>{r.lastError.slice(0, 80)}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )}</Async>
  );
}

// ---------- Página ----------
export default function Master() {
  const { me } = useAuth();
  const { orgId } = useParams();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.some(([k]) => k === sp.get('aba')) ? sp.get('aba') : 'geral') as Tab;
  const probe = useApi<Settings>(me?.isSuperAdmin ? null : '/master/settings');
  if (!me?.isSuperAdmin) {
    if (probe.loading) return <Loading />;
    if (!probe.data) return <><div className="page-head"><div><h1>Painel Master</h1></div></div><Forbidden /></>;
  }
  if (me?.user.mfaRequired && !me.user.mfaEnabled) {
    return (
      <>
        <div className="page-head"><div><h1>Painel Master</h1><p className="muted">Proteção extra obrigatória para o administrador da plataforma.</p></div></div>
        <div style={{ maxWidth: 560 }}><TwoFactorCard /></div>
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <div><h1>Painel Master</h1><p className="muted">Administração da plataforma: clientes, assinaturas, pagamentos e configurações.</p></div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <a className="btn" href="/empresa/" target="_blank" rel="noopener">Site oficial</a>
          <a className="btn sm" href="/empresa/planos.html" target="_blank" rel="noopener">Planos</a>
          <a className="btn sm" href="/empresa/ajuda.html" target="_blank" rel="noopener">Ajuda</a>
        </div>
      </div>
      {orgId ? <ClientDetailView orgId={orgId} /> : (
        <>
          <div className="tabs" role="tablist">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setSp(new URLSearchParams({ aba: k }))}>{label}</button>
            ))}
          </div>
          {tab === 'geral' && <Overview />}
          {tab === 'clientes' && <Clients />}
          {tab === 'vencimentos' && <Renewals />}
          {tab === 'pagamentos' && <Payments />}
          {tab === 'atividades' && <Activity />}
          {tab === 'avisos' && <AnnouncementsSection />}
          {tab === 'novidades' && <NovidadesTab />}
          {tab === 'indicacoes' && <ReferralsTab />}
          {tab === 'mckia' && <MckIaTab />}
          {tab === 'sdr' && <MasterSdr />}
          {tab === 'configuracoes' && <SettingsTab />}
        </>
      )}
    </>
  );
}

