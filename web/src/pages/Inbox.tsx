import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AvisoNumeroBanner from '../AvisoNumeroBanner';
import { useAuth } from '../auth';
import { post, patch } from '../api';
import { AiNotesPanel } from '../AiNotes';
import { useApi, Async, Empty, Loading, ErrorBox, fmtDate, initials, StatusBadge, useAction, Modal, Field } from '../ui';
import { ListaBarra, listaFiltrada, AgendarModal, AtendimentoModal } from './InboxExtras';
import { BotoesAssistente, PixModal, useAssistente } from './InboxV144';
import { renderResposta, termoBarra, type RespostaRapida } from '../../../server/inbox/core';

const TABS = [['open', 'Abertas'], ['pending', 'Aguardando humano'], ['closed', 'Encerradas']] as const;
const ORIGEM_ROTULO: Record<string, string> = { anuncio: 'Anúncio', site: 'Chat do site' };
const SENDER: Record<string, string> = { contact: '', bot: 'Automação', ai: 'IA', agent: 'Atendente', system: 'Sistema' };

export default function Inbox() {
  const { id } = useParams();
  const nav = useNavigate();
  const { me, can } = useAuth();
  const noNotify = !!me?.org && !(me.org.handoffNotifyPhones?.length);
  const [tab, setTab] = useState<string>('open');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [channelId, setChannelId] = useState('');
  const channels = useApi<any[]>('/channels?site=1');
  const assistente = useAssistente();
  const multi = (channels.data?.length ?? 0) > 1;
  const [showCfg, setShowCfg] = useState(false);
  const respostas = useApi<{ items: RespostaRapida[] }>('/inbox/respostas-rapidas');
  const list = useApi<any>(`/conversations?status=${tab}&q=${encodeURIComponent(query)}${channelId ? `&channelId=${encodeURIComponent(channelId)}` : ''}`, [tab, query, channelId]);
  useEffect(() => {
    const t = setInterval(() => list.reload(), 8000);
    return () => clearInterval(t);
  }, [list.reload]);
  return (
    <>
      <div className="page-head"><div><h1>Inbox</h1><p className="muted">Atendimento compartilhado. Atualiza automaticamente a cada 8 segundos.</p></div>
        {can('OWNER', 'ADMIN') && <button className="btn sm" onClick={() => setShowCfg(true)} title="Respostas rápidas, distribuição automática, horário de atendimento e pesquisa de satisfação">⚙️ Atendimento</button>}
      </div>
      {showCfg && <AtendimentoModal onClose={() => setShowCfg(false)} onChange={respostas.reload} />}
      {noNotify && <AvisoNumeroBanner />}
      <div className="inbox">
        <div className="list">
          <form className="row" style={{ padding: 10 }} onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
            <input placeholder="Pesquisar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Pesquisar conversas" />
          </form>
          {multi && (
            <div style={{ padding: '0 10px 8px' }}>
              <select aria-label="Filtrar por WhatsApp" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                <option value="">Todos os canais</option>
                {channels.data!.map((c) => <option key={c.id} value={c.id}>{c.label ?? c.name}{c.displayPhone ? ` (${c.displayPhone})` : ''}</option>)}
              </select>
            </div>
          )}
          <div className="tabs" style={{ padding: '0 8px', marginBottom: 0 }}>
            {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{list.data?.counts && ` (${list.data.counts[k.toUpperCase()] ?? 0})`}</button>)}
          </div>
          <div className="items">
            {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
            {!list.data && list.loading && <Loading />}
            {list.data?.items.length === 0 && <Empty title="Nenhuma conversa aqui">As conversas aparecem quando um contato envia mensagem para o seu número.</Empty>}
            {list.data?.items.map((c: any) => (
              <button key={c.id} className={`conv-item ${c.id === id ? 'on' : ''}`} onClick={() => nav(`/inbox/${c.id}`)}>
                <span className="avatar">{initials(c.contact?.name ?? c.contact?.phone)}</span>
                <span style={{ minWidth: 0 }}>
                  <strong>{c.contact?.name ?? c.contact?.phone}</strong>
                  <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.lastMessage?.direction === 'OUT' ? 'Você: ' : ''}{c.lastMessage?.body ?? '—'}</div>
                  {multi && c.channel && <div><span className="badge" title={c.channel.via}>📲 {c.channel.label}</span></div>}
                </span>
                <span className="small muted" style={{ textAlign: 'right' }}>
                  {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : ''}
                  {c.unreadCount > 0 && <div><span className="badge green">{c.unreadCount}</span></div>}
                  {c.mode === 'HUMAN' && <div><span className="badge blue">humano</span></div>}
                  {c.waitingSince && <div><span className="badge" style={{ background: '#ffedd5', color: '#9a3412' }}>Aguardando atendente</span></div>}
                </span>
              </button>
            ))}
          </div>
        </div>
        {id ? <Chat id={id} onChange={list.reload} respostas={respostas.data?.items ?? []} ia={assistente.data} /> : <div className="chat"><Empty title="Selecione uma conversa">Escolha uma conversa à esquerda para ver as mensagens.</Empty></div>}
      </div>
    </>
  );
}

function Chat({ id, onChange, respostas, ia }: { id: string; onChange: () => void; respostas: RespostaRapida[]; ia: { disponivel: boolean; motivo?: string } | null }) {
  const state = useApi<any>(`/conversations/${id}`, [id]);
  const stages = useApi<any>('/kanban');
  const flows = useApi<any[]>('/flows');
  const [text, setText] = useState('');
  const [note, setNote] = useState(false);
  const [aiNote, setAiNote] = useState(false);
  const [showAiNotes, setShowAiNotes] = useState(false);
  const [showFlow, setShowFlow] = useState(false);
  const [showTpl, setShowTpl] = useState(false);
  const [tpl, setTpl] = useState({ name: '', language: 'pt_BR' });
  // v1.41.0: "/" abre as respostas rápidas; agendar mensagem.
  const [barra, setBarra] = useState<{ termo: string; inicio: number } | null>(null);
  const [barraAtivo, setBarraAtivo] = useState(0);
  const [showAgendar, setShowAgendar] = useState(false);
  const [showPix, setShowPix] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // v1.35.0: "IA respondeu mal" — a resposta certa vira item da base de conhecimento.
  const { can, me } = useAuth();
  const [fix, setFix] = useState<{ id: string; body: string } | null>(null);
  const [fixText, setFixText] = useState('');
  const { busy, run } = useAction();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => state.reload(), 5000);
    return () => clearInterval(t);
  }, [state.reload]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [state.data?.messages.length]);
  const refresh = () => { state.reload(); onChange(); };
  const send = async () => {
    if (!text.trim()) return;
    if (note) {
      const r = await run(() => post(`/conversations/${id}/notes`, { text, ai: aiNote }), aiNote ? 'Nota para a IA salva no contato' : 'Nota interna adicionada');
      if (r) setText('');
    } else {
      try {
        await post(`/conversations/${id}/messages`, { type: 'text', text });
        setText('');
      } catch (e) {
        // Mensagem fica registrada como FAILED com o motivo — mostramos na conversa.
      }
    }
    refresh();
  };
  const atualizarBarra = (valor: string, cursor: number) => {
    const t = !note ? termoBarra(valor, cursor) : null;
    setBarra(t);
    setBarraAtivo(0);
  };
  const inserirResposta = (r: RespostaRapida) => {
    if (!barra) return;
    const fim = barra.inicio + 1 + barra.termo.length;
    const pronto = renderResposta(r.text, { nome: state.data?.contact?.name, atendente: me?.user?.name });
    const novo = text.slice(0, barra.inicio) + pronto + text.slice(fim);
    setText(novo);
    setBarra(null);
    requestAnimationFrame(() => { const el = taRef.current; if (el) { el.focus(); const pos = barra.inicio + pronto.length; el.setSelectionRange(pos, pos); } });
  };
  const action = (action: string, msg: string) => run(() => post(`/conversations/${id}/action`, { action }), msg).then(refresh);
  return (
    <div className="chat">
      <Async state={state}>{(d) => (
        <>
          <div className="chat-head">
            <span className="avatar">{initials(d.contact?.name ?? d.contact?.phone)}</span>
            <div style={{ flex: 1, minWidth: 140 }}>
              <strong>{d.contact?.name ?? d.contact?.phone}</strong>
              <div className="small muted">{d.contact?.phone} · <StatusBadge status={d.conversation.status} /> · {d.conversation.mode === 'HUMAN' ? 'Atendimento humano' : 'Robô'}{d.conversation.channel && <> · <span title="WhatsApp desta conversa">📲 {d.conversation.channel.via}</span></>}{d.assignedUser && <> · <span title="Responsável pela conversa">👤 {d.assignedUser.name}</span></>}{d.conversation.origem && <> · <span className="badge" title="De onde veio esta conversa (Relatórios › Origem dos leads)">📍 {ORIGEM_ROTULO[d.conversation.origem] ?? d.conversation.origem}</span></>}</div>
            </div>
            <select aria-label="Etapa do Kanban" style={{ width: 170 }} value={d.contact?.stageId ?? ''} onChange={(e) => run(() => patch(`/contacts/${d.contact.id}`, { stageId: e.target.value || null }), 'Etapa atualizada').then(refresh)}>
              <option value="">Sem etapa</option>
              {stages.data?.stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {d.conversation.mode === 'BOT' && d.conversation.status !== 'CLOSED' && <button className="btn sm" disabled={busy} onClick={() => action('take', 'Você assumiu a conversa')}>Assumir</button>}
            {d.conversation.mode === 'HUMAN' && d.conversation.status !== 'CLOSED' && <button className="btn sm" disabled={busy} onClick={() => action('to_bot', 'Conversa devolvida ao robô')}>Devolver ao robô</button>}
            {(d.conversation.voicePreference === 'audio' || d.conversation.voicePreference === 'texto') && <span className="badge" title="O cliente pediu nesta conversa; a IA segue automaticamente (quando a voz está ligada)">{d.conversation.voicePreference === 'audio' ? '🔊 Prefere áudio' : '✍️ Prefere texto'}</span>}
            {d.contact && <button className="btn sm" onClick={() => setShowAiNotes((v) => !v)} title="Observações sobre este contato que a IA considera ao responder (o cliente não vê)">🧠 Notas para a IA ({(d.aiNotes ?? []).length})</button>}
            {d.conversation.status !== 'CLOSED'
              ? <button className="btn sm" disabled={busy} onClick={() => action('close', 'Conversa encerrada')}>Encerrar</button>
              : <button className="btn sm" disabled={busy} onClick={() => action('reopen', 'Conversa reaberta')}>Reabrir</button>}
          </div>
          {showAiNotes && d.contact && <AiNotesPanel contactId={d.contact.id} notes={d.aiNotes ?? []} onChange={refresh} onClose={() => setShowAiNotes(false)} />}
          {d.activeRun && <div className="alert info" style={{ margin: 8 }}>Fluxo em execução ({d.activeRun.status === 'WAITING' ? 'aguardando resposta do contato' : 'executando'}).</div>}
          <div className="msgs">
            {d.messages.length === 0 && !(d.aiNotes ?? []).length && <Empty title="Sem mensagens ainda" />}
            {timeline(d).map((m: any) => m.kind === 'ai_note' ? (
              <div key={'ai-' + m.id} className="bubble note ai-note" title="Nota para a IA: vale para todas as conversas deste contato e nunca é enviada ao cliente">
                <div className="small" style={{ fontWeight: 700 }}>🧠 Nota para a IA · {m.authorName ?? ''}</div>
                {m.body}
                <div className="meta"><span>{fmtDate(m.createdAt)}</span>{m.updatedAt && new Date(m.updatedAt).getTime() - new Date(m.createdAt).getTime() > 1000 && <span>editada</span>}</div>
              </div>
            ) : (
              <div key={m.id} className={`bubble ${m.direction === 'INTERNAL' ? 'note' : m.direction === 'OUT' ? 'out' : ''} ${m.status === 'FAILED' ? 'failed' : ''}`}>
                {m.direction !== 'IN' && <div className="small" style={{ fontWeight: 700 }}>{m.direction === 'INTERNAL' ? (m.sender === 'agent' ? `Nota interna · ${m.authorName ?? ''}` : 'Sistema') : m.sender === 'agent' ? m.authorName ?? 'Atendente' : SENDER[m.sender]}</div>}
                {m.mediaUrl && <div><a href={m.mediaUrl} target="_blank" rel="noreferrer">[{m.type}] abrir mídia</a></div>}
                {m.type === 'audio' && !m.mediaUrl ? (
                  // v1.23.0: áudio recebido (com a transcrição da IA) ou nota de voz enviada pela IA (texto falado).
                  <div>
                    {m.direction === 'OUT'
                      ? <div className="small"><span className="badge" title="A resposta foi enviada ao cliente como nota de voz; abaixo, o texto falado">🔊 enviado em áudio</span></div>
                      : <div className="small" style={{ fontWeight: 600 }}>🎤 Áudio</div>}
                    {m.transcript ? <div className="small" style={{ fontStyle: 'italic', whiteSpace: 'pre-wrap' }} title={m.direction === 'OUT' ? 'Texto falado no áudio' : 'Transcrição feita pela IA'}>{m.direction === 'IN' && <span className="muted" style={{ fontStyle: 'normal' }}>Transcrição: </span>}“{m.transcript}”</div>
                      : m.body === '[áudio não transcrito]' ? <div className="small muted" title="Não deu para transcrever este áudio (sem provedor de IA capaz, áudio longo demais ou falha). Ouça no celular.">[áudio não transcrito]</div>
                      : m.body && !/^\[.*\]$/.test(m.body) ? m.body : <div className="small muted">sem transcrição</div>}
                  </div>
                ) : m.body}
                {m.status === 'FAILED' && <div className="small" style={{ color: 'var(--danger)' }}>Não enviada: {m.error}</div>}
                {m.direction === 'IN' && typeof m.error === 'string' && m.error.startsWith('AUTORESPOSTA') && <div className="small" title={m.error.replace(/^AUTORESPOSTA:\s*/, '')}><span className="badge">🤖 Resposta automática</span> <span className="muted">não conta como resposta</span></div>}
                <div className="meta"><span>{fmtDate(m.createdAt)}</span>{m.direction === 'OUT' && <StatusBadge status={m.status} />}
                  {m.direction === 'OUT' && m.sender === 'ai' && can('OWNER', 'ADMIN') && <button type="button" className="linklike small" title="Escreva a resposta certa: ela entra na base de conhecimento e a IA passa a usar" onClick={() => { setFix({ id: m.id, body: m.transcript || m.body || '' }); setFixText(''); }}>👎 IA respondeu mal</button>}</div>
              </div>
            ))}
            <div ref={end} />
          </div>
          {d.conversation.status !== 'CLOSED' && (
            <div className="composer">
              {!d.conversation.withinWindow && !note && (
                <div className="alert warn small">Fora da janela de 24 horas: o WhatsApp só permite enviar um <strong>modelo aprovado</strong>. <button className="btn sm" onClick={() => setShowTpl(true)}>Enviar modelo</button></div>
              )}
              <div style={{ position: 'relative' }}>
                {barra && <ListaBarra itens={respostas} termo={barra.termo} ativo={barraAtivo} onEscolher={inserirResposta} vars={{ nome: d.contact?.name, atendente: me?.user?.name }} />}
                <textarea ref={taRef} placeholder={aiNote ? 'Nota para a IA sobre este contato (o cliente não vê; a IA considera ao responder)' : note ? 'Nota interna (o contato não vê)' : 'Mensagem… (digite / para respostas rápidas)'} value={text}
                  onChange={(e) => { setText(e.target.value); atualizarBarra(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
                  onBlur={() => setTimeout(() => setBarra(null), 150)}
                  onKeyDown={(e) => {
                    if (barra) {
                      const lista = listaFiltrada(respostas, barra.termo);
                      if (e.key === 'Escape') { e.preventDefault(); setBarra(null); return; }
                      if (e.key === 'ArrowDown' && lista.length) { e.preventDefault(); setBarraAtivo((barraAtivo + 1) % lista.length); return; }
                      if (e.key === 'ArrowUp' && lista.length) { e.preventDefault(); setBarraAtivo((barraAtivo - 1 + lista.length) % lista.length); return; }
                      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && lista.length) { e.preventDefault(); inserirResposta(lista[Math.min(barraAtivo, lista.length - 1)]); return; }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                  }} aria-label="Mensagem" />
              </div>
              <div className="row between">
                <div className="row">
                  <label className="row small"><input type="checkbox" checked={note} onChange={(e) => { setNote(e.target.checked); if (!e.target.checked) setAiNote(false); }} /> Nota interna</label>
                  <label className="row small" title="A nota fica salva no contato (vale em todas as conversas dele) e a IA passa a considerá-la. Nunca é enviada ao cliente."><input type="checkbox" checked={aiNote} onChange={(e) => { setAiNote(e.target.checked); if (e.target.checked) setNote(true); }} /> 🧠 Nota para a IA</label>
                  <button className="btn sm" onClick={() => setShowFlow(true)}>Enviar fluxo</button>
                  {!note && <button className="btn sm" onClick={() => setShowAgendar(true)} title="Enviar esta mensagem numa data e hora">🕒 Agendar</button>}
                  {!note && <button className="btn sm" onClick={() => setShowPix(true)} title="Enviar ao cliente um Pix com QR code e copia e cola, com a chave da empresa">💠 Cobrar Pix</button>}
                  {!note && <BotoesAssistente conversationId={id} disponivel={!!ia?.disponivel} motivo={ia?.motivo ?? 'Carregando…'} onSugestao={(t) => { setText(t); requestAnimationFrame(() => taRef.current?.focus()); }} />}
                </div>
                <button className="btn primary" disabled={!text.trim() || busy} onClick={send}>{aiNote ? 'Salvar nota para a IA' : note ? 'Salvar nota' : 'Enviar'}</button>
              </div>
            </div>
          )}
          {showPix && <PixModal conversationId={id} podeConfigurar={can('OWNER', 'ADMIN')} onClose={() => setShowPix(false)} onDone={refresh} />}
          {showAgendar && <AgendarModal conversationId={id} textoInicial={text} onClose={() => setShowAgendar(false)} onDone={() => { setText(''); refresh(); }} />}
          {fix && (
            <Modal title="IA respondeu mal" onClose={() => setFix(null)}>
              <p className="small muted" style={{ marginTop: 0 }}>Resposta da IA: “{fix.body.slice(0, 300)}”</p>
              <Field label="Qual seria a resposta certa?" hint="Vira um item da base de conhecimento (IA › Base de conhecimento) e passa na frente de trechos parecidos. Você pode desfazer em IA › Qualidade.">
                <textarea rows={4} value={fixText} onChange={(e) => setFixText(e.target.value)} placeholder="Ex.: O financiamento é feito pelo banco parceiro, em até 60 vezes, sujeito a análise de crédito." />
              </Field>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                <button className="btn" onClick={() => setFix(null)}>Cancelar</button>
                <button className="btn primary" disabled={busy || fixText.trim().length < 3} onClick={async () => { const r = await run(() => post('/ai/feedback', { messageId: fix.id, correction: fixText.trim() }), 'Correção salva: a IA passa a usar essa resposta'); if (r) { setFix(null); refresh(); } }}>Salvar correção</button>
              </div>
            </Modal>
          )}
          {showFlow && (
            <Modal title="Enviar fluxo para este contato" onClose={() => setShowFlow(false)}>
              {!flows.data ? <Loading /> : flows.data.length === 0 ? <Empty title="Nenhum fluxo criado" /> : (
                <div className="stack">
                  {flows.data.map((f) => (
                    <div key={f.id} className="row between">
                      <span>{f.name} <StatusBadge status={f.status} /></span>
                      <button className="btn sm primary" disabled={busy} onClick={async () => { const r = await run(() => post(`/flows/${f.id}/start`, { conversationId: id }), 'Fluxo iniciado'); if (r) { setShowFlow(false); refresh(); } }}>Iniciar</button>
                    </div>
                  ))}
                </div>
              )}
            </Modal>
          )}
          {showTpl && (
            <Modal title="Enviar modelo (template) aprovado" onClose={() => setShowTpl(false)}>
              <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await post(`/conversations/${id}/messages`, { type: 'template', ...tpl }); } catch { /* falha fica registrada */ } setShowTpl(false); refresh(); }}>
                <Field label="Nome do modelo" hint="Exatamente como aprovado no Gerenciador do WhatsApp (ex.: hello_world)"><input required pattern="[a-z0-9_]+" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} /></Field>
                <Field label="Idioma"><input required value={tpl.language} onChange={(e) => setTpl({ ...tpl, language: e.target.value })} /></Field>
                <button className="btn primary">Enviar modelo</button>
              </form>
            </Modal>
          )}
        </>
      )}</Async>
    </div>
  );
}

/** Mensagens da conversa + notas para a IA do contato, em ordem cronológica. */
function timeline(d: any): any[] {
  const notes = (d.aiNotes ?? []).map((n: any) => ({ ...n, kind: 'ai_note' }));
  return [...d.messages, ...notes].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

