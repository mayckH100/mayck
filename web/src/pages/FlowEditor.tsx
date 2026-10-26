import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow, Background, Controls, Handle, Position, addEdge, applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type ReactFlowInstance, type NodeChange, type EdgeChange, type Connection, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { get, post, put } from '../api';
import { useAuth } from '../auth';
import { useAction, Loading, ErrorBox, StatusBadge, Modal, fmtDate, Field, useApi, useToast, copy } from '../ui';

type NodeType = 'start' | 'send_text' | 'send_media' | 'menu' | 'ask' | 'condition' | 'ai' | 'wait' | 'http' | 'handoff' | 'tag' | 'end';

const META: Record<NodeType, { label: string; color: string; outs: (d: any) => { id: string; label: string; color?: string }[]; defaults: () => any }> = {
  start: { label: 'Início', color: '#d90429', outs: () => [{ id: 'next', label: '' }], defaults: () => ({ triggers: [{ type: 'keyword', value: '', match: 'contains' }] }) },
  send_text: { label: 'Enviar texto', color: '#2f6fde', outs: () => [{ id: 'next', label: '' }], defaults: () => ({ text: 'Olá, {{contact_name}}!' }) },
  send_media: { label: 'Enviar mídia', color: '#2f6fde', outs: () => [{ id: 'next', label: '' }], defaults: () => ({ mediaType: 'image', url: '', caption: '' }) },
  menu: { label: 'Menu de opções', color: '#8b5cf6', outs: (d) => [...(d.options ?? []).map((o: any, i: number) => ({ id: `opt-${o.id}`, label: String(i + 1) })), { id: 'invalid', label: '✕', color: '#d64545' }], defaults: () => ({ text: 'Escolha uma opção:', options: [{ id: 'o1', label: 'Opção 1' }, { id: 'o2', label: 'Opção 2' }], style: 'text' }) },
  ask: { label: 'Perguntar e salvar', color: '#8b5cf6', outs: () => [{ id: 'next', label: 'ok' }, { id: 'invalid', label: '✕', color: '#d64545' }], defaults: () => ({ question: 'Qual é o seu nome?', variable: 'nome', validation: 'text' }) },
  condition: { label: 'Condição', color: '#b7791f', outs: () => [{ id: 'yes', label: 'sim', color: '#2f6fde' }, { id: 'no', label: 'não', color: '#d64545' }], defaults: () => ({ logic: 'all', rules: [{ variable: 'last_message', operator: 'contains', value: '' }] }) },
  ai: { label: 'Resposta com IA', color: '#0e9f6e', outs: () => [{ id: 'next', label: 'ok' }, { id: 'handoff', label: 'humano', color: '#d64545' }], defaults: () => ({ instructions: '', continueConversation: false }) },
  wait: { label: 'Aguardar', color: '#64748b', outs: () => [{ id: 'next', label: '' }], defaults: () => ({ seconds: 5 }) },
  http: { label: 'Webhook HTTP', color: '#0891b2', outs: () => [{ id: 'success', label: '2xx' }, { id: 'error', label: 'erro', color: '#d64545' }], defaults: () => ({ method: 'GET', url: '', headers: '', body: '', mappings: [] }) },
  tag: { label: 'Etiqueta / etapa', color: '#64748b', outs: () => [{ id: 'next', label: '' }], defaults: () => ({ action: 'add', tag: '' }) },
  handoff: { label: 'Transferir p/ humano', color: '#d64545', outs: () => [], defaults: () => ({ message: 'Vou chamar um atendente para você.' }) },
  end: { label: 'Encerrar', color: '#334155', outs: () => [], defaults: () => ({ message: '', closeConversation: false }) },
};

const TRIGGER_LABEL: Record<string, string> = { message: 'Mensagem recebida', keyword: 'Palavra-chave', first_message: 'Primeira mensagem', schedule: 'Horário' };

function summary(type: NodeType, d: any): string {
  switch (type) {
    case 'start': return (d.triggers ?? []).map((t: any) => `${TRIGGER_LABEL[t.type]}${t.value ? `: ${t.value}` : ''}${t.type === 'schedule' ? ` ${t.start ?? ''}–${t.end ?? ''}` : ''}`).join(' · ') || 'Sem gatilho';
    case 'send_text': return d.text;
    case 'send_media': return `${d.mediaType}: ${d.url || '(sem URL)'}`;
    case 'menu': return `${d.text} (${(d.options ?? []).map((o: any) => o.label).join(', ')})`;
    case 'ask': return `${d.question} → {{${d.variable}}}`;
    case 'condition': return (d.rules ?? []).map((r: any) => `${r.variable} ${r.operator} ${r.value ?? ''}`).join(d.logic === 'any' ? ' OU ' : ' E ');
    case 'ai': return d.instructions || 'Usa as configurações de IA';
    case 'wait': return `${d.seconds}s`;
    case 'http': return `${d.method} ${d.url || '(sem URL)'} · ${(d.mappings ?? []).length} map(s)`;
    case 'tag': return `${d.action === 'remove' ? 'Remover' : 'Adicionar'} etiqueta ${d.tag}`;
    case 'handoff': return d.message;
    case 'end': return d.closeConversation ? 'Encerra a conversa' : 'Fim do fluxo';
  }
}

function FlowNode({ data, type, selected }: NodeProps) {
  const t = type as NodeType;
  const m = META[t];
  const outs = m.outs(data);
  const st = (data as any).__stats as { ok: number; warn: number; error: number } | undefined;
  return (
    <div className={`fnode ${selected ? 'sel' : ''}`} style={{ borderTop: `4px solid ${m.color}` }}>
      {t !== 'start' && <Handle type="target" position={Position.Left} />}
      <div className="t"><span>{m.label}</span></div>
      <div className="d">{summary(t, data)}</div>
      {st && <div className="stats"><span style={{ color: '#2f6fde' }}>{st.ok} ok</span><span style={{ color: '#b7791f' }}>{st.warn} alerta</span><span style={{ color: '#d64545' }}>{st.error} erro</span></div>}
      {outs.length > 1 && <div className="handles-row">{outs.map((o) => <span key={o.id}>{o.label}</span>)}</div>}
      {outs.map((o, i) => (
        <Handle key={o.id} id={o.id} type="source" position={outs.length > 1 ? Position.Bottom : Position.Right}
          style={{ background: o.color ?? '#d90429', width: 10, height: 10, ...(outs.length > 1 ? { left: `${((i + 1) / (outs.length + 1)) * 100}%` } : {}) }} />
      ))}
    </div>
  );
}

const nodeTypes = Object.fromEntries(Object.keys(META).map((k) => [k, FlowNode]));
const VARS = ['contact_name', 'contact_phone', 'contact_id', 'contact_tags', 'conversation_id', 'organization_id', 'last_message', 'http_status', 'http_error'];
const uid = () => Math.random().toString(36).slice(2, 8);

export default function FlowEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const readOnly = !can('OWNER', 'ADMIN');
  const [flow, setFlow] = useState<any>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [stats, setStats] = useState<Record<string, any>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [modal, setModal] = useState<'versions' | 'runs' | null>(null);
  const { busy, run } = useAction();
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await get(`/flows/${id}`);
      setFlow(d.flow);
      setNodes(d.graph.nodes.map((n: any) => ({ ...n, data: { ...n.data } })));
      setEdges(d.graph.edges.map((e: any) => ({ ...e, animated: false })));
      setProblems(d.problems);
      setStats(d.nodeStats);
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const viewNodes = useMemo(() => nodes.map((n) => ({ ...n, data: { ...n.data, __stats: stats[n.id] } })), [nodes, stats]);
  const onNodesChange = useCallback((c: NodeChange[]) => { setNodes((ns) => applyNodeChanges(c, ns)); if (c.some((x) => x.type !== 'select' && x.type !== 'dimensions')) setDirty(true); }, []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => { setEdges((es) => applyEdgeChanges(c, es)); if (c.some((x) => x.type !== 'select')) setDirty(true); }, []);
  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge({ ...c, id: `e-${uid()}` }, es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? 'next') === (c.sourceHandle ?? 'next')))));
    setDirty(true);
  }, []);

  const addNode = (type: NodeType) => {
    if (type === 'start' && nodes.some((n) => n.type === 'start')) { toast('O fluxo já tem um bloco Início', 'err'); return; }
    const nid = `${type}-${uid()}`;
    // Posiciona ao lado do bloco selecionado (ou do último) e enquadra a visão para o novo bloco ficar visível.
    const ref = nodes.find((n) => n.id === selected) ?? nodes[nodes.length - 1];
    const position = ref ? { x: ref.position.x + 280, y: ref.position.y + 40 } : { x: 40, y: 80 };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id: nid, type, position, selected: true, data: META[type].defaults() }]);
    setSelected(nid);
    setDirty(true);
    setTimeout(() => rf?.fitView({ padding: 0.2, duration: 200, maxZoom: 1 }), 30);
  };
  const updateData = (nid: string, patchData: any) => {
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, ...patchData } } : n)));
    setDirty(true);
  };
  const removeNode = (nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid));
    setSelected(null);
    setDirty(true);
  };
  const graphPayload = () => ({
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: Object.fromEntries(Object.entries(n.data).filter(([k]) => !k.startsWith('__'))) })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? 'next' })),
  });
  const save = async () => {
    const r = await run(() => put(`/flows/${id}`, { name: flow.name, description: flow.description, priority: flow.priority, graph: graphPayload() }), 'Fluxo salvo (nova versão)');
    if (r) { setFlow(r.flow); setProblems(r.problems); setDirty(false); }
  };
  const toggle = async () => {
    if (dirty) { toast('Salve as alterações antes de ativar/pausar', 'err'); return; }
    const r = await run(() => post(`/flows/${id}/status`, { status: flow.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }), flow.status === 'ACTIVE' ? 'Fluxo pausado' : 'Fluxo ativado');
    if (r) setFlow(r);
  };

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!flow) return <Loading />;
  const sel = nodes.find((n) => n.id === selected);
  return (
    <>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div className="row" style={{ flex: 1 }}>
          <button className="btn sm" onClick={() => { if (!dirty || confirm('Sair sem salvar as alterações?')) nav('/fluxos'); }}>← Voltar</button>
          <input aria-label="Nome do fluxo" value={flow.name} disabled={readOnly} onChange={(e) => { setFlow({ ...flow, name: e.target.value }); setDirty(true); }} style={{ maxWidth: 280, fontWeight: 700 }} />
          <StatusBadge status={flow.status} /><span className="badge">v{flow.currentVersion}</span>
          {dirty && <span className="badge amber">Alterações não salvas</span>}
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => setModal('runs')}>Execuções</button>
          <button className="btn sm" onClick={() => setModal('versions')}>Versões</button>
          {!readOnly && <>
            <button className="btn sm" disabled={busy} onClick={toggle}>{flow.status === 'ACTIVE' ? 'Pausar' : 'Ativar'}</button>
            <button className="btn primary sm" disabled={busy || !dirty} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>
          </>}
        </div>
      </div>
      {problems.length > 0 && <div className="alert warn" style={{ marginBottom: 10 }}><strong>Corrija antes de ativar:</strong> {problems.join(' · ')}</div>}
      <div className="editor">
        <div className="palette">
          <div className="small muted" style={{ fontWeight: 700 }}>Blocos</div>
          {(Object.keys(META) as NodeType[]).map((t) => (
            <button key={t} className="btn sm" disabled={readOnly} onClick={() => addNode(t)} style={{ borderLeft: `4px solid ${META[t].color}`, justifyContent: 'flex-start' }}>{META[t].label}</button>
          ))}
          <p className="small muted" style={{ marginTop: 8 }}>Conecte as saídas (bolinhas) à entrada do próximo bloco. Condição: azul = sim, vermelho = não.</p>
        </div>
        <div className="canvas" style={{ minHeight: 0 }}>
          <ReactFlow nodes={viewNodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onInit={setRf} onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)} fitView fitViewOptions={{ maxZoom: 1 }} nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable deleteKeyCode={readOnly ? null : ['Delete']}>
            <Background /><Controls />
          </ReactFlow>
        </div>
        <div className="props">
          {!sel ? (
            <div className="stack">
              <h3>Propriedades</h3>
              <p className="small muted">Clique em um bloco para editar. Use Delete para remover conexões selecionadas.</p>
              <Field label="Descrição"><textarea disabled={readOnly} value={flow.description ?? ''} onChange={(e) => { setFlow({ ...flow, description: e.target.value }); setDirty(true); }} /></Field>
              <Field label="Prioridade" hint="Com gatilhos de mesma força, vence o fluxo de maior prioridade."><input type="number" disabled={readOnly} value={flow.priority} onChange={(e) => { setFlow({ ...flow, priority: Number(e.target.value) }); setDirty(true); }} /></Field>
              <div><div className="small muted" style={{ fontWeight: 700 }}>Variáveis disponíveis</div><div className="row" style={{ marginTop: 4 }}>{VARS.map((v) => <button key={v} className="badge" style={{ border: 0, cursor: 'pointer' }} onClick={() => copy(`{{${v}}}`, toast)}>{`{{${v}}}`}</button>)}</div>
                <p className="small muted">Variáveis salvas por "Perguntar" e pelo mapeamento do HTTP também podem ser usadas.</p></div>
            </div>
          ) : (
            <NodeEditor key={sel.id} node={sel} readOnly={readOnly} onChange={(p) => updateData(sel.id, p)} onRemove={() => removeNode(sel.id)} />
          )}
        </div>
      </div>
      {modal === 'versions' && <Versions id={id!} readOnly={readOnly} onClose={() => setModal(null)} onRestored={() => { setModal(null); load(); }} />}
      {modal === 'runs' && <Runs id={id!} onClose={() => setModal(null)} />}
    </>
  );
}

function NodeEditor({ node, onChange, onRemove, readOnly }: { node: Node; onChange: (p: any) => void; onRemove: () => void; readOnly: boolean }) {
  const d = node.data as any;
  const t = node.type as NodeType;
  const integrations = useApi<any[]>(t === 'http' ? '/integrations' : null);
  const stages = useApi<any>(t === 'tag' ? '/kanban' : null);
  const [testRes, setTestRes] = useState<any>(null);
  const { busy, run } = useAction();
  const inp = (k: string, props: any = {}) => <input disabled={readOnly} value={d[k] ?? ''} onChange={(e) => onChange({ [k]: props.type === 'number' ? Number(e.target.value) : e.target.value })} {...props} />;
  const area = (k: string, props: any = {}) => <textarea disabled={readOnly} value={d[k] ?? ''} onChange={(e) => onChange({ [k]: e.target.value })} {...props} />;
  const list = (k: string) => (d[k] ?? []) as any[];
  const setList = (k: string, v: any[]) => onChange({ [k]: v });
  return (
    <fieldset disabled={readOnly} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <h3>{META[t].label}</h3>
      {t === 'start' && (
        <>
          {list('triggers').map((tr, i) => (
            <div key={i} className="card stack" style={{ padding: 10 }}>
              <select value={tr.type} onChange={(e) => setList('triggers', list('triggers').map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                {Object.entries(TRIGGER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              {tr.type === 'keyword' && <>
                <input placeholder="palavras, separadas por vírgula" value={tr.value ?? ''} onChange={(e) => setList('triggers', list('triggers').map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <select value={tr.match ?? 'contains'} onChange={(e) => setList('triggers', list('triggers').map((x, j) => (j === i ? { ...x, match: e.target.value } : x)))}>
                  <option value="contains">Contém no texto</option><option value="equals">Igual à mensagem inteira</option>
                </select></>}
              {tr.type === 'schedule' && <>
                <div className="row"><input type="time" value={tr.start ?? '08:00'} onChange={(e) => setList('triggers', list('triggers').map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} style={{ width: 'auto' }} /> até
                  <input type="time" value={tr.end ?? '18:00'} onChange={(e) => setList('triggers', list('triggers').map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} style={{ width: 'auto' }} /></div>
                <div className="row small">{['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((n, di) => (
                  <label key={di} className="row"><input type="checkbox" checked={(tr.days ?? []).includes(di)} onChange={(e) => setList('triggers', list('triggers').map((x, j) => (j === i ? { ...x, days: e.target.checked ? [...(x.days ?? []), di] : (x.days ?? []).filter((y: number) => y !== di) } : x)))} />{n}</label>
                ))}</div>
                <p className="small muted">Dispara para mensagens recebidas dentro da janela (fuso da organização). Sem dias marcados = todos os dias.</p></>}
              <button className="btn sm danger" onClick={() => setList('triggers', list('triggers').filter((_, j) => j !== i))}>Remover gatilho</button>
            </div>
          ))}
          <button className="btn sm" onClick={() => setList('triggers', [...list('triggers'), { type: 'keyword', value: '', match: 'contains' }])}>+ Adicionar gatilho</button>
          <p className="small muted">Força dos gatilhos: palavra-chave &gt; primeira mensagem &gt; horário &gt; qualquer mensagem.</p>
        </>
      )}
      {t === 'send_text' && <><Field label="Texto">{area('text', { rows: 6 })}</Field><label className="row small"><input type="checkbox" checked={!!d.previewUrl} onChange={(e) => onChange({ previewUrl: e.target.checked })} /> Pré-visualização de link</label></>}
      {t === 'send_media' && <>
        <Field label="Tipo"><select value={d.mediaType} onChange={(e) => onChange({ mediaType: e.target.value })}><option value="image">Imagem</option><option value="video">Vídeo</option><option value="document">Documento</option><option value="audio">Áudio</option></select></Field>
        <Field label="URL pública da mídia" hint="HTTPS acessível pela Meta">{inp('url', { placeholder: 'https://…' })}</Field>
        {d.mediaType !== 'audio' && <Field label="Legenda">{inp('caption')}</Field>}
        {d.mediaType === 'document' && <Field label="Nome do arquivo">{inp('filename')}</Field>}
      </>}
      {t === 'menu' && <>
        <Field label="Texto do menu">{area('text')}</Field>
        <Field label="Formato"><select value={d.style ?? 'text'} onChange={(e) => onChange({ style: e.target.value })}><option value="text">Lista numerada (texto)</option><option value="buttons">Botões (até 3 opções)</option></select></Field>
        {list('options').map((o, i) => (
          <div key={o.id} className="row"><span className="small">{i + 1}.</span><input value={o.label} maxLength={20} onChange={(e) => setList('options', list('options').map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)))} style={{ flex: 1 }} />
            <button className="btn sm danger" aria-label="Remover opção" onClick={() => setList('options', list('options').filter((x) => x.id !== o.id))}>✕</button></div>
        ))}
        <button className="btn sm" onClick={() => setList('options', [...list('options'), { id: uid(), label: `Opção ${list('options').length + 1}` }])}>+ Opção</button>
        <Field label="Salvar escolha na variável">{inp('variable', { placeholder: 'menu_choice' })}</Field>
        <Field label="Mensagem para resposta inválida">{inp('invalidText', { placeholder: 'Opção inválida…' })}</Field>
      </>}
      {t === 'ask' && <>
        <Field label="Pergunta">{area('question')}</Field>
        <Field label="Salvar na variável" hint="Letras, números e _ (ex.: nome, email, cidade)">{inp('variable')}</Field>
        <Field label="Validação"><select value={d.validation ?? 'text'} onChange={(e) => onChange({ validation: e.target.value })}><option value="text">Texto livre</option><option value="number">Número</option><option value="email">E-mail</option><option value="phone">Telefone</option></select></Field>
        <Field label="Mensagem de erro">{inp('errorText', { placeholder: 'Resposta inválida, tente novamente.' })}</Field>
      </>}
      {t === 'condition' && <>
        <Field label="Combinar regras"><select value={d.logic ?? 'all'} onChange={(e) => onChange({ logic: e.target.value })}><option value="all">Todas (E)</option><option value="any">Qualquer uma (OU)</option></select></Field>
        {list('rules').map((r, i) => (
          <div key={i} className="card stack" style={{ padding: 8 }}>
            <input placeholder="variável (ex.: last_message, cidade)" value={r.variable} onChange={(e) => setList('rules', list('rules').map((x, j) => (j === i ? { ...x, variable: e.target.value } : x)))} />
            <select value={r.operator} onChange={(e) => setList('rules', list('rules').map((x, j) => (j === i ? { ...x, operator: e.target.value } : x)))}>
              <option value="equals">é igual a</option><option value="not_equals">é diferente de</option><option value="contains">contém</option><option value="not_contains">não contém</option><option value="starts_with">começa com</option><option value="gt">maior que</option><option value="lt">menor que</option><option value="exists">está preenchida</option><option value="not_exists">está vazia</option>
            </select>
            {!['exists', 'not_exists'].includes(r.operator) && <input placeholder="valor" value={r.value ?? ''} onChange={(e) => setList('rules', list('rules').map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />}
            <button className="btn sm danger" onClick={() => setList('rules', list('rules').filter((_, j) => j !== i))}>Remover regra</button>
          </div>
        ))}
        <button className="btn sm" onClick={() => setList('rules', [...list('rules'), { variable: '', operator: 'equals', value: '' }])}>+ Regra</button>
      </>}
      {t === 'ai' && <>
        <Field label="Instruções extras para este ponto" hint="Somam-se às instruções gerais da página IA">{area('instructions')}</Field>
        <label className="row small"><input type="checkbox" checked={!!d.continueConversation} onChange={(e) => onChange({ continueConversation: e.target.checked })} /> Continuar conversando (aguarda e responde as próximas mensagens)</label>
        <p className="small muted">Saída "humano": usada quando a IA não sabe, o cliente pede atendente, falha o provedor ou o limite é atingido.</p>
      </>}
      {t === 'wait' && <Field label="Segundos">{inp('seconds', { type: 'number', min: 1 })}</Field>}
      {t === 'http' && <>
        <Field label="Integração (opcional)" hint="Usa a URL base e a credencial cifrada da integração">
          <select value={d.integrationId ?? ''} onChange={(e) => onChange({ integrationId: e.target.value || undefined })}>
            <option value="">Nenhuma (URL completa)</option>
            {integrations.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </Field>
        <Field label="Método"><select value={d.method} onChange={(e) => onChange({ method: e.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select></Field>
        <Field label="URL">{inp('url', { placeholder: 'https://api.exemplo.com/clientes/{{contact_phone}}' })}</Field>
        <Field label="Cabeçalhos (JSON)">{area('headers', { placeholder: '{"Authorization": "Bearer …"}', rows: 3 })}</Field>
        {['POST', 'PUT', 'PATCH'].includes(d.method) && <Field label="Corpo (JSON)">{area('body', { placeholder: '{"telefone": "{{contact_phone}}"}', rows: 4 })}</Field>}
        <button className="btn sm" disabled={busy || !d.url} onClick={async () => setTestRes(await run(() => post('/flows/http-test', { method: d.method, url: d.url, headers: d.headers, body: d.body, integrationId: d.integrationId })))}>Testar requisição</button>
        {testRes && <div className={`alert ${testRes.ok ? 'ok' : 'err'} small`}><strong>{testRes.status || 'Erro'}</strong> {testRes.error}{testRes.ms ? ` · ${testRes.ms} ms` : ''}<pre className="mono" style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(testRes.json ?? testRes.text, null, 2)}</pre></div>}
        <div className="small muted" style={{ fontWeight: 700 }}>Mapeamento JSON → variáveis</div>
        {list('mappings').map((m, i) => (
          <div key={i} className="row"><input placeholder="variável" value={m.variable} onChange={(e) => setList('mappings', list('mappings').map((x, j) => (j === i ? { ...x, variable: e.target.value } : x)))} style={{ flex: 1 }} />
            <input placeholder="caminho (data.nome)" value={m.path} onChange={(e) => setList('mappings', list('mappings').map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} style={{ flex: 1 }} />
            <button className="btn sm danger" aria-label="Remover mapeamento" onClick={() => setList('mappings', list('mappings').filter((_, j) => j !== i))}>✕</button></div>
        ))}
        <button className="btn sm" onClick={() => setList('mappings', [...list('mappings'), { variable: '', path: '' }])}>+ Adicionar variável</button>
        <p className="small muted">Saída verde = HTTP 2xx; vermelha = erro (variáveis http_status e http_error). Endereços internos são bloqueados.</p>
      </>}
      {t === 'tag' && <>
        <Field label="Ação"><select value={d.action} onChange={(e) => onChange({ action: e.target.value })}><option value="add">Adicionar etiqueta</option><option value="remove">Remover etiqueta</option></select></Field>
        <Field label="Etiqueta">{inp('tag')}</Field>
        <Field label="Mover no Kanban para (opcional)"><select value={d.stageId ?? ''} onChange={(e) => onChange({ stageId: e.target.value || undefined })}><option value="">Não mover</option>{stages.data?.stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </>}
      {t === 'handoff' && <Field label="Mensagem ao contato (opcional)">{area('message')}</Field>}
      {t === 'end' && <><Field label="Mensagem final (opcional)">{area('message')}</Field><label className="row small"><input type="checkbox" checked={!!d.closeConversation} onChange={(e) => onChange({ closeConversation: e.target.checked })} /> Encerrar a conversa</label></>}
      {!readOnly && <button className="btn danger sm" onClick={onRemove}>Remover bloco</button>}
      <p className="small muted mono">id: {node.id}</p>
    </fieldset>
  );
}

function Versions({ id, onClose, onRestored, readOnly }: { id: string; onClose: () => void; onRestored: () => void; readOnly: boolean }) {
  const state = useApi<any>(`/flows/${id}/versions`);
  const { busy, run } = useAction();
  return (
    <Modal title="Versões do fluxo" onClose={onClose}>
      {!state.data ? <Loading /> : (
        <table><tbody>{state.data.versions.map((v: any) => (
          <tr key={v.version}><td>v{v.version} {v.version === state.data.current && <span className="badge green">atual</span>}</td><td>{fmtDate(v.createdAt)}</td>
            <td>{!readOnly && v.version !== state.data.current && <button className="btn sm" disabled={busy} onClick={async () => { if (await run(() => post(`/flows/${id}/restore/${v.version}`), `Versão ${v.version} restaurada como nova versão`)) onRestored(); }}>Restaurar</button>}</td></tr>
        ))}</tbody></table>
      )}
    </Modal>
  );
}

function Runs({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useApi<any[]>(`/flows/${id}/runs`);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Modal title="Últimas execuções" onClose={onClose}>
      {!state.data ? <Loading /> : state.data.length === 0 ? <p className="muted">Nenhuma execução registrada ainda.</p> : (
        <div className="stack">
          {state.data.map((r) => (
            <div key={r.id} className="card" style={{ padding: 10 }}>
              <div className="row between"><span><StatusBadge status={r.status} /> {r.contact?.name ?? r.contact?.phone} · v{r.flowVersion}</span><button className="btn sm" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Ocultar' : 'Etapas'}</button></div>
              <div className="small muted">{fmtDate(r.startedAt)} · {r.stepCount} passo(s){r.error && <span style={{ color: 'var(--danger)' }}> · {r.error}</span>}</div>
              {open === r.id && <table className="small" style={{ marginTop: 6 }}><tbody>{r.steps.map((s: any) => (
                <tr key={s.id}><td>{new Date(s.createdAt).toLocaleTimeString('pt-BR')}</td><td>{s.nodeType}</td><td><span className={`badge ${s.status === 'ok' ? 'green' : s.status === 'warn' ? 'amber' : 'red'}`}>{s.status}</span></td><td>{s.detail}</td></tr>
              ))}</tbody></table>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
