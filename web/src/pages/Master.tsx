import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { del, post, put } from '../api';
import { useAuth, type SubscriptionView, type SubStatus } from '../auth';
import { useApi, Async, Empty, Field, Loading, Modal, fmtDate, fmtNum, useAction } from '../ui';
import {
  CYCLES, CYCLE_LABEL, KIND_LABEL, PLAN_PRODUCTS, PRODUCTS, PRODUCT_LABEL, SOURCE_LABEL, STATUSES, STATUS_LABEL,
  SubBadge, centsToInput, daysLeft, fmtBRL, fmtDay, fmtMonth, parseBRL, toDateInput, type Cycle, type PlanProduct,
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
interface Settings {
  prices: Record<PlanProduct, Record<Cycle, number>>; trialDays: number; mpWebhookSecret: string | null; mpWebhookSecretConfigured: boolean; mpConfigured: boolean;
  mpCheck?: { ok: boolean; message: string };
}

const TABS = [
  ['geral', 'Visão geral'], ['clientes', 'Clientes'], ['pagamentos', 'Pagamentos'], ['atividades', 'Atividades'], ['configuracoes', 'Configurações'],
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
        {product === 'COMBO' && <div className="alert info small">Combo: a ação vale para MCKBOT e MCKMENSAGEM ao mesmo tempo.</div>}
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
              <div className="row between"><h2 style={{ margin: 0 }}>Combo (os dois produtos)</h2><span className="small muted">Aplica a ação em MCKBOT e MCKMENSAGEM juntos</span></div>
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

function PlatformSettingsForm() {
  const state = useApi<Settings>('/master/settings');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [trial, setTrial] = useState('');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!state.data) return;
    const p: Record<string, string> = {};
    for (const pr of PLAN_PRODUCTS) for (const c of CYCLES) p[`${pr}.${c}`] = centsToInput(state.data.prices[pr]?.[c]);
    setPrices(p);
    setTrial(String(state.data.trialDays));
  }, [state.data]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const out: Record<string, Record<string, number>> = {};
    for (const pr of PLAN_PRODUCTS) {
      out[pr] = {};
      for (const c of CYCLES) {
        const v = parseBRL(prices[`${pr}.${c}`] ?? '');
        if (v === null || v <= 0) { alert(`Preço inválido em ${PRODUCT_LABEL[pr]} (${CYCLE_LABEL[c]}). Use, por exemplo, 39,90.`); return; }
        out[pr][c] = v;
      }
    }
    const td = Number(trial);
    if (!Number.isInteger(td) || td < 0 || td > 365) { alert('Dias de teste deve ser um número inteiro entre 0 e 365.'); return; }
    const body: Record<string, unknown> = { prices: out, trialDays: td };
    if (clearSecret) body.mpWebhookSecret = null;
    else if (secret.trim()) body.mpWebhookSecret = secret.trim();
    const r = await run(() => put<Settings>('/master/settings', body), 'Configurações salvas');
    if (r) { state.setData(r); setSecret(''); setClearSecret(false); }
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
          <h2>Preços (R$)</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Produto</th>{CYCLES.map((c) => <th key={c}>{CYCLE_LABEL[c]}</th>)}</tr></thead>
              <tbody>{PLAN_PRODUCTS.map((pr) => (
                <tr key={pr}>
                  <td><strong>{PRODUCT_LABEL[pr]}</strong></td>
                  {CYCLES.map((c) => (
                    <td key={c} style={{ minWidth: 130 }}>
                      <div className="row" style={{ flexWrap: 'nowrap' }}><span className="muted">R$</span>
                        <input inputMode="decimal" aria-label={`${PRODUCT_LABEL[pr]} ${CYCLE_LABEL[c]}`} value={prices[`${pr}.${c}`] ?? ''} onChange={(e) => setPrices({ ...prices, [`${pr}.${c}`]: e.target.value })} />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="small muted">Os novos preços valem para os próximos pagamentos. Pagamentos já aprovados não mudam.</p>
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
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={state.reload}>Descartar alterações</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar configurações'}</button>
        </div>
      </form>
    )}</Async>
  );
}

// ---------- Cupons de desconto ----------
interface Coupon {
  id: string; code: string; partner: string | null; type: 'PERCENT' | 'FIXED'; value: number; product: string; cycles: string;
  validUntil: string | null; maxUses: number | null; active: boolean; state: 'ATIVO' | 'INATIVO' | 'EXPIRADO' | 'ESGOTADO';
  uses: number; revenueCents: number; discountCents: number; deletable: boolean; createdAt: string;
}
const COUPON_PRODUCT_LABEL: Record<string, string> = { ALL: 'Todos os planos', MCKBOT: 'MCKBOT', MCKMENSAGEM: 'MCK Mensagens', COMBO: 'Combo' };
const COUPON_CYCLE_LABEL: Record<string, string> = { ALL: 'Mensal e anual', MENSAL: 'Só mensal', ANUAL: 'Só anual' };
const COUPON_STATE_CLS: Record<Coupon['state'], string> = { ATIVO: 'green', INATIVO: '', EXPIRADO: 'amber', ESGOTADO: 'amber' };
const COUPON_STATE_LABEL: Record<Coupon['state'], string> = { ATIVO: 'Ativo', INATIVO: 'Inativo', EXPIRADO: 'Expirado', ESGOTADO: 'Esgotado' };
const couponValue = (c: Pick<Coupon, 'type' | 'value'>) => (c.type === 'PERCENT' ? `${c.value}%` : fmtBRL(c.value));

function CouponModal({ coupon, onClose, onSaved }: { coupon: Coupon | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    code: coupon?.code ?? '', partner: coupon?.partner ?? '', type: coupon?.type ?? 'PERCENT', value: coupon ? (coupon.type === 'PERCENT' ? String(coupon.value) : centsToInput(coupon.value)) : '',
    product: coupon?.product ?? 'ALL', cycles: coupon?.cycles ?? 'ALL', validUntil: coupon?.validUntil ? toDateInput(coupon.validUntil) : '',
    maxUses: coupon?.maxUses ? String(coupon.maxUses) : '', active: coupon?.active ?? true,
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
    const body = { code: f.code.trim().toUpperCase(), partner: f.partner.trim() || null, type: f.type, value, product: f.product, cycles: f.cycles, validUntil: f.validUntil || null, maxUses, active: f.active };
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
                <td className="small">{COUPON_PRODUCT_LABEL[c.product] ?? c.product}<br /><span className="muted">{COUPON_CYCLE_LABEL[c.cycles] ?? c.cycles}</span></td>
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

function SettingsTab() {
  return (
    <div className="stack">
      <PlatformSettingsForm />
      <CouponsSection />
      <SiteSettingsSection />
    </div>
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
          {tab === 'pagamentos' && <Payments />}
          {tab === 'atividades' && <Activity />}
          {tab === 'configuracoes' && <SettingsTab />}
        </>
      )}
    </>
  );
}

