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
      <Conversa f={f} setF={setF} />
      <Objecoes f={f} setF={setF} padrao={v.objecoesPadrao} />
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Acompanhamento (cadências)</h3>
        <Toggle checked={!!f.followupIa} onChange={(x) => setF({ ...f, followupIa: x })} label="A IA personaliza cada follow-up com o que o lead já disse" hint="Muda as mensagens das cadências. Usa a cota diária da IA; se a IA não responder, sai o texto padrão do passo." />
        <Toggle checked={!!f.melhorHorario} onChange={(x) => setF({ ...f, melhorHorario: x })} label="Enviar no horário em que o lead mais responde" hint="Sempre dentro do seu horário comercial (fuso da empresa, padrão Brasília). Sem histórico, envia às 10h. Adia no máximo um dia." />
      </div>
      <AutoResposta f={f} setF={setF} />
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Privacidade (LGPD)</h3>
        <Toggle checked={!!f.optOutAuto} onChange={(x) => setF({ ...f, optOutAuto: x })} label="Entender pedidos para sair escritos de outro jeito" hint='Além de "SAIR" e "PARAR", frases como "não quero mais receber", "me tira da lista" ou "pare de me mandar mensagem" param todas as mensagens automáticas para esse contato. Não envia nada.' />
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Reuniões</h3>
        <Toggle checked={!!f.reuniao.ofertaHorarios} onChange={(x) => setF({ ...f, reuniao: { ...f.reuniao, ofertaHorarios: x } })} label="A IA propõe horários livres da Agenda a leads mornos e quentes" hint="Usa os horários de atendimento já configurados na Agenda. Muda as respostas da IA." />
        <Toggle checked={!!f.reuniao.noShow} onChange={(x) => setF({ ...f, reuniao: { ...f.reuniao, noShow: x } })} label="Recuperar quem não compareceu" hint='Ao marcar "Não compareceu" no lead, envia uma mensagem com novos horários (só para quem pode receber).' />
        {f.reuniao.noShow && <Field label="Mensagem de recuperação ({horarios} = próximos horários livres)"><textarea rows={2} maxLength={600} value={f.reuniao.noShowTexto} onChange={(e) => setF({ ...f, reuniao: { ...f.reuniao, noShowTexto: e.target.value } })} /></Field>}
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Para o vendedor</h3>
        <Toggle checked={!!f.resumo} onChange={(x) => setF({ ...f, resumo: x })} label="Resumo para o vendedor no aviso de lead quente e no Kanban" hint="Dor, orçamento, prazo, decisor e próximo passo. Vai só para a sua equipe, nunca para o lead." />
        <Toggle checked={!!f.sentimento} onChange={(x) => setF({ ...f, sentimento: x })} label="Mostrar a intenção e o tom de cada resposta do lead" hint="Ex.: perguntou preço, quer marcar conversa, sem interesse; tom positivo, neutro ou negativo. Só para a equipe." />
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
    resumo: !!f.resumo,
    followupIa: !!f.followupIa,
    melhorHorario: !!f.melhorHorario,
    reuniao: f.reuniao,
    sentimento: !!f.sentimento,
    optOutAuto: !!f.optOutAuto,
    conversa: { enabled: !!f.conversa?.enabled, autoverificacao: f.conversa?.autoverificacao !== false, handoff: f.conversa?.handoff !== false },
    autoResposta: { enabled: !!f.autoResposta?.enabled, frases: String(f.autoResposta?.frasesTexto ?? (f.autoResposta?.frases ?? []).join('\n')).split('\n').map((x: string) => x.trim()).filter(Boolean).slice(0, 30), acao: f.autoResposta?.acao === 'PAUSAR' ? 'PAUSAR' : 'SEGUIR', pausaHoras: Math.min(168, Math.max(1, Math.round(Number(f.autoResposta?.pausaHoras) || 24))), iaDuvida: !!f.autoResposta?.iaDuvida },
    objecoes: { enabled: !!f.objecoes.enabled, itens: f.objecoes.itens.map((o: any) => ({ id: o.id, titulo: o.titulo, resposta: o.resposta, gatilhos: Array.isArray(o.gatilhos) ? o.gatilhos : String(o.gatilhos).split(',') })) },
  };
}

/** v1.26.0: IA conversacional avançada (muda as respostas aos leads: desligada para quem já usava o SDR). */
function Conversa({ f, setF }: { f: any; setF: (x: any) => void }) {
  const c = f.conversa ?? { enabled: false, autoverificacao: true, handoff: true };
  const set = (patch: any) => setF({ ...f, conversa: { ...c, ...patch } });
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>IA conversacional avançada</h3>
      <p className="small muted" style={{ margin: 0 }}>Conversa mais humana com os leads do SDR e com quem responde às suas campanhas. Muda as respostas da IA para leads; o atendimento comum continua igual.</p>
      <Toggle checked={!!c.enabled} onChange={(x) => set({ enabled: x })} label="Ligar a IA conversacional avançada" hint="A IA lê os dados do lead (empresa, CNPJ, respostas já dadas, objeções, campanha) e a conversa inteira, nunca pergunta de novo o que ele já respondeu, escreve como no WhatsApp (curto, uma pergunta por vez, no tom do lead) e decide o próximo passo pelo método escolhido." />
      {c.enabled && <>
        <Toggle checked={c.autoverificacao !== false} onChange={(x) => set({ autoverificacao: x })} label="Conferir cada resposta antes de enviar" hint="Tamanho, uma pergunta só, nada de preço, cobertura ou prazo fora das suas Instruções e nenhum dado sensível. Se algo estiver errado, a IA reescreve uma vez (conta no limite de uso e é pulada quando o limite está no fim). Sem a informação, ela diz que confirma com o especialista." />
        <Toggle checked={c.handoff !== false} onChange={(x) => set({ handoff: x })} label="Passar ao vendedor na hora certa" hint="Lead quente, pedido para falar com uma pessoa, lead irritado ou dúvida que as Instruções não cobrem: a IA para de responder e a equipe recebe o aviso com o resumo do lead." />
      </>}
    </div>
  );
}

/** v1.22.0: respostas automáticas do lead (saudação, ausência, menus, "estou dirigindo") não contam como resposta. */
function AutoResposta({ f, setF }: { f: any; setF: (x: any) => void }) {
  const a = f.autoResposta ?? { enabled: true, frases: [], acao: 'SEGUIR', pausaHoras: 24, iaDuvida: false };
  const set = (patch: any) => setF({ ...f, autoResposta: { ...a, ...patch } });
  const texto = a.frasesTexto ?? (a.frases ?? []).join('\n');
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Respostas automáticas</h3>
      <Toggle checked={!!a.enabled} onChange={(x) => set({ enabled: x })} label="Identificar respostas automáticas" hint='Mensagens de saudação ou ausência ("obrigado pelo contato, retornaremos em breve"), horário de atendimento, menus "digite 1", "estou dirigindo", Não Perturbe e "fora do escritório" no e-mail não contam como resposta: não qualificam, não mudam o funil, não param a cadência e a IA não responde. Ficam no histórico com o selo "Resposta automática". Não envia nada.' />
      {a.enabled && (
        <>
          <Field label="Frases que sempre indicam resposta automática (uma por linha, opcional)">
            <textarea rows={3} maxLength={4000} value={texto} placeholder={'Ex.: Bem-vindo ao atendimento da\nNosso expediente é'} onChange={(e) => set({ frasesTexto: e.target.value })} />
          </Field>
          <Field label="Quando receber resposta automática">
            <div className="row">
              <select value={a.acao} onChange={(e) => set({ acao: e.target.value })} style={{ width: 220 }}>
                <option value="SEGUIR">Seguir a cadência normalmente</option>
                <option value="PAUSAR">Pausar a cadência por</option>
              </select>
              {a.acao === 'PAUSAR' && <><input type="number" min={1} max={168} value={a.pausaHoras} onChange={(e) => set({ pausaHoras: e.target.value })} style={{ width: 80 }} aria-label="Horas de pausa" /><span className="small">horas</span></>}
            </div>
          </Field>
          <Toggle checked={!!a.iaDuvida} onChange={(x) => set({ iaDuvida: x })} label="Em caso de dúvida, confirmar com a MCK IA" hint="Só para mensagens que ficam no meio do caminho. Usa a cota diária da IA; sem cota, vale a identificação automática." />
        </>
      )}
    </div>
  );
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
        <strong>Resumo para o vendedor</strong>
        <div className="small">
          {[['Dor', d.resumo.dor], ['Orçamento', d.resumo.orcamento], ['Prazo', d.resumo.prazo], ['Decisor', d.resumo.decisor]].map(([k, val]) => <div key={k}><span className="muted">{k}:</span> {val ?? <em className="muted">não informado</em>}</div>)}
          <div><span className="muted">Próximo passo:</span> <strong>{d.resumo.proximoPasso}</strong></div>
          {d.intencao && <div><span className="muted">Última intenção:</span> {d.intencao.label} · tom {({ POSITIVO: '🙂 positivo', NEUTRO: 'neutro', NEGATIVO: '🙁 negativo' } as any)[d.intencao.sentimento]}</div>}
          <div><span className="muted">Melhor horário para falar:</span> {d.melhorHorario.hora}h–{d.melhorHorario.hora + 2}h{d.melhorHorario.base < 2 ? ' (padrão; ainda sem histórico de respostas)' : ` (com base em ${d.melhorHorario.base} respostas)`}</div>
        </div>
      </div>
      <div className="card stack">
        <strong>Reunião</strong>
        {d.stage === 'REUNIAO' ? (
          <div className="row"><button className="btn sm" disabled={busy} onClick={async () => { const r: any = await run(() => post(`/sdr/inteligencia/leads/${id}/noshow`, {}), 'Registrado'); if (r) { if (r.motivo) alert(`Mensagem de recuperação não enviada: ${r.motivo}`); state.reload(); } }}>Não compareceu</button></div>
        ) : d.horariosLivres.length ? (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="small muted">Próximos horários livres:</span>
            {d.horariosLivres.map((h: any) => <button key={h.inicio} className="btn sm ghost" disabled={busy} onClick={async () => { if (await run(() => post(`/sdr/leads/${id}/reuniao`, { inicio: h.inicio }), 'Reunião marcada na Agenda')) state.reload(); }}>{h.texto}</button>)}
          </div>
        ) : <span className="small muted">Sem horários livres nos próximos 7 dias na Agenda.</span>}
      </div>
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
