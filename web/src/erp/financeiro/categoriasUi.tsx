/** Peças de categorias e tipos de conta do Financeiro: opções do select (com subcategorias) e criação rápida dentro do modal. */
import { useState } from 'react';
import { post } from '../../api';
import { useAction } from '../../ui';

export interface Cat { id: string; codigo: string; nome: string; tipo: 'RECEITA' | 'DESPESA'; grupo: string; ativa: boolean; paiId?: string | null }
export interface TipoConta { id: string; nome: string; categoriaId?: string | null; ativo: boolean }

/** Categorias de um tipo em ordem de árvore: cada categoria seguida das suas subcategorias. */
export function arvore(cats: Cat[], tipo: 'RECEITA' | 'DESPESA', soAtivas = true) {
  const l = cats.filter((c) => c.tipo === tipo && (!soAtivas || c.ativa));
  const ids = new Set(l.map((c) => c.id));
  const raizes = l.filter((c) => !c.paiId || !ids.has(c.paiId));
  const out: { cat: Cat; nivel: number }[] = [];
  for (const r of raizes) {
    out.push({ cat: r, nivel: 0 });
    for (const f of l.filter((c) => c.paiId === r.id)) out.push({ cat: f, nivel: 1 });
  }
  return out;
}
export const nomeCat = (cats: Cat[], id?: string | null) => {
  const c = cats.find((x) => x.id === id); if (!c) return '';
  const pai = c.paiId ? cats.find((x) => x.id === c.paiId) : null;
  return pai ? `${pai.nome} › ${c.nome}` : c.nome;
};

/** Campo inline para criar categoria ou subcategoria sem sair do modal. */
export function NovaCategoriaInline({ tipo, cats, sub, paiInicial, onCriada, onCancel }: { tipo: 'RECEITA' | 'DESPESA'; cats: Cat[]; sub: boolean; paiInicial?: string | null; onCriada: (c: Cat) => void; onCancel: () => void }) {
  const raizes = cats.filter((c) => c.tipo === tipo && !c.paiId && c.ativa);
  const [nome, setNome] = useState(''); const [pai, setPai] = useState(paiInicial && raizes.some((r) => r.id === paiInicial) ? paiInicial : raizes[0]?.id ?? '');
  const { busy, run } = useAction();
  const salvar = async () => { const c = await run(() => post<Cat>('/erp/financeiro/categorias', { nome: nome.trim(), tipo, ...(sub ? { paiId: pai } : {}) }), sub ? 'Subcategoria criada' : 'Categoria criada'); if (c) onCriada(c); };
  return (
    <div className="card" style={{ padding: 10, display: 'grid', gap: 8 }}>
      <strong className="small">{sub ? 'Nova subcategoria' : 'Nova categoria'}</strong>
      {sub && <select value={pai} onChange={(e) => setPai(e.target.value)} aria-label="Categoria-mãe">{raizes.map((r) => <option key={r.id} value={r.id}>Dentro de: {r.nome}</option>)}</select>}
      <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} placeholder={sub ? 'Nome da subcategoria (ex.: Conta de água)' : 'Nome da categoria (ex.: Manutenção)'} aria-label="Nome" onKeyDown={(e) => { if (e.key === 'Enter' && nome.trim().length >= 2 && (!sub || pai)) { e.preventDefault(); salvar(); } }} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn ghost sm" onClick={onCancel}>Cancelar</button>
        <button type="button" className="btn primary sm" disabled={busy || nome.trim().length < 2 || (sub && !pai)} onClick={salvar}>Criar</button>
      </div>
    </div>
  );
}

/** Campo inline para criar um tipo de conta a pagar (ex.: "Condomínio", "Contador"). */
export function NovoTipoContaInline({ onCriado, onCancel }: { onCriado: (t: TipoConta) => void; onCancel: () => void }) {
  const [nome, setNome] = useState('');
  const { busy, run } = useAction();
  const salvar = async () => { const t = await run(() => post<TipoConta>('/erp/financeiro/tipos-conta', { nome: nome.trim() }), 'Tipo de conta criado'); if (t) onCriado(t); };
  return (
    <div className="card" style={{ padding: 10, display: 'grid', gap: 8 }}>
      <strong className="small">Novo tipo de conta</strong>
      <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Condomínio, Contador, Sistema" aria-label="Nome do tipo de conta" onKeyDown={(e) => { if (e.key === 'Enter' && nome.trim().length >= 2) { e.preventDefault(); salvar(); } }} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn ghost sm" onClick={onCancel}>Cancelar</button>
        <button type="button" className="btn primary sm" disabled={busy || nome.trim().length < 2} onClick={salvar}>Criar</button>
      </div>
    </div>
  );
}
