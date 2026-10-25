import { useEffect, useState } from 'react';
import { post, put, del } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, fmtDate, fmtNum } from '../ui';

// Padrão Gemini: modelo recomendado pelo Google para projetos novos (out/2026), disponível no plano gratuito.
const MODELS: Record<string, string> = { gemini: 'gemini-3.5-flash-lite', openai: '' };

export default function Ai() {
  const [tab, setTab] = useState<'config' | 'kb' | 'test' | 'usage'>('config');
  return (
    <>
      <div className="page-head"><div><h1>Inteligência artificial</h1><p className="muted">Instruções, tom de voz, base de conhecimento, provedor/modelo, limites e transferência para humano.</p></div></div>
      <div className="tabs">
        {([['config', 'Configuração'], ['kb', 'Base de conhecimento'], ['test', 'Testar'], ['usage', 'Uso']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'config' && <Config />}
      {tab === 'kb' && <Knowledge />}
      {tab === 'test' && <TestAi />}
      {tab === 'usage' && <Usage />}
    </>
  );
}

function Config() {
  const state = useApi<any>('/ai/settings');
  const { can } = useAuth();
  const [f, setF] = useState<any>(null);
  const [apiKey, setApiKey] = useState('');
  const { busy, run } = useAction();
  useEffect(() => { if (state.data) setF({ ...state.data, handoffKeywords: state.data.handoffKeywords.join(', '), baseUrl: state.data.baseUrl ?? '' }); }, [state.data]);
  const ro = !can('OWNER', 'ADMIN');
  return (
    <Async state={state}>{(s) => !f ? null : (
      <form className="grid g2" onSubmit={async (e) => {
        e.preventDefault();
        const body: any = {
          enabled: f.enabled, autoReply: f.autoReply, provider: f.provider, model: f.model, baseUrl: f.provider === 'openai' ? f.baseUrl : '',
          instructions: f.instructions, tone: f.tone, temperature: Number(f.temperature), maxTokens: Number(f.maxTokens), dailyLimit: Number(f.dailyLimit), monthlyTokenLimit: Number(f.monthlyTokenLimit),
          handoffKeywords: f.handoffKeywords.split(',').map((x: string) => x.trim()).filter(Boolean), fallbackMessage: f.fallbackMessage,
        };
        if (apiKey) body.apiKey = apiKey;
        const r = await run(() => put('/ai/settings', body), 'Configurações da IA salvas');
        if (r) { setApiKey(''); state.setData(r); }
      }}>
        <fieldset disabled={ro} className="card stack" style={{ margin: 0 }}>
          <h2>Provedor e modelo</h2>
          {!s.hasApiKey && <div className="alert warn">Nenhuma chave configurada: a IA não responde até você salvar uma chave. O Google Gemini tem camada gratuita (crie a chave em aistudio.google.com).</div>}
          <Field label="Provedor"><select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value, model: MODELS[e.target.value] ?? f.model })}><option value="gemini">Google Gemini</option><option value="openai">OpenAI ou compatível (Groq, OpenRouter, etc.)</option></select></Field>
          <Field label="Modelo" hint={f.provider === 'gemini' ? 'Ex.: gemini-3.5-flash-lite (gratuito) ou gemini-3.8-flash. Lista em ai.google.dev/gemini-api/docs/models' : 'Nome exato do modelo no seu provedor'}><input required value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
          {f.provider === 'openai' && <Field label="URL base (opcional)" hint="Deixe vazio para api.openai.com. Para compatíveis, ex.: https://api.groq.com/openai/v1"><input type="url" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} /></Field>}
          <Field label="Chave de API" hint={s.hasApiKey ? `Chave salva (cifrada): ${s.apiKeyPreview}. Preencha só para trocar.` : 'Guardada cifrada (AES-256-GCM).'}><input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.hasApiKey ? '••••••••' : 'Cole sua chave'} /></Field>
          {s.hasApiKey && !ro && <button type="button" className="btn sm danger" disabled={busy} onClick={async () => { const r = await run(() => put('/ai/settings', { clearApiKey: true }), 'Chave removida'); if (r) state.setData(r); }}>Remover chave</button>}
          <div className="grid g2">
            <Field label="Temperatura"><input type="number" step="0.1" min={0} max={2} value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })} /></Field>
            <Field label="Máx. tokens por resposta"><input type="number" min={50} max={4000} value={f.maxTokens} onChange={(e) => setF({ ...f, maxTokens: e.target.value })} /></Field>
            <Field label="Limite de respostas por dia"><input type="number" min={0} value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: e.target.value })} /></Field>
            <Field label="Limite de tokens por mês"><input type="number" min={0} value={f.monthlyTokenLimit} onChange={(e) => setF({ ...f, monthlyTokenLimit: e.target.value })} /></Field>
          </div>
        </fieldset>
        <fieldset disabled={ro} className="card stack" style={{ margin: 0 }}>
          <h2>Comportamento</h2>
          <label className="row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> IA ativada (permite o bloco "Resposta com IA" nos fluxos)</label>
          <label className="row"><input type="checkbox" checked={f.autoReply} onChange={(e) => setF({ ...f, autoReply: e.target.checked })} /> Responder automaticamente quando nenhum fluxo for acionado</label>
          <Field label="Instruções" hint="Quem é a empresa, o que vende, como atender. A IA usa a base de conhecimento para fatos."><textarea rows={6} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
          <Field label="Tom de voz"><input value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })} /></Field>
          <Field label="Palavras que pedem humano" hint="Separadas por vírgula"><input value={f.handoffKeywords} onChange={(e) => setF({ ...f, handoffKeywords: e.target.value })} /></Field>
          <Field label="Mensagem de transferência/fallback"><textarea rows={2} required value={f.fallbackMessage} onChange={(e) => setF({ ...f, fallbackMessage: e.target.value })} /></Field>
          <div className="alert info small">Regra fixa: a IA não informa preços, prazos ou políticas que não estejam na base de conhecimento. Se citar um valor não confirmado, a resposta é bloqueada e a conversa vai para um atendente.</div>
          {!ro && <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar configurações'}</button>}
        </fieldset>
      </form>
    )}</Async>
  );
}

function Knowledge() {
  const state = useApi<any[]>('/ai/knowledge');
  const { can } = useAuth();
  const [edit, setEdit] = useState<any>(null);
  const { busy, run } = useAction();
  const ro = !can('OWNER', 'ADMIN');
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0 }}>Cole FAQ, tabela de preços, políticas e horários. O texto é dividido em trechos e os mais relevantes vão para a IA a cada pergunta.</p>
        {!ro && <button className="btn primary" onClick={() => setEdit({ title: '', content: '' })}>+ Documento</button>}
      </div>
      <Async state={state}>{(docs) => docs.length === 0 ? <div className="card"><Empty title="Base de conhecimento vazia">Sem documentos, a IA não responde perguntas sobre preços e políticas — transfere para um humano.</Empty></div> : (
        <div className="grid g2">
          {docs.map((d) => (
            <div key={d.id} className="card stack">
              <div className="row between"><strong>{d.title}</strong><span className="badge">{d.chunks} trecho(s)</span></div>
              <p className="small muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 90, overflow: 'hidden' }}>{d.content}</p>
              <div className="row between small"><span className="muted">Atualizado {fmtDate(d.updatedAt)}</span>
                {!ro && <div className="row"><button className="btn sm" onClick={() => setEdit(d)}>Editar</button><button className="btn sm danger" disabled={busy} onClick={() => { if (confirm('Excluir documento?')) run(() => del(`/ai/knowledge/${d.id}`), 'Documento excluído').then(state.reload); }}>Excluir</button></div>}</div>
            </div>
          ))}
        </div>
      )}</Async>
      {edit && (
        <Modal title={edit.id ? 'Editar documento' : 'Novo documento'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => (edit.id ? put(`/ai/knowledge/${edit.id}`, { title: edit.title, content: edit.content }) : post('/ai/knowledge', { title: edit.title, content: edit.content })), 'Documento salvo e indexado');
            if (ok) { setEdit(null); state.reload(); }
          }}>
            <Field label="Título"><input required maxLength={200} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Conteúdo"><textarea required rows={12} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} /></Field>
            <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
          </form>
        </Modal>
      )}
    </>
  );
}

function TestAi() {
  const { can } = useAuth();
  const [msg, setMsg] = useState('');
  const [res, setRes] = useState<any>(null);
  const { busy, run } = useAction();
  if (!can('OWNER', 'ADMIN')) return <div className="card"><Empty title="Somente administradores podem testar a IA" /></div>;
  return (
    <div className="card stack">
      <p className="muted">Simula uma pergunta de cliente usando sua configuração real (consome a sua cota do provedor). Nada é enviado no WhatsApp.</p>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); setRes(await run(() => post('/ai/test', { message: msg }))); }}>
        <input required value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Ex.: Qual o horário de atendimento?" style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy}>{busy ? 'Consultando…' : 'Perguntar'}</button>
      </form>
      {res && (
        <div className="stack">
          <div className={`alert ${res.handoff ? 'warn' : 'ok'}`}><strong>{res.handoff ? 'Transferiria para humano' : 'Resposta'}:</strong> {res.text ?? '(nenhum texto)'}{res.reason && <div className="small">Motivo: {res.reason}</div>}{res.error && <div className="small">Erro do provedor: {res.error}</div>}</div>
          <h3>Trechos usados da base</h3>
          {res.sources.length === 0 ? <p className="small muted">Nenhum trecho relevante encontrado.</p> : res.sources.map((s: any, i: number) => <div key={i} className="small"><strong>{s.title}</strong> (relevância {s.score}) — {s.text}</div>)}
        </div>
      )}
    </div>
  );
}

function Usage() {
  const state = useApi<any>('/ai/usage');
  return (
    <Async state={state}>{(u) => (
      <div className="stack">
        <div className="grid g4">
          <div className="card stat"><div className="l">Requisições (30d)</div><div className="v">{fmtNum(u.total)}</div></div>
          <div className="card stat"><div className="l">Falhas</div><div className="v">{fmtNum(u.failed)}</div></div>
          <div className="card stat"><div className="l">Transferências</div><div className="v">{fmtNum(u.handoffs)}</div></div>
          <div className="card stat"><div className="l">Tokens (entrada + saída)</div><div className="v">{fmtNum(u.promptTokens + u.completionTokens)}</div><div className="small muted">Latência média {u.avgLatencyMs} ms</div></div>
        </div>
        <div className="card table-wrap">
          <h2>Últimas chamadas</h2>
          {u.recent.length === 0 ? <Empty title="Nenhuma chamada de IA ainda" /> : (
            <table><thead><tr><th>Quando</th><th>Modelo</th><th>Tokens</th><th>Resultado</th></tr></thead>
              <tbody>{u.recent.map((r: any) => <tr key={r.id}><td>{fmtDate(r.createdAt)}</td><td>{r.provider}/{r.model}</td><td>{r.promptTokens + r.completionTokens}</td><td>{r.success ? <span className="badge green">ok</span> : <span className="badge red">erro</span>} {r.handoff && <span className="badge blue">transferiu</span>} <span className="small muted">{r.error}</span></td></tr>)}</tbody></table>
          )}
        </div>
      </div>
    )}</Async>
  );
}
