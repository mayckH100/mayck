/** Estoque/WMS: saldos por lote e endereço, entradas, ajustes, transferências, quarentena, razão e etiquetas QR. */
import { useState } from 'react';
import { get, post, patch } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, fmtDate, useToast } from '../../ui';
import { qtd, toMil, toCents } from '../format';
import EntradaXml from './EntradaXml';
import Etiquetas from './Etiquetas';
import Inventarios from './Inventarios';
import { AjudaEmbalagem } from '../comum';
import { nomeUnidade, qtdUn } from '../../../../server/erp/shared/unidade';
import { LoteCard, ImprimirEtiquetas, CampoLeitura } from './lotes';
import { get as apiGet } from '../../api';
import { brl } from '../format';

export default function Estoque() {
  const [aba, setAba] = useState<'saldos' | 'lotes' | 'xml' | 'etiquetas' | 'inventarios' | 'movimentos' | 'depositos'>('saldos');
  const [filtro, setFiltro] = useState<any>(null); // v1.33.0: leitura de código filtra os saldos (produto/lote)
  const [etiquetas, setEtiquetas] = useState<any[] | null>(null);
  const toastE = useToast();
  const [depositoId, setDepositoId] = useState('');
  const deps = useApi<any[]>('/erp/estoque/depositos');
  const lotesSaldo = useApi<any[]>(aba === 'lotes' ? `/erp/estoque/lotes-saldo${depositoId ? `?depositoId=${depositoId}` : ''}` : null, [aba, depositoId]);

  const saldos = useApi<any[]>(`/erp/estoque/saldos${depositoId ? `?depositoId=${depositoId}` : ''}`, [depositoId]);
  const movs = useApi<any[]>(aba === 'movimentos' ? '/erp/estoque/movimentos' : null, [aba]);
  const [modal, setModal] = useState<any>(null);
  const [etiqueta, setEtiqueta] = useState<any>(null);
  const { run } = useAction();
  const { can } = useAuth();
  const recarregar = () => { saldos.reload(); deps.reload(); movs.reload(); };
  const abrirEtiqueta = async (tipo: string, id: string) => setEtiqueta(await get(`/erp/estoque/etiqueta/${tipo}/${id}`));
  return (
    <>
      <div className="page-head">
        <div><h1>Estoque</h1><p className="muted">Disponível = físico − reservado − quarentena. Toda movimentação fica registrada.</p></div>
        <div className="row">
          <select value={depositoId} onChange={(e) => setDepositoId(e.target.value)} aria-label="Depósito"><option value="">Todos os depósitos</option>{(deps.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}</select>
          <button className="btn primary" disabled={!deps.data?.length} onClick={() => setModal({ tipo: 'entrada' })}>+ Entrada</button>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {(['saldos', 'lotes', 'xml', 'etiquetas', 'inventarios', 'movimentos', 'depositos'] as const).map((a) => <button key={a} className={`btn sm ${aba === a ? 'primary' : ''}`} onClick={() => setAba(a)}>{{ saldos: 'Saldos', lotes: 'Saldo por lote', xml: 'Entrada por XML', etiquetas: 'Etiquetas', inventarios: 'Inventário', movimentos: 'Movimentações', depositos: 'Depósitos e endereços' }[a]}</button>)}
      </div>
      <AvisoInventarios onAbrir={() => setAba('inventarios')} />

      {aba === 'saldos' && <div className="card" style={{ marginBottom: 10 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Leia o código de barras ou a etiqueta do lote para achar o saldo e mover, dar baixa ou corrigir.</div>
        <CampoLeitura continuo={false} autoFocus={false} onCodigo={async (c) => { try { const r = await apiGet<any>(`/erp/estoque/ler?codigo=${encodeURIComponent(c)}`); setFiltro({ produtoId: r.produto.id, loteId: r.lote?.id ?? null, texto: `${r.produto.sku} · ${r.produto.nome}${r.lote ? ` · lote ${r.lote.numero}` : ''}` }); } catch (e) { toastE((e as Error).message, 'err'); } }} />
        {filtro && <div className="row small" style={{ marginTop: 6, gap: 6 }}>Mostrando: <b>{filtro.texto}</b><button className="btn sm ghost" onClick={() => setFiltro(null)}>Mostrar tudo</button></div>}
      </div>}
      {aba === 'lotes' && <Async state={lotesSaldo}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhum lote com saldo">Os lotes aparecem aqui assim que entram no estoque.</Empty></div> : <>{d.map((l) => <LoteCard key={l.id} l={l} />)}</>}</Async>}

      {aba === 'saldos' && <Async state={saldos}>{(d0) => { const d = filtro ? d0.filter((x) => x.produtoId === filtro.produtoId && (!filtro.loteId || x.loteId === filtro.loteId)) : d0; return d.length === 0 ? <div className="card"><Empty title={deps.data?.length ? 'Sem saldo em estoque' : 'Crie um depósito primeiro'}>{deps.data?.length ? 'Lance o saldo inicial pelo botão Entrada.' : 'Na aba Depósitos e endereços.'}</Empty></div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Produto</th><th>Lote interno / fabricante</th><th>Validade</th><th>Endereço</th><th>Físico</th><th>Reservado</th><th>Disponível</th><th></th></tr></thead>
          <tbody>{d.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.produto?.nome}</strong><div className="small muted">{s.produto?.sku}</div></td>
              <td>{s.lote?.numero === 'UNICO' ? '—' : s.lote?.numero}{s.lote?.loteFornecedor && s.lote.loteFornecedor !== s.lote.numero ? <div className="small muted">fab. {s.lote.loteFornecedor}</div> : null} {s.lote?.status !== 'LIBERADO' && <span className="badge red">{s.lote?.status}</span>}</td>
              <td>{s.lote?.validade ? new Date(s.lote.validade).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—'}</td>
              <td>{s.endereco.deposito} · {s.endereco.codigo}</td>
              <td>{qtd(s.fisicoMil)}</td><td>{qtd(s.reservadoMil)}</td><td><strong>{qtd(s.disponivelMil)}</strong></td>
              <td className="row" style={{ gap: 4 }}>
                <button className="btn ghost sm" onClick={() => setModal({ tipo: 'transferencia', saldo: s })}>Mover</button>
                <button className="btn ghost sm" onClick={() => setModal({ tipo: 'ajuste', saldo: s })}>Baixa</button>
                {can('OWNER', 'ADMIN') && s.lote?.numero !== 'UNICO' && <button className="btn ghost sm" onClick={async () => { await run(() => patch(`/erp/estoque/lotes/${s.loteId}`, { status: s.lote.status === 'LIBERADO' ? 'QUARENTENA' : 'LIBERADO' }), 'Lote atualizado'); recarregar(); }}>{s.lote?.status === 'LIBERADO' ? 'Quarentena' : 'Liberar'}</button>}
                <button className="btn ghost sm" onClick={() => setModal({ tipo: 'corrigir', saldo: s })}>Corrigir</button>
                <button className="btn ghost sm" title="Etiqueta do lote (código de barras e QR)" onClick={() => setEtiquetas([{ loteId: s.loteId, numero: s.lote?.numero, produto: `${s.produto?.sku} · ${s.produto?.nome}`, sugeridas: 1 }])}>🏷️</button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      ); }}</Async>}

      {aba === 'xml' && <EntradaXml depositos={deps.data ?? []} onLancada={(r?: any) => { recarregar(); if (r?.etiquetas?.length) setEtiquetas(r.etiquetas); }} />}
      {aba === 'etiquetas' && <Etiquetas />}
      {aba === 'inventarios' && <Inventarios depositos={deps.data ?? []} onAjustado={recarregar} />}
      {aba === 'movimentos' && <Async state={movs}>{(d) => (
        <div className="card table-wrap"><table>
          <thead><tr><th>Quando</th><th>Produto</th><th>Tipo</th><th>Qtd</th><th>Saldo após</th><th>Lote · Endereço</th><th>Motivo</th></tr></thead>
          <tbody>{d.map((m) => <tr key={m.id}><td>{fmtDate(m.createdAt)}</td><td>{m.produto?.sku}</td><td>{m.tipo}</td><td style={{ color: m.qtdMil < 0 ? '#dc2626' : undefined }}>{m.qtdMil > 0 ? '+' : ''}{qtd(m.qtdMil)}</td><td>{qtd(m.saldoAposMil)}</td><td>{m.lote === 'UNICO' ? '—' : m.lote} · {m.endereco}</td><td className="small">{m.motivo ?? '—'}</td></tr>)}</tbody>
        </table></div>
      )}</Async>}

      {aba === 'depositos' && <Async state={deps}>{(d) => (
        <>
          {can('OWNER', 'ADMIN') && <button className="btn" style={{ marginBottom: 10 }} onClick={() => setModal({ tipo: 'deposito' })}>+ Depósito</button>}
          {d.map((dep) => (
            <div key={dep.id} className="card" style={{ marginBottom: 10 }}>
              <div className="row between"><h3>{dep.nome}</h3>{can('OWNER', 'ADMIN') && <button className="btn sm" onClick={() => setModal({ tipo: 'enderecos', deposito: dep })}>+ Endereços</button>}</div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{dep.enderecos.map((e: any) => <button key={e.id} className="btn ghost sm" title="Etiqueta QR" onClick={() => abrirEtiqueta('endereco', e.id)}>{e.codigo}</button>)}</div>
            </div>
          ))}
        </>
      )}</Async>}

      {modal && modal.tipo === 'corrigir' && <CorrigirSaldo saldo={modal.saldo} onClose={() => setModal(null)} onDone={() => { setModal(null); recarregar(); }} />}
      {modal && modal.tipo !== 'corrigir' && <Movimento modal={modal} depositos={deps.data ?? []} onClose={() => setModal(null)} onDone={(r?: any) => { setModal(null); recarregar(); if (r?.etiquetas?.length) setEtiquetas(r.etiquetas.map((e: any) => ({ ...e, produto: modal.produtoNome }))); }} />}
      {etiquetas && <ImprimirEtiquetas titulo={etiquetas.length === 1 && etiquetas[0].sugeridas === 1 && !etiquetas[0].qtdMil ? `Etiquetas do lote ${etiquetas[0].numero}` : 'Entrada registrada'} itens={etiquetas} onClose={() => setEtiquetas(null)} />}
      {etiqueta && (
        <Modal title="Etiqueta QR" onClose={() => setEtiqueta(null)}>
          <div id="etiqueta-qr" style={{ textAlign: 'center' }}><img src={etiqueta.png} alt={etiqueta.texto} width={200} height={200} /><div><strong>{etiqueta.texto}</strong></div><div className="small">{etiqueta.titulo}</div></div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}><button className="btn primary" onClick={() => { const w = window.open('', '_blank', 'width=400,height=500'); if (w) { w.document.write(`<body style="font-family:sans-serif;text-align:center">${document.getElementById('etiqueta-qr')!.innerHTML}</body>`); w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 500); } }}>Imprimir</button></div>
        </Modal>
      )}
    </>
  );
}

function Movimento({ modal, depositos, onClose, onDone }: { modal: any; depositos: any[]; onClose: () => void; onDone: (r?: any) => void }) {
  const [f, setF] = useState<any>({ qtd: '', custo: '', lote: '', fabricante: '', validade: '', fabricacao: '', quarentena: false, motivo: '', enderecoId: '', produto: null, busca: '', nome: '', codigos: '', ruas: '', prateleiras: '', posicoes: '' });
  const [opcoes, setOpcoes] = useState<any[]>([]);
  const { busy, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const enderecos = depositos.flatMap((d) => d.enderecos.map((e: any) => ({ ...e, label: `${d.nome} · ${e.codigo}` })));
  async function procurar(q: string) { setF({ ...f, busca: q }); setOpcoes(q.length >= 2 ? (await get<any>(`/erp/produtos?q=${encodeURIComponent(q)}&ativos=1`)).items.filter((p: any) => p.tipo !== 'SERVICO').slice(0, 8) : []); }
  async function salvar() {
    const acoes: Record<string, () => Promise<unknown>> = {
      entrada: () => post('/erp/estoque/entrada', { produtoId: f.produto.id, enderecoId: f.enderecoId, qtdMil: toMil(f.qtd), custoUnitCents: f.custo ? toCents(f.custo) : undefined, lote: { fabricante: f.fabricante || null, validade: f.produto?.controlaValidade ? f.validade || null : null, fabricacao: f.fabricacao || null, status: f.quarentena ? 'QUARENTENA' : 'LIBERADO' }, motivo: f.motivo || undefined }),
      ajuste: () => post('/erp/estoque/ajuste', { saldoId: modal.saldo.id, qtdMil: toMil(f.qtd), motivo: f.motivo }),
      transferencia: () => post('/erp/estoque/transferencia', { saldoId: modal.saldo.id, enderecoDestinoId: f.enderecoId, qtdMil: toMil(f.qtd) }),
      deposito: () => post('/erp/estoque/depositos', { nome: f.nome, enderecos: f.codigos ? f.codigos.split(/[\s,;]+/).filter(Boolean) : ['GERAL'] }),
      enderecos: () => post(`/erp/estoque/depositos/${modal.deposito.id}/enderecos`, f.ruas ? { ruas: f.ruas, prateleiras: Number(f.prateleiras), posicoes: Number(f.posicoes) } : { codigos: f.codigos.split(/[\s,;]+/).filter(Boolean) }),
    };
    const r = await run(acoes[modal.tipo], 'Feito');
    if (r) { if (modal.tipo === 'entrada') modal.produtoNome = `${f.produto?.sku} · ${f.produto?.nome}`; onDone(r); }
  }
  const titulo = { entrada: 'Entrada de estoque', ajuste: 'Baixa / ajuste de saída', transferencia: 'Mover entre endereços', deposito: 'Novo depósito', enderecos: `Endereços em ${modal.deposito?.nome}` }[modal.tipo as string];
  return (
    <Modal title={titulo ?? ''} onClose={onClose}>
      {modal.tipo === 'entrada' && <>
        {f.produto ? <div className="row between"><strong>{f.produto.sku} · {f.produto.nome}</strong><button className="btn ghost sm" onClick={() => setF({ ...f, produto: null })}>Trocar</button></div> : (
          <Field label="Produto"><input value={f.busca} onChange={(e) => procurar(e.target.value)} placeholder="Nome ou SKU" autoFocus />{opcoes.map((o) => <button key={o.id} type="button" className="btn ghost sm" style={{ display: 'block' }} onClick={() => setF({ ...f, produto: o })}>{o.sku} · {o.nome}</button>)}</Field>
        )}
        <Field label="Endereço"><select value={f.enderecoId} onChange={set('enderecoId')}><option value="">Escolha…</option>{enderecos.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
        <div className="grid g2">
          <Field label={`Quantidade${f.produto ? ` (${nomeUnidade(f.produto.unidade, 2)})` : ''}`}><input value={f.qtd} onChange={set('qtd')} inputMode="decimal" /></Field>
          <Field label={`Custo por ${f.produto ? nomeUnidade(f.produto.unidade, 1) : 'unidade'} (R$)`} hint="Entra no custo médio"><input value={f.custo} onChange={set('custo')} inputMode="decimal" /></Field>
          <Field label="Lote do fabricante (opcional)" hint="O que vem impresso na caixa/embalagem"><input value={f.fabricante} onChange={set('fabricante')} maxLength={40} /></Field>
          {f.produto?.controlaValidade && <Field label="Validade *" hint="Obrigatória: este produto controla validade"><input type="date" value={f.validade} onChange={set('validade')} required /></Field>}
          <Field label="Data de fabricação (opcional)" hint="Sai na etiqueta do lote"><input type="date" value={f.fabricacao} onChange={set('fabricacao')} /></Field>
        </div>
        <AjudaEmbalagem produto={f.produto} qtd={f.qtd ?? ''} setQtd={(v) => setF({ ...f, qtd: v })} preco={f.custo ?? ''} setPreco={(v) => setF({ ...f, custo: v })} />
        <p className="small muted" style={{ margin: '2px 0 6px' }}>O <strong>lote interno</strong> é criado pelo sistema nesta entrada (ex.: L2611-0001). Ao confirmar, você já gera as etiquetas (código de barras + QR).</p>
        {f.produto?.controlaLote && <label className="row small"><input type="checkbox" checked={f.quarentena} onChange={set('quarentena')} /> Entrar em quarentena (aguardando inspeção)</label>}
        <Field label="Motivo"><input value={f.motivo} onChange={set('motivo')} placeholder="Saldo inicial, compra avulsa…" /></Field>
      </>}
      {(modal.tipo === 'ajuste' || modal.tipo === 'transferencia') && <>
        <div className="small muted">{modal.saldo.produto?.nome} · {modal.saldo.endereco.codigo} · disponível {qtd(modal.saldo.disponivelMil)}</div>
        <Field label="Quantidade"><input value={f.qtd} onChange={set('qtd')} inputMode="decimal" autoFocus /></Field>
        {modal.tipo === 'ajuste' && <Field label="Motivo"><input value={f.motivo} onChange={set('motivo')} placeholder="Quebra, perda, consumo interno…" /></Field>}
        {modal.tipo === 'transferencia' && <Field label="Para o endereço"><select value={f.enderecoId} onChange={set('enderecoId')}><option value="">Escolha…</option>{enderecos.filter((e) => e.id !== modal.saldo.enderecoId).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>}
      </>}
      {modal.tipo === 'deposito' && <>
        <Field label="Nome"><input value={f.nome} onChange={set('nome')} autoFocus /></Field>
        <Field label="Endereços (opcional)" hint="Separados por espaço ou vírgula. Vazio cria o endereço GERAL."><input value={f.codigos} onChange={set('codigos')} placeholder="A-01-01 A-01-02" /></Field>
      </>}
      {modal.tipo === 'enderecos' && <>
        <div className="small muted">Gere a grade (ruas × prateleiras × posições) ou digite os códigos.</div>
        <div className="grid g2">
          <Field label="Ruas (letras)"><input value={f.ruas} onChange={set('ruas')} placeholder="ABC" /></Field>
          <Field label="Prateleiras por rua"><input value={f.prateleiras} onChange={set('prateleiras')} inputMode="numeric" /></Field>
          <Field label="Posições por prateleira"><input value={f.posicoes} onChange={set('posicoes')} inputMode="numeric" /></Field>
        </div>
        <Field label="Ou códigos"><input value={f.codigos} onChange={set('codigos')} /></Field>
      </>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || (modal.tipo === 'entrada' && !!f.produto?.controlaValidade && !f.validade)} onClick={salvar}>Confirmar</button></div>
    </Modal>
  );
}

/** Aviso no app: inventário encerrado com diferença esperando a aprovação do proprietário. */
export function AvisoInventarios({ onAbrir }: { onAbrir?: () => void }) {
  const st = useApi<any[]>('/erp/estoque/inventarios/pendentes');
  if (!st.data?.length) return null;
  return <>{st.data.map((i) => (
    <div key={i.id} className="card" style={{ borderLeft: '4px solid #f59e0b', marginBottom: 10 }} role="alert">
      <b>📋 Inventário “{i.descricao}” com diferença</b>
      {i.resumo && <div className="small">{i.resumo.divergentes} de {i.resumo.linhas} itens com diferença · sobras {brl(i.resumo.sobrasCents)} · faltas {brl(i.resumo.faltasCents)} · líquido <b>{brl(i.resumo.liquidoCents)}</b></div>}
      <div className="small muted">O estoque só muda depois da aprovação com a senha do proprietário.</div>
      {onAbrir && <button className="btn sm primary" style={{ marginTop: 6 }} onClick={onAbrir}>Ver relatório e aprovar</button>}
    </div>
  ))}</>;
}

/** Correção manual de saldo (um lote num local): prévia antes/depois/R$, motivo e senha do proprietário. */
function CorrigirSaldo({ saldo, onClose, onDone }: { saldo: any; onClose: () => void; onDone: () => void }) {
  const [novo, setNovo] = useState(''); const [motivo, setMotivo] = useState(''); const [senha, setSenha] = useState('');
  const { busy, run } = useAction();
  const un = saldo.produto?.unidade;
  const novoMil = novo.trim() === '' ? null : toMil(novo);
  const dif = novoMil == null ? 0 : novoMil - saldo.fisicoMil;
  const valor = Math.round((dif * (saldo.produto?.custoTotalCents ?? 0)) / 1000);
  return (
    <Modal title="Corrigir saldo do lote" onClose={onClose}>
      <p className="small" style={{ marginTop: 0 }}><b>{saldo.produto?.nome}</b> · lote <b>{saldo.lote?.numero}</b> · {saldo.endereco.deposito} · {saldo.endereco.codigo}</p>
      <Field label={`Quantidade certa (${nomeUnidade(un, 2)})`} hint="O que existe de verdade neste lote e local"><input value={novo} onChange={(e) => setNovo(e.target.value)} inputMode="decimal" autoFocus /></Field>
      {novoMil != null && <div className="card" style={{ padding: 10, margin: '6px 0' }}>
        <div className="small">Antes: <b>{qtdUn(saldo.fisicoMil, un)}</b> → Depois: <b>{qtdUn(novoMil, un)}</b></div>
        <div className="small">Diferença: <b style={{ color: dif < 0 ? '#dc2626' : '#16a34a' }}>{dif > 0 ? '+' : ''}{qtdUn(dif, un)}</b> · Valor (preço de custo): <b style={{ color: dif < 0 ? '#dc2626' : '#16a34a' }}>{brl(valor)}</b></div>
      </div>}
      <Field label="Motivo *"><input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: contagem conferida, quebra encontrada" /></Field>
      <Field label="Senha do proprietário *" hint="Peça ao dono da empresa para digitar a senha dele aqui"><input type="password" autoComplete="off" value={senha} onChange={(e) => setSenha(e.target.value)} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}><button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || novoMil == null || !dif || motivo.trim().length < 3 || !senha} onClick={async () => { if (await run(() => post('/erp/estoque/inventarios/corrigir-saldo', { saldoId: saldo.id, novoMil, motivo, senhaProprietario: senha }), 'Saldo corrigido')) onDone(); }}>Corrigir saldo</button></div>
    </Modal>
  );
}
