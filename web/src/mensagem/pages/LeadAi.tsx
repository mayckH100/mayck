import { useEffect, useState } from 'react';
import { put, post } from '../../api';
import { useApi, Async, Field, useAction } from '../../ui';

interface Settings {
  enabled: boolean; instructions: string; offer: string; positiveAction: 'HANDOFF' | 'FLOW' | 'BOT';
  positiveFlowId: string | null; retryDays: number; maxAttempts: number; retryMessage: string; promptTemplate: string | null;
  positiveMessage: string; negativeAction: 'RETRY' | 'FLOW' | 'HANDOFF' | 'DISCARD'; negativeFlowId: string | null;
  doubtAction: 'AI' | 'FLOW' | 'HANDOFF'; doubtFlowId: string | null; tagPositive: string; tagWaiting: string; tagDiscarded: string;
}
interface View {
  settings: Settings; flows: { id: string; name: string }[]; aiReady: boolean; aiProvider: string | null; aiModel: string | null;
  counts: { aguardando: number; qualificados: number }; prompt: string;
  defaultPromptTemplate: string; promptVariables: string[]; lockedPrompt: string;
}
interface TestResult { intent: 'POSITIVO' | 'NEGATIVO' | 'DUVIDA' | 'SAIR'; reply: string; summary: string }

const INTENT_LABEL: Record<TestResult['intent'], string> = {
  POSITIVO: 'Interessado (positivo)', NEGATIVO: 'Sem interesse (negativo)', DUVIDA: 'Dúvida', SAIR: 'Pediu para sair → opt-out',
};

function Form({ view, onSaved }: { view: View; onSaved: (v: View) => void }) {
  const withTpl = (st: Settings) => ({ ...st, promptTemplate: st.promptTemplate ?? view.defaultPromptTemplate });
  const [f, setF] = useState<Settings>(withTpl(view.settings));
  const { busy, run } = useAction();
  const [texto, setTexto] = useState('Oi, como funciona o teste?');
  const [test, setTest] = useState<TestResult | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  useEffect(() => setF(withTpl(view.settings)), [view.settings]);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    const r = await run(() => put<View>('/mckmensagem/ia-leads', f), 'IA de qualificação salva');
    if (r) onSaved(r);
  };
  const testar = async () => {
    setTest(null);
    const r = await run(() => post<TestResult>('/mckmensagem/ia-leads/testar', { texto }));
    if (r) setTest(r);
  };

  return (
    <div className="stack">
      {!view.aiReady && <div className="alert warn">Configure o provedor e a chave da IA no MCKBOT &gt; IA. A qualificação usa a mesma IA (e a mesma base de conhecimento).</div>}
      <div className="grid g2">
        <div className="card stat"><div className="v">{view.counts.qualificados}</div><div className="l">Leads qualificados</div></div>
        <div className="card stat"><div className="v">{view.counts.aguardando}</div><div className="l">Em aguardo (nova tentativa agendada)</div></div>
      </div>

      <div className="card stack">
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <b>Ativar IA de qualificação nas respostas das campanhas</b>
        </label>
        <p className="muted small">Quando um lead abordado por campanha responde, a IA entende se ele tem interesse, responde e move o lead automaticamente.</p>
        <Field label="Como abordar e qualificar" hint="O que você vende, para quem, e o que perguntar para descobrir o interesse.">
          <textarea rows={5} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder="Ex.: Somos uma loja de carros seminovos revisados, com garantia e financiamento. Descubra qual modelo a pessoa procura, a faixa de preço e se tem carro para dar na troca. Destaque o test drive sem compromisso." />
        </Field>
        <Field label="Próximo passo para quem tem interesse" hint="O que a IA oferece quando o lead diz sim.">
          <input value={f.offer} onChange={(e) => set('offer', e.target.value)} placeholder="Ex.: agendar um test drive na loja e fazer uma simulação de financiamento" />
        </Field>
      </div>

      <div className="card stack">
        <h3>Quando o lead responde POSITIVO</h3>
        <p className="muted small">O lead vira <b>Qualificado</b> e a IA confirma o interesse com o próximo passo.</p>
        <Field label="Depois da resposta da IA">
          <select value={f.positiveAction} onChange={(e) => set('positiveAction', e.target.value as Settings['positiveAction'])}>
            <option value="HANDOFF">Transferir para um atendente</option>
            <option value="FLOW">Iniciar um fluxo do MCKBOT</option>
            <option value="BOT">Continuar com o robô e a IA do MCKBOT</option>
          </select>
        </Field>
        {f.positiveAction === 'FLOW' && <FlowSelect flows={view.flows} value={f.positiveFlowId} onChange={(v) => set('positiveFlowId', v)} />}
        <Field label="Mensagem extra (opcional)" hint="Enviada logo depois da resposta da IA. Ex.: link de agendamento, catálogo, endereço. Use {nome}.">
          <textarea rows={2} value={f.positiveMessage} onChange={(e) => set('positiveMessage', e.target.value)} placeholder="Ex.: Agende seu horário aqui: https://..." />
        </Field>
        <Field label="Etiqueta do contato"><input value={f.tagPositive} onChange={(e) => set('tagPositive', e.target.value)} placeholder="lead-qualificado" /></Field>
      </div>

      <div className="card stack">
        <h3>Quando o lead responde NEGATIVO</h3>
        <p className="muted small">A IA agradece sem insistir. Depois disso:</p>
        <Field label="Ação">
          <select value={f.negativeAction} onChange={(e) => set('negativeAction', e.target.value as Settings['negativeAction'])}>
            <option value="RETRY">Deixar em aguardo e tentar de novo depois</option>
            <option value="FLOW">Iniciar um fluxo do MCKBOT</option>
            <option value="HANDOFF">Transferir para um atendente</option>
            <option value="DISCARD">Descartar o lead (não abordar mais)</option>
          </select>
        </Field>
        {f.negativeAction === 'FLOW' && <FlowSelect flows={view.flows} value={f.negativeFlowId} onChange={(v) => set('negativeFlowId', v)} />}
        {f.negativeAction === 'RETRY' && <>
          <div className="grid g2">
            <Field label="Nova tentativa após (dias)"><input type="number" min={1} max={60} value={f.retryDays} onChange={(e) => set('retryDays', Number(e.target.value) || 1)} /></Field>
            <Field label="Descartar depois de quantos 'não'" hint="Ao atingir, o lead vira Descartado."><input type="number" min={1} max={10} value={f.maxAttempts} onChange={(e) => set('maxAttempts', Number(e.target.value) || 1)} /></Field>
          </div>
          <Field label="Mensagem da nova tentativa" hint="Use {nome} para o primeiro nome.">
            <textarea rows={3} value={f.retryMessage} onChange={(e) => set('retryMessage', e.target.value)} />
          </Field>
        </>}
        <div className="grid g2">
          <Field label="Etiqueta em aguardo"><input value={f.tagWaiting} onChange={(e) => set('tagWaiting', e.target.value)} placeholder="lead-aguardando" /></Field>
          <Field label="Etiqueta descartado"><input value={f.tagDiscarded} onChange={(e) => set('tagDiscarded', e.target.value)} placeholder="lead-descartado" /></Field>
        </div>
      </div>

      <div className="card stack">
        <h3>Quando o lead tem DÚVIDA</h3>
        <Field label="Ação">
          <select value={f.doubtAction} onChange={(e) => set('doubtAction', e.target.value as Settings['doubtAction'])}>
            <option value="AI">A IA responde e conduz para o próximo passo</option>
            <option value="FLOW">Iniciar um fluxo do MCKBOT</option>
            <option value="HANDOFF">Transferir para um atendente</option>
          </select>
        </Field>
        {f.doubtAction === 'FLOW' && <FlowSelect flows={view.flows} value={f.doubtFlowId} onChange={(v) => set('doubtFlowId', v)} />}
        <p className="muted small">Se o lead pedir para sair, ele recebe opt-out na hora e não é mais abordado (regra fixa, protege seu número).</p>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={save}>Salvar</button></div>

      <div className="card stack">
        <h3>Testar</h3>
        <p className="muted small">Simule a resposta de um lead. Nada é enviado no WhatsApp e nenhum lead é alterado (usa a configuração salva).</p>
        <div className="row" style={{ gap: 8 }}>
          <input style={{ flex: 1 }} value={texto} onChange={(e) => setTexto(e.target.value)} />
          <button className="btn" disabled={busy || !texto.trim()} onClick={testar}>Testar</button>
        </div>
        {test && (
          <div className="stack">
            <div><span className="badge blue">{INTENT_LABEL[test.intent]}</span></div>
            <div className="card" style={{ background: 'var(--bg-soft, #f6f7fb)' }}>{test.reply || <i className="muted">(sem texto)</i>}</div>
            {test.summary && <div className="muted small">Resumo: {test.summary}</div>}
          </div>
        )}
      </div>

      <div className="card stack">
        <h3>Prompt da IA</h3>
        <p className="muted small">Edite como a IA pensa e responde. As variáveis entre chaves são trocadas automaticamente: {view.promptVariables.map((v) => <code key={v} style={{ marginRight: 6 }}>{v}</code>)}</p>
        <textarea rows={18} style={{ fontFamily: 'monospace', fontSize: 12 }} value={f.promptTemplate ?? ''} onChange={(e) => set('promptTemplate', e.target.value)} />
        <div className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => set('promptTemplate', view.defaultPromptTemplate)}>Restaurar padrão</button>
          <button className="btn primary" disabled={busy} onClick={save}>Salvar prompt</button>
        </div>
        <button className="btn sm" onClick={() => setShowPrompt((x) => !x)}>{showPrompt ? 'Ocultar' : 'Ver'} a parte fixa (não editável)</button>
        {showPrompt && <>
          <p className="muted small">Esta parte é sempre adicionada no final: é o formato que o sistema lê para mover o lead (Qualificado, Aguardando, Descartado). Por isso não pode ser alterada.</p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{view.lockedPrompt}</pre>
        </>}
      </div>
    </div>
  );
}

function FlowSelect({ flows, value, onChange }: { flows: { id: string; name: string }[]; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <Field label="Fluxo">
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Escolha um fluxo ativo…</option>
        {flows.map((fl) => <option key={fl.id} value={fl.id}>{fl.name}</option>)}
      </select>
    </Field>
  );
}

export default function MmLeadAi() {
  const state = useApi<View>('/mckmensagem/ia-leads');
  return (
    <>
      <div className="page-head"><div><h1>IA de qualificação</h1><p className="muted">A IA conversa com quem respondeu às campanhas, separa os interessados e agenda novas tentativas para quem disse não.</p></div></div>
      <Async state={state}>{(v) => <Form view={v} onSaved={(nv) => state.setData(nv)} />}</Async>
    </>
  );
}
