import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post, patch, del } from '../../api';
import { useApi, Async, Empty, Field, Modal, useAction, fmtDate, fmtNum } from '../../ui';
import {
  CONSENT_LABEL, CONSENT_SOURCES, LEAD_STATUS, LEAD_STATUS_LABEL, LeadBadge, fmtPhone,
  type Campaign, type ConsentSource, type Lead, type LeadPage, type LeadStatus,
} from '../common';
import { useLeadSelection, SelectAllBanner, BulkBar, type LeadFilter } from './LeadBulk';

const parseTags = (s: string) => [...new Set(s.split(/[,|]/).map((t) => t.trim()).filter(Boolean))].slice(0, 30);

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function CampaignSelect({ value, onChange, campaigns, empty = 'Sem campanha', withNone = false }: { value: string; onChange: (v: string) => void; campaigns: Campaign[]; empty?: string; withNone?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {withNone && <option value="none">Sem campanha</option>}
      {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

function NewLead({ campaigns, onClose, onDone }: { campaigns: Campaign[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ phone: '', name: '', tags: '', consentSource: '' as ConsentSource | '', campaignId: '' });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => post('/mckmensagem/leads', {
      phone: f.phone, name: f.name || null, tags: parseTags(f.tags), consentSource: f.consentSource, campaignId: f.campaignId || null,
    }), 'Contato adicionado');
    if (r) { onDone(); onClose(); }
  };
  return (
    <Modal title="Novo contato" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="WhatsApp" hint="Com DDD. Números do Brasil sem +55 recebem o DDI automaticamente."><input required inputMode="tel" placeholder="(11) 99999-8888" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Opcional — usado no {nome}" /></Field>
        <Field label="Origem do consentimento *" hint="Como este contato autorizou receber suas mensagens. Obrigatório.">
          <select required value={f.consentSource} onChange={(e) => setF({ ...f, consentSource: e.target.value as ConsentSource })}>
            <option value="" disabled>Selecione…</option>
            {CONSENT_SOURCES.map((s) => <option key={s} value={s}>{CONSENT_LABEL[s]}</option>)}
          </select>
        </Field>
        <Field label="Etiquetas" hint="Separe por vírgula. Ex.: vip, black-friday"><input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        <Field label="Campanha"><CampaignSelect value={f.campaignId} onChange={(v) => setF({ ...f, campaignId: v })} campaigns={campaigns} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !f.consentSource}>{busy ? 'Salvando…' : 'Adicionar contato'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportLeads({ campaigns, onClose, onDone }: { campaigns: Campaign[]; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [declared, setDeclared] = useState(false);
  const [consentSource, setConsentSource] = useState<ConsentSource>('IMPORTACAO');
  const [campaignId, setCampaignId] = useState('');
  const [tags, setTags] = useState('');
  const [result, setResult] = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  const { busy, run } = useAction();
  const onFile = async (file?: File) => { if (file) setText(await file.text()); };
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => post<{ created: number; updated: number; errors: string[] }>('/mckmensagem/leads/import', {
      text, consentDeclared: declared, consentSource, campaignId: campaignId || null, tags: parseTags(tags),
    }));
    if (r) { setResult(r); onDone(); }
  };
  return (
    <Modal title="Importar contatos (CSV)" onClose={onClose}>
      {result ? (
        <div className="stack">
          <div className="alert ok">Importação concluída: <strong>{fmtNum(result.created)}</strong> novo(s) e <strong>{fmtNum(result.updated)}</strong> atualizado(s).</div>
          {result.errors.length > 0 && (
            <div className="alert warn">
              <strong>{result.errors.length} linha(s) ignorada(s):</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 160, overflow: 'auto' }}>{result.errors.map((er) => <li key={er}>{er}</li>)}</ul>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Fechar</button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="small muted" style={{ margin: 0 }}>Colunas: <span className="mono">telefone,nome,etiquetas</span> (etiquetas separadas por <span className="mono">|</span>). Aceita vírgula ou ponto e vírgula. Até 10.000 linhas.</p>
          <Field label="Arquivo CSV"><input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} /></Field>
          <Field label="…ou cole o conteúdo" hint={lines ? `${fmtNum(lines)} linha(s)` : undefined}>
            <textarea rows={6} className="mono" placeholder={'phone,name,tags\n11999998888,Ana Souza,vip|sp'} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="grid g2" style={{ gap: 10 }}>
            <Field label="Origem do consentimento">
              <select value={consentSource} onChange={(e) => setConsentSource(e.target.value as ConsentSource)}>
                {CONSENT_SOURCES.map((s) => <option key={s} value={s}>{CONSENT_LABEL[s]}</option>)}
              </select>
            </Field>
            <Field label="Vincular à campanha"><CampaignSelect value={campaignId} onChange={setCampaignId} campaigns={campaigns} /></Field>
          </div>
          <Field label="Etiquetas extras para todos" hint="Opcional, separadas por vírgula"><input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
          <label className="mm-check">
            <input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} required />
            <span>Declaro que todos os contatos autorizaram receber mensagens.<br /><span className="small muted" style={{ fontWeight: 400 }}>Enviar para quem não autorizou viola as regras do WhatsApp e a LGPD e pode bloquear o seu número.</span></span>
          </label>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={busy || !declared || !text.trim()}>{busy ? 'Importando…' : 'Importar'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EditLead({ lead, campaigns, onClose, onDone }: { lead: Lead; campaigns: Campaign[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: lead.name ?? '', tags: lead.tags.join(', '), status: lead.status, campaignId: lead.campaignId ?? '', optOut: !!lead.optOutAt });
  const { busy, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => patch(`/mckmensagem/leads/${lead.id}`, {
      name: f.name || null, tags: parseTags(f.tags), status: f.status, campaignId: f.campaignId || null, optOut: f.optOut,
    }), 'Contato atualizado');
    if (r) { onDone(); onClose(); }
  };
  const remove = async () => {
    if (!confirm(`Excluir o contato ${lead.name ?? fmtPhone(lead.phone)}? O histórico de envios dele também será removido.`)) return;
    const r = await run(() => del(`/mckmensagem/leads/${lead.id}`), 'Contato excluído');
    if (r) { onDone(); onClose(); }
  };
  return (
    <Modal title="Editar contato" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="small muted">
          <strong className="mono" style={{ fontSize: 13 }}>{lead.phone}</strong> · consentimento: {CONSENT_LABEL[lead.consentSource] ?? lead.consentSource} em {fmtDate(lead.consentAt)}
        </div>
        <Field label="Nome"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label="Status">
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as LeadStatus })}>
              {LEAD_STATUS.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
            </select>
          </Field>
          <Field label="Campanha"><CampaignSelect value={f.campaignId} onChange={(v) => setF({ ...f, campaignId: v })} campaigns={campaigns} /></Field>
        </div>
        <Field label="Etiquetas" hint="Separe por vírgula"><input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        <label className="mm-check" style={f.optOut ? { background: 'var(--danger-soft)' } : undefined}>
          <input type="checkbox" checked={f.optOut} onChange={(e) => setF({ ...f, optOut: e.target.checked })} />
          <span>Opt-out: não enviar mais mensagens para este contato<br /><span className="small muted" style={{ fontWeight: 400 }}>Marcado automaticamente quando o contato responde “SAIR”.</span></span>
        </label>
        <div className="row between">
          <button type="button" className="btn danger" onClick={remove} disabled={busy}>Excluir</button>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export default function MmLeads() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q);
  const status = sp.get('status') ?? '';
  const tag = sp.get('tag') ?? '';
  const campaignId = sp.get('campaignId') ?? '';
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const [tagInput, setTagInput] = useState(tag);
  const dTag = useDebounced(tagInput);
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v); else n.delete(k);
    if (k !== 'page') n.delete('page');
    setSp(n, { replace: true });
  };
  useEffect(() => { if (dq !== (sp.get('q') ?? '')) setParam('q', dq); }, [dq]);
  useEffect(() => { if (dTag !== tag) setParam('tag', dTag.trim()); }, [dTag]);

  const params = new URLSearchParams();
  if (sp.get('q')) params.set('q', sp.get('q')!);
  if (status) params.set('status', status);
  if (tag) params.set('tag', tag);
  if (campaignId) params.set('campaignId', campaignId);
  params.set('page', String(page));
  const leads = useApi<LeadPage>(`/mckmensagem/leads?${params}`);
  const camps = useApi<Campaign[]>('/mckmensagem/campaigns');
  const campaigns = camps.data ?? [];
  const campName = (id: string | null) => campaigns.find((c) => c.id === id)?.name;
  const [modal, setModal] = useState<null | 'new' | 'import' | Lead>(null);
  const { run } = useAction();
  const toggleOptOut = async (l: Lead) => {
    const r = await run(() => patch(`/mckmensagem/leads/${l.id}`, { optOut: !l.optOutAt }), l.optOutAt ? 'Opt-out removido' : 'Contato marcado como opt-out');
    if (r) leads.reload();
  };
  const filtered = !!(sp.get('q') || status || tag || campaignId);
  const filter: LeadFilter = { q: sp.get('q') ?? '', status, tag, campaignId };
  const sel = useLeadSelection(JSON.stringify(filter));
  const pageIds = leads.data?.items.map((l) => l.id) ?? [];
  const paginaToda = pageIds.length > 0 && pageIds.every((id) => sel.ids.has(id));

  return (
    <>
      <div className="page-head">
        <div><h1>Contatos</h1><p className="muted">Sua base de leads com consentimento. Só recebe campanhas quem autorizou e não pediu para sair.</p></div>
        <div className="row">
          <a className="btn" href="/api/mckmensagem/leads/export" download>Exportar CSV</a>
          <button className="btn" onClick={() => setModal('import')}>Importar CSV</button>
          <button className="btn primary" onClick={() => setModal('new')}>+ Novo contato</button>
        </div>
      </div>
      <div className="card stack">
        <div className="mm-filters">
          <input type="search" placeholder="Buscar por nome ou telefone…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
          <select value={status} onChange={(e) => setParam('status', e.target.value)} aria-label="Status">
            <option value="">Todos os status</option>
            {LEAD_STATUS.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
          </select>
          <input placeholder="Etiqueta" value={tagInput} onChange={(e) => setTagInput(e.target.value)} aria-label="Etiqueta" />
          <CampaignSelect value={campaignId} onChange={(v) => setParam('campaignId', v)} campaigns={campaigns} empty="Todas as campanhas" withNone />
        </div>
        <BulkBar sel={sel} filter={filter} total={leads.data?.total ?? 0} campaigns={campaigns} onDone={() => { leads.reload(); camps.reload(); }} />
        <Async state={leads}>{(d) => d.items.length === 0 ? (
          <Empty title={filtered ? 'Nenhum contato encontrado' : 'Nenhum contato ainda'}>
            {filtered ? 'Ajuste a busca ou os filtros.' : <>Adicione contatos que autorizaram receber mensagens ou <button className="btn sm" onClick={() => setModal('import')}>importe um CSV</button></>}
          </Empty>
        ) : (
          <>
            <SelectAllBanner sel={sel} pageIds={pageIds} total={d.total} />
            <div className="table-wrap">
              <table>
                <thead><tr><th style={{ width: 32 }}><input type="checkbox" aria-label="Selecionar todos desta página" checked={sel.todos || paginaToda} onChange={(e) => sel.setPage(pageIds, e.target.checked)} style={{ width: 'auto' }} /></th><th>Contato</th><th>Status</th><th className="hide-xs">Etiquetas</th><th className="hide-xs">Campanha</th><th className="hide-xs">Consentimento</th><th></th></tr></thead>
                <tbody>
                  {d.items.map((l) => (
                    <tr key={l.id} className={sel.todos || sel.ids.has(l.id) ? 'mm-row-sel' : undefined}>
                      <td><input type="checkbox" aria-label={`Selecionar ${l.name ?? l.phone}`} checked={sel.todos || sel.ids.has(l.id)} onChange={() => sel.toggle(l.id)} style={{ width: 'auto' }} /></td>
                      <td>
                        <strong>{l.name || '—'}</strong>
                        <div className="small muted">{fmtPhone(l.phone)}</div>
                        {l.optOutAt && <span className="badge red" title={`Desde ${fmtDate(l.optOutAt)}`}>Opt-out</span>}
                      </td>
                      <td><LeadBadge status={l.status} /></td>
                      <td className="hide-xs"><div className="mm-chips">{l.tags.map((t) => <button key={t} className="badge" style={{ border: 0, cursor: 'pointer' }} onClick={() => setTagInput(t)}>{t}</button>)}</div></td>
                      <td className="hide-xs small">{campName(l.campaignId) ?? '—'}</td>
                      <td className="hide-xs small">{CONSENT_LABEL[l.consentSource]?.split(' (')[0] ?? l.consentSource}<div className="muted">{fmtDate(l.consentAt)}</div></td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <button className="btn sm" onClick={() => setModal(l)}>Editar</button>{' '}
                        <button className={`btn sm ${l.optOutAt ? '' : 'danger'}`} onClick={() => toggleOptOut(l)} title={l.optOutAt ? 'Voltar a enviar' : 'Não enviar mais'}>{l.optOutAt ? 'Reativar' : 'Opt-out'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row between small muted">
              <span>{fmtNum(d.total)} contato(s) · página {d.page} de {Math.max(1, Math.ceil(d.total / d.pageSize))}</span>
              <div className="row">
                <button className="btn sm" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>← Anterior</button>
                <button className="btn sm" disabled={page * d.pageSize >= d.total} onClick={() => setParam('page', String(page + 1))}>Próxima →</button>
              </div>
            </div>
          </>
        )}</Async>
      </div>
      {modal === 'new' && <NewLead campaigns={campaigns} onClose={() => setModal(null)} onDone={leads.reload} />}
      {modal === 'import' && <ImportLeads campaigns={campaigns} onClose={() => setModal(null)} onDone={leads.reload} />}
      {modal && typeof modal === 'object' && <EditLead lead={modal} campaigns={campaigns} onClose={() => setModal(null)} onDone={leads.reload} />}
    </>
  );
}
