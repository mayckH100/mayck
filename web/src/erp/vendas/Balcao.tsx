/** Venda balcão: leitor de código de barras ou busca, cliente opcional, pagamento na hora; baixa o estoque e já recebe.
 * Entra no caixa aberto (caixaSessaoId); dinheiro vai para a conta do caixa, Pix/cartão para a conta escolhida.
 * Cartão com maquininha configurada: a cobrança vai para o terminal e a venda só fecha quando o pagamento é aprovado. */
import { useEffect, useRef, useState } from 'react';
import { get, post, ApiError } from '../../api';
import { useApi, Modal, Field, useAction } from '../../ui';
import { brl, toCents, toMil } from '../format';
import { BuscaParceiro } from '../comum';

const FORMAS = [['DINHEIRO', 'Dinheiro'], ['PIX', 'Pix'], ['CARTAO', 'Cartão']] as const;
const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const FIM_COBRANCA: Record<string, string> = { RECUSADA: 'Pagamento recusado na maquininha.', CANCELADA: 'Cobrança cancelada.', EXPIRADA: 'A cobrança expirou sem pagamento.', ESTORNADA: 'O pagamento foi estornado.' };

export default function VendaBalcao({ caixaSessaoId, onClose, onDone }: { caixaSessaoId: string; onClose: () => void; onDone: (p: any) => void }) {
  const contas = useApi<any[]>('/erp/vendas/balcao/contas');
  const [itens, setItens] = useState<{ produto: any; qtd: string; preco: string }[]>([]);
  const [busca, setBusca] = useState(''); const [ops, setOps] = useState<any[]>([]);
  const [cliente, setCliente] = useState<any>(null); const [nome, setNome] = useState('');
  const [forma, setForma] = useState<string>('DINHEIRO'); const [contaId, setContaId] = useState('');
  const [desconto, setDesconto] = useState(''); const [recebido, setRecebido] = useState('');
  const [feito, setFeito] = useState<any>(null);
  const maq = useApi<{ ativa: boolean; nome?: string; terminalId?: string }>('/erp/vendas/balcao/cartao/maquininha');
  const [tipoCartao, setTipoCartao] = useState<'CREDITO' | 'DEBITO'>('CREDITO'); const [parcelas, setParcelas] = useState(1);
  const [manual, setManual] = useState(false);
  const [cob, setCob] = useState<any>(null);
  const usaMaquininha = forma === 'CARTAO' && !!maq.data?.ativa && !manual;
  const { busy, run } = useAction();
  const ref = useRef<HTMLInputElement>(null);

  const add = (p: any) => {
    setBusca(''); setOps([]);
    setItens((l) => { const i = l.findIndex((x) => x.produto.id === p.id); if (i >= 0) return l.map((x, k) => (k === i ? { ...x, qtd: String((Number(x.qtd.replace(',', '.')) || 0) + 1).replace('.', ',') } : x)); return [...l, { produto: p, qtd: '1', preco: reais(p.precoBaseCents ?? 0) }]; });
    ref.current?.focus();
  };
  const buscar = async (q: string) => { setBusca(q); setOps(q.trim().length >= 2 ? (await get<any>(`/erp/produtos?ativos=1&q=${encodeURIComponent(q.trim())}`)).items.slice(0, 8) : []); };
  // Enter no campo: leitor de código de barras (ou SKU exato) entra direto.
  const enter = async () => {
    const q = busca.trim(); if (!q) return;
    const r = (await get<any>(`/erp/produtos?ativos=1&q=${encodeURIComponent(q)}`)).items as any[];
    const exato = r.find((p) => p.codigoBarras === q || p.sku === q.toUpperCase()) ?? (r.length === 1 ? r[0] : null);
    if (exato) add(exato); else setOps(r.slice(0, 8));
  };
  // Aviso antes de finalizar: o servidor recusa a venda sem estoque ("Sem estoque disponível").
  const semEstoque = (x: { produto: any; qtd: string }) => x.produto.tipo !== 'SERVICO' && !!x.produto.saldo && x.produto.saldo.disponivelMil < toMil(x.qtd);
  const linha = (x: { qtd: string; preco: string }) => Math.round((toMil(x.qtd) * toCents(x.preco)) / 1000);
  const subtotal = itens.reduce((a, x) => a + linha(x), 0);
  const total = Math.max(0, subtotal - toCents(desconto));
  const troco = forma === 'DINHEIRO' && recebido ? toCents(recebido) - total : 0;

  const corpo = () => ({ parceiroId: cliente?.id ?? null, nomeCliente: cliente ? null : nome || null, forma, caixaSessaoId, contaId: forma === 'DINHEIRO' ? null : contaId || contas.data?.[0]?.id || null, descontoCents: toCents(desconto), itens: itens.map((x) => ({ produtoId: x.produto.id, qtdMil: toMil(x.qtd), precoUnitCents: toCents(x.preco) })) });
  async function finalizar() {
    if (usaMaquininha) {
      const c = await run(async () => {
        try { return await post('/erp/vendas/balcao/cartao', { ...corpo(), tipo: tipoCartao, parcelas: tipoCartao === 'CREDITO' ? parcelas : 1 }); } catch (e) {
          // Maquininha ocupada com outra cobrança: abre essa para acompanhar/cancelar.
          const id = e instanceof ApiError ? (e.details as any)?.cobrancaId : null;
          if (id) return await get(`/erp/vendas/balcao/cartao/${id}`);
          throw e;
        }
      });
      if (c) setCob(c);
      return;
    }
    const p = await run(() => post('/erp/vendas/balcao', corpo()), 'Venda concluída');
    if (p) setFeito(p);
  }
  // "Aguardando pagamento na maquininha": consulta o status a cada 2,5 s até aprovar, recusar, cancelar ou expirar.
  useEffect(() => {
    if (!cob || cob.status !== 'PENDENTE') return;
    let vivo = true;
    const t = setTimeout(async () => { try { const c = await get(`/erp/vendas/balcao/cartao/${cob.id}`); if (vivo) setCob(c); } catch { if (vivo) setCob({ ...cob }); } }, 2500);
    return () => { vivo = false; clearTimeout(t); };
  }, [cob]);
  useEffect(() => { if (cob?.status === 'APROVADA' && cob.pedido) { setFeito(cob.pedido); setCob(null); } }, [cob]);

  if (cob) return (
    <Modal title="Pagamento na maquininha" onClose={() => { if (cob.status !== 'PENDENTE') setCob(null); }}>
      <p style={{ fontSize: 22 }}><b>{brl(cob.valorCents)}</b> · {cob.tipo === 'DEBITO' ? 'Débito' : `Crédito ${cob.parcelas > 1 ? `${cob.parcelas}x sem juros` : 'à vista'}`}</p>
      {cob.status === 'PENDENTE' && <>
        <p style={{ fontSize: 18 }} role="status">⏳ Aguardando pagamento na maquininha…</p>
        <p className="small muted">{cob.cancelamentoSolicitado ? 'Cancelamento pedido: aguardando a maquininha confirmar.' : cob.statusProvedor === 'at_terminal' ? 'A cobrança já está na tela da maquininha: peça para o cliente aproximar ou inserir o cartão.' : 'Enviando a cobrança para a maquininha…'}</p>
        {cob.aviso && <p className="small" style={{ color: '#b45309' }}>{cob.aviso}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" disabled={busy || cob.cancelamentoSolicitado} onClick={async () => { const c = await run(() => post(`/erp/vendas/balcao/cartao/${cob.id}/cancelar`)); if (c) setCob(c); }}>Cancelar cobrança</button>
        </div>
      </>}
      {FIM_COBRANCA[cob.status] && <>
        <p style={{ fontSize: 18, color: '#dc2626' }}>{FIM_COBRANCA[cob.status]}</p>
        <p className="small muted">Nenhuma venda foi registrada e o estoque não foi baixado.{cob.detalhe ? ` (${cob.detalhe})` : ''}</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" onClick={() => setCob(null)}>Voltar à venda</button>
          <button className="btn primary" disabled={busy} onClick={() => { setCob(null); finalizar(); }}>Cobrar de novo</button>
        </div>
      </>}
      {cob.status === 'ERRO_VENDA' && <>
        <p style={{ fontSize: 18, color: '#dc2626' }}>Pagamento aprovado, mas a venda não foi registrada.</p>
        <p className="small">{cob.detalhe}</p>
        <p className="small muted">Resolva o motivo (por exemplo, abra o caixa) e toque em Concluir venda. Se não for vender, faça o estorno pela maquininha.</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" onClick={() => setCob(null)}>Fechar</button>
          <button className="btn primary" disabled={busy} onClick={async () => { const c = await run(() => post(`/erp/vendas/balcao/cartao/${cob.id}/concluir`, { caixaSessaoId })); if (c) setCob(c); }}>Concluir venda</button>
        </div>
      </>}
    </Modal>
  );

  if (feito) return (
    <Modal title="Venda concluída" onClose={() => onDone(feito)}>
      <p style={{ fontSize: 18 }}>Venda nº <b>{feito.numero}</b> · <b>{brl(feito.totalCents)}</b> recebido em {FORMAS.find((f) => f[0] === forma)?.[1]}.</p>
      {troco > 0 && <p style={{ fontSize: 22 }}>Troco: <b>{brl(troco)}</b></p>}
      <p className="small muted">Estoque baixado e valor lançado no caixa.</p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
        <button className="btn" onClick={() => onDone(feito)}>Fechar</button>
        <button className="btn primary" onClick={() => { setFeito(null); setItens([]); setCliente(null); setNome(''); setDesconto(''); setRecebido(''); }}>Nova venda</button>
      </div>
    </Modal>
  );

  return (
    <Modal title="Venda balcão" onClose={onClose}>
      <Field label="Produto" hint="Use o leitor de código de barras ou digite nome/SKU e tecle Enter">
        <div style={{ position: 'relative' }}>
          <input ref={ref} autoFocus value={busca} placeholder="Código de barras, SKU ou nome" onChange={(e) => buscar(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); enter(); } }} aria-label="Produto" />
          {ops.length > 0 && <div className="card" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, padding: 4 }}>{ops.map((p) => <button key={p.id} type="button" className="btn ghost sm" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => add(p)}>{p.sku} · {p.nome} — {brl(p.precoBaseCents)}{p.saldo ? ` · ${p.saldo.disponivelMil / 1000} disp.` : ''}</button>)}</div>}
        </div>
      </Field>
      {itens.length > 0 && <div className="table-wrap"><table><thead><tr><th>Produto</th><th>Qtd</th><th>Preço (R$)</th><th>Total</th><th></th></tr></thead><tbody>
        {itens.map((x, i) => <tr key={x.produto.id}>
          <td className="small">{x.produto.nome}{semEstoque(x) && <div style={{ color: '#dc2626' }}>Sem estoque suficiente ({(x.produto.saldo?.disponivelMil ?? 0) / 1000} disp.): dê entrada em Estoque antes de vender.</div>}</td>
          <td><input style={{ width: 64 }} value={x.qtd} inputMode="decimal" aria-label="Quantidade" onChange={(e) => setItens(itens.map((y, k) => (k === i ? { ...y, qtd: e.target.value } : y)))} /></td>
          <td><input style={{ width: 80 }} value={x.preco} inputMode="decimal" aria-label="Preço" onChange={(e) => setItens(itens.map((y, k) => (k === i ? { ...y, preco: e.target.value } : y)))} /></td>
          <td>{brl(linha(x))}</td>
          <td><button className="btn ghost sm" onClick={() => setItens(itens.filter((_, k) => k !== i))} aria-label="Remover">✕</button></td>
        </tr>)}
      </tbody></table></div>}
      <div className="grid g2">
        <Field label="Cliente (opcional)">{cliente ? <div className="row between"><strong>{cliente.fantasia || cliente.nome}</strong><button className="btn ghost sm" onClick={() => setCliente(null)}>Trocar</button></div> : <><BuscaParceiro tipo="cliente" placeholder="Buscar cliente cadastrado" onPick={setCliente} /><input style={{ marginTop: 4 }} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="ou só o nome (consumidor final)" aria-label="Nome do cliente" /></>}</Field>
        <Field label="Desconto (R$)"><input value={desconto} onChange={(e) => setDesconto(e.target.value)} inputMode="decimal" placeholder="0,00" /></Field>
      </div>
      <Field label="Pagamento"><div className="row" style={{ gap: 6 }}>{FORMAS.map(([v, r]) => <button key={v} type="button" className={`btn ${forma === v ? 'primary' : ''}`} onClick={() => setForma(v)}>{r}</button>)}</div></Field>
      {forma === 'CARTAO' && maq.data?.ativa && <div className="card" style={{ padding: 8, marginBottom: 6 }}>
        {!manual ? <>
          <p className="small" style={{ margin: '0 0 6px' }}>A cobrança vai para a maquininha <b>{maq.data.nome}</b> ({maq.data.terminalId}).</p>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {(['CREDITO', 'DEBITO'] as const).map((t) => <button key={t} type="button" className={`btn sm ${tipoCartao === t ? 'primary' : ''}`} onClick={() => { setTipoCartao(t); if (t === 'DEBITO') setParcelas(1); }}>{t === 'CREDITO' ? 'Crédito' : 'Débito'}</button>)}
            {tipoCartao === 'CREDITO' && <select aria-label="Parcelas" value={parcelas} onChange={(e) => setParcelas(Number(e.target.value))}>{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? 'À vista' : `${n}x sem juros`}</option>)}</select>}
            <button type="button" className="btn ghost sm" onClick={() => setManual(true)}>Lançar sem maquininha</button>
          </div>
        </> : <div className="row between"><span className="small muted">Lançamento manual (o cartão foi passado fora do sistema).</span><button type="button" className="btn ghost sm" onClick={() => setManual(false)}>Usar a maquininha</button></div>}
      </div>}
      <div className="grid g2">
        {forma !== 'DINHEIRO' && (contas.data?.length ?? 0) > 1 && <Field label="Receber na conta"><select value={contaId} onChange={(e) => setContaId(e.target.value)}>{contas.data!.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>}
        {forma === 'DINHEIRO' && <Field label="Valor recebido (R$)" hint={troco > 0 ? `Troco: ${brl(troco)}` : undefined}><input value={recebido} onChange={(e) => setRecebido(e.target.value)} inputMode="decimal" placeholder={reais(total)} /></Field>}
      </div>
      <div className="row between" style={{ marginTop: 10 }}>
        <span style={{ fontSize: 22 }}>Total <b>{brl(total)}</b></span>
        <button className="btn primary" disabled={busy || !itens.length || total <= 0 || (forma === 'DINHEIRO' && !!recebido && troco < 0)} onClick={finalizar}>{usaMaquininha ? 'Cobrar na maquininha' : 'Finalizar venda'}</button>
      </div>
    </Modal>
  );
}
