/** Venda balcão: leitor de código de barras ou busca, cliente opcional, pagamento na hora; baixa o estoque e já recebe.
 * v1.34.0: cada leitura (leitor USB/Bluetooth, câmera do celular ou digitação) soma +1; etiqueta do lote (GS1/QR) →
 * a baixa sai DAQUELE lote; sem lote, mostra o lote que sai pela regra (FEFO/FIFO). Recibo com QR do pedido.
 * Entra no caixa aberto (caixaSessaoId); dinheiro vai para a conta do caixa, Pix/cartão para a conta escolhida.
 * Cartão com maquininha configurada: a cobrança vai para o terminal e a venda só fecha quando o pagamento é aprovado.
 * v1.59.0: cartão sem maquininha conectada abre um aviso no meio da tela (seguir sem ela ou voltar); a venda sai marcada
 * "liberada sem aprovação da maquininha". Pix: QR Code com a chave da empresa e o valor da venda; o operador confirma o recebimento. */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put, ApiError } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Modal, Field, useAction, useToast } from '../../ui';
import { LeitorCamera, sinal } from '../leitura/Leitor';
import { imprimirDocumento } from './documento';
import { brl, toCents, toMil } from '../format';
import { BuscaParceiro } from '../comum';
import { BAUDS, baudSalvo, fecharBalanca, lerPeso, salvarBaud, temSerial } from './balancaSerial';

const FORMAS = [['DINHEIRO', 'Dinheiro'], ['PIX', 'Pix'], ['CARTAO', 'Cartão']] as const;
const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const FIM_COBRANCA: Record<string, string> = { RECUSADA: 'Pagamento recusado na maquininha.', CANCELADA: 'Cobrança cancelada.', EXPIRADA: 'A cobrança expirou sem pagamento.', ESTORNADA: 'O pagamento foi estornado.' };

export default function VendaBalcao({ caixaSessaoId, onClose, onDone }: { caixaSessaoId: string; onClose: () => void; onDone: (p: any) => void }) {
  const contas = useApi<any[]>('/erp/vendas/balcao/contas');
  type Linha = { produto: any; lote: any | null; sugestao: any | null; aviso: string | null; qtd: string; preco: string; uid?: string };
  const [itens, setItens] = useState<Linha[]>([]);
  const [cam, setCam] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const toast = useToast();
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
  const { can } = useAuth(); const gestor = can('OWNER', 'ADMIN');
  const pixCfg = useApi<any>('/erp/vendas/balcao/pix/config');
  const [avisoMaq, setAvisoMaq] = useState(false);
  const [semMaq, setSemMaq] = useState(false);
  const [pix, setPix] = useState<any>(null);
  const [pixForm, setPixForm] = useState<{ keyType: string; key: string; name: string; city: string } | null>(null);
  const { busy, run } = useAction();
  const ref = useRef<HTMLInputElement>(null);

  const chave = (x: { produto: any; lote: any | null; uid?: string }) => `${x.produto.id}:${x.lote?.id ?? ''}${x.uid ? `:${x.uid}` : ''}`;
  const qtdTexto = (mil: number) => (mil / 1000).toFixed(3).replace(/\.?0+$/, '').replace('.', ',');
  const porPeso = (p: any) => String(p?.unidade ?? '').toUpperCase() === 'KG';
  const [pesando, setPesando] = useState<number | null>(null); const [baud, setBaud] = useState(baudSalvo());
  /** v1.58.0: lê o peso da balança ligada ao computador e põe na linha. */
  async function pesar(i: number, escolher = false) {
    setPesando(i);
    const r = await lerPeso(escolher);
    setPesando(null);
    if (!r.ok) { sinal(false); setMsg({ ok: false, t: r.erro }); return; }
    if (r.gramas <= 0) { sinal(false); setMsg({ ok: false, t: 'A balança está vazia (0 kg)' }); return; }
    sinal(true); setItens((l) => l.map((y, k) => (k === i ? { ...y, qtd: qtdTexto(r.gramas) } : y))); setMsg({ ok: true, t: `⚖️ ${qtdTexto(r.gramas)} kg` });
  }
  /** Cada leitura soma +1 na linha do mesmo produto + lote (ou cria a linha). */
  const add = (p: any, extra: { lote?: any; sugestao?: any; aviso?: string | null } = {}) => {
    setBusca(''); setOps([]);
    const nova: Linha = { produto: p, lote: extra.lote ?? null, sugestao: extra.sugestao ?? null, aviso: extra.aviso ?? null, qtd: '1', preco: reais(p.precoBaseCents ?? 0) };
    setItens((l) => { const i = l.findIndex((x) => chave(x) === chave(nova)); if (i >= 0) return l.map((x, k) => (k === i ? { ...x, aviso: nova.aviso, qtd: String((Number(x.qtd.replace(',', '.')) || 0) + 1).replace('.', ',') } : x)); return [...l, nova]; });
    ref.current?.focus();
  };
  const buscar = async (q: string) => { setBusca(q); setOps(q.trim().length >= 2 ? (await get<any>(`/erp/produtos?ativos=1&q=${encodeURIComponent(q.trim())}`)).items.slice(0, 8) : []); };
  /** Leitura (leitor que digita + Enter, câmera ou Enter no campo): produto, etiqueta do lote ou código. */
  const ler = async (codigo: string) => {
    const q = codigo.replace(/[\r\n]+/g, '').trim(); if (!q) return;
    try {
      const r = await get<any>(`/erp/vendas/balcao/ler?codigo=${encodeURIComponent(q)}`);
      if (r.lote && (r.lote.vencido || r.lote.disponivelMil <= 0)) { sinal(false); setMsg({ ok: false, t: r.aviso }); return; }
      if (r.balanca) {
        // Etiqueta da balança: cada etiqueta é uma linha com o peso dela (não soma +1).
        setBusca(''); setOps([]);
        setItens((l) => [...l, { produto: r.produto, lote: null, sugestao: r.sugestao, aviso: r.aviso, qtd: qtdTexto(r.balanca.qtdMil), preco: reais(r.produto.precoBaseCents ?? 0), uid: String(Date.now()) }]);
        sinal(!r.aviso); setMsg(r.aviso ? { ok: false, t: r.aviso } : { ok: true, t: `⚖️ ${qtdTexto(r.balanca.qtdMil)} kg · ${r.produto.nome}` });
        ref.current?.focus(); return;
      }
      add(r.produto, { lote: r.lote, sugestao: r.sugestao, aviso: r.aviso });
      sinal(!r.aviso); setMsg(r.aviso ? { ok: false, t: r.aviso } : { ok: true, t: `+1 ${r.produto.nome}${r.lote ? ` · lote ${r.lote.numero}` : ''}` });
    } catch (e) {
      // Não é código: procura por nome/código (digitação).
      const lista = (await get<any>(`/erp/produtos?ativos=1&q=${encodeURIComponent(q)}`).catch(() => ({ items: [] }))).items as any[];
      if (lista.length === 1) { add(lista[0]); sinal(true); setMsg({ ok: true, t: `+1 ${lista[0].nome}` }); return; }
      if (lista.length) { setOps(lista.slice(0, 8)); setMsg(null); return; }
      sinal(false); setMsg({ ok: false, t: e instanceof ApiError ? e.message : 'Produto não encontrado' });
    }
  };
  const enter = () => ler(busca);
  // Aviso antes de finalizar: o servidor recusa a venda sem estoque ("Sem estoque disponível").
  const semEstoque = (x: Linha) => x.produto.tipo !== 'SERVICO' && (x.lote ? x.lote.disponivelMil < toMil(x.qtd) : !!x.produto.saldo && x.produto.saldo.disponivelMil < toMil(x.qtd));
  const linha = (x: { qtd: string; preco: string }) => Math.round((toMil(x.qtd) * toCents(x.preco)) / 1000);
  const subtotal = itens.reduce((a, x) => a + linha(x), 0);
  const total = Math.max(0, subtotal - toCents(desconto));
  const troco = forma === 'DINHEIRO' && recebido ? toCents(recebido) - total : 0;

  const corpo = () => ({ parceiroId: cliente?.id ?? null, nomeCliente: cliente ? null : nome || null, forma, caixaSessaoId, contaId: forma === 'DINHEIRO' ? null : contaId || contas.data?.[0]?.id || null, descontoCents: toCents(desconto), itens: itens.map((x) => ({ produtoId: x.produto.id, qtdMil: toMil(x.qtd), precoUnitCents: toCents(x.preco), loteId: x.lote?.id ?? null })) });
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
    // Cartão sem maquininha conectada: avisa no meio da tela antes de liberar (não trava a venda).
    if (forma === 'CARTAO') { setAvisoMaq(true); return; }
    if (forma === 'PIX') { await abrirPix(); return; }
    await concluir();
  }
  async function concluir(obs?: string, aviso?: string) {
    const p = await run(() => post('/erp/vendas/balcao', { ...corpo(), observacoes: obs ?? null }), aviso ?? 'Venda concluída');
    if (p) { setFeito(p); setPix(null); setAvisoMaq(false); }
  }
  async function abrirPix() {
    if (!pixCfg.data?.configurado) { setPix({ semChave: true }); return; }
    const r = await run(() => get(`/erp/vendas/balcao/pix?valorCents=${total}`));
    if (r) setPix(r);
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

  if (avisoMaq) return (
    <Modal title="⚠️ Maquininha não conectada" onClose={() => setAvisoMaq(false)}>
      <p style={{ fontSize: 18 }}>{maq.data?.ativa ? 'Você escolheu lançar sem a maquininha.' : 'Nenhuma maquininha está conectada ao sistema.'} O pagamento de <b>{brl(total)}</b> não será conferido por ela.</p>
      <p className="small muted">Só siga se o cartão já foi passado e aprovado em outra maquininha. A venda fica marcada como "liberada sem aprovação da maquininha".{gestor ? ' Para conectar uma, vá em ☰ › Maquininhas.' : ''}</p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => setAvisoMaq(false)}>Voltar</button>
        <button className="btn primary" disabled={busy} onClick={async () => { setSemMaq(true); await concluir('Cartão: venda liberada sem aprovação da maquininha', 'Venda liberada sem aprovação da maquininha'); }}>Seguir sem maquininha</button>
      </div>
    </Modal>
  );

  if (pix) return (
    <Modal title="Pagamento com Pix" onClose={() => setPix(null)}>
      {pix.semChave ? (pixForm ? <>
        <p className="small muted" style={{ marginTop: 0 }}>Cadastre a chave Pix da empresa uma vez. O QR Code sai com o valor da venda e o dinheiro cai direto nessa conta.</p>
        <Field label="Tipo da chave"><select value={pixForm.keyType} onChange={(e) => setPixForm({ ...pixForm, keyType: e.target.value })}>{[['cnpj', 'CNPJ'], ['cpf', 'CPF'], ['email', 'E-mail'], ['telefone', 'Telefone'], ['aleatoria', 'Chave aleatória']].map(([v, r]) => <option key={v} value={v}>{r}</option>)}</select></Field>
        <Field label="Chave Pix"><input value={pixForm.key} onChange={(e) => setPixForm({ ...pixForm, key: e.target.value })} /></Field>
        <Field label="Nome do recebedor (como aparece no banco)"><input value={pixForm.name} onChange={(e) => setPixForm({ ...pixForm, name: e.target.value })} /></Field>
        <Field label="Cidade"><input value={pixForm.city} onChange={(e) => setPixForm({ ...pixForm, city: e.target.value })} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" onClick={() => setPixForm(null)}>Voltar</button>
          <button className="btn primary" disabled={busy || !pixForm.key.trim() || pixForm.name.trim().length < 2 || pixForm.city.trim().length < 2} onClick={async () => { if (await run(() => put('/erp/vendas/balcao/pix/config', pixForm), 'Chave Pix salva')) { setPixForm(null); pixCfg.reload(); const r = await run(() => get(`/erp/vendas/balcao/pix?valorCents=${total}`)); if (r) setPix(r); } }}>Salvar e gerar QR</button>
        </div>
      </> : <>
        <p>A chave Pix da empresa ainda não foi cadastrada, então não dá para gerar o QR Code.</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" onClick={() => setPix(null)}>Voltar</button>
          {gestor ? <button className="btn primary" onClick={() => setPixForm({ keyType: 'cnpj', key: '', name: '', city: '' })}>Cadastrar chave Pix</button> : <span className="small muted">Peça ao dono ou administrador para cadastrar.</span>}
        </div>
      </>) : <>
        <p style={{ fontSize: 22, textAlign: 'center', margin: '0 0 6px' }}><b>{brl(pix.valorCents)}</b></p>
        <div style={{ textAlign: 'center' }}><img src={pix.png} alt="QR Code Pix" style={{ width: 'min(280px, 80vw)', height: 'auto' }} /></div>
        <p className="small muted" style={{ textAlign: 'center' }}>Peça para o cliente ler com o app do banco. Recebedor: <b>{pix.nome}</b> · chave {pix.chave}</p>
        <div className="row" style={{ gap: 6 }}><input readOnly value={pix.codigo} aria-label="Pix copia e cola" onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} /><button className="btn sm" onClick={() => { navigator.clipboard?.writeText(pix.codigo).then(() => toast('Código copiado'), () => undefined); }}>Copiar</button></div>
        <p className="small" style={{ color: '#b45309' }}>Confira no app do banco que o Pix caiu antes de confirmar. A confirmação automática entra quando a API Pix do banco for ligada.</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setPix(null)}>Voltar</button>
          <button className="btn primary" disabled={busy} onClick={() => concluir(`Pix ${pix.txid}: recebimento confirmado pelo operador`, 'Pix confirmado. Venda concluída')}>Pix recebido · concluir venda</button>
        </div>
      </>}
    </Modal>
  );

  if (feito) return (
    <Modal title="Venda concluída" onClose={() => onDone(feito)}>
      <p style={{ fontSize: 18 }}>Venda nº <b>{feito.numero}</b> · <b>{brl(feito.totalCents)}</b> recebido em {FORMAS.find((f) => f[0] === forma)?.[1]}.</p>
      {forma === 'CARTAO' && semMaq && <p className="small" style={{ color: '#b45309' }}>⚠️ Venda liberada sem aprovação da maquininha.</p>}
      {troco > 0 && <p style={{ fontSize: 22 }}>Troco: <b>{brl(troco)}</b></p>}
      <p className="small muted">Estoque baixado (com o lote) e valor lançado no caixa. Para achar esta venda depois, leia o QR do recibo ou procure por <b>PV-{feito.numero}</b> em Localizar pedido.</p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => imprimirDocumento('recibo', feito.id).catch((e) => toast((e as Error).message, 'err'))}>🧾 Imprimir recibo</button>
        <Link className="btn" to={`/erp/pedidos/${feito.id}`} title="Abre a venda; lá dá para emitir NF-e (homologação) se o cliente pedir">Nota fiscal / abrir venda</Link>
        <button className="btn" onClick={() => onDone(feito)}>Fechar</button>
        <button className="btn primary" onClick={() => { setFeito(null); setSemMaq(false); setMsg(null); setItens([]); setCliente(null); setNome(''); setDesconto(''); setRecebido(''); }}>Nova venda</button>
      </div>
    </Modal>
  );

  return (
    <Modal title="Venda balcão" onClose={onClose}>
      <Field label="Produto" hint="Leitor de código de barras/QR (USB ou Bluetooth), câmera 📷 ou digite nome/código e tecle Enter. Cada leitura soma 1; a etiqueta da balança já vem com o peso.">
        <div style={{ position: 'relative' }}>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <input ref={ref} autoFocus value={busca} placeholder="Leia o código ou digite" onChange={(e) => buscar(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); enter(); } }} aria-label="Produto" autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" style={{ flex: 1, minWidth: 0 }} />
            <button type="button" className="btn" onClick={() => setCam(true)} aria-label="Ler com a câmera">📷</button>
          </div>
          {ops.length > 0 && <div className="card" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, padding: 4 }}>{ops.map((p) => <button key={p.id} type="button" className="btn ghost sm" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => add(p)}>{p.sku} · {p.nome} — {brl(p.precoBaseCents)}{p.saldo ? ` · ${p.saldo.disponivelMil / 1000} disp.` : ''}</button>)}</div>}
        </div>
        {msg && <div role="status" className="small" style={{ marginTop: 4, padding: '6px 8px', borderRadius: 6, background: msg.ok ? '#ecfdf5' : '#fef2f2', color: msg.ok ? '#065f46' : '#991b1b', fontWeight: 600 }}>{msg.ok ? '✔ ' : '⚠️ '}{msg.t}</div>}
      </Field>
      {cam && <LeitorCamera dica="Aponte para o código de barras do produto ou a etiqueta do lote." onLer={(c) => { ler(c); }} onClose={() => { setCam(false); ref.current?.focus(); }} />}
      {itens.length > 0 && <div className="balcao-itens">
        {itens.map((x, i) => <div key={chave(x)} className="card" style={{ padding: 8, marginBottom: 6 }} data-testid="balcao-item">
          <div className="row between" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <b className="small">{x.produto.nome}</b> <span className="small muted">{x.produto.sku}</span>
              {x.lote ? <div className="small">🏷️ Lote <b>{x.lote.numero}</b> (da etiqueta){x.lote.validade ? ` · val. ${String(x.lote.validade).slice(0, 10).split('-').reverse().join('/')}` : ''}</div>
                : x.sugestao ? <div className="small muted">Sai do lote {x.sugestao.numero} ({x.sugestao.regra === 'FEFO' ? 'vence primeiro' : 'mais antigo'})</div> : null}
              {semEstoque(x) && <div className="small" style={{ color: '#dc2626' }}>Sem estoque suficiente ({((x.lote ? x.lote.disponivelMil : x.produto.saldo?.disponivelMil) ?? 0) / 1000} disp.{x.lote ? ' neste lote' : ''}).</div>}
            </div>
            <button className="btn ghost sm" onClick={() => setItens(itens.filter((_, k) => k !== i))} aria-label="Remover">✕</button>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'nowrap' }}>
            {porPeso(x.produto) && temSerial() && <button type="button" className="btn sm" disabled={pesando !== null} title="Ler o peso da balança ligada a este computador" onClick={() => pesar(i)}>{pesando === i ? '…' : '⚖️'}</button>}
            <label className="small row" style={{ gap: 4, flexWrap: 'nowrap' }}>{porPeso(x.produto) ? 'Kg' : 'Qtd'} <input style={{ width: 64 }} value={x.qtd} inputMode="decimal" aria-label="Quantidade" onChange={(e) => setItens(itens.map((y, k) => (k === i ? { ...y, qtd: e.target.value } : y)))} /></label>
            <label className="small row" style={{ gap: 4, flexWrap: 'nowrap' }}>R$ <input style={{ width: 80 }} value={x.preco} inputMode="decimal" aria-label="Preço" onChange={(e) => setItens(itens.map((y, k) => (k === i ? { ...y, preco: e.target.value } : y)))} /></label>
            <b style={{ marginLeft: 'auto' }}>{brl(linha(x))}</b>
          </div>
        </div>)}
      </div>}
      {temSerial() && itens.some((x) => porPeso(x.produto)) && <div className="row small muted" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        ⚖️ Balança no computador:
        <select aria-label="Velocidade da balança" value={baud} onChange={async (e) => { const b = Number(e.target.value); salvarBaud(b); setBaud(b); await fecharBalanca(); }}>{BAUDS.map((b) => <option key={b} value={b}>{b} baud</option>)}</select>
        <button type="button" className="btn ghost sm" onClick={() => { const i = itens.findIndex((x) => porPeso(x.produto)); if (i >= 0) pesar(i, true); }}>Escolher/trocar balança</button>
      </div>}
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
        <button className="btn primary" disabled={busy || !itens.length || total <= 0 || (forma === 'DINHEIRO' && !!recebido && troco < 0)} onClick={finalizar}>{usaMaquininha ? 'Cobrar na maquininha' : forma === 'PIX' ? 'Gerar QR Pix' : 'Finalizar venda'}</button>
      </div>
    </Modal>
  );
}
