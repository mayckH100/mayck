import { useEffect, useState } from 'react';
import { post } from '../../api';
import { useApi, Async, Empty, Modal, useAction, fmtNum } from '../../ui';
import { LEAD_STATUS, LEAD_STATUS_LABEL, LeadBadge, fmtPhone, type Campaign, type LeadPage, type LeadStatus } from '../common';

/** Limite por operação em massa (igual ao do servidor). */
export const BULK_MAX = 10_000;

export type LeadFilter = { q?: string; status?: string; tag?: string; campaignId?: string; notCampaignId?: string; optOut?: string };
export interface BulkResult { matched: number; updated: number; queued: number }

const limpa = (f: LeadFilter) => Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as LeadFilter;

/**
 * Seleção de contatos: ids marcados um a um (em qualquer página) ou "todos que atendem ao filtro".
 * Trocar o filtro limpa a seleção para não aplicar uma ação ao conjunto errado.
 */
export function useLeadSelection(filterKey: string) {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [todos, setTodos] = useState(false);
  useEffect(() => { setIds(new Set()); setTodos(false); }, [filterKey]);
  const toggle = (id: string) => { setTodos(false); setIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const setPage = (pageIds: string[], on: boolean) => { setTodos(false); setIds((s) => { const n = new Set(s); for (const id of pageIds) { if (on) n.add(id); else n.delete(id); } return n; }); };
  const clear = () => { setIds(new Set()); setTodos(false); };
  return { ids, todos, setTodos, toggle, setPage, clear };
}
export type LeadSelection = ReturnType<typeof useLeadSelection>;

export function SelectAllBanner({ sel, pageIds, total }: { sel: LeadSelection; pageIds: string[]; total: number }) {
  const paginaToda = pageIds.length > 0 && pageIds.every((id) => sel.ids.has(id));
  if (sel.todos) {
    return (
      <div className="alert info small row between">
        <span>Todos os <strong>{fmtNum(total)}</strong> contatos que atendem ao filtro estão selecionados.{total > BULK_MAX && <> O limite por operação é {fmtNum(BULK_MAX)}: refine os filtros.</>}</span>
        <button className="btn sm" onClick={sel.clear}>Limpar seleção</button>
      </div>
    );
  }
  if (!paginaToda || total <= pageIds.length) return null;
  return (
    <div className="alert info small row between">
      <span>Os {fmtNum(pageIds.length)} contatos desta página estão selecionados.</span>
      <button className="btn sm" onClick={() => sel.setTodos(true)}>Selecionar todos os {fmtNum(total)} que atendem ao filtro</button>
    </div>
  );
}

export async function bulk(sel: LeadSelection, filter: LeadFilter, body: Record<string, unknown>) {
  const alvo = sel.todos ? { filter: limpa(filter) } : { ids: [...sel.ids] };
  return post<BulkResult>('/mckmensagem/leads/bulk', { ...alvo, ...body });
}

/** Limite de ids por requisição de exclusão em massa (igual ao do servidor). */
export const BULK_DELETE_MAX = 500;

/** Exclui contatos por ids, em lotes de até 500. Retorna quantos foram excluídos. */
export async function deleteLeads(ids: string[]) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BULK_DELETE_MAX) {
    const r = await post<{ requested: number; deleted: number }>('/mckmensagem/leads/bulk-delete', { ids: ids.slice(i, i + BULK_DELETE_MAX) });
    deleted += r.deleted;
  }
  return deleted;
}

/** Diálogo de confirmação de exclusão, informando quantos contatos serão excluídos. */
export function ConfirmDeleteLeads({ count, busy, onConfirm, onClose }: { count: number; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={count === 1 ? 'Excluir contato' : `Excluir ${fmtNum(count)} contatos`} onClose={onClose}>
      <div className="stack">
        <p style={{ margin: 0 }}>Tem certeza que deseja excluir definitivamente <strong>{count === 1 ? '1 contato' : `${fmtNum(count)} contatos`}</strong>?</p>
        <p className="small muted" style={{ margin: 0 }}>O histórico de envios de campanhas também será removido. Esta ação não pode ser desfeita.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="button" className="btn danger" onClick={onConfirm} disabled={busy}>{busy ? 'Excluindo…' : `Excluir ${count === 1 ? '1 contato' : `${fmtNum(count)} contatos`}`}</button>
        </div>
      </div>
    </Modal>
  );
}

const parseTags = (s: string) => [...new Set(s.split(/[,|]/).map((t) => t.trim()).filter(Boolean))].slice(0, 30);

/** Barra de ações em massa da lista de contatos. */
export function BulkBar({ sel, filter, total, campaigns, onDone, canDelete = false }: { sel: LeadSelection; filter: LeadFilter; total: number; campaigns: Campaign[]; onDone: () => void; canDelete?: boolean }) {
  const { busy, run } = useAction();
  const [acao, setAcao] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [campaignId, setCampaignId] = useState('');
  const [tags, setTags] = useState('');
  const [status, setStatus] = useState<LeadStatus>('CONTATADO');
  const n = sel.todos ? total : sel.ids.size;
  if (!n) return null;
  const exec = async (body: Record<string, unknown>, okMsg: (r: BulkResult) => string, confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    const r = await run(() => bulk(sel, filter, body));
    if (r) { alert(okMsg(r)); sel.clear(); setAcao(''); onDone(); }
  };
  const camp = campaigns.find((c) => c.id === campaignId);
  const excluir = async () => {
    // Seleção por ids: rota dedicada (lotes de 500). "Todos que atendem ao filtro": ação em massa por filtro.
    const r = await run(async () => sel.todos ? (await bulk(sel, filter, { action: 'delete' })).updated : deleteLeads([...sel.ids]), undefined);
    setConfirmDel(false);
    if (r !== undefined && r !== null) { alert(`${r} contato(s) excluído(s).`); sel.clear(); setAcao(''); onDone(); }
  };
  return (
    <div className="card row" style={{ position: 'sticky', top: 64, zIndex: 5, background: 'var(--brand-soft)', padding: 10 }} role="region" aria-label="Ações em massa">
      <strong className="small">{fmtNum(n)} selecionado(s)</strong>
      <select value={acao} onChange={(e) => setAcao(e.target.value)} style={{ width: 'auto' }} aria-label="Ação em massa">
        <option value="">Escolha uma ação…</option>
        <option value="setCampaign">Vincular a uma campanha</option>
        <option value="removeCampaign">Remover da campanha</option>
        <option value="addTags">Adicionar etiquetas</option>
        <option value="removeTags">Remover etiquetas</option>
        <option value="setStatus">Mudar status</option>
        <option value="optOut">Marcar opt-out (não enviar mais)</option>
        <option value="optIn">Remover opt-out</option>
        {canDelete && <option value="delete">Excluir contatos</option>}
      </select>
      {acao === 'setCampaign' && <>
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={{ width: 'auto' }} aria-label="Campanha"><option value="">Campanha…</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="btn sm primary" disabled={busy || !campaignId} onClick={() => exec({ action: 'setCampaign', campaignId }, (r) => `${r.updated} contato(s) vinculado(s) a “${camp?.name}”.${r.queued ? ` ${r.queued} entraram na fila de envio.` : ''}`)}>Aplicar</button>
        {camp && (camp.status === 'EM_ANDAMENTO' || camp.status === 'PAUSADA') && <span className="small muted">Campanha {camp.status === 'PAUSADA' ? 'pausada' : 'em andamento'}: os elegíveis entram na fila.</span>}
        <span className="small muted">Quem estiver em outra campanha passa para esta.</span>
      </>}
      {acao === 'removeCampaign' && <button className="btn sm primary" disabled={busy} onClick={() => exec({ action: 'removeCampaign', ...(filter.campaignId && filter.campaignId !== 'none' ? { campaignId: filter.campaignId } : {}) }, (r) => `${r.updated} contato(s) removido(s) da campanha. Envios já feitos continuam no histórico.`)}>Remover{filter.campaignId && filter.campaignId !== 'none' ? ' desta campanha' : ' de qualquer campanha'}</button>}
      {(acao === 'addTags' || acao === 'removeTags') && <>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, black-friday" style={{ maxWidth: 220 }} aria-label="Etiquetas" />
        <button className="btn sm primary" disabled={busy || !parseTags(tags).length} onClick={() => exec({ action: acao, tags: parseTags(tags) }, (r) => `${r.updated} contato(s) atualizado(s).`)}>Aplicar</button>
      </>}
      {acao === 'setStatus' && <>
        <select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)} style={{ width: 'auto' }} aria-label="Status">{LEAD_STATUS.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</select>
        <button className="btn sm primary" disabled={busy} onClick={() => exec({ action: 'setStatus', status }, (r) => `${r.updated} contato(s) atualizado(s).`)}>Aplicar</button>
      </>}
      {acao === 'optOut' && <button className="btn sm danger" disabled={busy} onClick={() => exec({ action: 'optOut' }, (r) => `${r.updated} contato(s) marcado(s) como opt-out.`, `Marcar ${n} contato(s) como opt-out? Eles deixam de receber campanhas.`)}>Aplicar</button>}
      {acao === 'optIn' && <button className="btn sm primary" disabled={busy} onClick={() => exec({ action: 'optIn' }, (r) => `${r.updated} contato(s) reativado(s).`, `Remover o opt-out de ${n} contato(s)? Só faça isso se eles pediram para voltar a receber.`)}>Aplicar</button>}
      {canDelete && acao === 'delete' && <button className="btn sm danger" disabled={busy} onClick={() => setConfirmDel(true)}>Excluir {fmtNum(n)}</button>}
      {canDelete && confirmDel && <ConfirmDeleteLeads count={n} busy={busy} onConfirm={excluir} onClose={() => setConfirmDel(false)} />}
      <button className="btn sm ghost" onClick={sel.clear} style={{ marginLeft: 'auto' }}>Limpar seleção</button>
    </div>
  );
}

/** Picker "Adicionar contatos" da campanha: busca, filtros por etiqueta/status, seleção da página ou de todos. */
export function AddContactsModal({ c, onClose, onDone }: { c: Campaign; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [semCampanha, setSemCampanha] = useState(false);
  const [page, setPage] = useState(1);
  const filter: LeadFilter = { q, status, tag, notCampaignId: c.id, optOut: 'nao', ...(semCampanha ? { campaignId: 'none' } : {}) };
  const key = JSON.stringify(filter);
  useEffect(() => setPage(1), [key]);
  const params = new URLSearchParams({ ...limpa(filter) as Record<string, string>, page: String(page), pageSize: '50' });
  const list = useApi<LeadPage>(`/mckmensagem/leads?${params}`);
  const sel = useLeadSelection(key);
  const { busy, run } = useAction();
  const pageIds = list.data?.items.map((l) => l.id) ?? [];
  const n = sel.todos ? list.data?.total ?? 0 : sel.ids.size;
  const ativa = c.status === 'EM_ANDAMENTO' || c.status === 'PAUSADA';
  return (
    <Modal title={`Adicionar contatos a “${c.name}”`} onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Mostra só contatos sem opt-out que ainda não estão nesta campanha.{ativa ? ' Como a campanha já começou, os elegíveis entram direto na fila de envio.' : ' Eles entram na fila quando você iniciar a campanha.'}</p>
        <div className="mm-filters">
          <input type="search" placeholder="Buscar por nome ou telefone…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Todos os status</option>{LEAD_STATUS.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</select>
          <input placeholder="Etiqueta" value={tag} onChange={(e) => setTag(e.target.value.trim())} aria-label="Etiqueta" />
          <label className="row small"><input type="checkbox" checked={semCampanha} onChange={(e) => setSemCampanha(e.target.checked)} style={{ width: 'auto' }} /> Só quem não tem campanha</label>
        </div>
        <Async state={list}>{(d) => d.items.length === 0 ? <Empty title="Nenhum contato disponível">Ajuste a busca ou os filtros.</Empty> : (
          <>
            <SelectAllBanner sel={sel} pageIds={pageIds} total={d.total} />
            <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}>
              <table>
                <thead><tr>
                  <th style={{ width: 32 }}><input type="checkbox" aria-label="Selecionar a página" checked={sel.todos || (pageIds.length > 0 && pageIds.every((id) => sel.ids.has(id)))} onChange={(e) => sel.setPage(pageIds, e.target.checked)} style={{ width: 'auto' }} /></th>
                  <th>Contato</th><th>Status</th><th className="hide-xs">Etiquetas</th><th className="hide-xs">Campanha atual</th>
                </tr></thead>
                <tbody>{d.items.map((l) => (
                  <tr key={l.id} onClick={() => sel.toggle(l.id)} style={{ cursor: 'pointer' }}>
                    <td><input type="checkbox" aria-label={`Selecionar ${l.name ?? l.phone}`} checked={sel.todos || sel.ids.has(l.id)} onChange={() => sel.toggle(l.id)} onClick={(e) => e.stopPropagation()} style={{ width: 'auto' }} /></td>
                    <td><strong>{l.name || '—'}</strong><div className="small muted">{fmtPhone(l.phone)}</div></td>
                    <td><LeadBadge status={l.status} /></td>
                    <td className="hide-xs small">{l.tags.join(', ')}</td>
                    <td className="hide-xs small">{l.campaignId ? <span className="badge amber">outra campanha</span> : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="row between small muted">
              <span>{fmtNum(d.total)} disponível(is) · página {d.page} de {Math.max(1, Math.ceil(d.total / d.pageSize))}</span>
              <span className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>←</button><button className="btn sm" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>→</button></span>
            </div>
          </>
        )}</Async>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !n || n > BULK_MAX} onClick={async () => {
            const r = await run(() => bulk(sel, filter, { action: 'setCampaign', campaignId: c.id }));
            if (r) { alert(`${r.updated} contato(s) adicionado(s) à campanha.${r.queued ? ` ${r.queued} entraram na fila de envio.` : ''}`); onDone(); }
          }}>{busy ? 'Adicionando…' : `Adicionar ${fmtNum(n)} contato(s)`}</button>
        </div>
      </div>
    </Modal>
  );
}
