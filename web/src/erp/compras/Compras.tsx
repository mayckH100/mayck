/** Compras: solicitações (aprovação), cotações (mapa e vencedoras) e pedidos de compra (alçada, envio ao fornecedor). */
import { useState } from 'react';
import { get, post, put } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, fmtDate } from '../../ui';
import { brl, qtd, toMil, toCents, fromCents } from '../format';
import { BuscaParceiro, EditorItens, type LinhaItem } from '../comum';
import OQueComprar from './OQueComprar';
import { useSearchParams } from 'react-router-dom';
import { linhaCompra, qtdComEmbalagem, temEmbalagem } from '../../../../server/erp/shared/embalagem';
import { ROTULO_STATUS_COMPRA, ROTULO_EVENTO_COMPRA, ETAPAS_COMPRA } from '../../../../server/erp/compras/compra.machine';
import { diaBr } from '../../../../server/erp/compras/prazo';

// Solicitação (início do fluxo): aberta → aguardando aprovação do gestor → aprovada → vira OC (atendida).
const ST: Record<string, string> = { RASCUNHO: 'Solicitação aberta', EM_APROVACAO: 'Aguardando aprovação do gestor', APROVADA: 'Aprovada', REPROVADA: 'Reprovada', ATENDIDA: 'Virou OC', CANCELADA: 'Cancelada', ABERTA: 'Aberta', ENCERRADA: 'Encerrada' };
const STATUS_OC: Record<string, string> = ROTULO_STATUS_COMPRA;
const COR_STATUS_OC: Record<string, string> = { RASCUNHO: '', EM_APROVACAO: 'amber', APROVADO: 'blue', ENVIADO: 'blue', RECEBIDO_PARCIAL: 'blue', AGUARDANDO_NF: 'amber', AGUARDANDO_QUALIDADE: 'amber', EM_CONFERENCIA: 'amber', LIBERADA_ESTOQUE: 'green', RECEBIDO: 'green', CANCELADO: 'red' };
const COR_PRAZO: Record<string, string> = { green: 'green', yellow: 'amber', red: 'red', gray: '' };
const SeloPrazo = ({ prazo }: { prazo: any }) => (prazo && prazo.codigo !== 'NA' ? <span className={`badge ${COR_PRAZO[prazo.cor] ?? ''}`} title={prazo.previsaoDia ? `Previsão de entrega: ${diaBr(prazo.previsaoDia)}` : undefined}>{prazo.codigo === 'ATRASADO' ? '🔴 ' : prazo.codigo === 'EM_BREVE' ? '🟡 ' : prazo.codigo === 'NO_PRAZO' ? '🟢 ' : ''}{prazo.rotulo}</span> : null);
const ACAO: Record<string, string> = { ...ROTULO_EVENTO_COMPRA, ENVIAR: 'Enviar para aprovação', CANCELAR: 'Cancelar', REABRIR: 'Reabrir', ATENDER: 'Marcar atendida' };
const precisaMotivo = (a: string) => ['REPROVAR', 'CANCELAR', 'REPROVAR_QUALIDADE'].includes(a);

/** v1.50.0: aba inicial pela rota (ex.: /erp/compras/…); as abas internas continuam como nas primeiras versões. */
export type AbaCompras = 'oqc' | 'sol' | 'cot' | 'ped' | 'avisos' | 'config';
export default function Compras({ aba: inicial }: { aba?: AbaCompras } = {}) {
  const [aba, setAba] = useState<AbaCompras>(inicial ?? 'oqc');
  const av = useApi<any>('/erp/compras/avisos', [aba]);
  const naoLidos = av.data?.naoLidos ?? 0;
  return (
    <div className="page">
      <div className="page-head"><div><h1>Compras</h1><p className="muted">Solicitação → aprovação → cotação → ordem de compra → entrega → NF → (qualidade) → conferência → estoque.</p></div></div>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {(['oqc', 'sol', 'cot', 'ped', 'avisos', 'config'] as const).map((a) => <button key={a} className={`btn sm ${aba === a ? 'primary' : ''}`} onClick={() => setAba(a)}>{{ oqc: 'O que comprar', ped: 'Ordens de compra', sol: 'Solicitações', cot: 'Cotações', avisos: '🔔 Avisos', config: '⚙️ Prazos e avisos' }[a]}{a === 'avisos' && naoLidos > 0 && <span className="badge red" style={{ marginLeft: 6 }}>{naoLidos}</span>}</button>)}
      </div>
      {aba === 'oqc' && <OQueComprar />}
      {aba === 'sol' && <Solicitacoes />}
      {aba === 'cot' && <Cotacoes />}
      {aba === 'ped' && <PedidosCompra />}
      {aba === 'avisos' && <Avisos onLidos={av.reload} />}
      {aba === 'config' && <ConfigAvisos />}
    </div>
  );
}

function Solicitacoes() {
  const l = useApi<any[]>('/erp/compras/solicitacoes');
  const [nova, setNova] = useState(false); const [cotar, setCotar] = useState<any>(null);
  const [itens, setItens] = useState<LinhaItem[]>([]); const [just, setJust] = useState('');
  const { busy, run } = useAction();
  const acao = async (id: string, evento: string) => { const motivo = precisaMotivo(evento) ? prompt('Motivo') : undefined; if (precisaMotivo(evento) && !motivo) return; if (await run(() => post(`/erp/compras/solicitacoes/${id}/acao`, { evento, motivo }), 'Feito')) l.reload(); };
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => { setItens([]); setJust(''); setNova(true); }}>+ Solicitação</button>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma solicitação">Quem precisa de material pede aqui; o MRP também cria solicitações.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Nº</th><th>Itens</th><th>Origem</th><th>Status</th><th></th></tr></thead>
          <tbody>{d.map((s) => <tr key={s.id}><td>{s.numero}</td><td className="small">{s.itens.map((i: any) => `${i.produto?.sku} ${qtd(i.qtdMil)}`).join(', ')}</td><td>{s.origem}</td><td>{ST[s.status] ?? s.status}</td>
            <td className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{s.status === 'APROVADA' && <button className="btn sm primary" onClick={() => setCotar(s)}>Cotar</button>}{s.acoes.map((a: string) => <button key={a} className="btn sm" onClick={() => acao(s.id, a)}>{ACAO[a] ?? a}</button>)}</td></tr>)}</tbody></table></div>
      )}</Async>
      {nova && <Modal title="Nova solicitação de compra" onClose={() => setNova(false)}>
        <EditorItens itens={itens} setItens={setItens} />
        <Field label="Justificativa"><input value={just} onChange={(e) => setJust(e.target.value)} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !itens.length} onClick={async () => { if (await run(() => post('/erp/compras/solicitacoes', { justificativa: just || null, enviar: true, itens: itens.map((i) => ({ produtoId: i.produto.id, qtdMil: toMil(i.qtd) })) }), 'Solicitação enviada para aprovação')) { setNova(false); l.reload(); } }}>Enviar para aprovação</button></div>
      </Modal>}
      {cotar && <NovaCotacao solicitacao={cotar} onClose={() => setCotar(null)} onDone={() => { setCotar(null); l.reload(); }} />}
    </>
  );
}

function NovaCotacao({ solicitacao, onClose, onDone }: { solicitacao?: any; onClose: () => void; onDone: () => void }) {
  const [forn, setForn] = useState<any[]>([]); const [itens, setItens] = useState<LinhaItem[]>([]);
  const { busy, run } = useAction();
  return (
    <Modal title={solicitacao ? `Cotar solicitação ${solicitacao.numero}` : 'Nova cotação'} onClose={onClose}>
      {!solicitacao && <EditorItens itens={itens} setItens={setItens} />}
      <Field label="Fornecedores convidados">
        <BuscaParceiro tipo="fornecedor" onPick={(p) => !forn.some((f) => f.id === p.id) && setForn([...forn, p])} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 4 }}>{forn.map((f) => <span key={f.id} className="badge">{f.fantasia || f.nome} <button className="btn ghost sm" onClick={() => setForn(forn.filter((x) => x.id !== f.id))} aria-label="Remover">✕</button></span>)}</div>
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !forn.length || (!solicitacao && !itens.length)} onClick={async () => { if (await run(() => post('/erp/compras/cotacoes', { solicitacaoId: solicitacao?.id ?? null, itens: solicitacao ? undefined : itens.map((i) => ({ produtoId: i.produto.id, qtdMil: toMil(i.qtd) })), fornecedores: forn.map((f) => f.id) }), 'Cotação aberta')) onDone(); }}>Abrir cotação</button></div>
    </Modal>
  );
}

function Cotacoes() {
  const l = useApi<any[]>('/erp/compras/cotacoes');
  const [nova, setNova] = useState(false); const [aberta, setAberta] = useState<string | null>(null);
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setNova(true)}>+ Cotação</button>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma cotação">Convide fornecedores, lance as propostas e o mapa escolhe a melhor por item.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Nº</th><th>Itens</th><th>Propostas</th><th>Status</th><th>Aberta</th><th></th></tr></thead>
          <tbody>{d.map((c) => <tr key={c.id}><td>{c.numero}</td><td>{c._count.itens}</td><td>{c._count.respostas}</td><td>{ST[c.status]}</td><td>{fmtDate(c.createdAt)}</td><td><button className="btn sm" onClick={() => setAberta(c.id)}>Abrir</button></td></tr>)}</tbody></table></div>
      )}</Async>
      {nova && <NovaCotacao onClose={() => setNova(false)} onDone={() => { setNova(false); l.reload(); }} />}
      {aberta && <Cotacao id={aberta} onClose={() => { setAberta(null); l.reload(); }} />}
    </>
  );
}

function Cotacao({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useApi<any>(`/erp/compras/cotacoes/${id}`, [id]);
  const [lancar, setLancar] = useState<any>(null); const [precos, setPrecos] = useState<Record<string, { preco: string; prazo: string }>>({}); const [cond, setCond] = useState('');
  const [esc, setEsc] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  return (
    <Modal title="Mapa de cotação" onClose={onClose}>
      <Async state={st}>{(c) => {
        const resp = (itemId: string, parceiroId: string) => c.respostas.find((r: any) => r.itemId === itemId && r.parceiroId === parceiroId);
        const texto = `Olá! Pedimos cotação dos itens abaixo (cotação nº ${c.numero}):\n${c.itens.map((i: any) => `• ${i.produto?.nome} (${i.produto?.sku}): ${qtd(i.qtdMil)} ${i.produto?.unidade}`).join('\n')}\nInforme preço unitário, prazo de entrega e condição de pagamento. Obrigado!`;
        return (
          <>
            <div className="table-wrap"><table><thead><tr><th>Item</th>{c.fornecedores.map((f: any) => <th key={f.id}>{f.fantasia || f.nome}</th>)}</tr></thead>
              <tbody>{c.itens.map((i: any) => <tr key={i.id}><td className="small">{i.produto?.sku} · {qtd(i.qtdMil)}</td>{c.fornecedores.map((f: any) => {
                const r = resp(i.id, f.id); const melhor = i.melhorParceiroId === f.id;
                return <td key={f.id} style={{ background: melhor ? 'rgba(22,163,74,.12)' : undefined }}>{r ? <label className="small">{c.status === 'ABERTA' && <input type="radio" name={i.id} checked={(esc[i.id] ?? i.melhorParceiroId) === f.id} onChange={() => setEsc({ ...esc, [i.id]: f.id })} />} {brl(r.precoUnitCents)}<div className="muted">{r.prazoEntregaDias} d{r.vencedora ? ' · vencedora' : ''}</div></label> : '—'}</td>;
              })}</tr>)}</tbody></table></div>
            {c.status === 'ABERTA' && <>
              <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 8 }}>{c.fornecedores.map((f: any) => <button key={f.id} className="btn sm" onClick={() => { setLancar(f); setPrecos({}); setCond(''); }}>Lançar proposta: {f.fantasia || f.nome}</button>)}
                <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(texto)}>Copiar pedido de cotação</button></div>
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn primary" disabled={busy || !c.respostas.length} onClick={async () => { const r = await run(() => post<any>(`/erp/compras/cotacoes/${id}/encerrar`, { escolhas: esc }), 'Cotação encerrada'); if (r) { alert(`Pedidos de compra gerados: ${r.pedidos.map((p: any) => p.numero).join(', ')}`); st.reload(); } }}>Encerrar e gerar pedidos</button></div>
            </>}
            {lancar && <Modal title={`Proposta de ${lancar.fantasia || lancar.nome}`} onClose={() => setLancar(null)}>
              <table><thead><tr><th>Item</th><th>Preço un. (R$)</th><th>Prazo (dias)</th></tr></thead><tbody>{c.itens.map((i: any) => { const r = resp(i.id, lancar.id); const v = precos[i.id] ?? { preco: r ? fromCents(r.precoUnitCents) : '', prazo: r ? String(r.prazoEntregaDias) : '' }; return <tr key={i.id}><td className="small">{i.produto?.sku}</td><td><input style={{ width: 90 }} value={v.preco} inputMode="decimal" aria-label="Preço" onChange={(e) => setPrecos({ ...precos, [i.id]: { ...v, preco: e.target.value } })} /></td><td><input style={{ width: 60 }} value={v.prazo} inputMode="numeric" aria-label="Prazo" onChange={(e) => setPrecos({ ...precos, [i.id]: { ...v, prazo: e.target.value } })} /></td></tr>; })}</tbody></table>
              <Field label="Condição de pagamento"><input value={cond} onChange={(e) => setCond(e.target.value)} placeholder="28 dias" /></Field>
              <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={async () => { const respostas = Object.entries(precos).filter(([, v]) => v.preco).map(([itemId, v]) => ({ itemId, precoUnitCents: toCents(v.preco), prazoEntregaDias: Number(v.prazo) || 0 })); if (!respostas.length) return; if (await run(() => put(`/erp/compras/cotacoes/${id}/respostas`, { parceiroId: lancar.id, condicao: cond || null, respostas }), 'Proposta lançada')) { setLancar(null); st.reload(); } }}>Salvar proposta</button></div>
            </Modal>}
          </>
        );
      }}</Async>
    </Modal>
  );
}

const FILTROS_OC: { id: string; nome: string; status?: string[] }[] = [
  { id: 'abertas', nome: 'Em andamento', status: ETAPAS_COMPRA.filter((e) => !['RECEBIDO', 'CANCELADO'].includes(e)) },
  { id: 'atrasados', nome: '🔴 Atrasados' },
  { id: 'em_breve', nome: '🟡 Chegam em breve' },
  { id: 'negociacao', nome: 'Em negociação', status: ['RASCUNHO'] },
  { id: 'aprovacao', nome: 'Aguardando aprovação', status: ['EM_APROVACAO'] },
  { id: 'entrega', nome: 'Aguardando entrega', status: ['APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL'] },
  { id: 'recebimento', nome: 'Recebimento (NF, qualidade, conferência)', status: ['AGUARDANDO_NF', 'AGUARDANDO_QUALIDADE', 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE'] },
  { id: 'estoque', nome: 'Em estoque', status: ['RECEBIDO'] },
  { id: 'canceladas', nome: 'Canceladas', status: ['CANCELADO'] },
  { id: 'todas', nome: 'Todas' },
];

function PedidosCompra() {
  const l = useApi<any[]>('/erp/compras/pedidos');
  const [novo, setNovo] = useState(false); const [aberto, setAberto] = useState<string | null>(null);
  const [sp] = useSearchParams();
  // Atalhos do Resumo/alertas abrem já filtrado (?filtro=atrasados|em_breve|aprovacao|recebimento…).
  const [filtro, setFiltro] = useState(() => { const f = sp.get('filtro'); return f && FILTROS_OC.some((x) => x.id === f) ? f : 'abertas'; });
  const passa = (p: any, id: string) => {
    if (id === 'atrasados') return p.prazo?.codigo === 'ATRASADO';
    if (id === 'em_breve') return p.prazo?.codigo === 'EM_BREVE';
    const f = FILTROS_OC.find((x) => x.id === id);
    return !f?.status || f.status.includes(p.status);
  };
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setNovo(true)}>+ Ordem de compra</button>
      <Async state={l}>{(d) => (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginBottom: 8 }} role="tablist" aria-label="Filtrar ordens de compra">
            {FILTROS_OC.map((f) => { const n = d.filter((p) => passa(p, f.id)).length; return <button key={f.id} role="tab" aria-selected={filtro === f.id} className={`btn sm ${filtro === f.id ? 'primary' : 'ghost'}`} onClick={() => setFiltro(f.id)}>{f.nome} <span className={`badge ${f.id === 'atrasados' && n ? 'red' : ''}`}>{n}</span></button>; })}
          </div>
          {d.length === 0 ? <div className="card"><Empty title="Nenhuma ordem de compra">Crie direto aqui ou gere pela cotação.</Empty></div> : (() => {
            const lista = d.filter((p) => passa(p, filtro));
            return lista.length === 0 ? <div className="card"><Empty title="Nada neste filtro" /></div> : (
              <div className="card table-wrap"><table><thead><tr><th>Nº</th><th>Fornecedor</th><th>Total</th><th>Previsão</th><th>Prazo</th><th>Etapa</th><th></th></tr></thead>
                <tbody>{lista.map((p) => <tr key={p.id}><td>{p.numero}</td><td>{p.parceiro?.fantasia || p.parceiro?.nome}</td><td>{brl(p.totalCents)}</td><td>{p.prazo?.previsaoDia ? diaBr(p.prazo.previsaoDia) : '—'}</td><td><SeloPrazo prazo={p.prazo} /></td><td><span className={`badge ${COR_STATUS_OC[p.status] ?? ''}`}>{STATUS_OC[p.status] ?? p.status}</span>{p.exigeQualidade && !['RECEBIDO', 'CANCELADO'].includes(p.status) && <span className="badge" style={{ marginLeft: 4 }} title="Passa pela liberação da qualidade">🔬</span>}</td><td><button className="btn sm" onClick={() => setAberto(p.id)}>Abrir</button></td></tr>)}</tbody></table></div>
            );
          })()}
        </>
      )}</Async>
      {novo && <NovoPedidoCompra onClose={() => setNovo(false)} onDone={(id) => { setNovo(false); l.reload(); setAberto(id); }} />}
      {aberto && <PedidoCompra id={aberto} onClose={() => { setAberto(null); l.reload(); }} />}
    </>
  );
}

/** Trilho das etapas da OC (a de qualidade só aparece quando a OC exige). */
function TrilhoEtapas({ p }: { p: any }) {
  const etapas = ['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO', 'AGUARDANDO_NF', ...(p.exigeQualidade ? ['AGUARDANDO_QUALIDADE'] : []), 'EM_CONFERENCIA', 'LIBERADA_ESTOQUE', 'RECEBIDO'];
  const atual = p.status === 'RECEBIDO_PARCIAL' ? 'ENVIADO' : p.status;
  const idx = etapas.indexOf(atual);
  if (p.status === 'CANCELADO') return <p className="small"><span className="badge red">Cancelada</span> {p.motivo ? `Motivo: ${p.motivo}` : ''}</p>;
  return (
    <ol className="row small" style={{ flexWrap: 'wrap', gap: 4, listStyle: 'none', padding: 0, margin: '6px 0' }} aria-label="Etapas da ordem de compra">
      {etapas.map((e, i) => <li key={e}><span className={`badge ${i < idx ? 'green' : i === idx ? 'blue' : ''}`} aria-current={i === idx ? 'step' : undefined}>{i < idx ? '✓ ' : ''}{STATUS_OC[e]}</span></li>)}
    </ol>
  );
}

function NovoPedidoCompra({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [forn, setForn] = useState<any>(null); const [itens, setItens] = useState<LinhaItem[]>([]);
  const [f, setF] = useState({ frete: '0', previsao: '', prazo: '', condicao: '', obs: '', qualidade: false });
  const { busy, run } = useAction();
  const total = itens.reduce((a, i) => a + Math.round((toMil(i.qtd) * toCents(i.preco ?? '0')) / 1000), 0) + toCents(f.frete);
  return (
    <Modal title="Novo pedido de compra" onClose={onClose}>
      <Field label="Fornecedor">{forn ? <div className="row between"><strong>{forn.fantasia || forn.nome}</strong><button className="btn ghost sm" onClick={() => setForn(null)}>Trocar</button></div> : <BuscaParceiro tipo="fornecedor" onPick={setForn} />}</Field>
      <EditorItens itens={itens} setItens={setItens} comPreco />
      <div className="grid g2">
        <Field label="Frete (R$)"><input value={f.frete} onChange={(e) => setF({ ...f, frete: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Prazo de entrega (dias)" hint="A previsão é calculada na emissão da OC (emissão + prazo)"><input value={f.prazo} inputMode="numeric" onChange={(e) => setF({ ...f, prazo: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="ou data prevista de entrega"><input type="date" value={f.previsao} onChange={(e) => setF({ ...f, previsao: e.target.value })} /></Field>
        <Field label="Condição de pagamento"><input value={f.condicao} onChange={(e) => setF({ ...f, condicao: e.target.value })} /></Field>
      </div>
      <Field label="Observações"><input value={f.obs} onChange={(e) => setF({ ...f, obs: e.target.value })} /></Field>
      <label className="row small"><input type="checkbox" checked={f.qualidade} onChange={(e) => setF({ ...f, qualidade: e.target.checked })} /> Exige liberação da qualidade (também liga sozinho se a empresa ou algum produto exigir)</label>
      <div className="row between"><strong>Total {brl(total)}</strong><button className="btn primary" disabled={busy || !forn || !itens.length} onClick={async () => { const r = await run(() => post<any>('/erp/compras/pedidos', { parceiroId: forn.id, freteCents: toCents(f.frete), previsaoEntrega: f.previsao || null, prazoEntregaDias: f.prazo ? Number(f.prazo) : null, ...(f.qualidade ? { exigeQualidade: true } : {}), condicao: f.condicao || null, observacoes: f.obs || null, itens: itens.map((i) => ({ produtoId: i.produto.id, qtdMil: toMil(i.qtd), precoUnitCents: toCents(i.preco ?? '0') })) }), 'Pedido criado'); if (r) onDone(r.id); }}>Criar pedido</button></div>
    </Modal>
  );
}

function PedidoCompra({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useApi<any>(`/erp/compras/pedidos/${id}`, [id]);
  const { busy, run } = useAction(); const { can } = useAuth();
  const [prazo, setPrazo] = useState<{ previsao: string; dias: string; obs: string } | null>(null);
  const acao = async (evento: string) => {
    const motivo = precisaMotivo(evento) ? prompt(evento === 'REPROVAR_QUALIDADE' ? 'Motivo da reprovação na qualidade (ex.: devolvido ao fornecedor)' : 'Motivo') : undefined;
    if (precisaMotivo(evento) && !motivo) return;
    const observacao = !precisaMotivo(evento) && ['REGISTRAR_ENTREGA', 'NF_ENTRADA', 'LIBERAR_QUALIDADE', 'CONCLUIR_CONFERENCIA', 'FINALIZAR'].includes(evento) ? (prompt('Observação (opcional)') ?? undefined) || undefined : undefined;
    if (evento === 'FINALIZAR' && !confirm('Finalizar a OC? Confirme que a entrada no estoque já foi feita (Estoque › Entrada).')) return;
    if (await run(() => post(`/erp/compras/pedidos/${id}/acao`, { evento, motivo, observacao }), 'Feito')) st.reload();
  };
  function imprimir(p: any) {
    const w = window.open('', '_blank', 'width=800,height=900'); if (!w) return;
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    w.document.write(`<!doctype html><html><head><title>Pedido de compra ${p.numero}</title><style>body{font-family:Arial;margin:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px;text-align:left}</style></head><body><h2>Pedido de compra nº ${p.numero}</h2><p>Fornecedor: <b>${esc(p.parceiro?.nome)}</b> · CNPJ ${esc(p.parceiro?.documento)}</p><p>Previsão de entrega: ${p.prazo?.previsaoDia ? diaBr(p.prazo.previsaoDia) : '—'} · Condição: ${esc(p.condicao ?? '—')}</p><table><tr><th>Produto</th><th>Qtd</th><th>Preço un.</th><th>Total</th></tr>${p.itens.map((i: any) => `<tr><td>${esc(i.produto?.sku)} · ${esc(i.descricao)}</td><td>${esc(qtdComEmbalagem(i.qtdMil, i.produto ?? {}))}</td><td>${brl(i.precoUnitCents)}</td><td>${brl(i.totalCents)}</td></tr>`).join('')}</table><p>Frete: ${brl(p.freteCents)} · <b>Total: ${brl(p.totalCents)}</b></p><p>${esc(p.observacoes ?? '')}</p><p>Informe o número deste pedido na nota fiscal.</p></body></html>`);
    w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 400);
  }
  return (
    <Modal title="Ordem de compra" onClose={onClose}>
      <Async state={st}>{(p) => (
        <>
          <p className="small"><b>OC nº {p.numero}</b> · {p.parceiro?.fantasia || p.parceiro?.nome} · {brl(p.totalCents)} <span className={`badge ${COR_STATUS_OC[p.status] ?? ''}`}>{p.statusRotulo}</span> <SeloPrazo prazo={p.prazo} />{p.precisaGestor && p.status === 'EM_APROVACAO' && <span className="badge red">acima da alçada</span>}</p>
          <TrilhoEtapas p={p} />
          <p className="small muted">
            Previsão de entrega: <b>{p.prazo?.previsaoDia ? diaBr(p.prazo.previsaoDia) : '—'}</b>
            {p.prazoEntregaDias != null && <> · prazo {p.prazoEntregaDias} dia(s){p.previsaoManual ? ' (data editada)' : p.emitidoEm ? ' a partir da emissão' : ' (recalcula na emissão)'}</>}
            {p.emitidoEm && <> · emitida em {fmtDate(p.emitidoEm)}</>}{p.entregueEm && <> · chegou em {fmtDate(p.entregueEm)}</>}
            {p.exigeQualidade && <> · 🔬 passa pela qualidade</>}
            {p.podeEditarPrazo && <> · <button className="btn ghost sm" onClick={() => setPrazo({ previsao: p.prazo?.previsaoDia ?? '', dias: p.prazoEntregaDias != null ? String(p.prazoEntregaDias) : '', obs: '' })}>Alterar prazo</button></>}
          </p>
          <table><thead><tr><th>Produto</th><th>Qtd</th><th>Recebido</th><th>Preço</th><th>Total</th></tr></thead>
            <tbody>{p.itens.map((i: any) => <tr key={i.id}><td className="small">{i.produto?.sku} · {i.descricao}{i.produto && temEmbalagem(i.produto) && <div className="muted">{linhaCompra(i.qtdMil, i.precoUnitCents, i.produto).texto}</div>}</td><td>{qtdComEmbalagem(i.qtdMil, i.produto ?? {})}</td><td>{qtd(i.recebidoMil)}</td><td>{brl(i.precoUnitCents)}</td><td>{brl(i.totalCents)}</td></tr>)}</tbody></table>
          {p.nfes.length > 0 && <p className="small">Notas: {p.nfes.map((n: any) => `${n.numero}/${n.serie} (${n.status === 'LANCADA' ? 'lançada' : 'pendente'})`).join(', ')}</p>}
          {['ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF'].includes(p.status) && <p className="small muted">A NF pode ser registrada pela importação do XML em Estoque › NF-e (vinculando a esta OC) ou pelo botão "NF registrada".</p>}
          {['EM_CONFERENCIA', 'LIBERADA_ESTOQUE'].includes(p.status) && p.nfes.some((n: any) => n.status === 'PENDENTE') && <p className="small muted">A entrada no estoque acontece ao lançar a NF-e em Estoque › NF-e.</p>}
          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <button className="btn ghost" onClick={() => imprimir(p)}>Imprimir / PDF</button>
            {p.acoes.filter((a: string) => a !== 'APROVAR' || !p.precisaGestor || can('OWNER', 'ADMIN')).map((a: string) => <button key={a} className={`btn ${['APROVAR', 'ENVIAR', 'ENVIAR_FORNECEDOR', 'LIBERAR_QUALIDADE', 'CONCLUIR_CONFERENCIA'].includes(a) ? 'primary' : ''}`} disabled={busy} onClick={() => acao(a)}>{ACAO[a] ?? a}</button>)}
          </div>
          <h3 style={{ marginTop: 14 }}>Linha do tempo</h3>
          <ol className="small" style={{ paddingLeft: 18 }}>
            {p.historico.map((h: any) => <li key={h.id} style={{ marginBottom: 4 }}>
              <b>{fmtDate(h.createdAt)}</b> · {h.userNome ?? '—'} · {h.evento === 'ALTERAR_PRAZO' ? 'Prazo alterado' : h.deRotulo ? <>{h.deRotulo} → <b>{h.paraRotulo}</b></> : <>Criada: <b>{h.paraRotulo}</b></>}
              {h.observacao && <div className="muted">{h.observacao}</div>}
            </li>)}
          </ol>
          {prazo && <Modal title={`Prazo da OC nº ${p.numero}`} onClose={() => setPrazo(null)}>
            <Field label="Data prevista de entrega"><input type="date" value={prazo.previsao} onChange={(e) => setPrazo({ ...prazo, previsao: e.target.value })} /></Field>
            <Field label="Prazo em dias (da cotação)" hint="Mudar o prazo sem mudar a data recalcula a previsão a partir da emissão"><input value={prazo.dias} inputMode="numeric" onChange={(e) => setPrazo({ ...prazo, dias: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Observação"><input value={prazo.obs} onChange={(e) => setPrazo({ ...prazo, obs: e.target.value })} placeholder="Ex.: fornecedor pediu mais 3 dias" /></Field>
            {['RASCUNHO', 'EM_APROVACAO', 'APROVADO', 'ENVIADO', 'RECEBIDO_PARCIAL', 'AGUARDANDO_NF'].includes(p.status) && <label className="row small"><input type="checkbox" checked={!!p.exigeQualidade} onChange={async (e) => { if (await run(() => put(`/erp/compras/pedidos/${id}/prazo`, { exigeQualidade: e.target.checked }), 'Salvo')) st.reload(); }} /> Exige liberação da qualidade</label>}
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={async () => {
              const diasAntes = p.prazoEntregaDias != null ? String(p.prazoEntregaDias) : ''; const dataAntes = p.prazo?.previsaoDia ?? '';
              const body: any = { observacao: prazo.obs || undefined };
              if (prazo.previsao !== dataAntes) body.previsaoEntrega = prazo.previsao || null;
              if (prazo.dias !== diasAntes) body.prazoEntregaDias = prazo.dias ? Number(prazo.dias) : null;
              if (await run(() => put(`/erp/compras/pedidos/${id}/prazo`, body), 'Prazo atualizado')) { setPrazo(null); st.reload(); }
            }}>Salvar</button></div>
          </Modal>}
        </>
      )}</Async>
    </Modal>
  );
}

function Avisos({ onLidos }: { onLidos: () => void }) {
  const l = useApi<any>('/erp/compras/avisos');
  const { busy, run } = useAction();
  return (
    <Async state={l}>{(d) => (
      <>
        <div className="row between" style={{ marginBottom: 8 }}><p className="small muted">Avisos de prazo e de etapas das ordens de compra. A rotina roda uma vez por dia (a partir da hora do alerta do ERP) e não repete o mesmo aviso no mesmo dia.</p>
          {d.naoLidos > 0 && <button className="btn sm" disabled={busy} onClick={async () => { if (await run(() => post('/erp/compras/avisos/lidos', {}), 'Marcados como lidos')) { l.reload(); onLidos(); } }}>Marcar todos como lidos</button>}</div>
        {d.avisos.length === 0 ? <div className="card"><Empty title="Nenhum aviso">Quando uma OC atrasar, estiver para chegar, aguardar aprovação ou tiver NF/estoque liberado, o aviso aparece aqui.</Empty></div> : (
          <div className="card table-wrap"><table><thead><tr><th>Quando</th><th>Aviso</th><th>Para</th><th>Envio</th></tr></thead>
            <tbody>{d.avisos.map((a: any) => <tr key={a.id} style={{ fontWeight: a.lidoEm || a.destino !== 'EQUIPE' ? undefined : 700 }}><td className="small">{fmtDate(a.createdAt)}</td><td><div>{a.titulo}</div><div className="small muted" style={{ whiteSpace: 'pre-line', fontWeight: 400 }}>{a.texto}</div></td><td>{a.destino === 'FORNECEDOR' ? 'Fornecedor' : 'Equipe'}</td><td className="small muted">{a.envio ?? (a.destino === 'EQUIPE' ? 'No app' : '—')}</td></tr>)}</tbody></table></div>
        )}
      </>
    )}</Async>
  );
}

function ConfigAvisos() {
  const st = useApi<any>('/erp/compras/config-avisos');
  const [f, setF] = useState<any>(null);
  const { busy, run } = useAction(); const { can } = useAuth();
  const gestor = can('OWNER', 'ADMIN');
  return (
    <Async state={st}>{(c) => {
      const v = f ?? c;
      const set = (k: string, val: unknown) => setF({ ...v, [k]: val });
      return (
        <div className="card">
          <h3>Prazos e etapas</h3>
          <Field label="'Chega em breve' quando faltam até (dias)"><input value={v.compraEmBreveDias} inputMode="numeric" disabled={!gestor} onChange={(e) => set('compraEmBreveDias', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
          <label className="row small"><input type="checkbox" checked={v.compraQualidadePadrao} disabled={!gestor} onChange={(e) => set('compraQualidadePadrao', e.target.checked)} /> Toda ordem de compra nova passa pela liberação da qualidade (também dá para ligar por produto ou por OC)</label>
          <h3 style={{ marginTop: 12 }}>Avisos para a equipe</h3>
          <p className="small muted">Sempre aparecem em Compras › 🔔 Avisos. {c.alertaAtivo ? 'O alerta diário do ERP está ligado: dá para receber também no WhatsApp dos números de alerta.' : 'Para receber também no WhatsApp, ligue o alerta diário em ERP › Alertas e cadastre os números.'}</p>
          <label className="row small"><input type="checkbox" checked={v.compraAvisoEquipeWhats} disabled={!gestor} onChange={(e) => set('compraAvisoEquipeWhats', e.target.checked)} /> Enviar os avisos de compras também no WhatsApp dos números de alerta do ERP</label>
          <h3 style={{ marginTop: 12 }}>Avisos para o fornecedor</h3>
          <label className="row small"><input type="checkbox" checked={v.compraAvisoFornecedor} disabled={!gestor} onChange={(e) => set('compraAvisoFornecedor', e.target.checked)} /> Mandar lembrete antes da data prevista e cobrança quando atrasar (só OC emitida)</label>
          {v.compraAvisoFornecedor && <>
            <div className="grid g2">
              <Field label="Canal"><select value={v.compraAvisoFornCanal} disabled={!gestor} onChange={(e) => set('compraAvisoFornCanal', e.target.value)}><option value="EMAIL">E-mail</option><option value="WHATSAPP">WhatsApp</option><option value="AMBOS">E-mail e WhatsApp</option></select></Field>
              <Field label="Lembrete quantos dias antes"><input value={v.compraAvisoFornDias} inputMode="numeric" disabled={!gestor} onChange={(e) => set('compraAvisoFornDias', Number(e.target.value.replace(/\D/g, '')) || 0)} /></Field>
            </div>
            <Field label="Texto do lembrete" hint={`Variáveis: ${c.variaveis.join(' ')}`}><textarea rows={4} value={v.compraAvisoFornTextoLembrete} disabled={!gestor} onChange={(e) => set('compraAvisoFornTextoLembrete', e.target.value)} /></Field>
            <Field label="Texto da cobrança de atraso" hint="Enviada no 1º dia de atraso e depois a cada 3 dias enquanto atrasar"><textarea rows={4} value={v.compraAvisoFornTextoAtraso} disabled={!gestor} onChange={(e) => set('compraAvisoFornTextoAtraso', e.target.value)} /></Field>
          </>}
          {gestor ? <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !f} onClick={async () => { const { alertaAtivo: _a, alertaHora: _h, variaveis: _v, ...body } = v; if (await run(() => put('/erp/compras/config-avisos', body), 'Configuração salva')) { setF(null); st.reload(); } }}>Salvar</button></div>
            : <p className="small muted">Só proprietário ou administrador altera esta configuração.</p>}
        </div>
      );
    }}</Async>
  );
}
