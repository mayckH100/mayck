/**
 * Caixa do PDV: faixa de status (aberto desde, por quem, valor de abertura), abrir, sangria, suprimento, fechar
 * (resumo + dinheiro contado + diferença), histórico de sessões e relatório de fechamento imprimível.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post } from '../../api';
import { useApi, Async, Empty, Modal, Field, useAction } from '../../ui';
import { useAuth } from '../../auth';
import ErpNav from '../ErpNav';
import { brl, toCents } from '../format';

export const FORMA_NOME: Record<string, string> = { DINHEIRO: 'Dinheiro', PIX: 'Pix', CARTAO: 'Cartão' };

/** Fuso da empresa (padrão Brasília). */
export function useFuso() { return useAuth().me?.org?.timezone || 'America/Sao_Paulo'; }
export const hora = (d: string | Date | null | undefined, tz: string) => (d ? new Date(d).toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : '—');
export const dataHora = (d: string | Date | null | undefined, tz: string) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '—');
const hojeLocal = (tz: string, menosDias = 0) => new Date(Date.now() - menosDias * 86_400_000).toLocaleDateString('en-CA', { timeZone: tz });

export interface EstadoCaixa { contas: { id: string; nome: string; aberta: boolean }[]; abertas: any[]; sessaoPadraoId: string | null }

/** Valor em reais digitado (aceita "0", "10", "10,50"); vazio = não informado. */
const valorValido = (s: string) => s.trim() !== '' && /^\d{1,3}(\.?\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(s.trim());

export function CaixaBanner({ estado, sessaoId, onEscolher, onAbrir, onReload }: { estado: EstadoCaixa | null; sessaoId: string | null; onEscolher: (id: string) => void; onAbrir: () => void; onReload: () => void }) {
  const tz = useFuso();
  const [mov, setMov] = useState<'SANGRIA' | 'SUPRIMENTO' | null>(null);
  const [fechar, setFechar] = useState(false);
  if (!estado) return null;
  const s = estado.abertas.find((x) => x.id === sessaoId) ?? null;
  if (!estado.abertas.length) return (
    <div className="alert warn row between" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
      <span><b>Caixa fechado.</b> Abra o caixa para fazer venda balcão.</span>
      <button className="btn primary sm" onClick={onAbrir}>Abrir caixa</button>
    </div>
  );
  return (
    <div className="alert ok" style={{ marginBottom: 10 }}>
      {estado.abertas.length > 1 && (
        <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small">Caixa da venda:</span>
          <select value={sessaoId ?? ''} onChange={(e) => onEscolher(e.target.value)} aria-label="Caixa da venda">
            {!sessaoId && <option value="">Escolha…</option>}
            {estado.abertas.map((x) => <option key={x.id} value={x.id}>{x.contaNome} · {x.abertoPor?.nome ?? '—'}</option>)}
          </select>
          {estado.contas.some((c) => !c.aberta) && <button className="btn sm" onClick={onAbrir}>Abrir outro caixa</button>}
        </div>
      )}
      {s ? (
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span><b>{s.contaNome} aberto</b> desde {hora(s.abertoEm, tz)} por {s.abertoPor?.nome ?? '—'} — {brl(s.valorAberturaCents)} na abertura · em dinheiro agora: <b>{brl(s.resumo?.esperadoDinheiroCents)}</b></span>
          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => setMov('SANGRIA')}>Sangria</button>
            <button className="btn sm" onClick={() => setMov('SUPRIMENTO')}>Suprimento</button>
            <button className="btn sm danger" onClick={() => setFechar(true)}>Fechar caixa</button>
          </span>
        </div>
      ) : <span className="small">Escolha o caixa em que as vendas vão entrar.</span>}
      {mov && s && <MovimentoModal sessao={s} tipo={mov} onClose={() => setMov(null)} onDone={() => { setMov(null); onReload(); }} />}
      {fechar && s && <FecharCaixaModal sessaoId={s.id} onClose={() => setFechar(false)} onDone={() => { setFechar(false); onReload(); }} />}
    </div>
  );
}

export function AbrirCaixaModal({ estado, onClose, onOpened }: { estado: EstadoCaixa | null; onClose: () => void; onOpened: (s: any) => void }) {
  const livres = (estado?.contas ?? []).filter((c) => !c.aberta);
  const [contaId, setContaId] = useState(livres[0]?.id ?? '');
  const [valor, setValor] = useState(''); const [obs, setObs] = useState('');
  const { busy, run } = useAction();
  const ok = valorValido(valor);
  async function abrir() {
    const s = await run(() => post<any>('/erp/vendas/caixa/abrir', { contaId: contaId || null, valorAberturaCents: toCents(valor), observacao: obs || null }), 'Caixa aberto');
    if (s) onOpened(s);
  }
  return (
    <Modal title="Abrir caixa" onClose={onClose}>
      <p className="small muted">Para vender no balcão o caixa precisa estar aberto. Conte o dinheiro que está na gaveta (troco) e informe abaixo; pode ser 0.</p>
      {livres.length > 1 && <Field label="Caixa"><select value={contaId} onChange={(e) => setContaId(e.target.value)}>{livres.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>}
      <Field label="Dinheiro na abertura (R$) *" hint={valor && !ok ? 'Valor inválido' : undefined}><input autoFocus value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" placeholder="0,00" aria-label="Dinheiro na abertura" /></Field>
      <Field label="Observação (opcional)"><input value={obs} onChange={(e) => setObs(e.target.value)} maxLength={500} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || !ok} onClick={abrir}>Abrir caixa</button>
      </div>
    </Modal>
  );
}

function MovimentoModal({ sessao, tipo, onClose, onDone }: { sessao: any; tipo: 'SANGRIA' | 'SUPRIMENTO'; onClose: () => void; onDone: () => void }) {
  const contas = useApi<any[]>('/erp/vendas/balcao/contas');
  const [valor, setValor] = useState(''); const [motivo, setMotivo] = useState(''); const [outra, setOutra] = useState('');
  const { busy, run } = useAction();
  const sangria = tipo === 'SANGRIA';
  const outras = (contas.data ?? []).filter((c) => c.id !== sessao.contaFinanceiraId);
  async function salvar() {
    const r = await run(() => post(`/erp/vendas/caixa/sessoes/${sessao.id}/movimentos`, { tipo, valorCents: toCents(valor), motivo, contaOutraId: outra || null }), sangria ? 'Sangria registrada' : 'Suprimento registrado');
    if (r) onDone();
  }
  return (
    <Modal title={sangria ? 'Sangria (retirada do caixa)' : 'Suprimento (reforço de troco)'} onClose={onClose}>
      <p className="small muted">{sangria ? `Dinheiro retirado da gaveta. Em dinheiro agora: ${brl(sessao.resumo?.esperadoDinheiroCents)}.` : 'Dinheiro colocado na gaveta durante o expediente.'}</p>
      <Field label="Valor (R$) *"><input autoFocus value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" placeholder="0,00" aria-label="Valor" /></Field>
      <Field label="Motivo *"><input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={300} placeholder={sangria ? 'Ex.: depósito no banco, cofre' : 'Ex.: troco'} aria-label="Motivo" /></Field>
      {outras.length > 0 && <Field label={sangria ? 'Levar para a conta (opcional)' : 'Veio da conta (opcional)'} hint="Lança a transferência na outra conta também"><select value={outra} onChange={(e) => setOutra(e.target.value)}><option value="">Nenhuma (só o caixa)</option>{outras.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || toCents(valor) <= 0 || motivo.trim().length < 2} onClick={salvar}>Registrar</button>
      </div>
    </Modal>
  );
}

function ResumoTabela({ r }: { r: any }) {
  const formas = Object.entries(r?.porForma ?? {}) as [string, { qtd: number; valorCents: number }][];
  return (
    <div className="table-wrap"><table>
      <tbody>
        <tr><td>Dinheiro na abertura</td><td style={{ textAlign: 'right' }}>{brl(r.aberturaCents)}</td></tr>
        {formas.map(([f, v]) => <tr key={f}><td>Vendas em {FORMA_NOME[f] ?? f} ({v.qtd})</td><td style={{ textAlign: 'right' }}>{brl(v.valorCents)}</td></tr>)}
        <tr><td><b>Total vendido</b></td><td style={{ textAlign: 'right' }}><b>{brl(r.totalVendasCents)}</b></td></tr>
        <tr><td>Suprimentos (+)</td><td style={{ textAlign: 'right' }}>{brl(r.suprimentosCents)}</td></tr>
        <tr><td>Sangrias (−)</td><td style={{ textAlign: 'right' }}>{brl(r.sangriasCents)}</td></tr>
        <tr><td><b>Esperado em dinheiro</b></td><td style={{ textAlign: 'right' }}><b>{brl(r.esperadoDinheiroCents)}</b></td></tr>
      </tbody>
    </table></div>
  );
}

function FecharCaixaModal({ sessaoId, onClose, onDone }: { sessaoId: string; onClose: () => void; onDone: () => void }) {
  const det = useApi<any>(`/erp/vendas/caixa/sessoes/${sessaoId}`);
  const [contado, setContado] = useState(''); const [obs, setObs] = useState('');
  const [fechado, setFechado] = useState<any>(null);
  const { busy, run } = useAction();
  const esperado = det.data?.resumo?.esperadoDinheiroCents ?? 0;
  const ok = valorValido(contado);
  const dif = ok ? toCents(contado) - esperado : 0;
  async function fechar() {
    const s = await run(() => post<any>(`/erp/vendas/caixa/sessoes/${sessaoId}/fechar`, { valorContadoCents: toCents(contado), observacao: obs || null }), 'Caixa fechado');
    if (s) setFechado(s);
  }
  if (fechado) return (
    <Modal title="Caixa fechado" onClose={onDone}>
      <p>Contado {brl(fechado.valorContadoCents)} · esperado {brl(fechado.valorEsperadoCents)} · {fechado.diferencaCents === 0 ? 'confere' : fechado.diferencaCents > 0 ? `sobra de ${brl(fechado.diferencaCents)}` : `falta de ${brl(-fechado.diferencaCents)}`}.</p>
      <p className="small muted">Novas vendas balcão só depois de abrir o caixa de novo.</p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
        <Link className="btn" to={`/erp/caixa/${fechado.id}`}>Ver relatório</Link>
        <button className="btn primary" onClick={onDone}>Concluir</button>
      </div>
    </Modal>
  );
  return (
    <Modal title="Fechar caixa" onClose={onClose}>
      <Async state={det}>{(d) => (
        <>
          <ResumoTabela r={d.resumo} />
          <Field label="Dinheiro contado na gaveta (R$) *"><input autoFocus value={contado} onChange={(e) => setContado(e.target.value)} inputMode="decimal" placeholder="0,00" aria-label="Dinheiro contado" /></Field>
          {ok && <p style={{ fontSize: 18, color: dif === 0 ? '#1d6b3a' : '#b91c1c' }}>{dif === 0 ? 'Confere com o esperado.' : dif > 0 ? `Sobra de ${brl(dif)}` : `Falta de ${brl(-dif)}`}</p>}
          <Field label={dif !== 0 ? 'Observação * (explique a diferença)' : 'Observação (opcional)'}><textarea rows={2} value={obs} onChange={(e) => setObs(e.target.value)} maxLength={1000} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" disabled={busy || !ok || (dif !== 0 && !obs.trim())} onClick={fechar}>Fechar caixa</button>
          </div>
        </>
      )}</Async>
    </Modal>
  );
}

/** Aba "Caixas": histórico de sessões com filtro por data. */
export function CaixasHistorico() {
  const tz = useFuso();
  const [de, setDe] = useState(hojeLocal(tz, 7)); const [ate, setAte] = useState(hojeLocal(tz));
  const [status, setStatus] = useState('');
  const state = useApi<any[]>(`/erp/vendas/caixa/sessoes?de=${de}&ate=${ate}${status ? `&status=${status}` : ''}`, [de, ate, status]);
  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="De"><input type="date" value={de} onChange={(e) => setDe(e.target.value)} /></Field>
        <Field label="Até"><input type="date" value={ate} onChange={(e) => setAte(e.target.value)} /></Field>
        <Field label="Situação"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option><option value="ABERTO">Abertos</option><option value="FECHADO">Fechados</option></select></Field>
      </div>
      <Async state={state}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhum caixa neste período">Abra o caixa para começar a vender no balcão.</Empty></div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Caixa</th><th>Abertura</th><th>Fechamento</th><th>Na abertura</th><th>Vendido</th><th>Esperado</th><th>Contado</th><th>Diferença</th><th></th></tr></thead>
          <tbody>{d.map((s) => (
            <tr key={s.id}>
              <td>{s.contaNome}{s.status === 'ABERTO' && <span className="badge green" style={{ marginLeft: 4 }}>Aberto</span>}</td>
              <td className="small">{dataHora(s.abertoEm, tz)}<br />{s.abertoPor?.nome}</td>
              <td className="small">{s.fechadoEm ? <>{dataHora(s.fechadoEm, tz)}<br />{s.fechadoPor?.nome}</> : '—'}</td>
              <td>{brl(s.valorAberturaCents)}</td>
              <td>{brl(s.resumo?.totalVendasCents)}</td>
              <td>{brl(s.resumo?.esperadoDinheiroCents)}</td>
              <td>{s.valorContadoCents == null ? '—' : brl(s.valorContadoCents)}</td>
              <td>{s.diferencaCents == null ? '—' : <span style={{ color: s.diferencaCents === 0 ? undefined : '#b91c1c' }}>{s.diferencaCents > 0 ? '+' : ''}{brl(s.diferencaCents)}</span>}</td>
              <td><Link className="btn sm" to={`/erp/caixa/${s.id}`}>Ver</Link></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}</Async>
    </>
  );
}

/** Relatório de fechamento (rota /erp/caixa/:id), com botão de impressão. */
export default function RelatorioCaixa() {
  const { id } = useParams();
  const tz = useFuso();
  const det = useApi<any>(`/erp/vendas/caixa/sessoes/${id}`, [id]);
  // Caixa ainda aberto: atualiza os valores a cada minuto.
  useEffect(() => { if (det.data?.status !== 'ABERTO') return; const t = setInterval(() => det.reload(), 60_000); return () => clearInterval(t); }, [det.data?.status, det.reload]);
  function imprimir() {
    const el = document.getElementById('relatorio-caixa'); if (!el) return;
    const w = window.open('', '_blank', 'width=700,height=800'); if (!w) return;
    w.document.write(`<html><head><title>Fechamento de caixa</title><style>body{font-family:sans-serif;font-size:13px;padding:16px}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left}h2,h3{margin:8px 0}.no-print{display:none}</style></head><body>${el.innerHTML}</body></html>`);
    w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 400);
  }
  return (
    <>
      <div className="page-head">
        <div><h1>Relatório do caixa</h1><p className="muted">Abertura, vendas por forma de pagamento, sangrias, suprimentos e conferência do dinheiro.</p></div>
        <div className="row" style={{ gap: 6 }}><Link className="btn" to="/erp/balcao">Voltar ao PDV</Link><button className="btn primary" onClick={imprimir} disabled={!det.data}>Imprimir</button></div>
      </div>
      <ErpNav />
      <Async state={det}>{(d) => (
        <div className="card" id="relatorio-caixa">
          <h2 style={{ marginTop: 0 }}>{d.empresa} · {d.contaNome}</h2>
          <p>Aberto em {dataHora(d.abertoEm, tz)} por {d.abertoPor?.nome ?? '—'}{d.observacaoAbertura ? ` (${d.observacaoAbertura})` : ''}<br />
            {d.status === 'FECHADO' ? <>Fechado em {dataHora(d.fechadoEm, tz)} por {d.fechadoPor?.nome ?? '—'}</> : <b>Caixa ainda aberto (valores até agora)</b>}</p>
          <ResumoTabela r={d.resumo} />
          {d.status === 'FECHADO' && (
            <div className="table-wrap"><table><tbody>
              <tr><td>Dinheiro contado</td><td style={{ textAlign: 'right' }}>{brl(d.valorContadoCents)}</td></tr>
              <tr><td><b>Diferença</b></td><td style={{ textAlign: 'right' }}><b>{d.diferencaCents === 0 ? 'Confere' : d.diferencaCents > 0 ? `Sobra ${brl(d.diferencaCents)}` : `Falta ${brl(-d.diferencaCents)}`}</b></td></tr>
              {d.observacaoFechamento && <tr><td>Observação</td><td style={{ textAlign: 'right' }}>{d.observacaoFechamento}</td></tr>}
            </tbody></table></div>
          )}
          <h3>Sangrias e suprimentos</h3>
          {d.movimentos.length === 0 ? <p className="small muted">Nenhum.</p> : <div className="table-wrap"><table><thead><tr><th>Hora</th><th>Tipo</th><th>Motivo</th><th>Quem</th><th>Valor</th></tr></thead><tbody>
            {d.movimentos.map((m: any) => <tr key={m.id}><td>{hora(m.em, tz)}</td><td>{m.tipo === 'SANGRIA' ? 'Sangria' : 'Suprimento'}</td><td>{m.motivo}</td><td>{m.usuario}</td><td>{m.tipo === 'SANGRIA' ? '−' : '+'}{brl(m.valorCents)}</td></tr>)}
          </tbody></table></div>}
          <h3>Vendas ({d.vendas.length})</h3>
          {d.vendas.length === 0 ? <p className="small muted">Nenhuma venda.</p> : <div className="table-wrap"><table><thead><tr><th>Nº</th><th>Hora</th><th>Pagamento</th><th>Total</th></tr></thead><tbody>
            {d.vendas.map((v: any) => <tr key={v.id}><td><Link to={`/erp/pedidos/${v.id}`}>{v.numero}</Link></td><td>{hora(v.createdAt, tz)}</td><td>{FORMA_NOME[v.forma] ?? v.forma ?? '—'}</td><td>{brl(v.totalCents)}</td></tr>)}
          </tbody></table></div>}
        </div>
      )}</Async>
    </>
  );
}
