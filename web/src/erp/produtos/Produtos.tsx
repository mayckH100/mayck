/** Produtos: cadastro com NCM, lote/validade, FEFO/FIFO, mínimo e estimativa de compra; regras comerciais (alçada). */
import { useState } from 'react';
import { post, put, del } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction } from '../../ui';
import ImportarExportar from '../ImportarExportar';
import { brl, qtd, toCents, fromCents, toMil } from '../format';
import { UNIDADES_CADASTRO, unidadeValida, unidadeLegivel, qtdUn, nomeUnidade, numeroQtd } from '../../../../server/erp/shared/unidade';
import { descricaoEmbalagem } from '../../../../server/erp/shared/embalagem';

export default function Produtos() {
  const [q, setQ] = useState(''); const [query, setQuery] = useState('');
  const state = useApi<any>(`/erp/produtos?q=${encodeURIComponent(query)}`, [query]);
  const [edit, setEdit] = useState<any>(null);
  const [regras, setRegras] = useState(false);
  const [excluir, setExcluir] = useState<any>(null);
  const { can } = useAuth();
  const admin = can('OWNER', 'ADMIN');
  return (
    <>
      <div className="page-head">
        <div><h1>Produtos</h1><p className="muted">Cadastro com dados fiscais, controle de lote e validade, e alertas de estoque mínimo.</p></div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><input placeholder="Nome, código ou código de barras" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 230 }} aria-label="Pesquisar" /></form>
          {can('OWNER', 'ADMIN') && <button className="btn" onClick={() => setRegras(true)}>Regras comerciais</button>}
          <ImportarExportar entidade="produtos" podeImportar={can('OWNER', 'ADMIN')} onImportado={state.reload} />
          <button className="btn primary" onClick={() => setEdit({})}>+ Produto</button>
        </div>
      </div>
      <Async state={state}>{(d) => d.items.length === 0 ? <div className="card"><Empty title="Nenhum produto ainda">Cadastre o primeiro produto para começar a vender e controlar estoque.</Empty></div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Código</th><th>Produto</th><th>Preço</th><th>Disponível</th><th>Reservado</th><th>Custo total</th><th></th></tr></thead>
          <tbody>{d.items.map((p: any) => (
            <tr key={p.id} style={{ opacity: p.ativo ? 1 : 0.5 }}>
              <td><code>{p.sku}</code></td>
              <td><strong>{p.nome}</strong>{!p.ativo && <span className="badge" style={{ marginLeft: 6 }}>arquivado</span>}<div className="small muted">{unidadeLegivel(p.unidade)}{descricaoEmbalagem(p) ? ` · compra: ${descricaoEmbalagem(p)}` : ''}{p.ncm ? ` · NCM ${p.ncm}` : ''}{p.controlaValidade ? ' · ⏳ controla validade' : p.controlaLote ? ` · lote ${p.regraSaida}` : ''}</div></td>
              <td>{brl(p.precoBaseCents)}</td>
              <td>{p.tipo === 'SERVICO' ? '—' : <>{qtd(p.saldo.disponivelMil)} {p.abaixoMinimo && <span className="badge red">abaixo do mínimo</span>}{!p.abaixoMinimo && p.noPontoPedido && <span className="badge">repor</span>}</>}</td>
              <td>{p.tipo === 'SERVICO' ? '—' : qtd(p.saldo.reservadoMil)}</td>
              <td>{brl(custoTotal(p))}{custoTotal(p) !== p.custoMedioCents ? <div className="small muted">produto {brl(p.custoMedioCents)}</div> : null}</td>
              <td className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                <button className="btn sm" onClick={() => setEdit(p)} aria-label={`Editar ${p.nome}`}>✏️ Editar</button>
                {admin && <button className="btn sm ghost" style={{ color: '#dc2626' }} onClick={() => setExcluir(p)} aria-label={`Excluir ${p.nome}`}>🗑️ Excluir</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}</Async>
      {edit && <ProdutoForm inicial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); state.reload(); }} />}
      {regras && <RegrasComerciais onClose={() => setRegras(false)} />}
      {excluir && <ExcluirProduto produto={excluir} onClose={() => setExcluir(null)} onDone={() => { setExcluir(null); state.reload(); }} />}
    </>
  );
}

/** Custo do produto + custos adicionais (embalagem etc.). */
export function custoTotal(p: any) {
  try { return (p.custoMedioCents ?? 0) + JSON.parse(p.custosAdicionais ?? '[]').reduce((a: number, c: any) => a + (c.valorCents ?? 0), 0); } catch { return p.custoMedioCents ?? 0; }
}

function ProdutoForm({ inicial, onClose, onSaved }: { inicial: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({
    sku: inicial.sku ?? '', nome: inicial.nome ?? '', unidade: unidadeValida(inicial.unidade) ? String(inicial.unidade).toUpperCase() : 'UN', codigoBarras: inicial.codigoBarras ?? '', ncm: inicial.ncm ?? '', cest: inicial.cest ?? '',
    origem: inicial.origem ?? 0, tipo: inicial.tipo ?? 'REVENDA', controlaLote: !!inicial.controlaLote, controlaValidade: !!inicial.controlaValidade, regraSaida: inicial.regraSaida ?? 'FIFO',
    preco: fromCents(inicial.precoBaseCents), custo: fromCents(inicial.custoMedioCents ?? 0), extras: (() => { try { return JSON.parse(inicial.custosAdicionais ?? '[]').map((c: any) => ({ nome: c.nome, valor: fromCents(c.valorCents) })); } catch { return []; } })(), fornecedor: inicial.fornecedorPadraoId ?? '', minimo: qtd(inicial.estoqueMinimoMil).replace(/\./g, ''), ponto: qtd(inicial.pontoPedidoMil).replace(/\./g, ''), lead: String(inicial.leadTimeDias ?? 0), unidadeCompra: inicial.unidadeCompra && unidadeValida(inicial.unidadeCompra) ? String(inicial.unidadeCompra).toUpperCase() : '', fator: qtd(inicial.fatorCompraMil ?? 1000).replace(/\./g, ''), loteMin: qtd(inicial.loteMinimoMil ?? 0).replace(/\./g, ''), ativo: inicial.ativo ?? true,
  });
  const { busy, run } = useAction();
  const fornecedores = useApi<any>('/erp/crm/parceiros?tipo=fornecedor', []);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const [senhaCusto, setSenhaCusto] = useState('');
  const { can } = useAuth();
  const [editarCodigo, setEditarCodigo] = useState(false);
  const unidadeRuim = inicial.id && !unidadeValida(inicial.unidade);
  // v1.32.0: unidade só por lista. Uma sigla antiga válida fora da lista continua aparecendo para não se perder.
  const opcoesUnidade = UNIDADES_CADASTRO.some((u) => u.sigla === f.unidade) ? UNIDADES_CADASTRO : [{ sigla: f.unidade, nome: f.unidade }, ...UNIDADES_CADASTRO];
  const fatorMil = f.unidadeCompra ? toMil(f.fator || '0') : 1000;
  const fatorOk = fatorMil > 0;
  async function salvar() {
    const body = { sku: f.sku.trim() || null, nome: f.nome, unidade: f.unidade, codigoBarras: f.codigoBarras || null, ncm: f.ncm || null, cest: f.cest || null, origem: Number(f.origem), tipo: f.tipo,
      controlaLote: f.controlaLote || f.controlaValidade, controlaValidade: f.controlaValidade, regraSaida: f.controlaValidade ? 'FEFO' : f.regraSaida,
      precoBaseCents: toCents(f.preco), custoMedioCents: toCents(f.custo || '0'), custosAdicionais: f.extras.filter((c: any) => c.nome.trim()).map((c: any) => ({ nome: c.nome.trim(), valorCents: toCents(c.valor || '0') })), estoqueMinimoMil: toMil(f.minimo), pontoPedidoMil: toMil(f.ponto), leadTimeDias: Number(f.lead) || 0, loteMinimoMil: toMil(f.loteMin || '0'), fornecedorPadraoId: f.fornecedor || null, ativo: f.ativo, unidadeCompra: f.unidadeCompra || null, fatorCompraMil: f.unidadeCompra ? fatorMil : 1000, ...(senhaCusto ? { senhaCusto } : {}) };
    if (await run(() => (inicial.id ? put(`/erp/produtos/${inicial.id}`, body) : post('/erp/produtos', body)), 'Produto salvo')) onSaved();
  }
  return (
    <Modal title={inicial.id ? 'Editar produto' : 'Novo produto'} onClose={onClose}>
      <div className="grid g2">
        <Field label="Código (automático)" hint={inicial.id ? 'Código do produto na empresa' : 'O sistema gera o próximo código ao salvar'}>
          {editarCodigo ? <input value={f.sku} onChange={set('sku')} placeholder={inicial.id ? '' : 'Vazio = automático'} maxLength={40} autoFocus />
            : <div className="row" style={{ gap: 6 }}><input value={inicial.id ? f.sku : ''} placeholder="Gerado automaticamente" readOnly disabled aria-label="Código" />{can('OWNER', 'ADMIN') && <button type="button" className="btn sm ghost" onClick={() => setEditarCodigo(true)}>{inicial.id ? 'Alterar' : 'Digitar'}</button>}</div>}
        </Field>
        <Field label="Tipo"><select value={f.tipo} onChange={set('tipo')}><option value="REVENDA">Revenda</option><option value="PRODUZIDO">Produzido</option><option value="INSUMO">Insumo / matéria-prima</option><option value="SERVICO">Serviço</option></select></Field>
      </div>
      <Field label="Nome"><input value={f.nome} onChange={set('nome')} autoFocus={!inicial.id} /></Field>
      <div className="grid g2">
        <Field label="Unidade de estoque" hint={unidadeRuim ? `A unidade salva era “${inicial.unidade}”, que não é uma unidade. Confira e salve.` : 'Como você conta e vende: peça, quilo, metro...'}>
          <select value={f.unidade} onChange={(e) => setF({ ...f, unidade: e.target.value, ...(e.target.value === f.unidadeCompra ? { unidadeCompra: '' } : {}) })}>
            {opcoesUnidade.map((u) => <option key={u.sigla} value={u.sigla}>{u.nome} ({u.sigla})</option>)}
          </select>
        </Field>
        <Field label="Unidade de compra" hint="Como o fornecedor vende: pacote, caixa, rolo...">
          <select value={f.unidadeCompra} onChange={(e) => setF({ ...f, unidadeCompra: e.target.value, fator: e.target.value ? f.fator : '1' })}>
            <option value="">Mesma do estoque ({nomeUnidade(f.unidade, 1)})</option>
            {UNIDADES_CADASTRO.filter((u) => u.sigla !== f.unidade).map((u) => <option key={u.sigla} value={u.sigla}>{u.nome} ({u.sigla})</option>)}
          </select>
        </Field>
        {f.unidadeCompra && <Field label={`Quantos(as) ${nomeUnidade(f.unidade, 2)} vêm em cada ${nomeUnidade(f.unidadeCompra, 1)}`} hint={fatorOk ? `Ex.: 5 ${nomeUnidade(f.unidadeCompra, 5)} = ${numeroQtd(fatorMil * 5)} ${nomeUnidade(f.unidade, fatorMil * 5 / 1000)}` : 'Informe um número maior que zero'}>
          <input value={f.fator} onChange={set('fator')} inputMode="decimal" aria-label="Quantidade por embalagem" />
        </Field>}
        <Field label="Preço base (R$)"><input value={f.preco} onChange={set('preco')} inputMode="decimal" /></Field>
        <Field label="Custo (R$)" hint={inicial.custoPorXml ? 'Veio da nota fiscal (XML): alterar pede sua senha e fica no log' : 'Custo inicial; as entradas de estoque atualizam pelo custo médio'}><input value={f.custo} onChange={set('custo')} inputMode="decimal" /></Field>
        {inicial.custoPorXml && toCents(f.custo || '0') !== (inicial.custoMedioCents ?? 0) && <Field label="Sua senha (para alterar o custo da nota)"><input type="password" autoComplete="current-password" value={senhaCusto} onChange={(e) => setSenhaCusto(e.target.value)} /></Field>}
        <Field label="Fornecedor padrão"><select value={f.fornecedor} onChange={set('fornecedor')}><option value="">—</option>{(fornecedores.data?.items ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.fantasia || x.nome}</option>)}</select></Field>
        <Field label="NCM" hint="8 dígitos, obrigatório para nota fiscal"><input value={f.ncm} onChange={set('ncm')} /></Field>
        <Field label="Código de barras (EAN)" hint="Deixe vazio para o sistema gerar"><input value={f.codigoBarras} onChange={set('codigoBarras')} placeholder="Gerado automaticamente" /></Field>
        <Field label="CEST"><input value={f.cest} onChange={set('cest')} /></Field>
        <Field label="Origem (SEFAZ)"><select value={f.origem} onChange={set('origem')}>{['0 Nacional', '1 Estrangeira (importação direta)', '2 Estrangeira (mercado interno)', '3 Nacional >40% importado', '4 Nacional (PPB)', '5 Nacional ≤40% importado', '6 Estrangeira sem similar (direta)', '7 Estrangeira sem similar (interno)', '8 Nacional >70% importado'].map((o, i) => <option key={i} value={i}>{o}</option>)}</select></Field>
      </div>
      <div className="small muted" style={{ margin: '6px 0 4px' }}>Outros custos por unidade (embalagem, rótulo, frete...)</div>
      {f.extras.map((c: any, i: number) => (
        <div className="row" key={i} style={{ marginBottom: 4 }}>
          <input placeholder="Ex.: Embalagem" value={c.nome} onChange={(e) => setF({ ...f, extras: f.extras.map((x: any, j: number) => (j === i ? { ...x, nome: e.target.value } : x)) })} aria-label="Nome do custo" />
          <input placeholder="0,00" value={c.valor} inputMode="decimal" style={{ width: 100 }} onChange={(e) => setF({ ...f, extras: f.extras.map((x: any, j: number) => (j === i ? { ...x, valor: e.target.value } : x)) })} aria-label="Valor (R$)" />
          <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, extras: f.extras.filter((_: any, j: number) => j !== i) })} aria-label="Remover custo">✕</button>
        </div>
      ))}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <button type="button" className="btn sm" onClick={() => setF({ ...f, extras: [...f.extras, { nome: '', valor: '' }] })}>+ Adicionar custo</button>
        <span className="small">Custo total (entra no CMV): <strong>{brl(toCents(f.custo || '0') + f.extras.reduce((a: number, c: any) => a + toCents(c.valor || '0'), 0))}</strong></span>
      </div>
      {f.tipo !== 'SERVICO' && <>
        <div className="row">
          <label className="row small"><input type="checkbox" checked={f.controlaLote} onChange={set('controlaLote')} /> Controla lote</label>
          <label className="row small"><input type="checkbox" checked={f.controlaValidade} onChange={set('controlaValidade')} /> Perecível: controla validade (pede a data na entrada e usa FEFO)</label>
          {!f.controlaValidade && <select value={f.regraSaida} onChange={set('regraSaida')} aria-label="Regra de saída"><option value="FIFO">FIFO</option><option value="FEFO">FEFO</option></select>}
        </div>
        <div className="grid g2">
          <Field label={`Estoque mínimo (${qtdUn(2000, f.unidade).replace(/^2 /, '')})`}><input value={f.minimo} onChange={set('minimo')} inputMode="decimal" /></Field>
          <Field label="Estimativa de compra"><input value={f.ponto} onChange={set('ponto')} inputMode="decimal" /></Field>
          <Field label="Prazo de compra/fabricação (dias)"><input value={f.lead} onChange={set('lead')} inputMode="numeric" /></Field>
          <Field label={`Lote mínimo de compra/produção (${nomeUnidade(f.unidade, 2)})`}><input value={f.loteMin} onChange={set('loteMin')} inputMode="decimal" /></Field>
        </div>
      </>}
      {inicial.id && inicial.controlaValidade && <LotesValidade produtoId={inicial.id} unidade={f.unidade} />}
      <label className="row small"><input type="checkbox" checked={f.ativo} onChange={set('ativo')} /> Ativo (desmarque para arquivar: some das buscas de venda, mas o histórico fica)</label>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || f.nome.length < 2 || !unidadeValida(f.unidade) || !fatorOk} onClick={salvar}>Salvar</button></div>
    </Modal>
  );
}

function RegrasComerciais({ onClose }: { onClose: () => void }) {
  const state = useApi<any>('/erp/produtos/config');
  const { busy, run } = useAction();
  const [f, setF] = useState<any>(null);
  const v = f ?? (state.data && { desconto: String(state.data.descontoMaxBp / 100).replace('.', ','), credito: state.data.bloquearSemCredito, validade: String(state.data.validadeOrcamentoDias), alcada: String(state.data.alcadaCompraCents / 100), tol: String(state.data.toleranciaPrecoBp / 100).replace('.', ','), cego: state.data.recebimentoCego });
  return (
    <Modal title="Regras comerciais e de compras" onClose={onClose}>
      {!v ? null : <>
        <Field label="Desconto máximo sem aprovação (%)" hint="Acima disso o pedido espera o proprietário ou um administrador"><input value={v.desconto} onChange={(e) => setF({ ...v, desconto: e.target.value })} inputMode="decimal" /></Field>
        <label className="row small"><input type="checkbox" checked={v.credito} onChange={(e) => setF({ ...v, credito: e.target.checked })} /> Bloquear pedido que passa do limite de crédito do cliente</label>
        <Field label="Validade do orçamento (dias)"><input value={v.validade} onChange={(e) => setF({ ...v, validade: e.target.value })} inputMode="numeric" /></Field>
        <h4 style={{ margin: '12px 0 4px' }}>Compras</h4>
        <Field label="Alçada do pedido de compra (R$)" hint="Até este valor o pedido é aprovado ao enviar; acima, só proprietário ou administrador aprova"><input value={v.alcada} onChange={(e) => setF({ ...v, alcada: e.target.value })} inputMode="decimal" /></Field>
        <Field label="Tolerância de preço no recebimento (%)" hint="Diferença entre a nota e o pedido de compra aceita sem aprovação"><input value={v.tol} onChange={(e) => setF({ ...v, tol: e.target.value })} inputMode="decimal" /></Field>
        <label className="row small"><input type="checkbox" checked={v.cego} onChange={(e) => setF({ ...v, cego: e.target.checked })} /> Recebimento cego (o conferente não vê a quantidade da nota)</label>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => put('/erp/produtos/config', { descontoMaxBp: Math.round(Number(v.desconto.replace(',', '.')) * 100) || 0, bloquearSemCredito: v.credito, validadeOrcamentoDias: Number(v.validade) || 15, alcadaCompraCents: toCents(v.alcada), toleranciaPrecoBp: Math.round(Number(String(v.tol).replace(',', '.')) * 100) || 0, recebimentoCego: !!v.cego }), 'Regras salvas')) onClose(); }}>Salvar</button>
        </div>
      </>}
    </Modal>
  );
}

/** Validade dos lotes com saldo (só para produto que controla validade). */
function LotesValidade({ produtoId, unidade }: { produtoId: string; unidade: string }) {
  const st = useApi<any[]>(`/erp/estoque/saldos?produtoId=${encodeURIComponent(produtoId)}`, [produtoId]);
  const hoje = new Date().toISOString().slice(0, 10);
  return (
    <div style={{ margin: '8px 0' }}>
      <div className="small"><strong>⏳ Validade dos lotes em estoque</strong></div>
      <Async state={st}>{(d) => d.length === 0 ? <div className="small muted">Nenhum lote com saldo.</div> : (
        <table className="small"><thead><tr><th>Lote interno</th><th>Lote fabricante</th><th>Validade</th><th>Quantidade</th></tr></thead>
          <tbody>{d.map((s: any) => {
            const v = s.lote?.validade ? String(s.lote.validade).slice(0, 10) : null;
            return <tr key={s.id}><td>{s.lote?.numero === 'UNICO' ? '—' : s.lote?.numero}</td><td>{s.lote?.loteFornecedor ?? '—'}</td><td style={{ color: v && v < hoje ? '#dc2626' : undefined }}>{v ? v.split('-').reverse().join('/') : 'sem data'}{v && v < hoje ? ' (vencido)' : ''}</td><td>{qtdUn(s.fisicoMil, unidade)}</td></tr>;
          })}</tbody></table>
      )}</Async>
    </div>
  );
}

/** Excluir com confirmação: nunca usado → apaga; já usado → arquiva (explica por quê). Só Proprietário/Admin. */
function ExcluirProduto({ produto, onClose, onDone }: { produto: any; onClose: () => void; onDone: () => void }) {
  const uso = useApi<any>(`/erp/produtos/${produto.id}/uso`, [produto.id]);
  const { busy, run } = useAction();
  const [resultado, setResultado] = useState<any>(null);
  return (
    <Modal title={resultado ? (resultado.acao === 'excluido' ? 'Produto excluído' : 'Produto arquivado') : `Excluir ${produto.nome}?`} onClose={resultado ? onDone : onClose}>
      {resultado ? <>
        <p>{resultado.mensagem}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onDone}>Ok</button></div>
      </> : <Async state={uso}>{(u) => <>
        <p><strong>{produto.nome}</strong> (cód. {produto.sku})</p>
        {u.usado
          ? <p>Este produto já tem <strong>{u.motivos.join(', ')}</strong>. Para não perder o histórico (vendas, notas, custos e estoque), ele <strong>não será apagado</strong>: vai ser <strong>arquivado</strong> (desativado). Ele some das buscas de venda e de entrada, e dá para reativar depois em Editar › Ativo.</p>
          : <p>Este produto nunca foi usado (sem estoque, vendas, compras, lotes ou notas). Ele será <strong>apagado de vez</strong>. Isso não pode ser desfeito.</p>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" style={{ background: '#dc2626', borderColor: '#dc2626' }} disabled={busy} onClick={async () => { const r = await run(() => del<any>(`/erp/produtos/${produto.id}`)); if (r) setResultado(r); }}>{u.usado ? 'Arquivar produto' : 'Excluir de vez'}</button>
        </div>
      </>}</Async>}
    </Modal>
  );
}
