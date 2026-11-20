/** Peças comuns do ERP: busca de produto e de parceiro com lista suspensa simples. */
import { useState } from 'react';
import { get } from '../api';
import { temEmbalagem, fatorDe, unidadeCompraDe, embalagensParaBase, baseParaEmbalagens, precoPorBase, precoPorEmbalagem, linhaCompra, descricaoEmbalagem, lerQtdMil } from '../../../server/erp/shared/embalagem';
import { nomeUnidade, numeroQtd } from '../../../server/erp/shared/unidade';

export function BuscaProduto({ onPick, placeholder = 'Produto (SKU ou nome)', filtro }: { onPick: (p: any) => void; placeholder?: string; filtro?: (p: any) => boolean }) {
  const [q, setQ] = useState(''); const [ops, setOps] = useState<any[]>([]);
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} placeholder={placeholder} aria-label={placeholder} onChange={async (e) => { setQ(e.target.value); setOps(e.target.value.length >= 2 ? (await get<any>(`/erp/produtos?q=${encodeURIComponent(e.target.value)}`)).items.filter(filtro ?? (() => true)).slice(0, 8) : []); }} />
      {ops.length > 0 && <div className="card" style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, padding: 4 }}>
        {ops.map((o) => <button key={o.id} type="button" className="btn ghost sm" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => { onPick(o); setQ(''); setOps([]); }}>{o.sku} · {o.nome}</button>)}
      </div>}
    </div>
  );
}

export function BuscaParceiro({ onPick, tipo = 'fornecedor', placeholder = 'Fornecedor (nome ou CNPJ)' }: { onPick: (p: any) => void; tipo?: 'fornecedor' | 'cliente' | ''; placeholder?: string }) {
  const [q, setQ] = useState(''); const [ops, setOps] = useState<any[]>([]);
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} placeholder={placeholder} aria-label={placeholder} onChange={async (e) => { setQ(e.target.value); setOps(e.target.value.length >= 2 ? (await get<any>(`/erp/crm/parceiros?q=${encodeURIComponent(e.target.value)}${tipo ? `&tipo=${tipo}` : ''}`)).items.slice(0, 8) : []); }} />
      {ops.length > 0 && <div className="card" style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, padding: 4 }}>
        {ops.map((o) => <button key={o.id} type="button" className="btn ghost sm" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => { onPick(o); setQ(''); setOps([]); }}>{o.fantasia || o.nome}</button>)}
      </div>}
    </div>
  );
}

/** Linhas de itens (produto + quantidade + preço opcional) para solicitações, cotações e pedidos de compra. */
export interface LinhaItem { produto: any; qtd: string; preco?: string }
const centsDe = (s: string) => Math.round(Number(String(s).replace(/\./g, '').replace(',', '.')) * 100) || 0;
const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const qtdTexto = (mil: number) => (mil / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3, useGrouping: false });

/**
 * v1.32.0: digitar em embalagens (pacote, caixa, rolo) quando o produto tem unidade de compra. O sistema converte
 * para a unidade de estoque (5 pacotes × 10 peças = 50 peças) e mostra o preço por embalagem e por unidade.
 * `qtd` e `preco` continuam na unidade de estoque (o que o servidor recebe não muda).
 */
export function AjudaEmbalagem({ produto, qtd, setQtd, preco, setPreco }: { produto: any; qtd: string; setQtd: (v: string) => void; preco?: string; setPreco?: (v: string) => void }) {
  if (!produto || !temEmbalagem(produto)) return null;
  const f = fatorDe(produto); const uc = unidadeCompraDe(produto);
  const baseMil = lerQtdMil(qtd); const embMil = baseParaEmbalagens(baseMil, f);
  const precoBase = preco !== undefined ? centsDe(preco) : 0;
  const lc = linhaCompra(baseMil, precoBase, produto);
  return (
    <div className="embalagem-ajuda">
      <div className="small muted">{descricaoEmbalagem(produto)}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="small">Quantidade em {nomeUnidade(uc, 2)}<input style={{ width: 90 }} inputMode="decimal" value={qtdTexto(embMil)} onChange={(e) => setQtd(qtdTexto(embalagensParaBase(lerQtdMil(e.target.value), f)))} aria-label={`Quantidade em ${nomeUnidade(uc, 2)}`} /></label>
        {setPreco && <label className="small">Preço por {nomeUnidade(uc, 1)} (R$)<input style={{ width: 90 }} inputMode="decimal" value={reais(precoPorEmbalagem(precoBase, f))} onChange={(e) => setPreco(reais(precoPorBase(centsDe(e.target.value), f)))} aria-label={`Preço por ${nomeUnidade(uc, 1)}`} /></label>}
      </div>
      <div className="small"><strong>{lc.texto}</strong></div>
      {embMil % 1000 !== 0 && <div className="small" style={{ color: '#b45309' }}>Atenção: não fecha {nomeUnidade(uc, 1)} inteiro ({numeroQtd(embMil)} {nomeUnidade(uc, embMil / 1000)}).</div>}
    </div>
  );
}

export function EditorItens({ itens, setItens, comPreco }: { itens: LinhaItem[]; setItens: (i: LinhaItem[]) => void; comPreco?: boolean }) {
  const muda = (n: number, campo: 'qtd' | 'preco') => (v: string) => setItens(itens.map((x, k) => (k === n ? { ...x, [campo]: v } : x)));
  return (
    <>
      <table><thead><tr><th>Produto</th><th>Qtd</th>{comPreco && <th>Preço un. (R$)</th>}<th></th></tr></thead>
        <tbody>{itens.map((i, n) => (
          <tr key={i.produto.id}>
            <td className="small">{i.produto.sku} · {i.produto.nome}
              <AjudaEmbalagem produto={i.produto} qtd={i.qtd} setQtd={muda(n, 'qtd')} preco={comPreco ? i.preco ?? '' : undefined} setPreco={comPreco ? muda(n, 'preco') : undefined} />
            </td>
            <td><input style={{ width: 80 }} value={i.qtd} inputMode="decimal" aria-label="Quantidade" onChange={(e) => muda(n, 'qtd')(e.target.value)} /><div className="small muted">{nomeUnidade(i.produto.unidade, 2)}</div></td>
            {comPreco && <td><input style={{ width: 90 }} value={i.preco ?? ''} inputMode="decimal" aria-label="Preço" onChange={(e) => muda(n, 'preco')(e.target.value)} /><div className="small muted">por {nomeUnidade(i.produto.unidade, 1)}</div></td>}
            <td><button className="btn ghost sm" onClick={() => setItens(itens.filter((_, k) => k !== n))} aria-label="Remover">✕</button></td>
          </tr>
        ))}</tbody></table>
      <BuscaProduto filtro={(p) => p.tipo !== 'SERVICO' && !itens.some((i) => i.produto.id === p.id)} onPick={(p) => setItens([...itens, { produto: p, qtd: temEmbalagem(p) ? qtdTexto(fatorDe(p)) : '1', preco: comPreco ? ((p.custoMedioCents ?? 0) / 100).toFixed(2).replace('.', ',') : undefined }])} />
    </>
  );
}
