/** Funil de vendas em Kanban: arrastar entre etapas, ganhar/perder com motivo, criar oportunidade. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, get } from '../../api';
import { useApi, Async, Modal, Field, useAction } from '../../ui';
import ErpNav from '../ErpNav';
import { brl, toCents } from '../format';

export default function Funil() {
  const state = useApi<any>('/erp/crm/funil');
  const [over, setOver] = useState<string | null>(null);
  const [nova, setNova] = useState(false);
  const [perder, setPerder] = useState<any>(null);
  const { run } = useAction();
  const acao = (id: string, body: any, ok?: string) => run(() => post(`/erp/crm/funil/oportunidades/${id}/acao`, body), ok).then(() => state.reload());
  return (
    <>
      <div className="page-head">
        <div><h1>Funil de vendas</h1><p className="muted">Arraste os cards entre as etapas. Ganhar ou perder fecha a oportunidade e registra na linha do tempo do cliente.</p></div>
        <button className="btn primary" onClick={() => setNova(true)}>+ Oportunidade</button>
      </div>
      <ErpNav />
      <Async state={state}>{(d) => (
        <div className="board">
          {d.etapas.map((e: any) => {
            const cards = d.oportunidades.filter((o: any) => o.etapaId === e.id);
            return (
              <div key={e.id} className={`col ${over === e.id ? 'over' : ''}`}
                onDragOver={(ev) => { ev.preventDefault(); setOver(e.id); }} onDragLeave={() => setOver(null)}
                onDrop={(ev) => { ev.preventDefault(); setOver(null); const id = ev.dataTransfer.getData('text/plain'); if (id) acao(id, { evento: 'MOVER', etapaId: e.id }); }}>
                <div className="col-head">
                  <span className="row"><span style={{ width: 10, height: 10, borderRadius: 3, background: e.cor, display: 'inline-block' }} />{e.nome} <span className="badge">{cards.length}</span></span>
                  <span className="small muted">{brl(cards.reduce((a: number, o: any) => a + o.valorCents, 0))}</span>
                </div>
                {cards.map((o: any) => (
                  <div key={o.id} className="kcard" draggable onDragStart={(ev) => ev.dataTransfer.setData('text/plain', o.id)}>
                    <strong>{o.titulo}</strong>
                    <div className="small"><Link to={`/erp/clientes/${o.parceiro.id}`}>{o.parceiro.fantasia || o.parceiro.nome}</Link></div>
                    <div className="row between small" style={{ marginTop: 4 }}><strong>{brl(o.valorCents)}</strong><span className="muted">{o.probabilidade}%</span></div>
                    <select aria-label="Mover para" className="small" style={{ marginTop: 6, padding: 4 }} value={o.etapaId} onChange={(ev) => acao(o.id, { evento: 'MOVER', etapaId: ev.target.value })}>
                      {d.etapas.map((x: any) => <option key={x.id} value={x.id}>{x.nome}</option>)}
                    </select>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      <button className="btn sm" onClick={() => acao(o.id, { evento: 'GANHAR' }, 'Oportunidade ganha')}>Ganhou</button>
                      <button className="btn ghost sm" onClick={() => setPerder(o)}>Perdeu</button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}</Async>
      {nova && <NovaOportunidade etapas={state.data?.etapas ?? []} onClose={() => setNova(false)} onSaved={() => { setNova(false); state.reload(); }} />}
      {perder && <MotivoPerda op={perder} onClose={() => setPerder(null)} onConfirm={async (motivo) => { await acao(perder.id, { evento: 'PERDER', motivoPerda: motivo }, 'Registrada como perdida'); setPerder(null); }} />}
    </>
  );
}

function NovaOportunidade({ etapas, onClose, onSaved }: { etapas: any[]; onClose: () => void; onSaved: () => void }) {
  const [busca, setBusca] = useState('');
  const [opcoes, setOpcoes] = useState<any[]>([]);
  const [parceiro, setParceiro] = useState<any>(null);
  const [f, setF] = useState({ titulo: '', valor: '', etapaId: etapas[0]?.id ?? '', custo: '', origem: '', previsao: '' });
  const { busy, run } = useAction();
  async function procurar(q: string) { setBusca(q); if (q.trim().length >= 2) setOpcoes((await get<any>(`/erp/crm/parceiros?q=${encodeURIComponent(q)}&tipo=cliente`)).items.slice(0, 8)); else setOpcoes([]); }
  async function salvar() {
    const r = await run(() => post('/erp/crm/funil/oportunidades', { parceiroId: parceiro.id, titulo: f.titulo, etapaId: f.etapaId, valorCents: toCents(f.valor), custoAquisicaoCents: toCents(f.custo), origem: f.origem || null, previsaoFechamento: f.previsao || null }), 'Oportunidade criada');
    if (r) onSaved();
  }
  return (
    <Modal title="Nova oportunidade" onClose={onClose}>
      {parceiro ? <div className="row between"><strong>{parceiro.fantasia || parceiro.nome}</strong><button className="btn ghost sm" onClick={() => setParceiro(null)}>Trocar</button></div> : (
        <Field label="Cliente">
          <input value={busca} onChange={(e) => procurar(e.target.value)} placeholder="Nome ou CNPJ" autoFocus />
          {opcoes.map((o) => <button key={o.id} type="button" className="btn ghost sm" style={{ display: 'block' }} onClick={() => setParceiro(o)}>{o.fantasia || o.nome}</button>)}
          {busca.length >= 2 && !opcoes.length && <div className="small muted">Nenhum cliente. <Link to="/erp/clientes">Cadastre primeiro</Link>.</div>}
        </Field>
      )}
      <Field label="Título"><input value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} placeholder="Ex.: 200 caixas de embalagem" /></Field>
      <div className="grid g2">
        <Field label="Valor (R$)"><input value={f.valor} onChange={(e) => setF({ ...f, valor: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Etapa"><select value={f.etapaId} onChange={(e) => setF({ ...f, etapaId: e.target.value })}>{etapas.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}</select></Field>
        <Field label="Custo de aquisição (R$)" hint="Anúncio, visita, comissão: entra no CAC"><input value={f.custo} onChange={(e) => setF({ ...f, custo: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Previsão de fechamento"><input type="date" value={f.previsao} onChange={(e) => setF({ ...f, previsao: e.target.value })} /></Field>
      </div>
      <Field label="Origem"><input value={f.origem} onChange={(e) => setF({ ...f, origem: e.target.value })} placeholder="Indicação, site, WhatsApp…" /></Field>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || !parceiro || f.titulo.trim().length < 2} onClick={salvar}>Criar</button>
      </div>
    </Modal>
  );
}

function MotivoPerda({ op, onClose, onConfirm }: { op: any; onClose: () => void; onConfirm: (m: string) => void }) {
  const [m, setM] = useState('');
  return (
    <Modal title={`Perdeu: ${op.titulo}`} onClose={onClose}>
      <Field label="Motivo"><select value={m} onChange={(e) => setM(e.target.value)}><option value="">Escolha…</option>{['Preço', 'Prazo', 'Concorrente', 'Sem orçamento', 'Sem resposta', 'Outro'].map((x) => <option key={x}>{x}</option>)}</select></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!m} onClick={() => onConfirm(m)}>Confirmar</button></div>
    </Modal>
  );
}
