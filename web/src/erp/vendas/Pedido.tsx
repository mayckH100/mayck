/** Pedido de venda: itens, ações permitidas pela máquina de estados, lista de separação e conferência por QR. */
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Modal, Field, useAction, useToast, fmtDate } from '../../ui';
import { NfeDoPedido } from '../fiscal/Fiscal';
import { brl, qtd, toMil } from '../format';
import { badgeStatus } from './Pedidos';
import { CampoLeitura } from '../leitura/Leitor';
import { imprimirDocumento, type TipoDocumento } from './documento';

const ROTULO: Record<string, string> = { ENVIAR: 'Enviar para aprovação', APROVAR: 'Aprovar', REPROVAR: 'Reprovar', RESERVAR: 'Tentar reservar de novo', SEPARAR: 'Liberar separação', CONFERIR: 'Concluir conferência', FATURAR: 'Faturar', EXPEDIR: 'Expedir', ENTREGAR: 'Confirmar entrega', ENTREGAR_PARCIAL: 'Entrega parcial', DEVOLVER: 'Devolução', CANCELAR: 'Cancelar pedido', CANCELAR_VENDA: 'Cancelar venda' };
const PEDE: Record<string, { campo: string; label: string }[]> = {
  REPROVAR: [{ campo: 'motivo', label: 'Motivo' }], CANCELAR: [{ campo: 'motivo', label: 'Motivo do cancelamento' }], CANCELAR_VENDA: [{ campo: 'motivo', label: 'Motivo do cancelamento' }],
  ENTREGAR_PARCIAL: [{ campo: 'motivo', label: 'O que faltou' }], DEVOLVER: [{ campo: 'motivo', label: 'Motivo da devolução' }],
  FATURAR: [{ campo: 'nfNumero', label: 'Número da nota fiscal' }], EXPEDIR: [{ campo: 'transportadora', label: 'Transportadora' }, { campo: 'rastreio', label: 'Código de rastreio' }],
};
// Ações automáticas ou internas que não viram botão.
const OCULTAS = new Set(['BLOQUEAR', 'FALTAR']);
// v1.57.1: motivos prontos para cancelamento e devolução (mais um detalhe opcional, ou "Outro" com texto).
const MOTIVOS_RETORNO = ['Desistência do cliente', 'Devolução do cliente', 'Produto com defeito', 'Produto com contaminação', 'Produto avariado', 'Produto vencido ou perto de vencer', 'Erro no lançamento', 'Outro'];
const MOTIVOS: Record<string, string[]> = { CANCELAR: ['Desistência do cliente', 'Sem estoque', 'Preço ou condição errada', 'Erro no lançamento', 'Outro'], CANCELAR_VENDA: MOTIVOS_RETORNO, DEVOLVER: MOTIVOS_RETORNO };

export default function Pedido() {
  const { id } = useParams();
  const state = useApi<any>(`/erp/vendas/pedidos/${id}`, [id]);
  const [pedindo, setPedindo] = useState<string | null>(null);
  const { busy, run } = useAction();
  const { can } = useAuth();
  const acao = async (evento: string, extra: any = {}) => { await run(() => post(`/erp/vendas/pedidos/${id}/acao`, { evento, ...extra }), ROTULO[evento]); setPedindo(null); state.reload(); };
  return (
    <>
      <Async state={state}>{(p) => (
        <>
          <div className="page-head">
            <div>
              <h1>Pedido nº {p.numero} {badgeStatus(p.statusOperacional)}</h1>
              <p className="muted"><Link to={`/erp/clientes/${p.parceiro?.id}`}>{p.parceiro?.fantasia || p.parceiro?.nome}</Link> · criado {fmtDate(p.createdAt)} · financeiro: {p.statusFinanceiro}{p.nfNumero ? ` · NF ${p.nfNumero}` : ''}{p.rastreio ? ` · rastreio ${p.rastreio}` : ''}</p>
              {p.motivoBloqueio && <p className="small" style={{ color: '#b45309' }}>{p.motivoBloqueio}</p>}
              {p.motivoCancelamento && <p className="small" style={{ color: '#dc2626' }}>{p.motivoCancelamento}</p>}
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Link className="btn" to="/erp/pedidos">Voltar</Link>
              <Link className="btn" to={`/erp/rastreio?pedido=${p.id}`}>🔎 Lotes deste pedido</Link>
              <Imprimir pedidoId={p.id} balcao={!!p.nfNumero?.startsWith('BALCAO-')} orcamento={p.statusOperacional === 'RASCUNHO'} />
              {p.acoes.filter((a: string) => !OCULTAS.has(a) && ((a !== 'APROVAR' && a !== 'CANCELAR_VENDA') || can('OWNER', 'ADMIN'))).map((a: string) => (
                <button key={a} className={`btn ${a === 'CANCELAR' || a === 'CANCELAR_VENDA' || a === 'REPROVAR' || a === 'DEVOLVER' ? 'ghost' : 'primary'}`} disabled={busy} onClick={() => (PEDE[a] ? setPedindo(a) : acao(a))}>{ROTULO[a] ?? a}</button>
              ))}
            </div>
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Qtd</th><th>Preço</th><th>Desc.</th><th>Total</th><th>Reservado</th><th>Separado</th></tr></thead>
              <tbody>{p.itens.map((i: any) => <tr key={i.id}><td>{i.descricao}</td><td>{qtd(i.qtdMil)}</td><td>{brl(i.precoUnitCents)}</td><td>{i.descontoBp ? `${(i.descontoBp / 100).toLocaleString('pt-BR')}%` : '—'}</td><td>{brl(i.totalCents)}</td><td>{qtd(i.reservadoMil)}</td><td>{qtd(i.separadoMil)}</td></tr>)}</tbody>
            </table>
            <div className="row between" style={{ marginTop: 8 }}><span className="small muted">Subtotal {brl(p.subtotalCents)} · descontos {brl(p.descontoCents)} · frete {brl(p.freteCents)}</span><strong>Total {brl(p.totalCents)}</strong></div>
          </div>
          <NfeDoPedido pedido={p} onFaturar={(nfNumero) => acao('FATURAR', { nfNumero })} />
          {p.separacao.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <h3>Lista de separação</h3>
              {p.statusOperacional === 'EM_SEPARACAO' && <Leitor pedidoId={p.id} onLido={state.reload} />}
              <table><thead><tr><th>Endereço</th><th>Item</th><th>Lote</th><th>Validade</th><th>Separar</th><th>Conferido</th></tr></thead>
                <tbody>{p.separacao.map((s: any) => <tr key={s.reservaId} style={{ opacity: s.separadoMil >= s.qtdMil ? 0.55 : 1 }}><td><strong>{s.endereco}</strong></td><td>{s.descricao}</td><td>{s.lote ?? '—'}</td><td>{s.validade ? new Date(s.validade).toLocaleDateString('pt-BR') : '—'}</td><td>{qtd(s.qtdMil)}</td><td>{s.separadoMil >= s.qtdMil ? '✔' : qtd(s.separadoMil)}</td></tr>)}</tbody></table>
            </div>
          )}
          {pedindo && <Pergunta evento={pedindo} onClose={() => setPedindo(null)} onConfirm={(v) => acao(pedindo, v)} />}
        </>
      )}</Async>
    </>
  );
}

/** Imprimir pedido / romaneio / recibo (todos com QR e código de barras do pedido para localizar depois). */
function Imprimir({ pedidoId, balcao, orcamento }: { pedidoId: string; balcao: boolean; orcamento?: boolean }) {
  const toast = useToast();
  const ir = (t: TipoDocumento) => imprimirDocumento(t, pedidoId).catch((e) => toast((e as Error).message, 'err'));
  return <>
    {balcao && <button className="btn" onClick={() => ir('recibo')}>🧾 Recibo</button>}
    {/* v1.54.0: rascunho imprime como orçamento (com "Válido até"). */}
    <button className="btn" onClick={() => ir('pedido')}>{orcamento ? '🖨️ Orçamento' : '🖨️ Pedido'}</button>
    <button className="btn" onClick={() => ir('romaneio')}>📦 Romaneio</button>
  </>;
}

/**
 * Separação: leitor USB/Bluetooth, câmera ou digitação (componente único de leitura). Confere o código lido com o
 * pedido: item ou lote errado → alerta (bipe grave + mensagem com o lote certo).
 */
function Leitor({ pedidoId, onLido }: { pedidoId: string; onLido: () => void }) {
  const [q, setQ] = useState('1');
  return (
    <div style={{ marginBottom: 10 }}>
      <CampoLeitura placeholder="Leia a etiqueta do lote ou o código de barras do produto" rotuloOk="Conferir" dicaCamera="Leia a etiqueta de cada volume separado."
        extra={<input value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 60 }} aria-label="Quantidade por leitura" title="Quantidade por leitura" inputMode="decimal" />}
        onCodigo={async (codigo) => { const r = await post<any>(`/erp/vendas/pedidos/${pedidoId}/conferencia`, { codigo, qtdMil: toMil(q) }); onLido(); return { ok: true, msg: r.tudoSeparado ? 'Tudo conferido: toque em "Concluir conferência"' : 'Conferido' }; }} />
    </div>
  );
}

function Pergunta({ evento, onClose, onConfirm }: { evento: string; onClose: () => void; onConfirm: (v: any) => void }) {
  const [v, setV] = useState<any>({});
  const campos = PEDE[evento];
  return (
    <Modal title={ROTULO[evento]} onClose={onClose}>
      {MOTIVOS[evento] && <Field label="Motivo"><select autoFocus value={v.tipoMotivo ?? ''} onChange={(e) => setV({ ...v, tipoMotivo: e.target.value, motivo: e.target.value === 'Outro' ? (v.detalhe ?? '') : [e.target.value, v.detalhe].filter(Boolean).join(': ') })}><option value="">Escolha o motivo</option>{MOTIVOS[evento].map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>}
      {campos.map((c, i) => MOTIVOS[evento] && c.campo === 'motivo'
        ? <Field key="detalhe" label={v.tipoMotivo === 'Outro' ? 'Descreva o motivo' : 'Detalhe (opcional)'}><input value={v.detalhe ?? ''} onChange={(e) => setV({ ...v, detalhe: e.target.value, motivo: v.tipoMotivo === 'Outro' ? e.target.value : [v.tipoMotivo, e.target.value].filter(Boolean).join(': ') })} /></Field>
        : <Field key={c.campo} label={c.label}><input autoFocus={i === 0} value={v[c.campo] ?? ''} onChange={(e) => setV({ ...v, [c.campo]: e.target.value })} /></Field>)}
      {evento === 'CANCELAR_VENDA' && <p className="small" style={{ margin: '4px 0 8px' }}>O dinheiro recebido é estornado da conta (ou do caixa) e a conta a receber é cancelada. Se tiver NF-e autorizada, cancele a nota antes.</p>}
      {(evento === 'DEVOLVER' || evento === 'CANCELAR_VENDA') && <label className="row small" style={{ margin: '4px 0 8px' }}><input type="checkbox" checked={v.voltarEstoque ?? true} onChange={(e) => setV({ ...v, voltarEstoque: e.target.checked })} /> Os produtos voltaram para a loja (entram no mesmo lote e local, em quarentena, até a qualidade liberar no Estoque)</label>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Voltar</button><button className="btn primary" disabled={evento !== 'EXPEDIR' && !v[campos[0].campo]} onClick={() => onConfirm(evento === 'DEVOLVER' || evento === 'CANCELAR_VENDA' ? { ...v, voltarEstoque: v.voltarEstoque ?? true } : v)}>Confirmar</button></div>
    </Modal>
  );
}
