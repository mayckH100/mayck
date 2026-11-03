/** Peças comuns do ERP: busca de produto e de parceiro com lista suspensa simples. */
import { useState } from 'react';
import { get } from '../api';

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
export function EditorItens({ itens, setItens, comPreco }: { itens: LinhaItem[]; setItens: (i: LinhaItem[]) => void; comPreco?: boolean }) {
  return (
    <>
      <table><thead><tr><th>Produto</th><th>Qtd</th>{comPreco && <th>Preço un. (R$)</th>}<th></th></tr></thead>
        <tbody>{itens.map((i, n) => (
          <tr key={i.produto.id}>
            <td className="small">{i.produto.sku} · {i.produto.nome}</td>
            <td><input style={{ width: 80 }} value={i.qtd} inputMode="decimal" aria-label="Quantidade" onChange={(e) => setItens(itens.map((x, k) => (k === n ? { ...x, qtd: e.target.value } : x)))} /></td>
            {comPreco && <td><input style={{ width: 90 }} value={i.preco ?? ''} inputMode="decimal" aria-label="Preço" onChange={(e) => setItens(itens.map((x, k) => (k === n ? { ...x, preco: e.target.value } : x)))} /></td>}
            <td><button className="btn ghost sm" onClick={() => setItens(itens.filter((_, k) => k !== n))} aria-label="Remover">✕</button></td>
          </tr>
        ))}</tbody></table>
      <BuscaProduto filtro={(p) => p.tipo !== 'SERVICO' && !itens.some((i) => i.produto.id === p.id)} onPick={(p) => setItens([...itens, { produto: p, qtd: '1', preco: comPreco ? ((p.custoMedioCents ?? 0) / 100).toFixed(2).replace('.', ',') : undefined }])} />
    </>
  );
}
