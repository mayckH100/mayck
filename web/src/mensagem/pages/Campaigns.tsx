import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { post, patch, del, get } from '../../api';
import { useApi, Async, Empty, Field, Modal, useAction, useToast, fmtDate, fmtNum } from '../../ui';
import { MetricsView } from './Dashboard';
import { AddContactsModal } from './LeadBulk';
import {
  CampaignBadge, LEAD_STATUS_LABEL, SAFE_DEFAULTS, campaignProgress, downloadCsv, fetchAllLeads, fmtPhone, personalize, slug,
  type Campaign, type ChannelLite, type Metrics,
} from '../common';

const MCKBOT_CHANNELS = '/canais';

function ChannelSelect({ value, onChange, channels }: { value: string; onChange: (v: string) => void; channels: ChannelLite[] }) {
  return (
    <select required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>Selecione o número…</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>{c.name}{c.displayPhone ? ` (${c.displayPhone})` : ''}{c.status === 'CONNECTED' ? ' — conectado' : ' — desconectado'}</option>
      ))}
    </select>
  );
}

type Form = { name: string; message: string; channelId: string; dailyLimit: number; minIntervalSec: number; maxIntervalSec: number; windowStart: string; windowEnd: string };

function CampaignForm({ initial, onClose, onSaved }: { initial?: Campaign; onClose: () => void; onSaved: (c: Campaign) => void }) {
  const channels = useApi<ChannelLite[]>('/channels');
  const connected = (channels.data ?? []).filter((c) => c.status === 'CONNECTED');
  const [f, setF] = useState<Form>(() => initial
    ? { name: initial.name, message: initial.message, channelId: initial.channelId, dailyLimit: initial.dailyLimit, minIntervalSec: initial.minIntervalSec, maxIntervalSec: initial.maxIntervalSec, windowStart: initial.windowStart, windowEnd: initial.windowEnd }
    : { name: '', message: 'Olá {nome}! ', channelId: '', ...SAFE_DEFAULTS });
  const [previewName, setPreviewName] = useState('Ana Souza');
  const { busy, run } = useAction();
  // Um único número conectado: já vem selecionado.
  useEffect(() => { if (!initial && connected.length === 1) setF((x) => (x.channelId ? x : { ...x, channelId: connected[0].id })); }, [channels.data]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const sel = channels.data?.find((c) => c.id === f.channelId);
  const risky = f.dailyLimit > 200 || f.minIntervalSec < 30;
  const intervalErr = f.minIntervalSec > f.maxIntervalSec;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, dailyLimit: Number(f.dailyLimit), minIntervalSec: Number(f.minIntervalSec), maxIntervalSec: Number(f.maxIntervalSec) };
    const r = await run(() => (initial ? patch<Campaign>(`/mckmensagem/campaigns/${initial.id}`, body) : post<Campaign>('/mckmensagem/campaigns', body)), initial ? 'Campanha atualizada' : 'Campanha criada');
    if (r) onSaved(r);
  };
  return (
    <Modal title={initial ? 'Editar campanha' : 'Nova campanha'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Nome da campanha"><input required maxLength={120} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Black Friday clientes VIP" /></Field>
        <Field label="Número de WhatsApp (canal)">
          {channels.data && channels.data.length === 0
            ? <div className="alert warn">Nenhum número de WhatsApp cadastrado. <a href={MCKBOT_CHANNELS}>Conecte um número no MCKBOT ↗</a></div>
            : <ChannelSelect value={f.channelId} onChange={(v) => set('channelId', v)} channels={channels.data ?? []} />}
        </Field>
        {sel && sel.status !== 'CONNECTED' && <div className="alert warn">Este número está desconectado: nada será enviado até reconectá-lo em <a href={MCKBOT_CHANNELS}>Canais do MCKBOT ↗</a>.</div>}
        <Field label="Mensagem" hint="Use {nome} para inserir o primeiro nome do contato. Inclua como sair, ex.: “Responda SAIR para não receber mais”.">
          <textarea required rows={5} maxLength={4000} value={f.message} onChange={(e) => set('message', e.target.value)} />
        </Field>
        <div className="row small"><button type="button" className="btn sm" onClick={() => set('message', f.message + '{nome}')}>+ Inserir {'{nome}'}</button><button type="button" className="btn sm" onClick={() => set('message', f.message.trimEnd() + '\n\nResponda SAIR para não receber mais mensagens.')}>+ Texto de saída</button><span className="muted">{f.message.length}/4000</span></div>
        <div>
          <div className="row between small" style={{ marginBottom: 6 }}>
            <strong>Prévia</strong>
            <label className="row small">Nome de teste: <input style={{ width: 140, padding: '4px 8px' }} value={previewName} onChange={(e) => setPreviewName(e.target.value)} placeholder="(sem nome)" /></label>
          </div>
          <div className="mm-preview"><div className="b">{personalize(f.message, previewName) || <span className="muted">Sua mensagem aparece aqui</span>}<div className="t">{f.windowStart} ✓✓</div></div></div>
        </div>
        <h3 style={{ margin: '4px 0 0' }}>Limites de envio</h3>
        <div className="grid g3" style={{ gap: 10 }}>
          <Field label="Limite por dia"><input type="number" min={1} max={1000} required value={f.dailyLimit} onChange={(e) => set('dailyLimit', Number(e.target.value))} /></Field>
          <Field label="Intervalo mínimo (s)"><input type="number" min={10} max={3600} required value={f.minIntervalSec} onChange={(e) => set('minIntervalSec', Number(e.target.value))} /></Field>
          <Field label="Intervalo máximo (s)"><input type="number" min={10} max={7200} required value={f.maxIntervalSec} onChange={(e) => set('maxIntervalSec', Number(e.target.value))} /></Field>
        </div>
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label="Enviar a partir de"><input type="time" required value={f.windowStart} onChange={(e) => set('windowStart', e.target.value)} /></Field>
          <Field label="Até (horário de Brasília)"><input type="time" required value={f.windowEnd} onChange={(e) => set('windowEnd', e.target.value)} /></Field>
        </div>
        {intervalErr && <div className="alert err">O intervalo mínimo não pode ser maior que o máximo.</div>}
        <div className={`alert ${risky ? 'warn' : 'info'}`}>
          <strong>Boas práticas:</strong> envie só para quem autorizou, comece devagar (até {SAFE_DEFAULTS.dailyLimit}/dia em números novos), mantenha intervalos de {SAFE_DEFAULTS.minIntervalSec}–{SAFE_DEFAULTS.maxIntervalSec}s, respeite o horário comercial e ofereça sempre a opção de sair. Envios em massa sem consentimento podem bloquear o número.
          {risky && <div style={{ marginTop: 4 }}>⚠ Os limites escolhidos estão acima do recomendado.</div>}
          {JSON.stringify({ d: f.dailyLimit, a: f.minIntervalSec, b: f.maxIntervalSec, s: f.windowStart, e: f.windowEnd }) !== JSON.stringify({ d: SAFE_DEFAULTS.dailyLimit, a: SAFE_DEFAULTS.minIntervalSec, b: SAFE_DEFAULTS.maxIntervalSec, s: SAFE_DEFAULTS.windowStart, e: SAFE_DEFAULTS.windowEnd }) && (
            <div style={{ marginTop: 4 }}><button type="button" className="btn sm" onClick={() => setF({ ...f, ...SAFE_DEFAULTS })}>Usar padrões seguros</button></div>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || intervalErr || !f.channelId}>{busy ? 'Salvando…' : initial ? 'Salvar alterações' : 'Criar campanha'}</button>
        </div>
      </form>
    </Modal>
  );
}

function StartModal({ c, onClose, onDone }: { c: Campaign; onClose: () => void; onDone: (c: Campaign) => void }) {
  const [mode, setMode] = useState<'linked' | 'tag'>('linked');
  const [tag, setTag] = useState('');
  const { busy, run } = useAction();
  const p = campaignProgress(c);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => post<Campaign & { added: number; pending: number }>(`/mckmensagem/campaigns/${c.id}/start`, mode === 'tag' ? { tag: tag.trim() } : {}));
    if (r) onDone(r);
  };
  return (
    <Modal title={c.status === 'PAUSADA' ? 'Retomar campanha' : 'Iniciar campanha'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ margin: 0 }}>Quem vai receber “{c.name}”? Só entram contatos com consentimento e sem opt-out; quem já está na fila não é duplicado.</p>
        <label className="mm-check" style={{ background: mode === 'linked' ? undefined : '#fff' }}><input type="radio" checked={mode === 'linked'} onChange={() => setMode('linked')} /><span>Contatos vinculados a esta campanha{p.pending ? <span className="small muted" style={{ fontWeight: 400 }}><br />{fmtNum(p.pending)} já na fila</span> : null}</span></label>
        <label className="mm-check" style={{ background: mode === 'tag' ? undefined : '#fff' }}><input type="radio" checked={mode === 'tag'} onChange={() => setMode('tag')} /><span>Contatos com a etiqueta…</span></label>
        {mode === 'tag' && <Field label="Etiqueta"><input required value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Ex.: vip" /></Field>}
        <div className="alert info small">Os envios respeitam o limite de {fmtNum(c.dailyLimit)}/dia, intervalos de {c.minIntervalSec}–{c.maxIntervalSec}s e a janela das {c.windowStart} às {c.windowEnd}. Você pode pausar a qualquer momento.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Iniciando…' : c.status === 'PAUSADA' ? 'Retomar envios' : 'Iniciar envios'}</button>
        </div>
      </form>
    </Modal>
  );
}

function useCampaignActions(reload: () => void) {
  const { run } = useAction();
  const toast = useToast();
  const [starting, setStarting] = useState<Campaign | null>(null);
  const pause = async (c: Campaign) => { if (await run(() => post(`/mckmensagem/campaigns/${c.id}/pause`), 'Campanha pausada')) reload(); };
  const remove = async (c: Campaign, after?: () => void) => {
    if (!confirm(`Excluir a campanha “${c.name}”? A fila e o histórico de envios dela serão apagados (os contatos continuam na base).`)) return;
    if (await run(() => del(`/mckmensagem/campaigns/${c.id}`), 'Campanha excluída')) { reload(); after?.(); }
  };
  const exportReport = async (c: Campaign) => {
    try {
      const [m, leads] = await Promise.all([get<Metrics>(`/mckmensagem/metrics?campaignId=${c.id}`), fetchAllLeads({ campaignId: c.id })]);
      const p = campaignProgress(c);
      downloadCsv(`campanha-${slug(c.name)}.csv`, [
        ['campanha', c.name], ['status', c.status], ['enviadas', p.sent], ['falhas', p.failed], ['ignoradas', p.skipped], ['na_fila', p.pending],
        ['respostas', m.replies], ['taxa_resposta_%', m.responseRate], ['taxa_conversao_%', m.conversionRate], ['opt_outs', m.optOuts], [],
        ['telefone', 'nome', 'status', 'etiquetas', 'opt_out', 'consentimento', 'origem_consentimento'],
        ...leads.map((l) => [l.phone, l.name ?? '', LEAD_STATUS_LABEL[l.status] ?? l.status, l.tags.join('|'), l.optOutAt ? 'sim' : 'não', l.consentAt ?? '', l.consentSource]),
      ]);
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  return { starting, setStarting, pause, remove, exportReport };
}

function Actions({ c, a, onEdit, compact }: { c: Campaign; a: ReturnType<typeof useCampaignActions>; onEdit: () => void; compact?: boolean }) {
  const running = c.status === 'EM_ANDAMENTO' || c.status === 'AGENDADA';
  return (
    <div className="row">
      {running
        ? <button className="btn sm" onClick={() => a.pause(c)}>❚❚ Pausar</button>
        : <button className="btn sm primary" onClick={() => a.setStarting(c)}>▶ {c.status === 'PAUSADA' ? 'Retomar' : c.status === 'CONCLUIDA' ? 'Reenviar' : 'Iniciar'}</button>}
      <button className="btn sm" onClick={onEdit}>Editar</button>
      {!compact && <button className="btn sm" onClick={() => a.exportReport(c)}>Exportar</button>}
    </div>
  );
}

function Progress({ c }: { c: Campaign }) {
  const p = campaignProgress(c);
  return (
    <div>
      <div className="bar"><span style={{ width: `${p.pct}%` }} /></div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {p.total ? <>{fmtNum(p.sent)} enviadas · {fmtNum(p.pending)} na fila{p.failed ? ` · ${fmtNum(p.failed)} falhas` : ''}{p.skipped ? ` · ${fmtNum(p.skipped)} ignoradas` : ''} · {p.pct}%</> : 'Ainda sem destinatários'}
      </div>
    </div>
  );
}

function CampaignDetail({ id, list, reload }: { id: string; list: Campaign[]; reload: () => void }) {
  const nav = useNavigate();
  const c = list.find((x) => x.id === id);
  const metrics = useApi<Metrics>(c ? `/mckmensagem/metrics?campaignId=${id}` : null, [c?.updatedAt, c?.status]);
  const leads = useApi<{ items: any[]; total: number }>(c ? `/mckmensagem/leads?campaignId=${id}` : null, [c?.updatedAt]);
  const channels = useApi<ChannelLite[]>('/channels');
  const a = useCampaignActions(reload);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!c) return <Empty title="Campanha não encontrada"><NavLink to="/campanhas">Voltar para campanhas</NavLink></Empty>;
  const ch = channels.data?.find((x) => x.id === c.channelId);
  return (
    <>
      <div className="page-head">
        <div>
          <NavLink to="/campanhas" className="small">← Campanhas</NavLink>
          <h1 className="row">{c.name} <CampaignBadge status={c.status} /></h1>
          <p className="muted small">Criada em {fmtDate(c.createdAt)} · {ch ? <>{ch.name}{ch.status !== 'CONNECTED' && <span className="badge red" style={{ marginLeft: 6 }}>desconectado</span>}</> : 'canal —'}</p>
        </div>
        <div className="row">
          <Actions c={c} a={a} onEdit={() => setEditing(true)} />
          <button className="btn sm danger" onClick={() => a.remove(c, () => nav('/campanhas'))}>Excluir</button>
        </div>
      </div>
      <div className="stack">
        <div className="card stack"><h2 style={{ margin: 0 }}>Progresso</h2><Progress c={c} /></div>
        <Async state={metrics}>{(m) => <MetricsView m={m} />}</Async>
        <div className="grid g2">
          <div className="card">
            <h2>Mensagem</h2>
            <div className="mm-preview"><div className="b">{personalize(c.message, 'Ana')}</div></div>
            <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>Limite {fmtNum(c.dailyLimit)}/dia · intervalo {c.minIntervalSec}–{c.maxIntervalSec}s · das {c.windowStart} às {c.windowEnd} (Brasília)</p>
          </div>
          <div className="card">
            <div className="row between"><h2 style={{ margin: 0 }}>Contatos vinculados{leads.data ? ` (${fmtNum(leads.data.total)})` : ''}</h2><span className="row"><button className="btn sm primary" onClick={() => setAdding(true)}>+ Adicionar contatos</button><NavLink to={`/contatos?campaignId=${c.id}`} className="small">Ver todos / remover →</NavLink></span></div>
            <Async state={leads}>{(d) => d.items.length === 0
              ? <p className="muted small" style={{ marginTop: 8 }}>Nenhum contato vinculado. Use “Adicionar contatos” para escolher vários de uma vez (com busca, etiqueta e status), ou inicie por etiqueta.</p>
              : (
                <table style={{ marginTop: 8 }}><tbody>
                  {d.items.slice(0, 8).map((l) => <tr key={l.id}><td>{l.name || '—'}<div className="small muted">{fmtPhone(l.phone)}</div></td><td style={{ textAlign: 'right' }}><span className="badge">{LEAD_STATUS_LABEL[l.status as keyof typeof LEAD_STATUS_LABEL]}</span></td></tr>)}
                </tbody></table>
              )}</Async>
          </div>
        </div>
      </div>
      {editing && <CampaignForm initial={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {a.starting && <StartModal c={a.starting} onClose={() => a.setStarting(null)} onDone={() => { a.setStarting(null); reload(); }} />}
      {adding && <AddContactsModal c={c} onClose={() => setAdding(false)} onDone={() => { setAdding(false); leads.reload(); metrics.reload(); reload(); }} />}
    </>
  );
}

export default function MmCampaigns() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const state = useApi<Campaign[]>('/mckmensagem/campaigns');
  const a = useCampaignActions(state.reload);
  const [editing, setEditing] = useState<Campaign | 'new' | null>(sp.get('nova') ? 'new' : null);
  const closeForm = () => { setEditing(null); if (sp.get('nova')) setSp(new URLSearchParams(), { replace: true }); };

  if (id) return <Async state={state}>{(list) => <CampaignDetail id={id} list={list} reload={state.reload} />}</Async>;
  return (
    <>
      <div className="page-head">
        <div><h1>Campanhas</h1><p className="muted">Disparos personalizados com limites seguros, janela de horário e opt-out automático.</p></div>
        <button className="btn primary" onClick={() => setEditing('new')}>+ Nova campanha</button>
      </div>
      <Async state={state}>{(list) => list.length === 0 ? (
        <div className="card"><Empty title="Nenhuma campanha ainda">Crie a primeira campanha, escreva a mensagem com {'{nome}'} e escolha o número de WhatsApp.<div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => setEditing('new')}>Criar campanha</button></div></Empty></div>
      ) : (
        <div className="grid g2">
          {list.map((c) => (
            <div key={c.id} className="card mm-camp">
              <div className="head">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <NavLink to={`/campanhas/${c.id}`} style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</NavLink>
                  <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{c.message}</div>
                </div>
                <CampaignBadge status={c.status} />
              </div>
              <Progress c={c} />
              <div className="row between">
                <Actions c={c} a={a} onEdit={() => setEditing(c)} compact />
                <div className="row">
                  <button className="btn sm ghost" onClick={() => a.exportReport(c)}>Exportar</button>
                  <button className="btn sm ghost" onClick={() => nav(`/campanhas/${c.id}`)}>Métricas →</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}</Async>
      {editing && <CampaignForm initial={editing === 'new' ? undefined : editing} onClose={closeForm} onSaved={(c) => { closeForm(); state.reload(); if (editing === 'new') nav(`/campanhas/${c.id}`); }} />}
      {a.starting && <StartModal c={a.starting} onClose={() => a.setStarting(null)} onDone={() => { a.setStarting(null); state.reload(); }} />}
    </>
  );
}
