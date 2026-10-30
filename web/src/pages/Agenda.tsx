import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, patch, put, del, ApiError } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, useToast, copy } from '../ui';

const KIND: Record<string, string> = { MEETING: 'Reunião', TASK: 'Tarefa' };
const STATUS: Record<string, [string, string]> = { SCHEDULED: ['Agendado', 'blue'], DONE: ['Concluído', 'green'], CANCELLED: ['Cancelado', 'red'] };
const SOURCE: Record<string, string> = { MANUAL: 'Manual', AI: 'IA no WhatsApp', KANBAN: 'Kanban' };
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
}
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
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    if (draft.contactLabel) return;
    const t = setTimeout(() => { get(`/contacts?q=${encodeURIComponent(q)}`).then((r) => setContacts(r.items ?? [])).catch(() => undefined); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const save = async (force = false) => {
    const body: any = { kind: d.kind, title: d.title, start: d.start, durationMin: d.durationMin, reminderMin: d.reminderMin, contactId: d.contactId, assignedUserId: d.assignedUserId, location: d.location || null, description: d.description || null, notifyContact: d.notifyContact, force };
    if (!d.id && d.source) body.source = d.source;
    try {
      await (d.id ? patch(`/agenda/${d.id}`, body) : post('/agenda', body));
      toast(d.id ? 'Compromisso atualizado' : d.contactId && d.notifyContact ? 'Agendado! O contato recebeu o link para a agenda do celular.' : 'Agendado!');
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
        <Field label="Observações (opcional)"><textarea rows={2} maxLength={2000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
        {d.contactId && <label className="row small"><input type="checkbox" checked={d.notifyContact} onChange={(e) => setD({ ...d, notifyContact: e.target.checked })} style={{ width: 'auto' }} /> Avisar o contato pelo WhatsApp (link "Adicionar à agenda" + lembrete)</label>}
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
          const { timezone: _tz, ...body } = s;
          if (await run(() => put('/agenda/settings', body), 'Configurações salvas')) onClose();
        }}>
          <label className="row"><input type="checkbox" checked={s.aiBooking} onChange={(e) => setS({ ...s, aiBooking: e.target.checked })} style={{ width: 'auto' }} /> <strong>A IA pode agendar reuniões no WhatsApp</strong></label>
          <span className="small muted">A IA oferece só horários livres (sem conflito com a agenda e com o Google Agenda conectado) e, quando o cliente confirma, cria a reunião e envia o link para a agenda do celular. Requer a IA automática ligada.</span>
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
          <label className="row small"><input type="checkbox" checked={s.notifyContact} onChange={(e) => setS({ ...s, notifyContact: e.target.checked })} style={{ width: 'auto' }} /> Avisar o contato pelo WhatsApp por padrão</label>
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
  const { busy, run } = useAction();
  const path = useMemo(() => {
    const day = (n: number) => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const r = { upcoming: [day(0), day(90)], today: [day(0), day(0)], week: [day(0), day(7)], past: [day(-60), day(0)] }[range];
    return `/agenda?from=${r[0]}&to=${r[1]}${mine ? '&mine=1' : ''}`;
  }, [range, mine]);
  const state = useApi<any>(path, [path]);
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
        <div><h1>Agenda</h1><p className="muted">Reuniões e tarefas que vão direto para a agenda do celular — sua, da equipe e do cliente.</p></div>
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
                            <span className="row"><strong style={{ fontSize: 15 }}>{a.localStart.slice(11)}</strong><span className="badge">{KIND[a.kind]}</span><strong style={{ textDecoration: a.status === 'CANCELLED' ? 'line-through' : undefined }}>{a.title}</strong></span>
                            <span className={`badge ${STATUS[a.status][1]}`}>{STATUS[a.status][0]}</span>
                          </div>
                          <div className="small muted" style={{ marginTop: 4 }}>
                            {a.durationMin} min{a.contact ? ` · ${a.contact.name ?? a.contact.phone}` : ''}{a.assignedUser ? ` · Resp.: ${a.assignedUser.name}` : ''}{a.location ? ` · ${a.location}` : ''} · {SOURCE[a.source]}{a.googleSynced ? ' · Google ✓' : ''}
                          </div>
                          <div className="row" style={{ marginTop: 6 }}>
                            <a className="btn sm" href={a.links.google} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Google Agenda</a>
                            <a className="btn sm" href={a.links.ics} style={{ textDecoration: 'none' }}>iPhone (.ics)</a>
                            {a.status === 'SCHEDULED' && <>
                              <button className="btn sm" onClick={() => setEdit({ id: a.id, kind: a.kind, title: a.title, start: a.localStart, durationMin: a.durationMin, reminderMin: a.reminderMin, contactId: a.contactId, contactLabel: undefined, assignedUserId: a.assignedUserId, location: a.location ?? '', description: a.description ?? '', notifyContact: a.notifyContact })}>Editar</button>
                              <button className="btn sm" disabled={busy} onClick={() => act(a.id, { status: 'DONE' }, 'Marcado como concluído')}>Concluir</button>
                              {a.contact && <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/agenda/${a.id}/send`)).then((r) => r && toast(r.ok ? 'Link enviado ao contato' : `Não enviado: ${r.error ?? r.status}`, r.ok ? undefined : 'err'))}>Reenviar ao contato</button>}
                              <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm('Cancelar este compromisso? O contato é avisado e ele some das agendas.')) act(a.id, { status: 'CANCELLED' }, 'Compromisso cancelado'); }}>Cancelar</button>
                            </>}
                            {a.status !== 'SCHEDULED' && <button className="btn sm" disabled={busy} onClick={() => act(a.id, { status: 'SCHEDULED' }, 'Compromisso reaberto')}>Reabrir</button>}
                            {can('OWNER', 'ADMIN') && a.status !== 'SCHEDULED' && <button className="btn sm ghost" disabled={busy} onClick={() => { if (confirm('Excluir de vez?')) run(() => del(`/agenda/${a.id}`), 'Excluído').then(state.reload); }}>Excluir</button>}
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
        <SyncCard />
      </div>
      {edit && <AppointmentModal draft={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); state.reload(); }} />}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </>
  );
}
