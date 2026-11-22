import { useState } from 'react';
import { post } from '../../api';
import { useApi, Async, Field, useAction, fmtDate, fmtNum } from '../../ui';
import { LEAD_STATUS_LABEL, fmtPhone, type Campaign, type LeadStatus } from '../common';

/** v1.43.0 — Separação automática dos contatos da campanha e repescagem de quem não respondeu. */

type Grupo = 'RESPONDEU' | 'VISUALIZOU' | 'NAO_VISUALIZOU' | 'FALHOU' | 'SAIU' | 'PENDENTE' | 'NAO_ENVIADA';
type Filtro = Grupo | 'SEM_RESPOSTA' | 'REPESCADOS' | '';
interface Linha {
  recipientId: string; leadId: string; nome: string | null; telefone: string; grupo: Grupo; grupoRotulo: string;
  statusMensagem: string | null; enviadaEm: string | null; respondeuEm: string | null; leadStatus: string | null;
  repescagens: number; repescagemStatus: string | null; repescagemMotivo: string | null; proximaRepescagemEm: string | null; erro: string | null;
}
interface Resposta {
  contagem: Record<Grupo | 'SEM_RESPOSTA' | 'REPESCADOS', number>; rotulos: Record<Grupo, string>; total: number; page: number; pageSize: number; itens: Linha[];
  repescagem: { ativa: boolean; dias: number; max: number; pausa: string | null; pausaEm: string | null };
}

const ORDEM: { g: Grupo; cls: string }[] = [
  { g: 'RESPONDEU', cls: 'green' }, { g: 'VISUALIZOU', cls: 'amber' }, { g: 'NAO_VISUALIZOU', cls: 'blue' },
  { g: 'FALHOU', cls: 'red' }, { g: 'SAIU', cls: 'red' }, { g: 'PENDENTE', cls: '' }, { g: 'NAO_ENVIADA', cls: '' },
];
const STATUS_MSG: Record<string, string> = { QUEUED: 'Na fila', SENT: 'Enviada ✓', DELIVERED: 'Entregue ✓✓', READ: 'Lida ✓✓', FAILED: 'Falhou' };
const REPESCAGEM_STATUS: Record<string, string> = { RESPONDEU: 'Respondeu', SEM_RESPOSTA: 'Sem resposta', PARADA: 'Parada', ENVIANDO: 'Enviando…' };

export function CampaignGroups({ c }: { c: Campaign }) {
  const [filtro, setFiltro] = useState<Filtro>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ ...(filtro ? { grupo: filtro } : {}), ...(q.trim() ? { q: q.trim() } : {}), page: String(page), pageSize: '25' });
  const state = useApi<Resposta>(`/mckmensagem/campaigns/${c.id}/grupos?${qs}`, [filtro, q, page, c.updatedAt]);
  const exportQs = new URLSearchParams(filtro ? { grupo: filtro } : {});
  const escolher = (f: Filtro) => { setFiltro(filtro === f ? '' : f); setPage(1); };
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Quem respondeu e quem não</h2>
        <a className="btn sm" href={`/api/mckmensagem/campaigns/${c.id}/grupos/export?${exportQs}`} download>Exportar CSV{filtro ? ' (filtro)' : ''}</a>
      </div>
      <Async state={state}>{(d) => (
        <>
          {d.repescagem.pausa && <div className="alert warn">⚠ {d.repescagem.pausa}</div>}
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {ORDEM.map(({ g, cls }) => (
              <button key={g} type="button" className={`btn sm ${filtro === g ? 'primary' : ''}`} onClick={() => escolher(g)} aria-pressed={filtro === g}>
                <span className={`badge ${cls}`} style={{ marginRight: 6 }}>{fmtNum(d.contagem[g] ?? 0)}</span>{d.rotulos[g]}
              </button>
            ))}
            <button type="button" className={`btn sm ${filtro === 'REPESCADOS' ? 'primary' : ''}`} onClick={() => escolher('REPESCADOS')}><span className="badge" style={{ marginRight: 6 }}>{fmtNum(d.contagem.REPESCADOS ?? 0)}</span>Repescados</button>
            <button type="button" className={`btn sm ${filtro === 'SEM_RESPOSTA' ? 'primary' : ''}`} onClick={() => escolher('SEM_RESPOSTA')}><span className="badge" style={{ marginRight: 6 }}>{fmtNum(d.contagem.SEM_RESPOSTA ?? 0)}</span>Sem resposta (fim)</button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            “Visualizou” depende da confirmação de leitura (✓✓ azul): quem desligou essa opção no WhatsApp aparece como “Não visualizou”.
            {d.repescagem.ativa
              ? <> Repescagem automática ligada: depois de {d.repescagem.dias} dia(s) sem resposta, até {d.repescagem.max} nova(s) mensagem(ns) escritas pela IA, só para “Visualizou e não respondeu” e “Não visualizou”. Quem responde qualquer coisa nunca recebe repescagem.</>
              : <> Repescagem automática desligada (ligue em Editar).</>}
          </p>
          <input placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 320 }} />
          {d.itens.length === 0
            ? <p className="muted small" style={{ margin: 0 }}>Nenhum contato {filtro ? 'neste grupo' : 'nesta campanha'}.</p>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Contato</th><th>Grupo</th><th className="col-sec">Mensagem</th><th className="col-sec">Enviada</th><th>Repescagem</th></tr></thead>
                  <tbody>
                    {d.itens.map((l) => (
                      <tr key={l.recipientId}>
                        <td>{l.nome || '—'}<div className="small muted">{fmtPhone(l.telefone)}</div>{l.leadStatus && <div className="small muted">{LEAD_STATUS_LABEL[l.leadStatus as LeadStatus] ?? l.leadStatus}</div>}</td>
                        <td><span className="badge">{l.grupoRotulo}</span>{l.respondeuEm && <div className="small muted">respondeu {fmtDate(l.respondeuEm)}</div>}</td>
                        <td className="col-sec small">{l.statusMensagem ? STATUS_MSG[l.statusMensagem] ?? l.statusMensagem : '—'}{l.erro && <div className="small muted" title={l.erro}>{l.erro.slice(0, 60)}</div>}</td>
                        <td className="col-sec small">{fmtDate(l.enviadaEm)}</td>
                        <td className="small">
                          {l.repescagens > 0 ? `${l.repescagens}/${d.repescagem.max} enviada(s)` : '—'}
                          {l.repescagemStatus && <div><span className="badge">{REPESCAGEM_STATUS[l.repescagemStatus] ?? l.repescagemStatus}</span></div>}
                          {l.proximaRepescagemEm && <div className="muted">próxima: {fmtDate(l.proximaRepescagemEm)}</div>}
                          {l.repescagemMotivo && l.repescagemStatus === 'PARADA' && <div className="muted">{l.repescagemMotivo}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          {d.total > d.pageSize && (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <span className="small muted">{(d.page - 1) * d.pageSize + 1}–{Math.min(d.total, d.page * d.pageSize)} de {fmtNum(d.total)}</span>
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Anterior</button>
              <button className="btn sm" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>Próxima →</button>
            </div>
          )}
        </>
      )}</Async>
    </div>
  );
}

export type RepescagemForm = { repescagemAtiva: boolean; repescagemDias: number; repescagemMax: number; repescagemModelo: string };

/** Campos da repescagem no formulário da campanha. */
export function RepescagemFields({ f, set, campaignId }: { f: RepescagemForm; set: <K extends keyof RepescagemForm>(k: K, v: RepescagemForm[K]) => void; campaignId?: string }) {
  const { busy, run } = useAction();
  const [previa, setPrevia] = useState<{ ia: { texto: string; fonte: string; motivo?: string }; modelo: string } | null>(null);
  const testar = async () => {
    if (!campaignId) return;
    const r = await run(() => post<{ ia: { texto: string; fonte: string; motivo?: string }; modelo: string }>(`/mckmensagem/campaigns/${campaignId}/repescagem/previa`, { grupo: 'NAO_VISUALIZOU', modelo: f.repescagemModelo }));
    if (r) setPrevia(r);
  };
  return (
    <>
      <h3 style={{ margin: '4px 0 0' }}>Repescagem automática</h3>
      <label className="mm-check"><input type="checkbox" checked={f.repescagemAtiva} onChange={(e) => set('repescagemAtiva', e.target.checked)} /><span>Enviar de novo, automaticamente, para quem não respondeu<span className="small muted" style={{ fontWeight: 400 }}><br />Só para “Visualizou e não respondeu” e “Não visualizou”. Nunca para quem respondeu (inclusive “sim”), saiu, está em qualificação ou falhou. A IA escreve uma mensagem curta e diferente para cada contato, com a opção “responda SAIR”.</span></span></label>
      {f.repescagemAtiva && (
        <>
          <div className="grid g2" style={{ gap: 10 }}>
            <Field label="Esperar (dias sem resposta)"><input type="number" min={1} max={30} required value={f.repescagemDias} onChange={(e) => set('repescagemDias', Number(e.target.value))} /></Field>
            <Field label="Máximo de repescagens"><input type="number" min={1} max={5} required value={f.repescagemMax} onChange={(e) => set('repescagemMax', Number(e.target.value))} /></Field>
          </div>
          <Field label="Texto modelo (quando a IA não estiver disponível)" hint="Opcional. Use {nome} e variações entre chaves, ex.: {Oi|Olá} {nome}! Cada contato recebe uma combinação diferente. Vazio = modelo padrão. “Responda SAIR” é incluído sozinho.">
            <textarea rows={3} maxLength={2000} value={f.repescagemModelo} onChange={(e) => set('repescagemModelo', e.target.value)} placeholder="{Oi|Olá} {nome}, tudo bem? {Passando para lembrar|Só lembrando} da nossa oferta. Se tiver interesse, é só responder aqui." />
          </Field>
          <div className="small muted">Conta como envio em massa: respeita a janela de horário, o limite por dia da campanha e a proteção do número (pausa sozinha se o número ficar em nível Risco). Depois da última repescagem sem resposta, o contato fica como “Sem resposta”.</div>
          {campaignId && <div className="row"><button type="button" className="btn sm" disabled={busy} onClick={testar}>{busy ? 'Gerando…' : 'Ver exemplo da repescagem'}</button><span className="small muted">Nada é enviado.</span></div>}
          {previa && (
            <div className="stack small">
              <div><strong>{previa.ia.fonte === 'ia' ? 'Escrita pela IA:' : `Texto modelo (IA indisponível${previa.ia.motivo ? `: ${previa.ia.motivo}` : ''}):`}</strong><div className="mm-preview"><div className="b" style={{ whiteSpace: 'pre-wrap' }}>{previa.ia.texto}</div></div></div>
              {previa.ia.fonte === 'ia' && <div><strong>Texto modelo (reserva):</strong><div className="mm-preview"><div className="b" style={{ whiteSpace: 'pre-wrap' }}>{previa.modelo}</div></div></div>}
            </div>
          )}
        </>
      )}
    </>
  );
}
