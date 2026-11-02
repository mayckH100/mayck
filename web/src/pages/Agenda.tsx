import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, patch, put, del, api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, useToast, copy, SenhaExclusaoModal } from '../ui';

const KIND: Record<string, string> = { MEETING: 'Reunião', TASK: 'Tarefa' };
const STATUS: Record<string, [string, string]> = { SCHEDULED: ['Agendado', 'blue'], DONE: ['Concluído', 'green'], CANCELLED: ['Cancelado', 'red'] };
const SOURCE: Record<string, string> = { MANUAL: 'Manual', AI: 'IA no WhatsApp', KANBAN: 'Kanban' };
/** Classificação da conversa pela IA (tag no card). */
const INTENT: Record<string, [string, string]> = { REUNIAO: ['Reunião', 'blue'], PEDIDO: ['Pedido', 'amber'], AMBOS: ['Reunião + Pedido', 'green'] };
const HANDLES: [string, string, string][] = [['REUNIAO', 'Agendar reunião', 'A IA só agenda reuniões.'], ['PEDIDO', 'Anotar pedido', 'A IA só anota pedidos.'], ['AMBOS', 'Ambos', 'A IA anota pedidos e agenda reuniões.']];
const ORDER_TYPES: [string, string, string][] = [['FISICO', 'Físico', 'Ex.: pet shop, loja. A IA pede os dados de entrega.'], ['ONLINE', 'Online', 'Ex.: e-book, curso. Sem dados de entrega.'], ['AMBOS', 'Os dois', 'A IA pede entrega só quando o item for físico.']];
const ORDER_STATUS: Record<string, [string, string]> = {
  NOVO: ['Novo', 'blue'], CONFIRMADO: ['Confirmado', 'blue'], EM_SEPARACAO: ['Em separação (preparando)', 'amber'], PRONTO_RETIRADA: ['Pronto para retirada', 'amber'],
  EM_TRANSPORTE: ['Em transporte', 'amber'], SAIU_ENTREGA: ['Saiu para entrega', 'amber'], ENTREGUE: ['Entregue', 'green'], FINALIZADO: ['Finalizado', 'green'],
  CANCELADO: ['Cancelado', 'red'], SUSPENSO: ['Suspenso', 'red'], ATRASADO: ['Atrasado', 'red'], DEVOLVIDO: ['Devolvido', 'red'],
};
/** Seletor de status agrupado: fluxo normal (online pode pular as etapas de envio) e exceções. */
const STATUS_GROUPS: [string, string[]][] = [
  ['Fluxo do pedido', ['NOVO', 'CONFIRMADO', 'EM_SEPARACAO', 'PRONTO_RETIRADA', 'EM_TRANSPORTE', 'SAIU_ENTREGA', 'ENTREGUE', 'FINALIZADO']],
  ['Exceções', ['SUSPENSO', 'ATRASADO', 'DEVOLVIDO']],
];
/** Filtros por grupo de status (o servidor tem os mesmos grupos em ORDER_GROUPS). */
const ORDER_TABS: [string, string][] = [['ativos', 'Ativos'], ['abertos', 'Novos/Confirmados'], ['preparo', 'Em preparo'], ['entrega', 'Em entrega'], ['concluidos', 'Concluídos'], ['excecoes', 'Exceções'], ['cancelados', 'Cancelados'], ['all', 'Todos']];
/** Pagamento: independente do status do pedido. */
const PAYMENT: Record<string, [string, string]> = { AGUARDANDO: ['Aguardando pagamento', 'amber'], PAGO: ['Pago', 'green'], PARCIAL: ['Parcial', 'blue'], ESTORNADO: ['Estornado/Reembolsado', 'red'], NAO_SE_APLICA: ['Não se aplica', ''] };
const MAX_ORDER_EXTRAS = 5;
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const REMINDERS = [[0, 'Sem lembrete'], [10, '10 min antes'], [30, '30 min antes'], [60, '1 hora antes'], [120, '2 horas antes'], [1440, '1 dia antes']] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const localNow = (addMin = 60) => {
  const d = new Date(Date.now() + addMin * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DIAS[dt.getDay()]}, ${pad(d)}/${pad(m)}/${y}`;
};

export interface ApptDraft {
  id?: string; kind: 'MEETING' | 'TASK'; title: string; start: string; durationMin: number; reminderMin: number;
  contactId: string | null; contactLabel?: string; assignedUserId: string | null; location: string; description: string; notifyContact: boolean; source?: 'MANUAL' | 'KANBAN';
  /** "Gerar link do Google Meet" (só na criação; padrão ligado quando o Google está conectado). */
  generateMeet?: boolean;
  /** Contatos adicionais (equipe) que recebem o link por WhatsApp (máx. 5). */
  extraContacts?: { name: string; phone: string }[];
  /** Destinatários: responsável (atendente) e contatos adicionais. Indefinido = padrão da empresa. */
  notifyAssignee?: boolean;
  notifyExtras?: boolean;
  /** Dono(s) da empresa e membros da equipe pré-configurada (telefones) que recebem o aviso. Indefinido = padrão da empresa. */
  notifyOwner?: boolean;
  teamPhones?: string[];
}
const MAX_EXTRAS = 5;
const MAX_TEAM = 5;
export const newDraft = (over: Partial<ApptDraft> = {}): ApptDraft => ({
  kind: 'MEETING', title: '', start: localNow(), durationMin: 30, reminderMin: 60, contactId: null, assignedUserId: null,
  location: '', description: '', notifyContact: true, ...over,
});

/** Formulário de reunião/tarefa (usado na Agenda e no Kanban). */
export function AppointmentModal({ draft, onClose, onSaved }: { draft: ApptDraft; onClose: () => void; onSaved: () => void }) {
  const { me, can } = useAuth();
  const [d, setD] = useState<ApptDraft>(draft);
  const [q, setQ] = useState('');
  const [contacts, setContacts] = useState<any[]>([]);
  const [conflicts, setConflicts] = useState<any[] | null>(null);
  const team = useApi<any>('/team');
  const google = useApi<any>('/agenda/google/status');
  const googleOn = !!google.data?.connected;
  const wantMeet = d.generateMeet ?? true;
  const settings = useApi<any>('/agenda/settings');
  const notifyAssignee = d.notifyAssignee ?? settings.data?.notifyAssignee ?? false;
  const notifyExtras = d.notifyExtras ?? settings.data?.notifyExtras ?? true;
  const extras = d.extraContacts ?? [];
  const teamList: { name: string; phone: string; active: boolean }[] = settings.data?.teamContacts ?? [];
  const isMeeting = d.kind === 'MEETING';
  // Novo compromisso: dono e membros ativos já vêm marcados (só reuniões); dá para desmarcar quem não deve receber.
  const notifyOwner = d.notifyOwner ?? (d.id ? false : isMeeting && settings.data?.notifyOwner !== false);
  const teamPhones = d.teamPhones ?? (d.id || !isMeeting ? [] : teamList.filter((m) => m.active).map((m) => m.phone));
  const teamShown = [...teamList.filter((m) => m.active || teamPhones.includes(m.phone)), ...teamPhones.filter((p) => !teamList.some((m) => m.phone === p)).map((p) => ({ name: p, phone: p, active: true }))];
  const toggleTeam = (phone: string, on: boolean) => setD({ ...d, teamPhones: on ? [...teamPhones.filter((p) => p !== phone), phone] : teamPhones.filter((p) => p !== phone) });
  const setExtra = (i: number, k: 'name' | 'phone', v: string) => setD({ ...d, extraContacts: extras.map((c, j) => (j === i ? { ...c, [k]: v } : c)) });
  const assignee = (team.data?.members ?? []).find((m: any) => m.user.id === d.assignedUserId);
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    if (draft.contactLabel) return;
    const t = setTimeout(() => { get(`/contacts?q=${encodeURIComponent(q)}`).then((r) => setContacts(r.items ?? [])).catch(() => undefined); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const save = async (force = false) => {
    const body: any = { kind: d.kind, title: d.title, start: d.start, durationMin: d.durationMin, reminderMin: d.reminderMin, contactId: d.contactId, assignedUserId: d.assignedUserId, location: d.location || null, description: d.description || null, notifyContact: d.notifyContact, force,
      notifyAssignee, notifyExtras, notifyOwner, teamPhones: d.teamPhones ?? (settings.data ? teamPhones : undefined), extraContacts: extras.filter((c) => c.phone.trim() || c.name.trim()).map((c) => ({ name: c.name.trim() || null, phone: c.phone.trim() })) };
    if (!d.id && d.source) body.source = d.source;
    if (!d.id && d.kind === 'MEETING') body.generateMeet = googleOn && wantMeet;
    try {
      const r = await (d.id ? patch(`/agenda/${d.id}`, body) : post('/agenda', body));
      if (!d.id && body.generateMeet && !r?.meetLink) toast('Agendado, mas o Google não gerou o link do Meet. Confira a conexão do Google em Agenda.', 'err');
      else toast(d.id ? 'Compromisso atualizado' : d.contactId && d.notifyContact ? `Agendado! O contato recebeu ${r?.meetLink ? 'o link do Meet e ' : ''}o link para a agenda do celular.` : 'Agendado!');
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflicts((e.details as any)?.conflicts ?? []);
      else toast((e as Error).message, 'err');
    }
  };
  return (
    <Modal title={d.id ? 'Editar compromisso' : d.kind === 'TASK' ? 'Nova tarefa' : 'Nova reunião'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); run(() => save(false)); }}>
        <div className="row">
          {(['MEETING', 'TASK'] as const).map((k) => <button type="button" key={k} className={`btn sm ${d.kind === k ? 'primary' : ''}`} onClick={() => setD({ ...d, kind: k })}>{KIND[k]}</button>)}
        </div>
        <Field label="Título"><input required maxLength={120} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder={d.kind === 'TASK' ? 'Ex.: Enviar proposta' : 'Ex.: Reunião de apresentação'} /></Field>
        <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', gap: 8 }}>
          <Field label={d.kind === 'TASK' ? 'Prazo (data e hora)' : 'Data e hora'}><input required type="datetime-local" value={d.start} onChange={(e) => { setD({ ...d, start: e.target.value }); setConflicts(null); }} /></Field>
          <Field label="Duração (min)"><input type="number" min={5} max={1440} step={5} value={d.durationMin} onChange={(e) => setD({ ...d, durationMin: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Contato (cliente)" hint={d.contactId ? undefined : 'Opcional. Com contato, ele recebe pelo WhatsApp o link para pôr na agenda do celular.'}>
          {draft.contactLabel ? <input disabled value={draft.contactLabel} /> : (
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
              <select value={d.contactId ?? ''} onChange={(e) => setD({ ...d, contactId: e.target.value || null })} style={{ flex: 1 }} aria-label="Contato">
                <option value="">Sem contato</option>
                {d.contactId && !contacts.some((c) => c.id === d.contactId) && <option value={d.contactId}>{d.contactLabel ?? 'Contato atual'}</option>}
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name ? `${c.name} (${c.phone})` : c.phone}</option>)}
              </select>
            </div>
          )}
        </Field>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Responsável">
            <select value={d.assignedUserId ?? ''} onChange={(e) => setD({ ...d, assignedUserId: e.target.value || null })}>
              <option value="">Equipe (sem responsável)</option>
              {(team.data?.members ?? []).filter((m: any) => can('OWNER', 'ADMIN') || m.user.id === me?.user.id).map((m: any) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
            </select>
          </Field>
          <Field label="Lembrete">
            <select value={d.reminderMin} onChange={(e) => setD({ ...d, reminderMin: Number(e.target.value) })}>
              {REMINDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Local ou link da chamada (opcional)"><input maxLength={300} value={d.location} onChange={(e) => setD({ ...d, location: e.target.value })} placeholder="Endereço, Google Meet, WhatsApp…" /></Field>
        {!d.id && d.kind === 'MEETING' && (googleOn
          ? <label className="row small"><input type="checkbox" checked={wantMeet} onChange={(e) => setD({ ...d, generateMeet: e.target.checked })} style={{ width: 'auto' }} /> Gerar link do Google Meet</label>
          : google.data && <div className="small muted">🎥 Conecte o Google em Agenda para gerar o link do Meet.</div>)}
        <Field label="Observações (opcional)"><textarea rows={2} maxLength={2000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
        <Field label={`Contatos adicionais (${extras.length}/${MAX_EXTRAS})`} hint="Equipe que recebe pelo WhatsApp a confirmação, o link do Meet e o lembrete.">
          <div className="stack" style={{ gap: 6 }}>
            {extras.map((c, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                <input placeholder="Nome (opcional)" maxLength={80} value={c.name} onChange={(e) => setExtra(i, 'name', e.target.value)} style={{ flex: 1 }} aria-label={`Nome do contato adicional ${i + 1}`} />
                <input required type="tel" placeholder="WhatsApp (DDD + número)" maxLength={30} value={c.phone} onChange={(e) => setExtra(i, 'phone', e.target.value)} style={{ flex: 1 }} aria-label={`Telefone do contato adicional ${i + 1}`} />
                <button type="button" className="btn sm ghost" onClick={() => setD({ ...d, extraContacts: extras.filter((_, j) => j !== i) })} aria-label="Remover contato">✕</button>
              </div>
            ))}
            {extras.length < MAX_EXTRAS && <div><button type="button" className="btn sm" onClick={() => setD({ ...d, extraContacts: [...extras, { name: '', phone: '' }] })}>+ Adicionar contato</button></div>}
          </div>
        </Field>
        <Field label="Notificar pelo WhatsApp (confirmação, remarcação e lembrete)">
          <div className="row small">
            <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={d.notifyContact} disabled={!d.contactId} onChange={(e) => setD({ ...d, notifyContact: e.target.checked })} style={{ width: 'auto' }} /> Cliente</label>
            <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={notifyAssignee} disabled={!d.assignedUserId} onChange={(e) => setD({ ...d, notifyAssignee: e.target.checked })} style={{ width: 'auto' }} /> Atendente (responsável)</label>
            <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={notifyExtras} disabled={!extras.length} onChange={(e) => setD({ ...d, notifyExtras: e.target.checked })} style={{ width: 'auto' }} /> Contatos adicionais</label>
            <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={notifyOwner} onChange={(e) => setD({ ...d, notifyOwner: e.target.checked })} style={{ width: 'auto' }} /> Dono da empresa</label>
          </div>
          {teamShown.length > 0 && (
            <div className="row small" style={{ marginTop: 4 }}>
              <span className="muted">Equipe:</span>
              {teamShown.map((m) => <label key={m.phone} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={teamPhones.includes(m.phone)} onChange={(e) => toggleTeam(m.phone, e.target.checked)} style={{ width: 'auto' }} aria-label={`Avisar ${m.name}`} /> {m.name}</label>)}
            </div>
          )}
          {notifyAssignee && assignee && assignee.user.hasPhone === false && <div className="small muted">O responsável não tem WhatsApp no perfil — ele não será avisado. Cadastre em Perfil › "WhatsApp para contato".</div>}
        </Field>
        {conflicts && (
          <div className="alert warn">
            <strong>Conflito de horário.</strong> Já existe compromisso nesse período:
            <ul style={{ margin: '6px 0' }}>{conflicts.map((c, i) => <li key={i}>{new Date(c.start).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}–{new Date(c.end).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}: {c.title}</li>)}</ul>
            <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => save(true))}>Agendar mesmo assim</button>
          </div>
        )}
        <button className="btn primary" disabled={busy}>{d.id ? 'Salvar' : 'Agendar'}</button>
      </form>
    </Modal>
  );
}

function SyncCard() {
  const { can } = useAuth();
  const feeds = useApi<any[]>('/agenda/feeds');
  const google = useApi<any>('/agenda/google/status');
  const { busy, run } = useAction();
  const toast = useToast();
  const [help, setHelp] = useState(false);
  const feed = (scope: 'me' | 'org') => feeds.data?.find((f) => f.scope === scope);
  const FeedRow = ({ scope, label }: { scope: 'me' | 'org'; label: string }) => {
    const f = feed(scope);
    return (
      <div className="stack" style={{ gap: 6, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
        <strong>{label}</strong>
        {f ? (
          <>
            <div className="row">
              <a className="btn sm primary" href={f.webcal} style={{ color: '#fff', textDecoration: 'none' }}>Assinar no iPhone / Mac</a>
              <a className="btn sm" href={f.google} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Assinar no Google Agenda</a>
              <button className="btn sm" onClick={() => copy(f.https, toast)}>Copiar link</button>
              <button className="btn sm ghost" disabled={busy} onClick={() => { if (confirm('Gerar um novo link? O link antigo para de funcionar em todos os aparelhos.')) run(() => post('/agenda/feeds', { scope }), 'Novo link gerado').then(feeds.reload); }}>Gerar novo link</button>
            </div>
            <span className="small muted">Link secreto: quem tiver o link vê esta agenda. Atualiza sozinho no celular (o Google pode levar algumas horas; o iPhone, minutos).</span>
          </>
        ) : <div><button className="btn sm" disabled={busy} onClick={() => run(() => post('/agenda/feeds', { scope }), 'Link criado').then(feeds.reload)}>Criar link de assinatura</button></div>}
      </div>
    );
  };
  return (
    <div className="card stack">
      <div className="row between"><h2 style={{ margin: 0 }}>Na agenda do celular</h2><button className="btn sm ghost" onClick={() => setHelp(!help)}>{help ? 'Fechar ajuda' : 'Como funciona?'}</button></div>
      {help && (
        <div className="alert info small">
          <div><strong>Sem login, em qualquer celular:</strong> cada compromisso com contato envia pelo WhatsApp um link com os botões "Google Agenda", "iPhone" e "Outlook".</div>
          <div style={{ marginTop: 6 }}><strong>Feed assinável:</strong> assine uma vez e todas as reuniões e tarefas (novas, remarcadas e canceladas) aparecem sozinhas na agenda do seu celular.</div>
          <div style={{ marginTop: 6 }}><strong>Android:</strong> toque em "Assinar no Google Agenda" (pelo computador ou navegador) — a agenda aparece no app do Google Agenda do celular. <strong>iPhone:</strong> toque em "Assinar no iPhone" e confirme.</div>
        </div>
      )}
      <FeedRow scope="me" label="Minha agenda (meus compromissos)" />
      {can('OWNER', 'ADMIN') && <FeedRow scope="org" label="Agenda da empresa (todos os compromissos)" />}
      <div className="stack" style={{ gap: 6, padding: '10px 0 0', borderTop: '1px solid var(--line)' }}>
        <strong>Google Agenda (conexão direta)</strong>
        <Async state={google}>{(g) => !g.configured ? (
          <span className="small muted">Ainda não ativada pelo administrador da plataforma. Enquanto isso, use o feed acima — funciona igual no celular.</span>
        ) : g.connected ? (
          <div className="row"><span className="badge green">Conectado</span><span className="small">{g.email}</span>
            <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm('Desconectar o Google Agenda?')) run(() => del('/agenda/google'), 'Google Agenda desconectado').then(google.reload); }}>Desconectar</button>
            <span className="small muted" style={{ flexBasis: '100%' }}>Seus compromissos vão direto para o seu Google Agenda, e os horários ocupados lá contam como conflito.</span></div>
        ) : (
          <div className="row"><button className="btn sm primary" disabled={busy} onClick={() => run(() => post('/agenda/google/connect', { app: 'mckbot' })).then((r) => { if (r?.url) window.location.href = r.url; })}>Conectar Google Agenda</button>
            <span className="small muted">Cria, atualiza e cancela eventos no seu Google Agenda e lê seus horários ocupados.</span></div>
        )}</Async>
      </div>
    </div>
  );
}

/** Pedidos registrados pela IA (aparecem no mesmo painel das reuniões). */
function OrdersCard({ handles }: { handles: string }) {
  const { can } = useAuth();
  const isAdmin = can('OWNER', 'ADMIN');
  const [group, setGroup] = useState<string>('ativos');
  const [payment, setPayment] = useState<string>('all');
  const qs = `group=${group === 'ativos' ? 'all' : group}&payment=${payment}`;
  const state = useApi<any>(`/agenda/orders?${qs}`);
  const { busy, run } = useAction();
  const [statusFor, setStatusFor] = useState<{ order: any; status: string } | null>(null);
  const [editFor, setEditFor] = useState<any>(null);
  const [cancelFor, setCancelFor] = useState<any>(null);
  const [historyFor, setHistoryFor] = useState<any>(null);
  const setPay = (o: any, paymentStatus: string) => run(() => patch(`/agenda/orders/${o.id}`, { paymentStatus, notify: false }), `Pagamento: ${PAYMENT[paymentStatus]?.[0] ?? paymentStatus}`).then(state.reload);
  // "Ativos" = tudo que não está concluído nem cancelado.
  const items = ((state.data?.items ?? []) as any[]).filter((o) => group !== 'ativos' || !['ENTREGUE', 'FINALIZADO', 'CANCELADO'].includes(o.status));
  if (handles === 'REUNIAO' && state.data && !state.data.items.length && group === 'ativos' && payment === 'all') return null;
  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Pedidos</h2>
        <select value={payment} onChange={(e) => setPayment(e.target.value)} aria-label="Filtrar por pagamento" style={{ width: 'auto' }}>
          <option value="all">Pagamento: todos</option>
          {Object.entries(PAYMENT).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="tabs" style={{ marginBottom: 8, borderBottom: 0, flexWrap: 'wrap' }} role="group" aria-label="Filtrar por status">
        {ORDER_TABS.map(([k, l]) => <button key={k} className={group === k ? 'on' : ''} onClick={() => setGroup(k)}>{l}</button>)}
      </div>
      <Async state={state}>{() => !items.length ? <Empty title="Nenhum pedido">{handles === 'REUNIAO' ? 'Escolha "Anotar pedido" ou "Ambos" em Configurações para a IA registrar pedidos no WhatsApp.' : 'Quando o cliente confirmar um pedido no WhatsApp, a IA registra e ele aparece aqui.'}</Empty> : (
        <div className="stack" style={{ gap: 8 }}>
          {items.map((o) => {
            const closed = o.status === 'CANCELADO' || o.status === 'FINALIZADO';
            return (
              <div key={o.id} className="kcard" style={{ opacity: o.status === 'CANCELADO' ? 0.6 : 1 }}>
                <div className="row between">
                  <span className="row"><strong>🛒 {o.code}</strong><span className="badge">{o.type === 'ONLINE' ? 'Online' : 'Físico'}</span><span className={`badge ${INTENT[o.intent]?.[1] ?? 'amber'}`} title="Classificação da conversa pela IA">{INTENT[o.intent]?.[0] ?? 'Pedido'}</span></span>
                  <span className="row" style={{ gap: 4 }}>
                    <span className={`badge ${PAYMENT[o.paymentStatus]?.[1] ?? ''}`} title="Pagamento">💳 {PAYMENT[o.paymentStatus]?.[0] ?? o.paymentStatus}</span>
                    <span className={`badge ${ORDER_STATUS[o.status]?.[1] ?? ''}`}>{ORDER_STATUS[o.status]?.[0] ?? o.status}</span>
                  </span>
                </div>
                <div style={{ marginTop: 4 }}>📦 {o.items.map((i: any) => `${i.quantidade}x ${i.nome}${i.obs ? ` (${i.obs})` : ''}`).join(', ')}</div>
                {o.description && <div className="small muted">📝 {o.description}</div>}
                {o.delivery && <div className="small" style={{ marginTop: 2 }}>🚚 {o.delivery.nome} — {o.delivery.endereco}, nº {o.delivery.numero}{o.delivery.complemento ? `, ${o.delivery.complemento}` : ''} — CEP {o.delivery.cep} — Tel. {o.delivery.telefone}</div>}
                {o.extraContacts?.length > 0 && <div className="small muted">👥 Contatos adicionais: {o.extraContacts.map((c: any) => c.name ?? c.phone).join(', ')}</div>}
                {o.status === 'CANCELADO' && o.cancelReason && <div className="small" style={{ color: '#991b1b' }}>❌ Motivo: {o.cancelReason}</div>}
                <div className="small muted" style={{ marginTop: 4 }}>
                  {new Date(o.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}{o.contact ? ` · ${o.contact.name ?? o.contact.phone}` : ''} · {o.source === 'AI' ? 'IA no WhatsApp' : 'Manual'}{o.channel ? <> · <span title="WhatsApp pelo qual foi feito">📲 Via: {o.channel.via}</span></> : null}
                </div>
                <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
                  {o.status === 'CANCELADO'
                    ? isAdmin && <button className="btn sm" disabled={busy} onClick={() => setStatusFor({ order: o, status: 'NOVO' })}>Reabrir</button>
                    : <select value="" disabled={busy} onChange={(e) => e.target.value && setStatusFor({ order: o, status: e.target.value })} aria-label={`Mudar status do pedido ${o.code}`} style={{ width: 'auto' }}>
                        <option value="">Mudar status…</option>
                        {STATUS_GROUPS.map(([label, list]) => (
                          <optgroup key={label} label={label}>
                            {list.filter((s) => s !== o.status && s !== 'CANCELADO' && (o.status !== 'FINALIZADO' || s === 'DEVOLVIDO')).map((s) => <option key={s} value={s}>{ORDER_STATUS[s][0]}</option>)}
                          </optgroup>
                        ))}
                      </select>}
                  <select value={o.paymentStatus} disabled={busy} onChange={(e) => setPay(o, e.target.value)} aria-label={`Pagamento do pedido ${o.code}`} style={{ width: 'auto' }}>
                    {Object.entries(PAYMENT).map(([k, [l]]) => <option key={k} value={k}>💳 {l}</option>)}
                  </select>
                  {!closed && <button className="btn sm" disabled={busy} onClick={() => setEditFor(o)}>Editar</button>}
                  <button className="btn sm ghost" onClick={() => setHistoryFor(o)}>Histórico</button>
                  {isAdmin && !closed && <button className="btn sm danger" disabled={busy} onClick={() => setCancelFor(o)}>Cancelar pedido</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}</Async>
      {statusFor && <OrderStatusModal order={statusFor.order} status={statusFor.status} onClose={() => setStatusFor(null)} onDone={() => { setStatusFor(null); state.reload(); }} />}
      {editFor && <OrderEditModal order={editFor} onClose={() => setEditFor(null)} onDone={() => { setEditFor(null); state.reload(); }} />}
      {cancelFor && <OrderCancelModal order={cancelFor} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); state.reload(); }} />}
      {historyFor && <OrderHistoryModal order={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

const notifySummary = (r: any) => {
  const n: any[] = r?.notifications ?? [];
  if (!n.length) return '';
  const ok = n.filter((x) => x.ok).length;
  const skip = n.filter((x) => x.skipped).length;
  const fail = n.length - ok - skip;
  return ` · Avisos: ${ok} enviado(s)${skip ? `, ${skip} sem permissão (opt-out)` : ''}${fail ? `, ${fail} com falha` : ''}`;
};

function OrderStatusModal({ order, status, onClose, onDone }: { order: any; status: string; onClose: () => void; onDone: () => void }) {
  const [st, setSt] = useState(status);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const { busy, run } = useAction();
  const toast = useToast();
  return (
    <Modal title={`Status do pedido ${order.code}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => patch(`/agenda/orders/${order.id}`, { status: st, note: note.trim() || null, notify }));
        if (r) { toast(`Status: ${ORDER_STATUS[st]?.[0] ?? st}${notifySummary(r)}`); onDone(); }
      }}>
        <div className="small muted">Atual: {ORDER_STATUS[order.status]?.[0] ?? order.status}</div>
        <Field label="Novo status">
          <select value={st} onChange={(e) => setSt(e.target.value)}>
            {order.status === 'CANCELADO' ? <option value="NOVO">Novo (reabrir)</option> : STATUS_GROUPS.map(([label, list]) => (
              <optgroup key={label} label={label}>
                {list.filter((s) => s !== order.status && s !== 'CANCELADO' && (order.status !== 'FINALIZADO' || s === 'DEVOLVIDO')).map((s) => <option key={s} value={s}>{ORDER_STATUS[s][0]}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Observação para o cliente (opcional)"><textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: chega até as 18h" /></Field>
        <label className="row small"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 'auto' }} /> Notificar cliente e contatos (WhatsApp{order.channel ? ` · ${order.channel.via}` : ''})</label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Voltar</button>
          <button className="btn primary" disabled={busy}>Salvar status</button>
        </div>
      </form>
    </Modal>
  );
}

function OrderEditModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<string>(order.type);
  const [items, setItems] = useState<{ nome: string; quantidade: number; obs: string }[]>(order.items.map((i: any) => ({ nome: i.nome, quantidade: i.quantidade, obs: i.obs ?? '' })));
  const [description, setDescription] = useState<string>(order.description ?? '');
  const [hasDelivery, setHasDelivery] = useState<boolean>(!!order.delivery);
  const [dl, setDl] = useState<any>(order.delivery ?? { nome: '', endereco: '', cep: '', numero: '', complemento: '', telefone: '' });
  const [extras, setExtras] = useState<{ name: string; phone: string }[]>((order.extraContacts ?? []).map((c: any) => ({ name: c.name ?? '', phone: c.phone })));
  const [notify, setNotify] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();
  const setItem = (i: number, k: string, v: any) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  const setExtra = (i: number, k: 'name' | 'phone', v: string) => setExtras(extras.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  return (
    <Modal title={`Editar pedido ${order.code}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const body: any = {
          type, description: description.trim() || null,
          items: items.filter((i) => i.nome.trim()).map((i) => ({ nome: i.nome.trim(), quantidade: Math.max(1, Math.floor(Number(i.quantidade) || 1)), obs: i.obs.trim() || null })),
          delivery: hasDelivery ? { ...dl, complemento: (dl.complemento ?? '').trim() || null } : null,
          extraContacts: extras.filter((c) => c.phone.trim() || c.name.trim()).map((c) => ({ name: c.name.trim() || null, phone: c.phone.trim() })),
          notify,
        };
        const r = await run(() => put(`/agenda/orders/${order.id}`, body));
        if (r) { toast(`Pedido atualizado${notifySummary(r)}`); onDone(); }
      }}>
        <Field label="Tipo">
          <select value={type} onChange={(e) => setType(e.target.value)}><option value="FISICO">Físico</option><option value="ONLINE">Online</option></select>
        </Field>
        <Field label="Itens">
          <div className="stack" style={{ gap: 6 }}>
            {items.map((it, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="number" min={1} max={9999} value={it.quantidade} onChange={(e) => setItem(i, 'quantidade', e.target.value)} style={{ width: 70 }} aria-label={`Quantidade do item ${i + 1}`} />
                <input required maxLength={120} placeholder="Produto" value={it.nome} onChange={(e) => setItem(i, 'nome', e.target.value)} style={{ flex: 2 }} aria-label={`Item ${i + 1}`} />
                <input maxLength={200} placeholder="Obs. (opcional)" value={it.obs} onChange={(e) => setItem(i, 'obs', e.target.value)} style={{ flex: 1 }} aria-label={`Observação do item ${i + 1}`} />
                <button type="button" className="btn sm ghost" disabled={items.length <= 1} onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remover item">✕</button>
              </div>
            ))}
            {items.length < 30 && <div><button type="button" className="btn sm" onClick={() => setItems([...items, { nome: '', quantidade: 1, obs: '' }])}>+ Adicionar item</button></div>}
          </div>
        </Field>
        <Field label="Descrição (opcional)"><textarea rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <label className="row small"><input type="checkbox" checked={hasDelivery} onChange={(e) => setHasDelivery(e.target.checked)} style={{ width: 'auto' }} /> Dados de entrega</label>
        {hasDelivery && (
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Quem recebe"><input required maxLength={100} value={dl.nome} onChange={(e) => setDl({ ...dl, nome: e.target.value })} /></Field>
            <Field label="Telefone"><input required type="tel" maxLength={30} value={dl.telefone} onChange={(e) => setDl({ ...dl, telefone: e.target.value })} /></Field>
            <Field label="Endereço (rua, bairro e cidade)"><input required maxLength={200} value={dl.endereco} onChange={(e) => setDl({ ...dl, endereco: e.target.value })} /></Field>
            <Field label="Número"><input required maxLength={20} value={dl.numero} onChange={(e) => setDl({ ...dl, numero: e.target.value })} /></Field>
            <Field label="CEP"><input required maxLength={12} value={dl.cep} onChange={(e) => setDl({ ...dl, cep: e.target.value })} /></Field>
            <Field label="Complemento (opcional)"><input maxLength={100} value={dl.complemento ?? ''} onChange={(e) => setDl({ ...dl, complemento: e.target.value })} /></Field>
          </div>
        )}
        <Field label={`Contatos adicionais (${extras.length}/${MAX_ORDER_EXTRAS})`} hint="Recebem pelo WhatsApp os avisos de status do pedido (junto com o cliente).">
          <div className="stack" style={{ gap: 6 }}>
            {extras.map((c, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                <input placeholder="Nome (opcional)" maxLength={80} value={c.name} onChange={(e) => setExtra(i, 'name', e.target.value)} style={{ flex: 1 }} aria-label={`Nome do contato adicional ${i + 1}`} />
                <input required type="tel" placeholder="WhatsApp (DDD + número)" maxLength={30} value={c.phone} onChange={(e) => setExtra(i, 'phone', e.target.value)} style={{ flex: 1 }} aria-label={`Telefone do contato adicional ${i + 1}`} />
                <button type="button" className="btn sm ghost" onClick={() => setExtras(extras.filter((_, j) => j !== i))} aria-label="Remover contato">✕</button>
              </div>
            ))}
            {extras.length < MAX_ORDER_EXTRAS && <div><button type="button" className="btn sm" onClick={() => setExtras([...extras, { name: '', phone: '' }])}>+ Adicionar contato</button></div>}
          </div>
        </Field>
        <label className="row small"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 'auto' }} /> Notificar cliente sobre a alteração (envia o resumo do que mudou)</label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Voltar</button>
          <button className="btn primary" disabled={busy}>Salvar alterações</button>
        </div>
      </form>
    </Modal>
  );
}

function OrderCancelModal({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const toast = useToast();
  return (
    <Modal title={`Cancelar pedido ${order.code}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => post(`/agenda/orders/${order.id}/cancel`, { reason: reason.trim() }));
        if (r) { toast(`Pedido cancelado${notifySummary(r)}`); onDone(); }
      }}>
        <Field label="Motivo do cancelamento" hint="O cliente, os contatos adicionais e a equipe recebem o aviso pelo WhatsApp com este motivo.">
          <textarea required minLength={3} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: produto sem estoque" />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Voltar</button>
          <button className="btn danger" disabled={busy || reason.trim().length < 3}>Cancelar pedido</button>
        </div>
      </form>
    </Modal>
  );
}

function OrderHistoryModal({ order, onClose }: { order: any; onClose: () => void }) {
  const h = useApi<any>(`/agenda/orders/${order.id}/history`);
  const KIND_ICON: Record<string, string> = { STATUS: '🔄', PAGAMENTO: '💳', EDICAO: '✏️', CANCELAMENTO: '❌' };
  return (
    <Modal title={`Histórico do pedido ${order.code}`} onClose={onClose}>
      <Async state={h}>{(d: any) => !d.items.length ? <Empty title="Sem histórico">As mudanças de status aparecem aqui.</Empty> : (
        <ol className="stack" style={{ gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
          {d.items.map((x: any) => (
            <li key={x.id} className="kcard">
              <div><strong>{KIND_ICON[x.kind] ?? '•'} {x.kind === 'EDICAO' ? 'Pedido editado' : x.fromLabel ? `${x.fromLabel} → ${x.toLabel}` : x.toLabel}</strong></div>
              {x.note && <div className="small">📝 {x.note}</div>}
              <div className="small muted">{new Date(x.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · {x.by}{x.notified ? ` · 📣 ${x.notified} aviso(s) enviado(s)` : ''}</div>
            </li>
          ))}
        </ol>
      )}</Async>
    </Modal>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const st = useApi<any>('/agenda/settings');
  const [s, setS] = useState<any>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (st.data && !s) setS(st.data); }, [st.data]);
  return (
    <Modal title="Configurações da Agenda" onClose={onClose}>
      {!s ? <div className="muted">Carregando…</div> : (
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          const { timezone: _tz, owners: _o, ...body } = s;
          // O botão escolhido manda: Agendar reunião ou Ambos = IA agenda; Anotar pedido = não agenda.
          body.aiBooking = (s.aiHandles ?? 'REUNIAO') !== 'PEDIDO';
          body.teamContacts = (s.teamContacts ?? []).map((m: any) => ({ name: m.name.trim(), phone: m.phone.trim(), active: m.active !== false }));
          if (await run(() => put('/agenda/settings', body), 'Configurações salvas')) onClose();
        }}>
          <Field label="O que a IA atende no WhatsApp" hint={HANDLES.find(([k]) => k === (s.aiHandles ?? 'REUNIAO'))?.[2]}>
            <div className="row" role="group" aria-label="O que a IA atende">
              {HANDLES.map(([k, l]) => <button type="button" key={k} className={`btn sm ${(s.aiHandles ?? 'REUNIAO') === k ? 'primary' : ''}`} aria-pressed={(s.aiHandles ?? 'REUNIAO') === k} onClick={() => setS({ ...s, aiHandles: k, aiBooking: k !== 'PEDIDO' })}>{l}</button>)}
            </div>
          </Field>
          {(s.aiHandles === 'PEDIDO' || s.aiHandles === 'AMBOS') && (
            <Field label="Tipo de pedido" hint={ORDER_TYPES.find(([k]) => k === (s.orderType ?? 'FISICO'))?.[2]}>
              <div className="stack" style={{ gap: 6 }}>
                <div className="row" role="group" aria-label="Tipo de pedido">
                  {ORDER_TYPES.map(([k, l]) => <button type="button" key={k} className={`btn sm ${(s.orderType ?? 'FISICO') === k ? 'primary' : ''}`} aria-pressed={(s.orderType ?? 'FISICO') === k} onClick={() => setS({ ...s, orderType: k })}>{l}</button>)}
                </div>
                {(s.orderType === 'ONLINE' || s.orderType === 'AMBOS') && (
                  <label className="row small"><input type="checkbox" checked={!!s.orderAskDelivery} onChange={(e) => setS({ ...s, orderAskDelivery: e.target.checked })} style={{ width: 'auto' }} /> Solicitar dados de entrega {s.orderType === 'AMBOS' ? '(também nos pedidos online)' : '(mesmo sendo online)'}</label>
                )}
                <span className="small muted">Dados de entrega: nome, endereço com CEP, número, complemento e telefone. A IA resume o pedido e só registra depois que o cliente confirma; os preços vêm das Instruções e da base de conhecimento da IA.</span>
              </div>
            </Field>
          )}
          
          {s.aiHandles !== 'PEDIDO' && <span className="small muted">A IA oferece só horários livres (sem conflito com a agenda e com o Google Agenda conectado) e, quando o cliente confirma, cria a reunião e envia o link para a agenda do celular. Requer a IA automática ligada.</span>}
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Início do atendimento"><input type="time" value={s.workStart} onChange={(e) => setS({ ...s, workStart: e.target.value })} /></Field>
            <Field label="Fim do atendimento"><input type="time" value={s.workEnd} onChange={(e) => setS({ ...s, workEnd: e.target.value })} /></Field>
          </div>
          <Field label="Dias de atendimento">
            <div className="row">{DIAS.map((n, i) => <label key={i} className="row small" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={s.workDays.includes(i)} onChange={(e) => setS({ ...s, workDays: e.target.checked ? [...s.workDays, i] : s.workDays.filter((x: number) => x !== i) })} />{n}</label>)}</div>
          </Field>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Duração padrão (min)"><input type="number" min={5} max={480} value={s.defaultDurationMin} onChange={(e) => setS({ ...s, defaultDurationMin: Number(e.target.value) })} /></Field>
            <Field label="Antecedência mínima (min)" hint="A IA não marca antes disso"><input type="number" min={0} max={10080} value={s.minNoticeMin} onChange={(e) => setS({ ...s, minNoticeMin: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Lembrete padrão">
            <select value={s.reminderMin} onChange={(e) => setS({ ...s, reminderMin: Number(e.target.value) })}>{REMINDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </Field>
          <Field label="Notificar por padrão pelo WhatsApp (novos compromissos)">
            <div className="row small">
              <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={s.notifyContact} onChange={(e) => setS({ ...s, notifyContact: e.target.checked })} style={{ width: 'auto' }} /> Cliente</label>
              <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={!!s.notifyAssignee} onChange={(e) => setS({ ...s, notifyAssignee: e.target.checked })} style={{ width: 'auto' }} /> Atendente (responsável)</label>
              <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={s.notifyExtras !== false} onChange={(e) => setS({ ...s, notifyExtras: e.target.checked })} style={{ width: 'auto' }} /> Contatos adicionais</label>
            </div>
          </Field>
          <Field label="Avisos de reunião para a equipe (WhatsApp)" hint="A cada nova reunião (inclusive as marcadas pela IA), o dono e os membros ativos recebem pelo WhatsApp da empresa: cliente, data/hora, descrição, link do Meet e quem agendou. Também recebem lembrete, remarcação e cancelamento.">
            <div className="stack" style={{ gap: 6 }}>
              <label className="row small"><input type="checkbox" checked={s.notifyOwner !== false} onChange={(e) => setS({ ...s, notifyOwner: e.target.checked })} style={{ width: 'auto' }} /> Me avisar (proprietário)</label>
              {s.notifyOwner !== false && (s.owners ?? []).filter((o: any) => !o.hasPhone).map((o: any, i: number) => <div key={i} className="small muted">⚠ {o.name} (dono) não tem WhatsApp no perfil — cadastre em Perfil › "WhatsApp para contato" para receber os avisos.</div>)}
              {(s.teamContacts ?? []).map((m: any, i: number) => {
                const set = (k: string, v: any) => setS({ ...s, teamContacts: s.teamContacts.map((x: any, j: number) => (j === i ? { ...x, [k]: v } : x)) });
                return (
                  <div key={i} className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    <input required placeholder="Nome" maxLength={80} value={m.name} onChange={(e) => set('name', e.target.value)} style={{ flex: '1 1 120px' }} aria-label={`Nome do membro ${i + 1}`} />
                    <input required type="tel" placeholder="WhatsApp (DDD + número)" maxLength={30} value={m.phone} onChange={(e) => set('phone', e.target.value)} style={{ flex: '1 1 140px' }} aria-label={`Telefone do membro ${i + 1}`} />
                    <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={m.active !== false} onChange={(e) => set('active', e.target.checked)} style={{ width: 'auto' }} /> Recebe avisos de reunião</label>
                    <button type="button" className="btn sm ghost" onClick={() => setS({ ...s, teamContacts: s.teamContacts.filter((_: any, j: number) => j !== i) })} aria-label="Remover membro">✕</button>
                  </div>
                );
              })}
              {(s.teamContacts ?? []).length < MAX_TEAM && <div><button type="button" className="btn sm" onClick={() => setS({ ...s, teamContacts: [...(s.teamContacts ?? []), { name: '', phone: '', active: true }] })}>+ Adicionar membro</button></div>}
            </div>
          </Field>
          <span className="small muted">Fuso horário da empresa: {s.timezone}</span>
          <button className="btn primary" disabled={busy}>Salvar</button>
        </form>
      )}
    </Modal>
  );
}

export default function Agenda() {
  const { me, can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState<'upcoming' | 'today' | 'week' | 'past'>('upcoming');
  const [mine, setMine] = useState(false);
  const [edit, setEdit] = useState<ApptDraft | null>(null);
  const [settings, setSettings] = useState(false);
  const [excluir, setExcluir] = useState<{ id: string; title: string } | null>(null);
  const { busy, run } = useAction();
  const path = useMemo(() => {
    const day = (n: number) => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const r = { upcoming: [day(0), day(90)], today: [day(0), day(0)], week: [day(0), day(7)], past: [day(-60), day(0)] }[range];
    return `/agenda?from=${r[0]}&to=${r[1]}${mine ? '&mine=1' : ''}`;
  }, [range, mine]);
  const state = useApi<any>(path, [path]);
  const agendaSettings = useApi<any>('/agenda/settings', [settings]);
  const handles: string = agendaSettings.data?.aiHandles ?? 'REUNIAO';
  useEffect(() => {
    const g = params.get('google');
    if (!g) return;
    toast(g === 'ok' ? 'Google Agenda conectado!' : `Não foi possível conectar o Google Agenda: ${params.get('msg') ?? 'erro'}`, g === 'ok' ? undefined : 'err');
    setParams({}, { replace: true });
  }, []);
  const act = (id: string, body: any, msg: string) => run(() => patch(`/agenda/${id}`, body), msg).then(state.reload);
  return (
    <>
      <div className="page-head">
        <div><h1>Agenda</h1><p className="muted">Reuniões e tarefas que vão direto para a agenda do celular — sua, da equipe e do cliente{handles !== 'REUNIAO' ? ' — e os pedidos que a IA registra no WhatsApp' : ''}.</p>
          {agendaSettings.data && <span className="small muted">IA atende: <strong>{HANDLES.find(([k]) => k === handles)?.[1]}</strong></span>}</div>
        <div className="row">
          {can('OWNER', 'ADMIN') && <button className="btn" onClick={() => setSettings(true)}>Configurações</button>}
          <button className="btn" onClick={() => setEdit(newDraft({ kind: 'TASK', assignedUserId: me?.user.id ?? null }))}>+ Tarefa</button>
          <button className="btn primary" onClick={() => setEdit(newDraft({ assignedUserId: me?.user.id ?? null }))}>+ Reunião</button>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}>
        <div className="card">
          <div className="row between" style={{ marginBottom: 8 }}>
            <div className="tabs" style={{ marginBottom: 0, borderBottom: 0 }}>
              {([['upcoming', 'Próximos'], ['today', 'Hoje'], ['week', '7 dias'], ['past', 'Anteriores']] as const).map(([k, l]) => <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>)}
            </div>
            <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} style={{ width: 'auto' }} /> Só os meus</label>
          </div>
          <Async state={state}>{(d) => {
            const items = (range === 'past' ? [...d.items].reverse() : d.items) as any[];
            if (!items.length) return <Empty title="Nada agendado">Crie uma reunião ou tarefa — ou ligue em Configurações a opção para a IA agendar sozinha no WhatsApp.</Empty>;
            const groups: Record<string, any[]> = {};
            for (const a of items) (groups[a.localStart.slice(0, 10)] ??= []).push(a);
            return (
              <div className="stack">
                {Object.entries(groups).map(([day, list]) => (
                  <div key={day}>
                    <div className="small muted" style={{ fontWeight: 700, margin: '6px 0' }}>{dayLabel(day)}</div>
                    <div className="stack" style={{ gap: 8 }}>
                      {list.map((a) => (
                        <div key={a.id} className="kcard" style={{ opacity: a.status === 'CANCELLED' ? 0.6 : 1 }}>
                          <div className="row between">
                            <span className="row"><strong style={{ fontSize: 15 }}>{a.localStart.slice(11)}</strong><span className="badge">{KIND[a.kind]}</span>{a.intent && a.intent !== 'REUNIAO' && <span className={`badge ${INTENT[a.intent]?.[1] ?? ''}`} title="Classificação da conversa pela IA">{INTENT[a.intent]?.[0]}</span>}<strong style={{ textDecoration: a.status === 'CANCELLED' ? 'line-through' : undefined }}>{a.title}</strong></span>
                            <span className={`badge ${STATUS[a.status][1]}`}>{STATUS[a.status][0]}</span>
                          </div>
                          <div className="small muted" style={{ marginTop: 4 }}>
                            {a.durationMin} min{a.contact ? ` · ${a.contact.name ?? a.contact.phone}` : ''}{a.extraContacts?.length ? ` · +${a.extraContacts.length} contato(s)` : ''}{a.assignedUser ? ` · Resp.: ${a.assignedUser.name}` : ''}{a.location ? ` · ${a.location}` : ''} · {SOURCE[a.source]}{a.googleSynced ? ' · Google ✓' : ''}{a.channel ? <> · <span title="WhatsApp pelo qual foi marcado">📲 Via: {a.channel.via}</span></> : null}
                          </div>
                          {a.meetLink && a.status !== 'CANCELLED' && (
                            <div className="row small" style={{ marginTop: 4 }}>
                              🎥 <a href={a.meetLink} target="_blank" rel="noreferrer">{a.meetLink.replace(/^https:\/\//, '')}</a>
                              <button className="btn sm ghost" onClick={() => copy(a.meetLink, toast)}>Copiar link do Meet</button>
                            </div>
                          )}
                          <div className="row" style={{ marginTop: 6 }}>
                            <a className="btn sm" href={a.links.google} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Google Agenda</a>
                            <a className="btn sm" href={a.links.ics} style={{ textDecoration: 'none' }}>iPhone (.ics)</a>
                            {a.status === 'SCHEDULED' && <>
                              <button className="btn sm" onClick={() => setEdit({ id: a.id, kind: a.kind, title: a.title, start: a.localStart, durationMin: a.durationMin, reminderMin: a.reminderMin, contactId: a.contactId, contactLabel: undefined, assignedUserId: a.assignedUserId, location: a.location ?? '', description: a.description ?? '', notifyContact: a.notifyContact, notifyAssignee: a.notifyAssignee, notifyExtras: a.notifyExtras, notifyOwner: a.notifyOwner, teamPhones: (a.teamContacts ?? []).map((c: any) => c.phone), extraContacts: (a.extraContacts ?? []).map((c: any) => ({ name: c.name ?? '', phone: c.phone })) })}>Editar</button>
                              <button className="btn sm" disabled={busy} onClick={() => act(a.id, { status: 'DONE' }, 'Marcado como concluído')}>Concluir</button>
                              {((a.contact && a.notifyContact) || a.notifyOwner || a.teamContacts?.length > 0 || (a.assignedUserId && a.notifyAssignee) || (a.notifyExtras && a.extraContacts?.length > 0)) && <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/agenda/${a.id}/send`)).then((r) => r && toast(r.ok ? `Aviso reenviado (${r.sent}/${r.total})` : `Enviado ${r.sent}/${r.total}. Falhas: ${r.error ?? r.status}`, r.ok ? undefined : 'err'))}>Reenviar aviso</button>}
                              <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm('Cancelar este compromisso? O contato é avisado e ele some das agendas.')) act(a.id, { status: 'CANCELLED' }, 'Compromisso cancelado'); }}>Cancelar</button>
                            </>}
                            {a.status !== 'SCHEDULED' && <button className="btn sm" disabled={busy} onClick={() => act(a.id, { status: 'SCHEDULED' }, 'Compromisso reaberto')}>Reabrir</button>}
                            {can('OWNER', 'ADMIN') && a.status === 'CANCELLED' && <button className="btn sm ghost" disabled={busy} onClick={() => setExcluir({ id: a.id, title: a.title })}>Excluir</button>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          }}</Async>
        </div>
        <div className="stack" style={{ alignItems: 'stretch' }}>
          <OrdersCard handles={handles} />
          <SyncCard />
        </div>
      </div>
      {edit && <AppointmentModal draft={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); state.reload(); }} />}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
      {excluir && <SenhaExclusaoModal title="Excluir compromisso cancelado" onClose={() => setExcluir(null)}
        onConfirm={async (senha) => { await api(`/agenda/${excluir.id}`, { method: 'DELETE', body: { senha } }); setExcluir(null); toast('Compromisso excluído'); state.reload(); }}>
        <p style={{ margin: 0 }}>Excluir de vez o compromisso <strong>{excluir.title}</strong>?</p>
      </SenhaExclusaoModal>}
    </>
  );
}
