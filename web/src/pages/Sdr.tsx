import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post, put, patch } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, useAction, fmtDate, Modal, Field, Empty, copy, useToast } from '../ui';

/** SDR com IA (v1.18.0): pré-vendas automática — leads, qualificação pela IA, cadências, reuniões e funil. */
type Lead = {
  id: string; name: string | null; company: string | null; segment: string | null; segmentLabel: string; phone: string | null; email: string | null;
  source: string; stage: string; score: number; temperature: 'FRIO' | 'MORNO' | 'QUENTE'; ownerUserId: string | null; ownerName: string | null;
  consent: boolean; optOut: boolean; aiSummary: string | null; cadenceName: string | null; cadenceStatus: string; nextStepAt: string | null; stopReason: string | null;
  lastContactAt: string | null; lastReplyAt: string | null; createdAt: string;
};

const STAGES: [string, string][] = [['NOVO', 'Novo'], ['CONTATADO', 'Contatado'], ['RESPONDEU', 'Respondeu'], ['QUALIFICADO', 'Qualificado'], ['REUNIAO', 'Reunião marcada'], ['GANHO', 'Ganho'], ['PERDIDO', 'Perdido']];
const stageLabel = (s: string) => STAGES.find(([k]) => k === s)?.[1] ?? s;
const SOURCE: Record<string, string> = { MANUAL: 'Manual', IMPORTACAO: 'Importação', WHATSAPP: 'WhatsApp', FORMULARIO: 'Formulário' };
const TEMP: Record<string, { label: string; color: string }> = { FRIO: { label: 'Frio', color: '#3b82f6' }, MORNO: { label: 'Morno', color: '#f59e0b' }, QUENTE: { label: 'Quente', color: '#dc2626' } };
const CAD: Record<string, string> = { SEM: 'Sem cadência', ESPERA: 'Acompanha se parar de responder', ATIVA: 'Em cadência', APROVACAO: 'Aguardando aprovação', PARADA: 'Parada', CONCLUIDA: 'Concluída' };
const STOP: Record<string, string> = { RESPONDEU: 'respondeu', AGENDOU: 'reunião marcada', SAIU: 'pediu para sair', MANUAL: 'parada pela equipe', GANHO: 'ganho', PERDIDO: 'perdido' };
const EVENT: Record<string, string> = { CRIADO: 'Entrou', ETAPA: 'Etapa', ENVIO: 'Mensagem enviada', PULO: 'Passo pulado', FALHA: 'Falha no envio', RESPOSTA: 'Respondeu', QUALIFICACAO: 'Qualificação da IA', QUENTE: '🔥 Lead quente (aviso enviado)', REUNIAO: '📅 Reunião', PARADA: 'Cadência parada', OPTOUT: 'Pediu para sair', NOTA: 'Nota', CADENCIA: 'Cadência', APROVACAO: 'Aguardando aprovação', KANBAN: 'Kanban do MCKBOT', DONO: 'Responsável' };

function Temp({ t, score }: { t: string; score?: number }) {
  const x = TEMP[t] ?? TEMP.FRIO;
  return <span className="badge" style={{ background: x.color, color: '#fff' }}>{x.label}{score !== undefined ? ` · ${score}` : ''}</span>;
}

export default function Sdr() {
  const acesso = useApi<any>('/sdr/acesso');
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('aba') ?? 'painel';
  const leadId = sp.get('lead');
  const setTab = (k: string) => setSp(new URLSearchParams({ aba: k }));
  const openLead = (id: string | null) => { const n = new URLSearchParams(sp); if (id) n.set('lead', id); else n.delete('lead'); setSp(n); };
  const { can } = useAuth();
  const { run, busy } = useAction();
  return (
    <>
      <div className="page-head">
        <div><h1>SDR com IA</h1><p className="muted">Pré-vendas no automático: a IA qualifica os leads, faz o acompanhamento, marca reuniões e avisa você quando um lead fica quente.</p></div>
      </div>
      <Async state={acesso}>{(a) => {
        if (!a.liberado) return (
          <div className="card stack">
            <h3>O SDR com IA faz parte do Plano Completo</h3>
            <p className="muted">MCK ERP + MCKBOT + MCK Mensagens + SDR com IA em uma só assinatura (também no período de teste).</p>
            <div><Link className="btn primary" to="/plano">Ver o Plano Completo</Link></div>
          </div>
        );
        if (!a.enabled) return (
          <div className="card stack">
            <h3>Ligue o SDR com um clique</h3>
            <p>Tudo já vem pronto: cadências por segmento, perguntas de qualificação, horário comercial (9h–18h, seg–sex), limite de 40 envios por dia e o <strong>modo automático</strong> ligado.</p>
            <ul className="small">
              <li>Quem chamar no seu WhatsApp vira lead e a IA qualifica na conversa.</li>
              <li>Quem parar de responder recebe um acompanhamento educado (para quando responde, marca reunião ou pede para sair).</li>
              <li>WhatsApp só para quem chamou ou autorizou; lista fria só por e-mail, sempre com descadastro.</li>
              <li>A IA nunca transfere a conversa: lead quente só gera um aviso para você.</li>
            </ul>
            {can('OWNER', 'ADMIN') ? <div><button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => put('/sdr/config', { enabled: true }), 'SDR ligado')) acesso.reload(); }}>Ligar o SDR com IA</button></div>
              : <p className="small muted">Peça ao proprietário ou a um administrador para ligar.</p>}
          </div>
        );
        return (
          <>
            <div className="tabs" role="tablist">
              {[['painel', 'Painel'], ['funil', 'Funil'], ['leads', 'Leads'], ['cadencias', 'Cadências'], ['relatorios', 'Relatórios'], ['config', 'Configuração']].map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
              ))}
              <span className="small muted" style={{ marginLeft: 'auto', alignSelf: 'center' }}>{a.autoMode ? '⚡ Modo automático ligado' : '✋ Aprovação manual de cada envio'}</span>
            </div>
            {tab === 'painel' && <Painel open={openLead} />}
            {tab === 'funil' && <Funil open={openLead} />}
            {tab === 'leads' && <Leads open={openLead} />}
            {tab === 'cadencias' && <Cadencias />}
            {tab === 'relatorios' && <Relatorios />}
            {tab === 'config' && <Config onSaved={acesso.reload} />}
            {leadId && <LeadModal id={leadId} onClose={() => openLead(null)} />}
          </>
        );
      }}</Async>
    </>
  );
}

function Painel({ open }: { open: (id: string) => void }) {
  const state = useApi<any>('/sdr/painel');
  return <Async state={state}>{(d) => {
    const m = d.metricas;
    return (
      <div className="stack">
        <div className="grid g4">
          {[['Leads (30 dias)', m.leads], ['Contatados', m.contatados], ['Responderam', `${m.responderam} (${m.taxaResposta}%)`], ['Qualificados', m.qualificados], ['Reuniões', m.reunioes], ['Ganhos', m.ganhos], ['Conversão', `${m.conversao}%`], ['Envios hoje', `${m.enviosHoje} / ${m.limiteDiario}`]].map(([l, v]) => (
            <div key={l as string} className="card stat"><div className="v">{v}</div><div className="l">{l}</div></div>
          ))}
        </div>
        {d.quentes.length > 0 && (
          <div className="card stack">
            <h3>🔥 Leads quentes (últimos 7 dias)</h3>
            {d.quentes.map((l: any) => (
              <div key={l.id} className="row between"><span><strong>{l.name || 'Sem nome'}</strong>{l.company ? ` · ${l.company}` : ''} <Temp t="QUENTE" score={l.score} /> <span className="small muted">{l.aiSummary}</span></span><button className="btn sm" onClick={() => open(l.id)}>Abrir</button></div>
            ))}
          </div>
        )}
        <div className="grid g2">
          <div className="card stack">
            <h3>Aguardando sua aprovação</h3>
            {d.aprovar.length ? d.aprovar.map((l: any) => <div key={l.id} className="row between"><span>{l.name || l.company || 'Lead'} <Temp t={l.temperature} /></span><button className="btn sm" onClick={() => open(l.id)}>Revisar</button></div>)
              : <p className="small muted">Nada esperando. No modo automático os envios saem sozinhos.</p>}
          </div>
          <div className="card stack">
            <h3>Próximas ações</h3>
            {d.proximas.length ? d.proximas.map((l: any) => <div key={l.id} className="row between small"><span>{l.name || l.company || 'Lead'} · {CAD[l.cadenceStatus]}</span><span className="muted">{fmtDate(l.nextStepAt)}</span></div>)
              : <p className="small muted">Nenhum acompanhamento agendado.</p>}
          </div>
        </div>
        <div className="card"><h3>Funil</h3><div className="row">{d.funil.map((f: any) => <span key={f.id} className="badge">{f.label}: {f.total}</span>)}</div></div>
      </div>
    );
  }}</Async>;
}

function Funil({ open }: { open: (id: string) => void }) {
  const state = useApi<{ items: Lead[] }>('/sdr/leads');
  const { run } = useAction();
  const [over, setOver] = useState<string | null>(null);
  const move = async (id: string, stage: string) => {
    if (!state.data) return;
    state.setData({ items: state.data.items.map((l) => (l.id === id ? { ...l, stage } : l)) });
    if (!(await run(() => patch(`/sdr/leads/${id}`, { stage })))) state.reload();
  };
  return <Async state={state}>{(d) => (
    <div className="board">
      {STAGES.map(([k, label]) => {
        const cards = d.items.filter((l) => l.stage === k);
        return (
          <div key={k} className={`col ${over === k ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); move(e.dataTransfer.getData('text/plain'), k); }}>
            <div className="col-head"><span>{label} <span className="badge">{cards.length}</span></span></div>
            {cards.map((l) => (
              <div key={l.id} className="kcard" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', l.id)}>
                <div className="row between"><strong>{l.name || l.company || l.phone || l.email}</strong><Temp t={l.temperature} score={l.score} /></div>
                {l.company && l.name && <div className="small muted">{l.company}</div>}
                <div className="small muted">{SOURCE[l.source]} · {CAD[l.cadenceStatus]}{l.optOut ? ' · saiu' : ''}</div>
                <div className="row between" style={{ marginTop: 6 }}>
                  <select aria-label="Mover para" className="small" style={{ padding: 4, width: 140 }} value={l.stage} onChange={(e) => move(l.id, e.target.value)}>
                    {STAGES.map(([s, n]) => <option key={s} value={s}>{n}</option>)}
                  </select>
                  <button className="btn ghost sm" onClick={() => open(l.id)}>Detalhes</button>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  )}</Async>;
}

function Leads({ open }: { open: (id: string) => void }) {
  const [f, setF] = useState({ stage: '', temperature: '', source: '', q: '' });
  const [q, setQ] = useState('');
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const state = useApi<{ items: Lead[] }>(`/sdr/leads${qs ? `?${qs}` : ''}`, [qs]);
  const [novo, setNovo] = useState(false);
  const [imp, setImp] = useState(false);
  const { can } = useAuth();
  return (
    <div className="stack">
      <div className="row between">
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); setF({ ...f, q }); }}><input placeholder="Buscar nome, empresa, e-mail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} /></form>
          <select aria-label="Etapa" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} style={{ width: 150 }}><option value="">Todas as etapas</option>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select aria-label="Temperatura" value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })} style={{ width: 130 }}><option value="">Frio/morno/quente</option><option value="QUENTE">Quente</option><option value="MORNO">Morno</option><option value="FRIO">Frio</option></select>
          <select aria-label="Origem" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} style={{ width: 140 }}><option value="">Todas as origens</option>{Object.entries(SOURCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => setNovo(true)}>+ Lead</button>
          {can('OWNER', 'ADMIN') && <button className="btn" onClick={() => setImp(true)}>Importar planilha (CSV)</button>}
        </div>
      </div>
      <Async state={state}>{(d) => d.items.length === 0 ? <Empty title="Nenhum lead ainda">Os leads chegam sozinhos pelo WhatsApp e pelo formulário. Você também pode cadastrar ou importar uma planilha.</Empty> : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Lead</th><th>Pontuação</th><th>Etapa</th><th>Origem</th><th>Cadência</th><th>Dono</th><th /></tr></thead>
            <tbody>{d.items.map((l) => (
              <tr key={l.id}>
                <td><strong>{l.name || '—'}</strong>{l.company ? <div className="small muted">{l.company}</div> : null}<div className="small muted">{l.phone || l.email}</div></td>
                <td><Temp t={l.temperature} score={l.score} /></td>
                <td>{stageLabel(l.stage)}</td>
                <td>{SOURCE[l.source]}{l.consent ? '' : l.source === 'IMPORTACAO' ? ' (sem consentimento: só e-mail)' : ''}</td>
                <td className="small">{l.optOut ? 'Pediu para sair' : CAD[l.cadenceStatus]}{l.cadenceStatus === 'PARADA' && l.stopReason ? ` (${STOP[l.stopReason] ?? l.stopReason})` : ''}</td>
                <td className="small">{l.ownerName ?? '—'}</td>
                <td><button className="btn sm" onClick={() => open(l.id)}>Abrir</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}</Async>
      {novo && <NovoLead onClose={() => setNovo(false)} onDone={() => { setNovo(false); state.reload(); }} />}
      {imp && <Importar onClose={() => setImp(false)} onDone={() => { setImp(false); state.reload(); }} />}
    </div>
  );
}

function NovoLead({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ name: '', company: '', phone: '', email: '', segment: 'geral', consent: false });
  const cfg = useApi<any>('/sdr/config');
  const { run, busy } = useAction();
  const save = async (e: FormEvent) => { e.preventDefault(); if (await run(() => post('/sdr/leads', v), 'Lead salvo')) onDone(); };
  return (
    <Modal title="Novo lead" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <div className="grid g2">
          <Field label="Nome"><input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={120} /></Field>
          <Field label="Empresa"><input value={v.company} onChange={(e) => setV({ ...v, company: e.target.value })} maxLength={120} /></Field>
          <Field label="WhatsApp"><input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} inputMode="tel" placeholder="(11) 90000-0000" /></Field>
          <Field label="E-mail"><input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        </div>
        <Field label="Segmento"><select value={v.segment} onChange={(e) => setV({ ...v, segment: e.target.value })}>{(cfg.data?.segments ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
        <label className="row small"><input type="checkbox" checked={v.consent} onChange={(e) => setV({ ...v, consent: e.target.checked })} style={{ width: 'auto' }} /> A pessoa autorizou receber mensagens (sem isso, o WhatsApp não é usado; só e-mail com descadastro)</label>
        <div className="row"><button className="btn primary" disabled={busy}>Salvar</button><button type="button" className="btn" onClick={onClose}>Cancelar</button></div>
      </form>
    </Modal>
  );
}

function Importar({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [consent, setConsent] = useState(false);
  const [res, setRes] = useState<any>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const onFile = async (file?: File) => { if (!file) return; if (file.size > 850_000) return toast('Arquivo grande demais (máx. ~5.000 linhas).', 'err'); setCsv(await file.text()); };
  return (
    <Modal title="Importar leads (CSV)" onClose={onClose}>
      <div className="stack">
        <p className="small">Colunas aceitas: <code>nome; empresa; segmento; telefone; email; consentimento</code>. Quem já pediu para sair continua fora: o opt-out nunca é sobrescrito.</p>
        <p className="small muted">Modelo: <code>nome;empresa;telefone;email{'\n'}Ana Souza;Loja X;11988887777;ana@lojax.com.br</code></p>
        <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        <label className="row small"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 'auto' }} /> Todos desta planilha autorizaram receber mensagens (LGPD). Sem marcar, o WhatsApp não é usado: só e-mail.</label>
        {res && <div className="alert info small">{res.linhas} linhas: {res.criados} novos, {res.atualizados} já existiam, {res.comOptOut} com opt-out mantido{res.erros.length ? `, ${res.erros.length} com erro (ex.: linha ${res.erros[0].linha}: ${res.erros[0].erro})` : ''}.</div>}
        <div className="row">
          <button className="btn primary" disabled={!csv || busy} onClick={async () => { const r = await run(() => post('/sdr/importar', { csv, consentimento: consent })); if (r) setRes(r); }}>Importar</button>
          <button className="btn" onClick={res ? onDone : onClose}>{res ? 'Concluir' : 'Cancelar'}</button>
        </div>
      </div>
    </Modal>
  );
}

function LeadModal({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useApi<any>(`/sdr/leads/${id}`, [id]);
  const team = useApi<any>('/team');
  const { run, busy } = useAction();
  const [nota, setNota] = useState('');
  const [inicio, setInicio] = useState('');
  const act = async (path: string, body?: unknown, msg?: string) => { if (await run(() => post(`/sdr/leads/${id}/${path}`, body), msg)) state.reload(); };
  const upd = async (body: unknown, msg = 'Salvo') => { if (await run(() => patch(`/sdr/leads/${id}`, body), msg)) state.reload(); };
  return (
    <Modal title="Lead" onClose={onClose}>
      <Async state={state}>{(l) => (
        <div className="stack">
          <div className="row between">
            <div><h3 style={{ margin: 0 }}>{l.name || 'Sem nome'}</h3><div className="small muted">{[l.company, l.segmentLabel, l.phone, l.email].filter(Boolean).join(' · ')}</div></div>
            <Temp t={l.temperature} score={l.score} />
          </div>
          {l.optOut && <div className="alert warn small">Pediu para sair: não recebe mais mensagens automáticas.</div>}
          {l.aiSummary && <p className="small"><strong>Resumo da IA:</strong> {l.aiSummary}</p>}
          <div className="grid g2">
            <Field label="Etapa"><select value={l.stage} onChange={(e) => upd({ stage: e.target.value })}>{STAGES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></Field>
            <Field label="Dono"><select value={l.ownerUserId ?? ''} onChange={(e) => upd({ ownerUserId: e.target.value || null })}><option value="">Sem dono</option>{(team.data?.members ?? []).map((m: any) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}</select></Field>
          </div>
          <div className="card stack">
            <strong>Qualificação</strong>
            {l.questions.map((q: any) => <div key={q.id} className="small"><span className="muted">{q.pergunta}</span><br />{l.answers[q.id]?.resposta ?? <em className="muted">ainda não respondeu</em>}</div>)}
          </div>
          <div className="card stack">
            <strong>Cadência: {l.cadenceName ?? '—'}</strong>
            <span className="small">{CAD[l.cadenceStatus]}{l.cadenceStatus === 'PARADA' && l.stopReason ? ` (${STOP[l.stopReason] ?? l.stopReason})` : ''}{l.nextStepAt ? ` · próximo passo ${fmtDate(l.nextStepAt)}` : ''}</span>
            {l.cadenceStatus === 'APROVACAO' && l.steps[l.cadenceStep] && <div className="alert info small"><strong>Passo do dia {l.steps[l.cadenceStep].dia} ({l.steps[l.cadenceStep].canal === 'EMAIL' ? 'e-mail' : 'WhatsApp'}):</strong> {l.steps[l.cadenceStep].texto}</div>}
            <div className="row">
              {l.cadenceStatus === 'APROVACAO' && <button className="btn sm primary" disabled={busy} onClick={() => act('aprovar', undefined, 'Enviado')}>Aprovar e enviar</button>}
              {['ATIVA', 'APROVACAO'].includes(l.cadenceStatus) && <button className="btn sm" disabled={busy} onClick={() => act('pular', undefined, 'Passo pulado')}>Pular passo</button>}
              {['ATIVA', 'APROVACAO', 'ESPERA'].includes(l.cadenceStatus) && <button className="btn sm danger" disabled={busy} onClick={() => act('parar', undefined, 'Cadência parada')}>Parar cadência</button>}
              {!l.optOut && ['SEM', 'PARADA', 'CONCLUIDA'].includes(l.cadenceStatus) && <button className="btn sm" disabled={busy} onClick={() => act('cadencia', undefined, 'Lead colocado na cadência')}>Pôr na cadência</button>}
              {!l.consent && !l.optOut && <button className="btn sm" disabled={busy} onClick={() => upd({ consent: true }, 'Consentimento registrado')}>Registrar consentimento</button>}
              {!l.optOut && <button className="btn sm ghost" disabled={busy} onClick={() => upd({ consent: false }, 'Marcado como "não quer receber"')}>Não quer receber</button>}
              {l.conversationId && <Link className="btn sm ghost" to={`/inbox/${l.conversationId}`}>Abrir conversa</Link>}
            </div>
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (inicio) act('reuniao', { inicio }, 'Reunião marcada na Agenda'); }}>
            <input type="datetime-local" value={inicio} onChange={(e) => setInicio(e.target.value)} aria-label="Data da reunião" style={{ width: 220 }} />
            <button className="btn sm" disabled={!inicio || busy}>📅 Marcar reunião</button>
          </form>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (nota.trim()) { upd({ note: nota.trim() }, 'Nota salva'); setNota(''); } }}>
            <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Anotação no histórico" maxLength={500} style={{ flex: 1 }} />
            <button className="btn sm" disabled={!nota.trim() || busy}>Anotar</button>
          </form>
          <div className="stack">
            <strong>Histórico</strong>
            {l.events.map((e: any) => <div key={e.id} className="small"><span className="muted">{fmtDate(e.createdAt)}</span> · {EVENT[e.type] ?? e.type}{e.channel ? ` (${e.channel === 'EMAIL' ? 'e-mail' : e.channel === 'WHATSAPP' ? 'WhatsApp' : e.channel === 'KANBAN' ? 'Kanban' : SOURCE[e.channel] ?? e.channel})` : ''}{e.detail ? `: ${e.detail}` : ''}</div>)}
          </div>
        </div>
      )}</Async>
    </Modal>
  );
}

function Relatorios() {
  const [dias, setDias] = useState(30);
  const state = useApi<any>(`/sdr/relatorio?dias=${dias}`, [dias]);
  const [aberta, setAberta] = useState<string | null>(null);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <div className="stack">
      <div className="row">
        <select aria-label="Período" value={dias} onChange={(e) => setDias(Number(e.target.value))} style={{ width: 160 }}>
          {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>Últimos {d} dias</option>)}
        </select>
        <a className="btn sm" href={`/api/sdr/relatorio.csv?dias=${dias}`} download>⬇ Baixar CSV</a>
        <span className="small muted">Resposta, reunião e descadastro contam para o último passo enviado antes deles.</span>
      </div>
      <Async state={state}>{(d) => d.cadencias.length ? (
        <div className="card table-wrap"><table>
          <thead><tr><th>Cadência</th><th>Leads</th><th>Enviados</th><th>Respondidos</th><th>Agendados</th><th>Descadastros</th><th>Taxa de resposta</th><th /></tr></thead>
          <tbody>{d.cadencias.map((c: any) => (
            <Fragment key={c.id}>
              <tr>
                <td><strong>{c.name}</strong><div className="small muted">{c.segmentLabel}</div></td>
                <td>{c.leads}</td><td>{c.enviados}</td><td>{c.respondidos}</td><td>{c.agendados}</td><td>{c.descadastros}</td><td>{c.taxaResposta}%</td>
                <td><button className="btn sm ghost" onClick={() => setAberta(aberta === c.id ? null : c.id)}>{aberta === c.id ? 'Fechar' : 'Por passo'}</button></td>
              </tr>
              {aberta === c.id && c.passos.map((p: any) => (
                <tr key={`${c.id}-${p.indice}`} className="small">
                  <td style={{ paddingLeft: 24 }}>Passo {p.indice + 1}{p.dia !== null ? ` · dia ${p.dia}` : ''}{p.canal ? ` · ${p.canal === 'EMAIL' ? 'e-mail' : 'WhatsApp'}` : ''}</td>
                  <td /><td>{p.enviados}</td><td>{p.respondidos}</td><td>{p.agendados}</td><td>{p.descadastros}</td><td>{pct(p.respondidos, p.enviados)}</td><td />
                </tr>
              ))}
            </Fragment>
          ))}</tbody>
        </table></div>
      ) : <Empty title="Nenhum envio no período"><p className="small muted">Os números aparecem quando as cadências começarem a enviar.</p></Empty>}</Async>
    </div>
  );
}

function Cadencias() {
  const state = useApi<{ items: any[] }>('/sdr/cadencias');
  const [edit, setEdit] = useState<any>(null);
  const { can } = useAuth();
  const { run } = useAction();
  return (
    <div className="stack">
      <p className="small muted">Cadências prontas por segmento. Cada lead recebe só os passos dos canais permitidos para ele: WhatsApp para quem chamou ou autorizou, e-mail (com descadastro) para quem não chegou pelo WhatsApp. Param sozinhas quando o lead responde, marca reunião ou pede para sair. Variáveis: {'{nome} {primeiro_nome} {empresa} {segmento} {minha_empresa}'}.</p>
      <Async state={state}>{(d) => (
        <div className="grid g2">
          {d.items.map((c) => (
            <div key={c.id} className="card stack">
              <div className="row between"><strong>{c.name}</strong><span className="badge">{c.active ? 'Ativa' : 'Desativada'}</span></div>
              <div className="small muted">{c.segmentLabel}</div>
              {c.steps.map((s: any, i: number) => <div key={i} className="small">Dia {s.dia} · {s.canal === 'EMAIL' ? '✉ E-mail' : '💬 WhatsApp'}: <span className="muted">{s.texto.slice(0, 90)}{s.texto.length > 90 ? '…' : ''}</span></div>)}
              {can('OWNER', 'ADMIN') && <div className="row">
                <button className="btn sm" onClick={() => setEdit(JSON.parse(JSON.stringify(c)))}>Editar</button>
                <button className="btn sm ghost" onClick={async () => { if (await run(() => put(`/sdr/cadencias/${c.id}`, { active: !c.active }))) state.reload(); }}>{c.active ? 'Desativar' : 'Ativar'}</button>
                {c.builtIn && <button className="btn sm ghost" onClick={async () => { if (await run(() => post(`/sdr/cadencias/${c.id}/restaurar`), 'Texto original restaurado')) state.reload(); }}>Restaurar texto</button>}
              </div>}
            </div>
          ))}
        </div>
      )}</Async>
      {edit && (
        <Modal title={`Editar: ${edit.name}`} onClose={() => setEdit(null)}>
          <div className="stack">
            <Field label="Nome"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={80} /></Field>
            {edit.steps.map((s: any, i: number) => (
              <div key={i} className="card stack">
                <div className="row">
                  <label className="small">Dia <input type="number" min={0} max={60} value={s.dia} onChange={(e) => { const st = [...edit.steps]; st[i] = { ...s, dia: Number(e.target.value) }; setEdit({ ...edit, steps: st }); }} style={{ width: 70 }} /></label>
                  <select value={s.canal} onChange={(e) => { const st = [...edit.steps]; st[i] = { ...s, canal: e.target.value }; setEdit({ ...edit, steps: st }); }} style={{ width: 140 }}><option value="WHATSAPP">WhatsApp</option><option value="EMAIL">E-mail</option></select>
                  <button className="btn sm danger" onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_: any, j: number) => j !== i) })}>Remover</button>
                </div>
                {s.canal === 'EMAIL' && <input value={s.assunto ?? ''} placeholder="Assunto" onChange={(e) => { const st = [...edit.steps]; st[i] = { ...s, assunto: e.target.value }; setEdit({ ...edit, steps: st }); }} maxLength={150} />}
                <textarea value={s.texto} rows={3} onChange={(e) => { const st = [...edit.steps]; st[i] = { ...s, texto: e.target.value }; setEdit({ ...edit, steps: st }); }} maxLength={2000} />
              </div>
            ))}
            <div className="row">
              <button className="btn sm" disabled={edit.steps.length >= 12} onClick={() => setEdit({ ...edit, steps: [...edit.steps, { dia: (edit.steps.at(-1)?.dia ?? 0) + 2, canal: 'WHATSAPP', texto: 'Oi {primeiro_nome}! ' }] })}>+ Passo</button>
              <button className="btn primary" onClick={async () => { if (await run(() => put(`/sdr/cadencias/${edit.id}`, { name: edit.name, steps: edit.steps }), 'Cadência salva')) { setEdit(null); state.reload(); } }}>Salvar</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Config({ onSaved }: { onSaved: () => void }) {
  const state = useApi<any>('/sdr/config');
  const [v, setV] = useState<any>(null);
  const { run, busy } = useAction();
  const { can } = useAuth();
  const toast = useToast();
  useEffect(() => { if (state.data) setV(state.data); }, [state.data]);
  if (!v) return <Async state={state}>{() => null}</Async>;
  const save = async (extra: Record<string, unknown> = {}) => {
    const body = { enabled: v.enabled, autoMode: v.autoMode, captureWhatsapp: v.captureWhatsapp, autoBook: v.autoBook, segment: v.segment, questions: v.questions, warmScore: Number(v.warmScore), hotScore: Number(v.hotScore), workStart: v.workStart, workEnd: v.workEnd, workDays: v.workDays, dailyLimit: Number(v.dailyLimit), silenceHours: Number(v.silenceHours), formEnabled: v.formEnabled, formTitle: v.formTitle, alertHot: v.alertHot, kanbanSync: v.kanbanSync, rodizio: v.rodizio, ...extra };
    const r = await run(() => put('/sdr/config', body), 'Configuração salva');
    if (r) { state.setData(r); onSaved(); }
  };
  const toggle = (k: string, label: string, hint: string) => (
    <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={!!v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} style={{ width: 'auto', marginTop: 3 }} disabled={!can('OWNER', 'ADMIN')} /><span><strong>{label}</strong><br /><span className="small muted">{hint}</span></span></label>
  );
  return (
    <div className="stack">
      <div className="card stack">
        {toggle('enabled', 'SDR ligado', 'Desligado, nada é enviado e nenhum lead novo entra.')}
        {toggle('autoMode', 'Modo automático', 'Cadência, qualificação, funil e reuniões sem aprovar cada passo. Desligue para aprovar cada envio manualmente.')}
        {toggle('captureWhatsapp', 'Quem chama no WhatsApp vira lead', 'Só contatos novos; quem pediu para sair nunca entra.')}
        {toggle('autoBook', 'A IA marca a reunião sozinha', 'Com confirmação do lead, nos horários livres da Agenda (lembrete pela própria Agenda).')}
        {toggle('kanbanSync', 'Acompanhar o Kanban do MCKBOT', 'A etapa do lead e a do contato no Kanban andam juntas (Novo, Contatado, Respondeu, Qualificado, Reunião, Ganho, Perdido), quando o Kanban tem uma etapa com esse nome.')}
        {toggle('alertHot', 'Avisar quando um lead ficar quente', 'Pelos Números de aviso (Perfil › Organização) e no painel. A conversa NÃO é transferida.')}
      </div>
      <div className="card stack">
        <strong>Distribuição automática de leads (rodízio)</strong>
        <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={!!v.rodizio?.enabled} disabled={!can('OWNER', 'ADMIN')} onChange={(e) => setV({ ...v, rodizio: { ...v.rodizio, enabled: e.target.checked } })} style={{ width: 'auto', marginTop: 3 }} /><span><strong>Distribuir os leads novos entre a equipe</strong><br /><span className="small muted">Cada lead novo sem responsável vai para o próximo da lista, um de cada vez.</span></span></label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {(v.team ?? []).map((m: any) => {
            const on = (v.rodizio?.members ?? []).includes(m.id);
            return <label key={m.id} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={on} disabled={!can('OWNER', 'ADMIN')} style={{ width: 'auto' }} onChange={() => setV({ ...v, rodizio: { ...v.rodizio, members: on ? v.rodizio.members.filter((x: string) => x !== m.id) : [...(v.rodizio?.members ?? []), m.id] } })} />{m.name}</label>;
          })}
        </div>
        {can('OWNER', 'ADMIN') && state.data?.rodizio?.enabled && <div><button className="btn sm" disabled={busy} onClick={async () => { const r = await run(() => post('/sdr/rodizio/distribuir')); if (r) toast(`${r.distribuidos} lead(s) distribuído(s)`); }}>Distribuir agora os leads sem responsável</button></div>}
      </div>
      <div className="card stack">
        <strong>Perguntas de qualificação (a IA pergunta com naturalidade e dá a nota)</strong>
        {v.questions.map((q: any, i: number) => (
          <div key={i} className="row">
            <input value={q.pergunta} onChange={(e) => { const qs = [...v.questions]; qs[i] = { ...q, pergunta: e.target.value }; setV({ ...v, questions: qs }); }} style={{ flex: 1 }} maxLength={200} />
            <label className="small">Peso <input type="number" min={1} max={100} value={q.peso} onChange={(e) => { const qs = [...v.questions]; qs[i] = { ...q, peso: Number(e.target.value) }; setV({ ...v, questions: qs }); }} style={{ width: 70 }} /></label>
            <button className="btn sm ghost" disabled={v.questions.length <= 1} onClick={() => setV({ ...v, questions: v.questions.filter((_: any, j: number) => j !== i) })}>Remover</button>
          </div>
        ))}
        <div><button className="btn sm" disabled={v.questions.length >= 8} onClick={() => setV({ ...v, questions: [...v.questions, { pergunta: '', peso: 20 }] })}>+ Pergunta</button></div>
        <div className="row small">Morno a partir de <input type="number" min={1} max={99} value={v.warmScore} onChange={(e) => setV({ ...v, warmScore: e.target.value })} style={{ width: 70 }} /> · Quente a partir de <input type="number" min={2} max={100} value={v.hotScore} onChange={(e) => setV({ ...v, hotScore: e.target.value })} style={{ width: 70 }} /> pontos (0 a 100)</div>
      </div>
      <div className="card stack">
        <strong>Envios</strong>
        <div className="grid g4">
          <Field label="Segmento padrão"><select value={v.segment} onChange={(e) => setV({ ...v, segment: e.target.value })}>{v.segments.map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
          <Field label="Início"><input type="time" value={v.workStart} onChange={(e) => setV({ ...v, workStart: e.target.value })} /></Field>
          <Field label="Fim"><input type="time" value={v.workEnd} onChange={(e) => setV({ ...v, workEnd: e.target.value })} /></Field>
          <Field label="Limite por dia"><input type="number" min={1} max={1000} value={v.dailyLimit} onChange={(e) => setV({ ...v, dailyLimit: e.target.value })} /></Field>
        </div>
        <Field label="Dias (0=domingo … 6=sábado)" hint="Ex.: 1,2,3,4,5"><input value={v.workDays} onChange={(e) => setV({ ...v, workDays: e.target.value })} /></Field>
        <p className="small muted">{v.emailReplies ? '✉ Resposta por e-mail ligada: quando o lead responde o e-mail, a cadência para sozinha (e "descadastrar" na resposta vale como pedido para sair).' : '✉ Resposta por e-mail ainda não ligada no servidor: quando o lead responder um e-mail, marque como "Respondeu" no funil para parar a cadência.'}</p>
        <Field label="Horas sem resposta para começar o acompanhamento de quem chamou no WhatsApp"><input type="number" min={1} max={23} value={v.silenceHours} onChange={(e) => setV({ ...v, silenceHours: e.target.value })} style={{ width: 90 }} /></Field>
      </div>
      <div className="card stack">
        <strong>Formulário / link público</strong>
        {toggle('formEnabled', 'Formulário ligado', 'Quem preencher entra como lead com autorização de contato.')}
        <Field label="Título"><input value={v.formTitle} onChange={(e) => setV({ ...v, formTitle: e.target.value })} maxLength={80} /></Field>
        <div className="row"><code className="small">{v.formUrl}</code><button className="btn sm" onClick={() => copy(v.formUrl, toast)}>Copiar link</button>{can('OWNER', 'ADMIN') && <button className="btn sm ghost" onClick={() => save({ newFormLink: true })}>Gerar novo link</button>}</div>
      </div>
      {can('OWNER', 'ADMIN') && <div><button className="btn primary" disabled={busy} onClick={() => save()}>Salvar configuração</button></div>}
      <SdrTeste />
    </div>
  );
}

function SdrTeste() {
  return <p className="small muted">Nada é enviado fora do horário comercial, acima do limite diário, sem consentimento (WhatsApp) ou para quem pediu para sair.</p>;
}
