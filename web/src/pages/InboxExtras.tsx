/**
 * v1.41.0 — Inbox: lista do "/" (respostas rápidas), mensagens agendadas e configurações do atendimento
 * (respostas rápidas, distribuição automática, horário de atendimento e pesquisa de satisfação).
 */
import { useEffect, useMemo, useState } from 'react';
import { post, put, del } from '../api';
import { useApi, Async, Empty, Loading, useAction, Modal, Field, fmtDate } from '../ui';
import { filtrarRespostas, renderResposta, DIAS, descreverHorario, type Faixa, type RespostaRapida } from '../../../server/inbox/core';

// ---------------- Lista do "/" ----------------

export function ListaBarra({ itens, termo, ativo, onEscolher, vars }: {
  itens: RespostaRapida[]; termo: string; ativo: number; onEscolher: (r: RespostaRapida) => void; vars: { nome?: string | null; atendente?: string | null };
}) {
  const lista = filtrarRespostas(itens, termo);
  return (
    <div className="card" role="listbox" aria-label="Respostas rápidas" style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 4, maxHeight: 260, overflowY: 'auto', zIndex: 20, padding: 4, boxShadow: '0 6px 24px rgba(0,0,0,.15)' }}>
      {lista.length === 0
        ? <div className="small muted" style={{ padding: 8 }}>{itens.length ? `Nenhuma resposta rápida com "/${termo}".` : 'Nenhuma resposta rápida cadastrada. O administrador cadastra em ⚙️ Atendimento › Respostas rápidas.'}</div>
        : lista.map((r, i) => (
          <button key={r.id} type="button" role="option" aria-selected={i === ativo} className="linklike" onMouseDown={(e) => { e.preventDefault(); onEscolher(r); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 6, background: i === ativo ? 'var(--hover, #f1f5f9)' : 'transparent', color: 'inherit', textDecoration: 'none' }}>
            <strong>/{r.shortcut}</strong> <span className="small muted">{renderResposta(r.text, vars).slice(0, 90)}</span>
          </button>
        ))}
      <div className="small muted" style={{ padding: '4px 8px' }}>↑ ↓ para escolher · Enter ou Tab para inserir · Esc para fechar</div>
    </div>
  );
}

export const listaFiltrada = (itens: RespostaRapida[], termo: string) => filtrarRespostas(itens, termo);

// ---------------- Mensagens agendadas ----------------

const STATUS_AG: Record<string, [string, string]> = { PENDENTE: ['Agendada', 'blue'], ENVIANDO: ['Enviando', 'blue'], ENVIADA: ['Enviada', 'green'], FALHOU: ['Falhou', 'red'], CANCELADA: ['Cancelada', ''] };

function amanha9h() {
  const d = new Date(Date.now() + 86400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}

export function AgendarModal({ conversationId, textoInicial, onClose, onDone }: { conversationId: string; textoInicial: string; onClose: () => void; onDone: () => void }) {
  const lista = useApi<{ items: any[] }>(`/inbox/conversas/${conversationId}/agendadas`, [conversationId]);
  const [texto, setTexto] = useState(textoInicial);
  const [quando, setQuando] = useState(amanha9h());
  const { busy, run } = useAction();
  const agendar = async () => {
    const r = await run(() => post(`/inbox/conversas/${conversationId}/agendadas`, { text: texto, sendAt: quando }), 'Mensagem agendada');
    if (r) { setTexto(''); lista.reload(); onDone(); }
  };
  return (
    <Modal title="Agendar mensagem" onClose={onClose}>
      <div className="stack">
        <Field label="Mensagem"><textarea rows={4} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ex.: Oi! Passando para lembrar do seu horário amanhã." /></Field>
        <Field label="Enviar em" hint="Horário de Brasília (fuso da empresa). Até 90 dias à frente."><input type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" onClick={onClose}>Fechar</button>
          <button className="btn primary" disabled={busy || !texto.trim() || !quando} onClick={agendar}>Agendar</button>
        </div>
        <h3 style={{ margin: '8px 0 0' }}>Agendadas nesta conversa</h3>
        <Async state={lista}>{(d) => d.items.length === 0 ? <div className="small muted">Nenhuma mensagem agendada.</div> : (
          <div className="stack">
            {d.items.map((m) => (
              <div key={m.id} className="row between" style={{ alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="small"><strong>{fmtDate(m.sendAt)}</strong> <span className={`badge ${STATUS_AG[m.status]?.[1] ?? ''}`}>{STATUS_AG[m.status]?.[0] ?? m.status}</span>{m.autor && <span className="muted"> · {m.autor}</span>}</div>
                  <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                  {m.error && <div className="small" style={{ color: 'var(--danger)' }}>{m.error}</div>}
                </div>
                {m.status === 'PENDENTE' && <button className="btn sm" disabled={busy} onClick={async () => { const r = await run(() => del(`/inbox/agendadas/${m.id}`), 'Agendamento cancelado'); if (r) lista.reload(); }}>Cancelar</button>}
              </div>
            ))}
          </div>
        )}</Async>
      </div>
    </Modal>
  );
}

// ---------------- Configurações do atendimento ----------------

const ABAS = [['respostas', 'Respostas rápidas'], ['distribuicao', 'Distribuição'], ['horario', 'Horário'], ['pesquisa', 'Pesquisa de satisfação']] as const;

export function AtendimentoModal({ onClose, onChange }: { onClose: () => void; onChange: () => void }) {
  const [aba, setAba] = useState<string>('respostas');
  return (
    <Modal title="⚙️ Configurações do atendimento" onClose={onClose}>
      <div className="tabs" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {ABAS.map(([k, l]) => <button key={k} className={aba === k ? 'on' : ''} onClick={() => setAba(k)}>{l}</button>)}
      </div>
      {aba === 'respostas' ? <RespostasRapidas onChange={onChange} /> : <ConfigAtendimento aba={aba} />}
    </Modal>
  );
}

function RespostasRapidas({ onChange }: { onChange: () => void }) {
  const lista = useApi<{ items: RespostaRapida[] }>('/inbox/respostas-rapidas');
  const [edit, setEdit] = useState<{ id?: string; shortcut: string; text: string } | null>(null);
  const { busy, run } = useAction();
  const salvar = async () => {
    if (!edit) return;
    const r = await run(() => (edit.id ? put(`/inbox/respostas-rapidas/${edit.id}`, edit) : post('/inbox/respostas-rapidas', edit)), 'Resposta rápida salva');
    if (r) { setEdit(null); lista.reload(); onChange(); }
  };
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>No campo de mensagem, digite <strong>/</strong> e o atalho para inserir o texto. Use <code>{'{nome}'}</code> para o primeiro nome do cliente e <code>{'{atendente}'}</code> para o seu nome.</p>
      {edit ? (
        <div className="stack card" style={{ padding: 10 }}>
          <Field label="Atalho" hint="Ex.: preco, pix, endereco (sem espaços)"><input value={edit.shortcut} maxLength={30} onChange={(e) => setEdit({ ...edit, shortcut: e.target.value })} placeholder="preco" /></Field>
          <Field label="Texto"><textarea rows={4} maxLength={2000} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} placeholder="Olá {nome}! Nossos planos começam em..." /></Field>
          {edit.text && <div className="small muted">Prévia: {renderResposta(edit.text, { nome: 'Maria Silva', atendente: 'Ana' })}</div>}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <button className="btn" onClick={() => setEdit(null)}>Cancelar</button>
            <button className="btn primary" disabled={busy || !edit.shortcut.trim() || !edit.text.trim()} onClick={salvar}>Salvar</button>
          </div>
        </div>
      ) : <div><button className="btn primary sm" onClick={() => setEdit({ shortcut: '', text: '' })}>+ Nova resposta rápida</button></div>}
      <Async state={lista}>{(d) => d.items.length === 0 ? <Empty title="Nenhuma resposta rápida">Crie atalhos para as mensagens que você mais manda.</Empty> : (
        <div className="table-wrap"><table className="small"><thead><tr><th>Atalho</th><th>Texto</th><th /></tr></thead><tbody>
          {d.items.map((r) => (
            <tr key={r.id}>
              <td><strong>/{r.shortcut}</strong></td>
              <td style={{ whiteSpace: 'pre-wrap' }}>{r.text.length > 160 ? r.text.slice(0, 160) + '…' : r.text}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn sm" onClick={() => setEdit({ id: r.id, shortcut: r.shortcut, text: r.text })}>Editar</button>{' '}
                <button className="btn sm" disabled={busy} onClick={async () => { if (!window.confirm(`Excluir a resposta /${r.shortcut}?`)) return; const x = await run(() => del(`/inbox/respostas-rapidas/${r.id}`), 'Resposta rápida excluída'); if (x) { lista.reload(); onChange(); } }}>Excluir</button>
              </td>
            </tr>
          ))}
        </tbody></table></div>
      )}</Async>
    </div>
  );
}

const SEMANA_PADRAO: Faixa[] = [1, 2, 3, 4, 5].map((dia) => ({ dia, inicio: '08:00', fim: '18:00' }));

function ConfigAtendimento({ aba }: { aba: string }) {
  const cfg = useApi<any>('/inbox/config');
  const [f, setF] = useState<any>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (cfg.data) setF({ ...cfg.data, hours: cfg.data.hours?.length ? cfg.data.hours : SEMANA_PADRAO }); }, [cfg.data]);
  const resumo = useMemo(() => (f ? descreverHorario(f.hours ?? []) : ''), [f]);
  if (cfg.error) return <Async state={cfg}>{() => null}</Async>;
  if (!f) return <Loading />;
  const salvar = async (campos: string[]) => {
    const body = Object.fromEntries(campos.map((k) => [k, f[k]]));
    const r = await run(() => put('/inbox/config', body), 'Configuração salva');
    if (r) cfg.reload();
  };
  const setFaixa = (i: number, k: keyof Faixa, v: string | number) => setF({ ...f, hours: f.hours.map((x: Faixa, j: number) => (j === i ? { ...x, [k]: v } : x)) });
  if (aba === 'distribuicao') return (
    <div className="stack">
      <label className="row"><input type="checkbox" checked={f.autoAssign} onChange={(e) => setF({ ...f, autoAssign: e.target.checked })} /> <strong>Distribuir automaticamente as conversas que vão para a equipe</strong></label>
      <p className="small muted" style={{ margin: 0 }}>Vale quando a conversa vai para atendimento humano (o cliente pediu um atendente, um fluxo transferiu ou nenhuma automação respondeu). Enquanto a IA ou um fluxo está respondendo, nada muda. Só recebe quem tem acesso ao Inbox e ao WhatsApp da conversa.</p>
      <Field label="Como distribuir">
        <select value={f.assignStrategy} onChange={(e) => setF({ ...f, assignStrategy: e.target.value })}>
          <option value="rodizio">Rodízio (um de cada vez, na ordem da equipe)</option>
          <option value="menos_ocupado">Menos ocupado (quem tem menos conversas abertas)</option>
        </select>
      </Field>
      <label className="row small"><input type="checkbox" checked={f.assignOnlineOnly} onChange={(e) => setF({ ...f, assignOnlineOnly: e.target.checked })} /> Só para quem está online (com o app aberto nos últimos 15 minutos). Sem ninguém online, a conversa fica na fila e é distribuída na próxima mensagem.</label>
      <Field label="Quem participa" hint="Nenhum marcado = toda a equipe com acesso ao Inbox">
        <div className="stack">{f.membros.map((m: any) => (
          <label key={m.userId} className="row small"><input type="checkbox" checked={f.assignUserIds.includes(m.userId)} onChange={(e) => setF({ ...f, assignUserIds: e.target.checked ? [...f.assignUserIds, m.userId] : f.assignUserIds.filter((x: string) => x !== m.userId) })} /> {m.nome} {m.online ? <span className="badge green">online</span> : <span className="badge">offline</span>}</label>
        ))}</div>
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={() => salvar(['autoAssign', 'assignStrategy', 'assignOnlineOnly', 'assignUserIds'])}>Salvar</button></div>
    </div>
  );
  if (aba === 'horario') return (
    <div className="stack">
      <label className="row"><input type="checkbox" checked={f.hoursEnabled} onChange={(e) => setF({ ...f, hoursEnabled: e.target.checked })} /> <strong>Mandar mensagem automática fora do horário de atendimento</strong></label>
      <p className="small muted" style={{ margin: 0 }}>Só quando a conversa está com a equipe (humano). Se a IA estiver respondendo no WhatsApp, ela continua respondendo normalmente a qualquer hora. Horário de Brasília.</p>
      <div className="stack">
        {f.hours.map((x: Faixa, i: number) => (
          <div key={i} className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select aria-label="Dia" value={x.dia} style={{ width: 130 }} onChange={(e) => setFaixa(i, 'dia', Number(e.target.value))}>{DIAS.map((d, n) => <option key={n} value={n}>{d}</option>)}</select>
            <input aria-label="Início" type="time" value={x.inicio} style={{ width: 110 }} onChange={(e) => setFaixa(i, 'inicio', e.target.value)} />
            <span className="small">às</span>
            <input aria-label="Fim" type="time" value={x.fim} style={{ width: 110 }} onChange={(e) => setFaixa(i, 'fim', e.target.value)} />
            <button className="btn sm" onClick={() => setF({ ...f, hours: f.hours.filter((_: Faixa, j: number) => j !== i) })}>Remover</button>
          </div>
        ))}
        <div><button className="btn sm" onClick={() => setF({ ...f, hours: [...f.hours, { dia: 6, inicio: '08:00', fim: '12:00' }] })}>+ Adicionar faixa</button></div>
        {resumo && <div className="small muted">Resumo: {resumo}</div>}
      </div>
      <Field label="Mensagem" hint="Variáveis: {nome} (primeiro nome do cliente) e {horario} (o resumo acima). Vazio = texto padrão."><textarea rows={3} value={f.awayMessage} placeholder={f.padroes.awayMessage} onChange={(e) => setF({ ...f, awayMessage: e.target.value })} /></Field>
      <Field label="Repetir para o mesmo cliente no máximo a cada (horas)"><input type="number" min={1} max={168} value={f.awayEveryHours} onChange={(e) => setF({ ...f, awayEveryHours: Number(e.target.value) || 12 })} style={{ width: 100 }} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={() => salvar(['hoursEnabled', 'hours', 'awayMessage', 'awayEveryHours'])}>Salvar</button></div>
    </div>
  );
  return (
    <div className="stack">
      <label className="row"><input type="checkbox" checked={f.csatEnabled} onChange={(e) => setF({ ...f, csatEnabled: e.target.checked })} /> <strong>Enviar pesquisa de satisfação ao encerrar a conversa</strong></label>
      <p className="small muted" style={{ margin: 0 }}>Ao clicar em Encerrar, o cliente recebe a pergunta. A resposta seguinte, de 1 a 5 e em até 24 horas, vira a nota. A média aparece em Relatórios.</p>
      <Field label="Pergunta" hint="Vazio = texto padrão"><textarea rows={2} value={f.csatQuestion} placeholder={f.padroes.csatQuestion} onChange={(e) => setF({ ...f, csatQuestion: e.target.value })} /></Field>
      <Field label="Agradecimento depois da nota" hint="Vazio = texto padrão"><input value={f.csatThanks} placeholder={f.padroes.csatThanks} onChange={(e) => setF({ ...f, csatThanks: e.target.value })} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={() => salvar(['csatEnabled', 'csatQuestion', 'csatThanks'])}>Salvar</button></div>
    </div>
  );
}
