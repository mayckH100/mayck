import { useEffect, useState } from 'react';
import { put, post } from '../../api';
import { useApi, Async, Field, useAction } from '../../ui';

/**
 * SDR com IA › Inteligência (v1.21.0): método de qualificação (Padrão, BANT, SPIN) e os recursos da fase 2.
 * Tudo que muda mensagens para os leads vem desligado: a empresa liga quando quiser.
 */
export default function Inteligencia() {
  const state = useApi<any>('/sdr/inteligencia');
  return <Async state={state}>{(v) => <Form v={v} onSaved={state.reload} />}</Async>;
}

function Form({ v, onSaved }: { v: any; onSaved: () => void }) {
  const [f, setF] = useState<any>(v);
  const { run, busy } = useAction();
  useEffect(() => setF(v), [v]);
  const save = async () => { if (await run(() => put('/sdr/inteligencia', bodyOf(f)), 'Inteligência salva')) onSaved(); };
  const metodo = v.metodos.find((m: any) => m.id === f.metodo) ?? v.metodos[0];
  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Método de qualificação</h3>
        <p className="small muted" style={{ margin: 0 }}>Como a IA conduz a conversa e pontua o lead. Em cada lead você vê o porquê da pontuação.</p>
        <Field label="Método">
          <select value={f.metodo} onChange={(e) => setF({ ...f, metodo: e.target.value })}>
            {v.metodos.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
        <div className="small">
          {metodo.perguntas.map((q: any) => <div key={q.id} className="row between"><span>{q.pergunta}</span><span className="badge">peso {q.peso}</span></div>)}
        </div>
        {f.metodo === 'PADRAO' && <p className="small muted" style={{ margin: 0 }}>As perguntas do método Padrão são editadas em Configuração.</p>}
      </div>
      <Objecoes f={f} setF={setF} padrao={v.objecoesPadrao} />
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Dados da empresa do lead</h3>
        <Toggle checked={!!f.cnpj} onChange={(x) => setF({ ...f, cnpj: x })} label="Completar pelo CNPJ (Receita Federal, grátis)" hint="Quando o lead informa o CNPJ (na conversa, no formulário ou no cadastro), buscamos razão social, atividade, situação, regime e cidade. Não envia nada ao lead; se a consulta falhar, nada muda." />
      </div>
      <div><button className="btn primary" disabled={busy} onClick={save}>Salvar</button></div>
    </div>
  );
}

function bodyOf(f: any) {
  return {
    metodo: f.metodo,
    cnpj: !!f.cnpj,
    objecoes: { enabled: !!f.objecoes.enabled, itens: f.objecoes.itens.map((o: any) => ({ id: o.id, titulo: o.titulo, resposta: o.resposta, gatilhos: Array.isArray(o.gatilhos) ? o.gatilhos : String(o.gatilhos).split(',') })) },
  };
}

/** Ligado só quando a empresa quer: muda as respostas da IA aos leads. */
function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><strong>{label}</strong>{hint ? <><br /><span className="small muted">{hint}</span></> : null}</span>
    </label>
  );
}

function Objecoes({ f, setF, padrao }: { f: any; setF: (x: any) => void; padrao: any[] }) {
  const o = f.objecoes;
  const set = (patch: any) => setF({ ...f, objecoes: { ...o, ...patch } });
  const setItem = (i: number, patch: any) => set({ itens: o.itens.map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Biblioteca de objeções</h3>
      <Toggle checked={!!o.enabled} onChange={(x) => set({ enabled: x })} label="A IA usa estas respostas quando o lead levantar uma objeção" hint="Muda as respostas da IA aos leads. O vendedor também vê no histórico qual objeção apareceu." />
      {o.itens.map((x: any, i: number) => (
        <div key={i} className="stack" style={{ borderTop: '1px solid #e5e7eb', paddingTop: 8 }}>
          <div className="row">
            <input value={x.titulo} maxLength={80} onChange={(e) => setItem(i, { titulo: e.target.value })} aria-label="Objeção" style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={() => set({ itens: o.itens.filter((_: any, j: number) => j !== i) })}>Remover</button>
          </div>
          <Field label="Quando o lead disser (separe por vírgula)"><input value={Array.isArray(x.gatilhos) ? x.gatilhos.join(', ') : x.gatilhos} maxLength={900} onChange={(e) => setItem(i, { gatilhos: e.target.value })} /></Field>
          <Field label="Como a IA deve responder"><textarea rows={2} value={x.resposta} maxLength={600} onChange={(e) => setItem(i, { resposta: e.target.value })} /></Field>
        </div>
      ))}
      <div className="row">
        <button className="btn sm" disabled={o.itens.length >= 20} onClick={() => set({ itens: [...o.itens, { titulo: '', gatilhos: '', resposta: '' }] })}>+ Objeção</button>
        <button className="btn sm ghost" onClick={() => set({ itens: padrao })}>Restaurar padrão</button>
      </div>
    </div>
  );
}

const NIVEL: Record<string, { label: string; color: string }> = {
  forte: { label: 'forte', color: '#16a34a' }, medio: { label: 'médio', color: '#f59e0b' }, fraco: { label: 'fraco', color: '#dc2626' }, falta: { label: 'falta', color: '#9ca3af' },
};

/** Bloco do lead (janela do lead): por que a pontuação é essa e o que fazer agora. */
export function LeadInteligencia({ id }: { id: string }) {
  const state = useApi<any>(`/sdr/inteligencia/leads/${id}`, [id]);
  const [cnpj, setCnpj] = useState('');
  const { run, busy } = useAction();
  const buscar = async () => {
    const r: any = await run(() => post(`/sdr/inteligencia/leads/${id}/cnpj`, { cnpj }));
    if (r) { if (r.aviso) alert(r.aviso); state.reload(); }
  };
  return (
    <Async state={state}>{(d) => (
      <>
      <div className="card stack">
        <strong>Empresa do lead</strong>
        {d.empresa ? (
          <div className="small">
            <div><strong>{d.empresa.fantasia || d.empresa.razaoSocial}</strong>{d.empresa.fantasia ? <span className="muted"> · {d.empresa.razaoSocial}</span> : null}</div>
            <div className="muted">CNPJ {d.empresa.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}{d.empresa.situacao ? ` · ${d.empresa.situacao}` : ''}{d.empresa.regime ? ` · ${d.empresa.regime}` : ''}{d.empresa.cidade ? ` · ${d.empresa.cidade}/${d.empresa.uf}` : ''}</div>
            {d.empresa.atividade && <div>Atividade: {d.empresa.atividade}</div>}
          </div>
        ) : (
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (cnpj.trim()) buscar(); }}>
            <input value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="CNPJ do lead" maxLength={20} style={{ width: 200 }} />
            <button className="btn sm" disabled={busy || !cnpj.trim()}>Completar pela Receita</button>
          </form>
        )}
      </div>
      <div className="card stack">
        <strong>Por que esta pontuação? <span className="small muted">({d.explicacao.titulo})</span></strong>
        <p className="small" style={{ margin: 0 }}>{d.explicacao.porque}</p>
        <p className="small" style={{ margin: 0 }}><strong>Próximo passo sugerido:</strong> {d.explicacao.proximaAcao}</p>
        <div className="small stack" style={{ gap: 4 }}>
          {d.explicacao.fatores.map((x: any) => (
            <div key={x.id} className="row between">
              <span><span className="muted">{x.label}:</span> {x.resposta ?? <em className="muted">ainda não respondeu</em>}{x.motivo ? <span className="muted"> — {x.motivo}</span> : null}</span>
              <span className="badge" style={{ background: NIVEL[x.nivel].color, color: '#fff' }}>{x.nota === null ? NIVEL[x.nivel].label : `+${x.pontos} pts`}</span>
            </div>
          ))}
        </div>
      </div>
      </>
    )}</Async>
  );
}
