/** Entrada por XML de NF-e: importa, vincula itens a produtos (fator de conversão), lança com lote interno e imprime etiquetas. */
import { useState } from 'react';
import { get, post, put } from '../../api';
import { useApi, Async, Empty, Modal, Field, useAction, useToast, fmtDate } from '../../ui';
import { useAuth } from '../../auth';
import { ApiError } from '../../api';
import { brl, qtd, toMil } from '../format';
import { imprimirComum } from './impressao';
import { CampoLeitura } from '../leitura/Leitor';
import { BotaoZebra } from './ZebraImprimir';
import { BotaoImprimir } from '../impressao/BotaoPdf';
import { htmlTabela, fmt } from '../impressao/listas';
import { lerArquivosXml, limparXml, pareceXml, type ArquivoXml } from '../../../../server/erp/estoque/xmlArquivo';

type Resultado = { nome: string; ok: boolean; msg: string; id?: string };

export default function EntradaXml({ depositos, onLancada, onDepositos }: { depositos: any[]; onLancada: (r?: any) => void; onDepositos?: () => void }) {
  const lista = useApi<any[]>('/erp/estoque/nfe');
  const [aberta, setAberta] = useState<string | null>(null);
  const [colar, setColar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const toast = useToast();

  /** Envia os XMLs um a um e mostra o resultado de cada arquivo (antes só um aviso rápido que sumia). */
  async function enviar(xmls: ArquivoXml[], erros: Resultado[] = []) {
    const res: Resultado[] = [...erros];
    for (const x of xmls) {
      try {
        const r = await post<any>('/erp/estoque/nfe/importar', { xml: x.xml });
        res.push({ nome: x.nome, ok: true, id: r.id, msg: `NF ${r.numero ?? ''} de ${r.emitente ?? 'fornecedor'} importada (${r.itens ?? '?'} itens).${r.avisos?.length ? ' ' + r.avisos.join(' ') : ''}` });
      } catch (e) {
        res.push({ nome: x.nome, ok: false, msg: (e as Error).message || 'Não foi possível importar' });
      }
    }
    setResultados(res);
    const ok = res.filter((r) => r.ok);
    if (ok.length) toast(ok.length === 1 ? 'XML importado' : `${ok.length} XMLs importados`);
    else if (res.length) toast(res[0].msg, 'err');
    // Uma nota só: já abre para vincular os itens e lançar.
    if (ok.length === 1 && res.length === 1) setAberta(ok[0].id!);
    lista.reload();
  }

  async function arquivos(files: File[]) {
    if (!files.length) return;
    setEnviando(true);
    try {
      const xmls: ArquivoXml[] = []; const erros: Resultado[] = [];
      for (const f of files) {
        try { xmls.push(...(await lerArquivosXml(f.name || 'arquivo', new Uint8Array(await f.arrayBuffer())))); }
        catch (e) { erros.push({ nome: f.name || 'arquivo', ok: false, msg: (e as Error).message }); }
      }
      await enviar(xmls, erros);
    } finally { setEnviando(false); }
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {/* v1.50.0: sem filtro de tipo. No Android o filtro ".xml,text/xml" deixava cinza (sem poder tocar) o XML baixado
              do e-mail/WhatsApp, que chega como application/xml ou application/octet-stream. Aceita também .zip. */}
          <label className={`btn primary${enviando ? ' disabled' : ''}`} data-testid="importar-xml">{enviando ? 'Importando…' : 'Importar XML da NF-e'}
            <input type="file" multiple hidden disabled={enviando} onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; arquivos(fs); }} /></label>
          <button className="btn" type="button" onClick={() => setColar(true)}>Colar o XML</button>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>Escolha o arquivo .xml (ou .zip) que o fornecedor enviou. O fornecedor é cadastrado pelo XML e os itens já vinculados entram sozinhos nas próximas notas. Também aceita NFC-e (cupom de loja).</div>
        {resultados.length > 0 && (
          <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }} data-testid="resultado-importacao">
            {resultados.map((r, i) => <li key={i} style={{ color: r.ok ? undefined : '#dc2626' }}><b>{r.nome}</b>: {r.msg}{r.ok && r.id && <> <button className="btn ghost sm" onClick={() => setAberta(r.id!)}>Abrir</button></>}</li>)}
          </ul>
        )}
      </div>
      <Async state={lista}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma NF-e importada">Importe o XML que o fornecedor enviou.</Empty></div> : (
        <div className="card table-wrap">
          <div className="row" style={{ justifyContent: 'flex-end' }}><BotaoImprimir className="btn sm" montar={() => htmlTabela({ titulo: 'Notas de entrada (XML)', linhas: d, colunas: [{ titulo: 'NF-e', valor: (n: any) => `${n.numero}/${n.serie}${n.autorizada ? '' : ' (sem protocolo)'}` }, { titulo: 'Fornecedor', valor: (n: any) => n.emitenteNome }, { titulo: 'Emissão', valor: (n: any) => fmt.dia(n.dataEmissao) }, { titulo: 'Valor', valor: (n: any) => fmt.brl(n.valorTotalCents), dir: true }, { titulo: 'Status', valor: (n: any) => (n.status === 'LANCADA' ? 'Lançada' : 'Pendente') }] })} /></div>
          <table>
          <thead><tr><th>NF-e</th><th>Fornecedor</th><th>Emissão</th><th>Valor</th><th>Status</th><th></th></tr></thead>
          <tbody>{d.map((n) => <tr key={n.id}><td>{n.numero}/{n.serie}{!n.autorizada && <span className="badge red">sem protocolo</span>}</td><td>{n.emitenteNome}</td><td>{n.dataEmissao ? new Date(n.dataEmissao).toLocaleDateString('pt-BR') : '—'}</td><td>{brl(n.valorTotalCents)}</td><td><span className={`badge ${n.status === 'LANCADA' ? 'green' : ''}`}>{n.status === 'LANCADA' ? 'Lançada' : 'Pendente'}</span></td><td><button className="btn sm" onClick={() => setAberta(n.id)}>Abrir</button></td></tr>)}</tbody>
        </table></div>
      )}</Async>
      {colar && <ColarXml onClose={() => setColar(false)} onEnviar={async (xml) => { setColar(false); setEnviando(true); try { await enviar([{ nome: 'XML colado', xml, encoding: 'utf-8' }]); } finally { setEnviando(false); } }} />}
      {aberta && <NfeDetalhe id={aberta} depositos={depositos} onDepositos={onDepositos} onClose={() => { setAberta(null); lista.reload(); }} onLancada={onLancada} />}
    </>
  );
}

/** Alternativa ao arquivo (celular sem gerenciador de arquivos, XML aberto no navegador/e-mail): colar o conteúdo. */
function ColarXml({ onClose, onEnviar }: { onClose: () => void; onEnviar: (xml: string) => void }) {
  const [t, setT] = useState('');
  const xml = limparXml(t);
  const ok = xml.length >= 100 && pareceXml(xml);
  return (
    <Modal title="Colar o XML da NF-e" onClose={onClose}>
      <p className="small muted">Abra o XML da nota (no e-mail ou no navegador), copie todo o conteúdo e cole aqui.</p>
      <textarea aria-label="Conteúdo do XML" rows={8} style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} value={t} onChange={(e) => setT(e.target.value)} placeholder="<?xml version=&quot;1.0&quot; ...><nfeProc ...>" />
      {t && !ok && <div className="small" style={{ color: '#dc2626' }}>Isto não parece o XML completo da nota.</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!ok} onClick={() => onEnviar(xml)}>Importar</button></div>
    </Modal>
  );
}

function NfeDetalhe({ id, depositos, onClose, onLancada, onDepositos }: { id: string; depositos: any[]; onClose: () => void; onLancada: (r?: any) => void; onDepositos?: () => void }) {
  const st = useApi<any>(`/erp/estoque/nfe/${id}`, [id]);
  const [vinc, setVinc] = useState<any>(null);
  const [f, setF] = useState({ enderecoId: '', quarentena: false, usarLoteFornecedor: false });
  const [manuais, setManuais] = useState<Record<string, { numero: string; qtd: string; validade: string }>>({});
  const [conf, setConf] = useState<Record<string, string>>({});
  const [div, setDiv] = useState<string[]>([]);
  const { busy, run } = useAction();
  const toast = useToast(); const { can } = useAuth();
  const enderecos = depositos.filter((d) => d.ativo !== false).flatMap((d) => d.enderecos.filter((e: any) => e.ativo !== false).map((e: any) => ({ id: e.id, label: `${d.nome} · ${e.codigo}` })));
  // v1.50.0: com um só endereço (o normal numa loja), ele já vem escolhido; antes o botão "Lançar no estoque" ficava
  // apagado até a pessoa achar o campo "Guardar no endereço".
  const enderecoId = f.enderecoId || (enderecos.length === 1 ? enderecos[0].id : '');
  const [criandoDep, setCriandoDep] = useState(false);
  async function criarDeposito() {
    setCriandoDep(true);
    try {
      const d = await post<any>('/erp/estoque/depositos', { nome: 'Loja', enderecos: ['GERAL'] });
      toast('Depósito "Loja · GERAL" criado'); onDepositos?.();
      if (d?.enderecos?.[0]?.id) setF((x) => ({ ...x, enderecoId: d.enderecos[0].id }));
    } catch (e) { toast((e as Error).message, 'err'); } finally { setCriandoDep(false); }
  }
  async function lancar(n: any) {
    const lotesManuais: Record<string, any[]> = {};
    // Quantidade do lote = a do item (o servidor calcula; no recebimento cego a tela não conhece a quantidade).
    for (const i of n.itens) { const m = manuais[i.id]; if (m?.numero || m?.validade) lotesManuais[i.id] = [{ numero: m.numero || 'S/N', validade: m.validade || null }]; }
    try {
      const r = await post<any>(`/erp/estoque/nfe/${id}/lancar`, { ...f, enderecoId, lotesManuais, aceitarDivergencias: div.length > 0 });
      // v1.33.0: já abre o "Gerar etiqueta e imprimir" com a quantidade sugerida.
      toast('NF-e lançada no estoque'); setDiv([]); st.reload(); onClose(); onLancada(r);
    } catch (e) {
      const d = (e instanceof ApiError ? (e.details as any)?.divergencias : null) as string[] | null;
      if (d?.length) setDiv(d); else toast((e as Error).message, 'err');
    }
  }
  async function salvarConferencia(n: any) {
    const itens = n.itens.filter((i: any) => conf[i.id] !== undefined && conf[i.id] !== '').map((i: any) => ({ itemId: i.id, qtdMil: toMil(conf[i.id]) }));
    if (!itens.length) return;
    const r = await run(() => put<any>(`/erp/estoque/nfe/${id}/conferencia`, { itens }), 'Conferência salva');
    if (r) { if (r.divergentes) toast(`${r.divergentes} item(ns) com quantidade diferente da nota`, 'err'); setConf({}); st.reload(); }
  }
  const itensEtq = (n: any) => n.itens.flatMap((i: any) => i.lotesGerados.map((l: any) => ({ loteId: l.id, copias: 1 })));
  async function etiquetas(n: any) { imprimirComum(await post<any>('/erp/estoque/etiquetas', { itens: itensEtq(n) }), 'a4'); }
  return (
    <Modal title="NF-e de entrada" onClose={onClose}>
      <Async state={st}>{(n) => (
        <>
          <p className="small"><strong>{n.emitenteNome}</strong> · NF {n.numero}/{n.serie} · {brl(n.valorTotalCents)} · chave <code style={{ fontSize: 10 }}>{n.chave}</code></p>
          {n.status === 'PENDENTE' && <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span>Pedido de compra:</span>
            <select value={n.pedidoCompraId ?? ''} aria-label="Pedido de compra" onChange={async (e) => { if (await run(() => put(`/erp/estoque/nfe/${id}/pedido`, { pedidoCompraId: e.target.value || null }), 'Pedido vinculado')) st.reload(); }}>
              <option value="">Sem pedido</option>{n.pedidosAbertos.map((p: any) => <option key={p.id} value={p.id}>Nº {p.numero} · {brl(p.totalCents)}</option>)}
            </select>
            {n.cego && <span className="badge">recebimento cego</span>}
          </div>}
          {n.status === 'PENDENTE' && <div style={{ margin: '8px 0' }}>
            <CampoLeitura autoFocus={false} placeholder="Conferir lendo: código de barras da caixa/produto" dicaCamera="Leia cada volume recebido: cada leitura soma 1 na conferência do item." onCodigo={async (c) => {
              const cod = c.trim(); const nums = cod.replace(/^0+/, '');
              let item = n.itens.find((i: any) => (i.ean && i.ean.replace(/^0+/, '') === nums && nums) || (i.codigo && i.codigo.toUpperCase() === cod.toUpperCase()));
              if (!item) { try { const r = await get<any>(`/erp/estoque/ler?codigo=${encodeURIComponent(cod)}`); item = n.itens.find((i: any) => i.produtoId === r.produto.id); if (!item) return { ok: false, msg: `${r.produto.nome} não está nesta nota: separe e avise o comprador.` }; } catch { return { ok: false, msg: `Código ${cod.slice(0, 30)} não está nesta nota.` }; } }
              const it = item;
              setConf((x) => ({ ...x, [it.id]: String(((Number(String(x[it.id] ?? '').replace(',', '.')) || 0) + 1)).replace('.', ',') }));
              return { ok: true, msg: `+1 ${it.unidade} · ${it.descricao}` };
            }} />
            <div className="small muted">Cada leitura soma 1 ({'na unidade da nota'}) no item. Ao terminar, toque em "Salvar conferência".</div>
          </div>}
          <table><thead><tr><th>#</th><th>Item do fornecedor</th><th>Qtd</th>{n.status === 'PENDENTE' && <th>Conferido</th>}<th>Produto interno</th><th>Lotes</th></tr></thead>
            <tbody>{n.itens.map((i: any) => (
              <tr key={i.id}>
                <td>{i.nItem}</td>
                <td><div className="small">{i.codigo} · {i.descricao}</div><div className="small muted">custo {brl(i.custoTotalCents)}</div></td>
                <td>{i.qtdMil == null ? <span className="muted">oculto</span> : <>{qtd(i.qtdMil)} {i.unidade}{i.fatorMil !== 1000 && i.produto && <div className="small muted">= {qtd(Math.round((i.qtdMil * i.fatorMil) / 1000))} {i.produto.unidade}</div>}</>}</td>
                {n.status === 'PENDENTE' && <td><input style={{ width: 70 }} inputMode="decimal" aria-label="Quantidade conferida" placeholder={i.conferidoMil != null ? qtd(i.conferidoMil) : i.unidade} value={conf[i.id] ?? ''} onChange={(e) => setConf({ ...conf, [i.id]: e.target.value })} />{i.conferidoMil != null && i.qtdMil != null && i.conferidoMil !== i.qtdMil && <div className="small" style={{ color: '#dc2626' }}>diverge</div>}</td>}
                <td>{i.produto ? <span className="small">{i.produto.sku} · {i.produto.nome}</span> : <span className="badge red">sem vínculo</span>}{n.status === 'PENDENTE' && <button className="btn ghost sm" onClick={() => setVinc(i)}>{i.produto ? 'Trocar' : 'Vincular'}</button>}</td>
                <td className="small">
                  {i.lotesGerados.length ? i.lotesGerados.map((l: any) => <div key={l.id}><b>{l.numero}</b>{l.loteFornecedor ? ` ← ${l.loteFornecedor}` : ''}</div>)
                    : i.lotes.length ? i.lotes.map((l: any) => <div key={l.numero}>{l.numero}{l.validade ? ` · val ${l.validade.split('-').reverse().join('/')}` : ''}</div>)
                    : i.produto?.controlaLote && n.status === 'PENDENTE' ? <>
                      <input placeholder="Lote do fornecedor" style={{ width: 120 }} value={manuais[i.id]?.numero ?? ''} onChange={(e) => setManuais({ ...manuais, [i.id]: { ...manuais[i.id], numero: e.target.value } as any })} />
                      {i.produto.controlaValidade && <input type="date" aria-label="Validade" value={manuais[i.id]?.validade ?? ''} onChange={(e) => setManuais({ ...manuais, [i.id]: { ...manuais[i.id], validade: e.target.value } as any })} />}
                    </> : '—'}
                </td>
              </tr>
            ))}</tbody></table>
          {n.status === 'PENDENTE' ? <>
            <div className="grid g2" style={{ marginTop: 10 }}>
              <Field label="Guardar no endereço">{enderecos.length ? <select value={enderecoId} onChange={(e) => setF({ ...f, enderecoId: e.target.value })}><option value="">Escolha…</option>{enderecos.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
                : <div className="small">Nenhum depósito cadastrado. <button type="button" className="btn sm" disabled={criandoDep} onClick={criarDeposito}>Criar depósito "Loja · GERAL"</button></div>}</Field>
            </div>
            {n.itens.some((i: any) => !i.produtoId) && <p className="small" style={{ color: '#b45309' }}>Toque em "Vincular" nos itens sem vínculo (produto existente ou "Criar produto com este item") para poder lançar.</p>}
            <label className="row small"><input type="checkbox" checked={f.quarentena} onChange={(e) => setF({ ...f, quarentena: e.target.checked })} /> Entrar em quarentena (inspeção de qualidade)</label>
            <label className="row small"><input type="checkbox" checked={f.usarLoteFornecedor} onChange={(e) => setF({ ...f, usarLoteFornecedor: e.target.checked })} /> Usar o lote do fornecedor como lote interno (sem gerar novo)</label>
            {div.length > 0 && <div className="card" style={{ borderColor: '#dc2626', marginTop: 8 }}>
              <strong className="small">Divergências no recebimento</strong>
              <ul className="small">{div.map((d) => <li key={d}>{d}</li>)}</ul>
              {!can('OWNER', 'ADMIN') && <p className="small muted">Só proprietário ou administrador aceita divergências. Corrija a conferência ou peça aprovação.</p>}
            </div>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" disabled={busy || !Object.keys(conf).length} onClick={() => salvarConferencia(n)}>Salvar conferência</button>
              <button className="btn primary" disabled={busy || !enderecoId || n.itens.some((i: any) => !i.produtoId) || (div.length > 0 && !can('OWNER', 'ADMIN'))} onClick={() => lancar(n)}>{div.length ? 'Aceitar divergências e lançar' : 'Lançar no estoque'}</button>
            </div>
          </> : (
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              <span className="small muted">Lançada {fmtDate(n.lancadaEm)}</span>
              <button className="btn" onClick={() => etiquetas(n)}>Etiquetas (impressora comum)</button>
              <BotaoZebra className="btn primary" rotulo="Etiquetas Zebra" obterZpl={async () => (await post<any>('/erp/estoque/etiquetas/zpl', { itens: itensEtq(n) })).zpl} />
            </div>
          )}
          {vinc && <Vincular nfeId={n.id} item={vinc} onClose={() => setVinc(null)} onDone={() => { setVinc(null); st.reload(); }} />}
        </>
      )}</Async>
    </Modal>
  );
}

function Vincular({ nfeId, item, onClose, onDone }: { nfeId: string; item: any; onClose: () => void; onDone: () => void }) {
  const [busca, setBusca] = useState(''); const [ops, setOps] = useState<any[]>([]);
  const [prod, setProd] = useState<any>(null); const [criar, setCriar] = useState(false);
  const [f, setF] = useState({ fator: '1', sku: '', lote: false, validade: false }); // v1.31.0: código vazio = automático
  const { busy, run } = useAction();
  async function salvar() {
    const body = { fatorMil: toMil(f.fator), lembrar: true, ...(criar ? { criarProduto: { sku: f.sku.trim() || null, controlaLote: f.lote, controlaValidade: f.validade } } : { produtoId: prod.id }) };
    if (await run(() => put(`/erp/estoque/nfe/${nfeId}/itens/${item.id}`, body), 'Item vinculado')) onDone();
  }
  return (
    <Modal title={`Vincular: ${item.descricao}`} onClose={onClose}>
      <div className="row"><button className={`btn sm ${!criar ? 'primary' : ''}`} onClick={() => setCriar(false)}>Produto existente</button><button className={`btn sm ${criar ? 'primary' : ''}`} onClick={() => setCriar(true)}>Criar produto com este item</button></div>
      {!criar ? (prod ? <div className="row between"><strong>{prod.sku} · {prod.nome}</strong><button className="btn ghost sm" onClick={() => setProd(null)}>Trocar</button></div> : (
        <Field label="Produto"><input autoFocus value={busca} onChange={async (e) => { setBusca(e.target.value); setOps(e.target.value.length >= 2 ? (await get<any>(`/erp/produtos?q=${encodeURIComponent(e.target.value)}`)).items.slice(0, 8) : []); }} />
          {ops.map((o) => <button key={o.id} type="button" className="btn ghost sm" style={{ display: 'block' }} onClick={() => setProd(o)}>{o.sku} · {o.nome}</button>)}</Field>
      )) : <>
        <Field label="Código do novo produto (automático)" hint={`Vazio = o sistema gera o próximo código. Código do fornecedor: ${item.codigo}`}><input value={f.sku} placeholder="Gerado automaticamente" onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <label className="row small"><input type="checkbox" checked={f.lote} onChange={(e) => setF({ ...f, lote: e.target.checked })} /> Controla lote</label>
        <label className="row small"><input type="checkbox" checked={f.validade} onChange={(e) => setF({ ...f, validade: e.target.checked })} /> Controla validade (FEFO)</label>
      </>}
      <Field label={`1 ${item.unidade} do fornecedor = quantas unidades suas?`} hint="Ex.: caixa com 12 → 12"><input value={f.fator} onChange={(e) => setF({ ...f, fator: e.target.value })} inputMode="decimal" /></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || (!criar && !prod) || toMil(f.fator) <= 0} onClick={salvar}>Salvar vínculo</button></div>
    </Modal>
  );
}
