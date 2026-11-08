import { useEffect, useState } from 'react';
import { post, put, patch, del } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field } from '../ui';

type Stock = 'disponivel' | 'sob_encomenda' | 'esgotado';
interface Product {
  id: string; name: string; category: string | null; priceCents: number | null; promoCents: number | null;
  description: string; details: string; stock: Stock; quantity: number | null; link: string | null; imageUrl: string | null; active: boolean;
}
interface Form {
  id?: string; name: string; category: string; price: string; promo: string; description: string; details: string;
  stock: Stock; quantity: string; link: string; imageUrl: string; active: boolean;
}

const STOCK_LABEL: Record<Stock, string> = { disponivel: 'Disponível', sob_encomenda: 'Sob encomenda', esgotado: 'Esgotado' };
const STOCK_BADGE: Record<Stock, string> = { disponivel: 'green', sob_encomenda: 'amber', esgotado: 'red' };

export const brl = (c: number | null) => (c == null ? '—' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const centsToInput = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
/** "1.234,56" | "49,9" | "49.90" → centavos; vazio → null; inválido → NaN. */
function toCents(v: string): number | null {
  let s = v.replace(/r\$|\s/gi, '').trim();
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}

const EMPTY: Form = { name: '', category: '', price: '', promo: '', description: '', details: '', stock: 'disponivel', quantity: '', link: '', imageUrl: '', active: true };
const toForm = (p: Product): Form => ({
  id: p.id, name: p.name, category: p.category ?? '', price: centsToInput(p.priceCents), promo: centsToInput(p.promoCents),
  description: p.description, details: p.details, stock: p.stock, quantity: p.quantity == null ? '' : String(p.quantity),
  link: p.link ?? '', imageUrl: p.imageUrl ?? '', active: p.active,
});

const EXEMPLO = 'nome;categoria;preco;promocao;descricao;detalhes;estoque;link;imagem\nCamiseta Básica;Roupas;49,90;39,90;Camiseta 100% algodão;"cores: preta, branca; tamanhos P, M, G";disponivel;https://minhaloja.com.br/camiseta;\nFiat Uno 2015;Veículos;32.900,00;;Revisado, único dono;"ano 2015; 80.000 km; garantia 3 meses";sob encomenda;;';

export default function Products() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const state = useApi<{ items: Product[]; total: number; limit: number }>(`/ai/products${query ? `?q=${encodeURIComponent(query)}` : ''}`, [query]);
  const { can } = useAuth();
  const ro = !can('OWNER', 'ADMIN');
  const [edit, setEdit] = useState<Form | null>(null);
  const [remove, setRemove] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  const { busy, run } = useAction();

  const toggle = (p: Product) => run(() => patch(`/ai/products/${p.id}`, { active: !p.active }), p.active ? 'Produto desativado' : 'Produto ativado').then(state.reload);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Produtos</h1>
          <p className="muted">A IA usa estes produtos para responder preço, disponibilidade e detalhes. Só os produtos ativos entram nas respostas.</p>
        </div>
        {!ro && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setImporting(true)}>⬆ Importar planilha</button>
            <button className="btn primary" onClick={() => setEdit({ ...EMPTY })}>+ Produto</button>
          </div>
        )}
      </div>

      <ProductSourceCard ro={ro} />

      <div className="card" style={{ marginBottom: 12 }}>
        <input type="search" placeholder="Buscar por nome, categoria ou detalhe…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} aria-label="Buscar produtos" />
      </div>

      <Async state={state}>{(d) => d.items.length === 0 ? (
        <div className="card"><Empty title={query ? 'Nenhum produto encontrado' : 'Nenhum produto cadastrado'}>
          {query ? 'Tente outra palavra.' : 'Cadastre seus produtos (ou importe uma planilha) para a IA informar preço, disponibilidade e detalhes aos clientes.'}
        </Empty></div>
      ) : (
        <div className="card table-wrap">
          <p className="small muted" style={{ margin: '0 0 8px' }}>{d.items.length} de {d.total} produto(s) · limite {d.limit}</p>
          <table>
            <thead><tr><th>Produto</th><th>Preço</th><th>Estoque</th><th>Ativo</th>{!ro && <th />}</tr></thead>
            <tbody>
              {d.items.map((p) => (
                <tr key={p.id} style={p.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.category && <div className="small muted">{p.category}</div>}
                    {p.details && <div className="small muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.details}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {p.promoCents != null && p.priceCents != null && p.promoCents < p.priceCents
                      ? <><s className="small muted">{brl(p.priceCents)}</s><div><strong>{brl(p.promoCents)}</strong></div></>
                      : brl(p.promoCents ?? p.priceCents)}
                  </td>
                  <td><span className={`badge ${STOCK_BADGE[p.stock] ?? ''}`}>{STOCK_LABEL[p.stock] ?? p.stock}</span>{p.quantity != null && p.stock !== 'esgotado' && <div className="small muted">{p.quantity} un.</div>}</td>
                  <td>
                    <label className="row small" style={{ gap: 6 }}>
                      <input type="checkbox" checked={p.active} disabled={ro || busy} onChange={() => toggle(p)} aria-label={`Ativo: ${p.name}`} />
                      {p.active ? 'Sim' : 'Não'}
                    </label>
                  </td>
                  {!ro && (
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button className="btn sm" onClick={() => setEdit(toForm(p))}>Editar</button>{' '}
                      <button className="btn sm danger" onClick={() => setRemove(p)}>Excluir</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}</Async>

      {edit && <ProductModal form={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); state.reload(); }} />}

      {remove && (
        <Modal title="Excluir produto" onClose={() => setRemove(null)}>
          <div className="stack">
            <p style={{ margin: 0 }}>Excluir <strong>{remove.name}</strong>? A IA deixa de usar este produto. Para só esconder, desative em vez de excluir.</p>
            <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={() => setRemove(null)} disabled={busy}>Voltar</button>
              <button type="button" className="btn danger" disabled={busy} onClick={async () => {
                const ok = await run(() => del(`/ai/products/${remove.id}`), 'Produto excluído');
                if (ok) { setRemove(null); state.reload(); }
              }}>{busy ? 'Excluindo…' : 'Excluir'}</button>
            </div>
          </div>
        </Modal>
      )}

      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => state.reload()} />}
    </>
  );
}

type Source = 'catalogo' | 'erp' | 'ambos';
interface SourceView {
  productSource: Source; erpShowQuantity: boolean; erpDepositoId: string | null;
  erpLiberado: boolean; motivo: string | null; depositos: { id: string; nome: string }[]; efetivo: Source;
}
const SOURCE_OPTS: { id: Source; label: string; hint: string }[] = [
  { id: 'catalogo', label: 'Somente Produtos cadastrados', hint: 'A IA usa só esta lista de produtos (como sempre foi).' },
  { id: 'erp', label: 'ERP da MCK (saldo em tempo real)', hint: 'A IA consulta os produtos ativos do MCK ERP, com o estoque disponível (já descontado o reservado e a quarentena).' },
  { id: 'ambos', label: 'Os dois', hint: 'Descrição, promoção e link vêm daqui; o estoque vem do ERP (liga pelo código SKU citado no produto ou pelo mesmo nome).' },
];
const ORIGEM_LABEL: Record<string, string> = { catalogo: 'Produtos', erp: 'ERP', ambos: 'Produtos + ERP' };

/** v1.24.0 — "De onde a IA consulta os produtos": Produtos, ERP ou os dois, com teste do que a IA receberia. */
function ProductSourceCard({ ro }: { ro: boolean }) {
  const state = useApi<SourceView>('/ai/products/source');
  const [f, setF] = useState<{ productSource: Source; erpShowQuantity: boolean; erpDepositoId: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [prev, setPrev] = useState<{ context: string; source: Source; requested: Source; fallback: string | null; products: { id: string; name: string; origem: string }[] } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (state.data) setF({ productSource: state.data.productSource, erpShowQuantity: state.data.erpShowQuantity, erpDepositoId: state.data.erpDepositoId ?? '' }); }, [state.data]);
  const body = () => f && ({ productSource: f.productSource, erpShowQuantity: f.erpShowQuantity, erpDepositoId: f.erpDepositoId || null });
  const save = async () => { const ok = await run(() => put('/ai/products/source', body()), 'Fonte dos produtos salva'); if (ok) state.reload(); };
  const test = async () => { const r = await run(() => post('/ai/products/preview', { message: msg, ...body() })); if (r) setPrev(r as any); };
  return (
    <Async state={state}>{(d) => !f ? null : (
      <div className="card stack" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>De onde a IA consulta os produtos</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>A IA nunca informa custo, fornecedor ou dados internos, e nunca inventa preço ou estoque.</p>
        </div>
        <div className="stack" role="radiogroup" aria-label="De onde a IA consulta os produtos">
          {SOURCE_OPTS.map((o) => {
            const off = o.id !== 'catalogo' && !d.erpLiberado;
            return (
              <label key={o.id} className="row" style={{ alignItems: 'flex-start', gap: 8, opacity: off ? 0.55 : 1 }}>
                <input type="radio" name="productSource" value={o.id} checked={f.productSource === o.id} disabled={ro || off || busy}
                  onChange={() => { setF({ ...f, productSource: o.id }); setPrev(null); }} style={{ marginTop: 3 }} />
                <span><strong>{o.label}</strong><div className="small muted">{o.hint}</div></span>
              </label>
            );
          })}
          {!d.erpLiberado && <p className="small muted" style={{ margin: 0 }}>🔒 {d.motivo}</p>}
          {d.productSource !== d.efetivo && <p className="small" style={{ margin: 0, color: 'var(--danger)' }}>A opção salva usa o ERP, mas ele não está liberado: a IA está usando só os Produtos cadastrados.</p>}
        </div>
        {f.productSource !== 'catalogo' && d.erpLiberado && (
          <div className="grid g2">
            <Field label="Quantidade em estoque" hint={f.erpShowQuantity ? 'A IA informa a quantidade exata disponível (ex.: 12 UN).' : 'A IA diz só: disponível, poucas unidades, sem estoque ou sob encomenda.'}>
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={f.erpShowQuantity} disabled={ro || busy} onChange={(e) => { setF({ ...f, erpShowQuantity: e.target.checked }); setPrev(null); }} />
                Mostrar a quantidade exata ao cliente
              </label>
            </Field>
            <Field label="Depósito" hint="Saldo de qual depósito a IA considera.">
              <select value={f.erpDepositoId} disabled={ro || busy} onChange={(e) => { setF({ ...f, erpDepositoId: e.target.value }); setPrev(null); }}>
                <option value="">Todos os depósitos</option>
                {d.depositos.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}
              </select>
            </Field>
          </div>
        )}
        {!ro && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn primary" disabled={busy} onClick={save}>Salvar</button>
          </div>
        )}
        <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <strong>Testar</strong>
          <form className="row" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (msg.trim()) test(); }}>
            <input value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={2000} placeholder="Ex.: quanto custa a furadeira? tem em estoque?" aria-label="Mensagem de teste" style={{ flex: 1, minWidth: 220 }} />
            <button className="btn" disabled={busy || !msg.trim()}>Testar</button>
          </form>
          {prev && (
            <div className="stack">
              {prev.fallback && <p className="small" style={{ margin: 0 }}>{prev.fallback === 'sem_plano' ? 'ERP não liberado para esta empresa: o teste usou só os Produtos cadastrados.' : 'Não foi possível consultar o ERP agora: o teste usou só os Produtos cadastrados.'}</p>}
              {prev.products.length === 0
                ? <p className="small muted" style={{ margin: 0 }}>Nenhum produto combinou com a mensagem. A IA vai dizer que verifica com a equipe.</p>
                : <p className="small muted" style={{ margin: 0 }}>Produtos encontrados: {prev.products.map((p) => `${p.name} (${ORIGEM_LABEL[p.origem] ?? p.origem})`).join(', ')}</p>}
              {prev.context && <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0, padding: 8, background: 'var(--bg)', borderRadius: 6 }}>{prev.context}</pre>}
            </div>
          )}
        </div>
      </div>
    )}</Async>
  );
}

function ProductModal({ form, onClose, onSaved }: { form: Form; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(form);
  const [err, setErr] = useState('');
  const { busy, run } = useAction();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title={f.id ? 'Editar produto' : 'Novo produto'} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const priceCents = toCents(f.price), promoCents = toCents(f.promo);
        if (Number.isNaN(priceCents) || Number.isNaN(promoCents)) { setErr('Preço inválido. Use, por exemplo, 49,90.'); return; }
        const quantity = f.quantity.trim() === '' ? null : Number(f.quantity);
        if (quantity !== null && (!Number.isInteger(quantity) || quantity < 0)) { setErr('Quantidade inválida.'); return; }
        setErr('');
        const body = {
          name: f.name, category: f.category || null, priceCents, promoCents, description: f.description, details: f.details,
          stock: f.stock, quantity, link: f.link.trim() || null, imageUrl: f.imageUrl.trim() || null, active: f.active,
        };
        const ok = await run(() => (f.id ? put(`/ai/products/${f.id}`, body) : post('/ai/products', body)), 'Produto salvo');
        if (ok) onSaved();
      }}>
        <Field label="Nome"><input required maxLength={160} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Camiseta Básica" /></Field>
        <div className="grid g2">
          <Field label="Categoria"><input maxLength={80} value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Ex.: Roupas" /></Field>
          <Field label="Disponibilidade">
            <select value={f.stock} onChange={(e) => set('stock', e.target.value as Stock)}>
              <option value="disponivel">Disponível</option>
              <option value="sob_encomenda">Sob encomenda</option>
              <option value="esgotado">Esgotado</option>
            </select>
          </Field>
          <Field label="Preço (R$)"><input inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="49,90" /></Field>
          <Field label="Preço promocional (R$)" hint="Opcional"><input inputMode="decimal" value={f.promo} onChange={(e) => set('promo', e.target.value)} placeholder="39,90" /></Field>
          <Field label="Quantidade em estoque" hint="Opcional"><input inputMode="numeric" value={f.quantity} onChange={(e) => set('quantity', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="Ativo">
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> A IA pode usar este produto</label>
          </Field>
        </div>
        <Field label="Descrição"><textarea rows={3} maxLength={4000} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="O que é, para quem serve, diferenciais" /></Field>
        <Field label="Detalhes" hint="Cor, tamanho, ano, km, garantia, medidas…"><textarea rows={3} maxLength={2000} value={f.details} onChange={(e) => set('details', e.target.value)} placeholder="cores: preta, branca; tamanhos: P, M, G; garantia 3 meses" /></Field>
        <div className="grid g2">
          <Field label="Link do produto" hint="Opcional, https://"><input type="url" maxLength={500} value={f.link} onChange={(e) => set('link', e.target.value)} placeholder="https://" /></Field>
          <Field label="Link da foto" hint="Opcional, https://"><input type="url" maxLength={500} value={f.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} placeholder="https://" /></Field>
        </div>
        {err && <div className="small" style={{ color: 'var(--danger, #c0392b)' }}>{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ created: number; updated: number; errors: string[]; errorCount: number } | null>(null);
  const { busy, run } = useAction();
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 900_000) { setText(''); setResult({ created: 0, updated: 0, errors: ['Arquivo grande demais (máx. ~900 KB).'], errorCount: 1 }); return; }
    setText(await file.text());
  };
  return (
    <Modal title="Importar produtos (CSV)" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Colunas: <code>nome;categoria;preco;descricao;detalhes;estoque;link;imagem</code> (e <code>promocao</code>, opcional). Separador <code>;</code> ou <code>,</code>.
          Estoque: <em>disponivel</em>, <em>sob encomenda</em>, <em>esgotado</em> ou a quantidade. Produto com o mesmo nome é atualizado.
          Até 500 produtos por importação e 2.000 no total.
        </p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <a className="btn sm" href="/api/ai/products/template" download="modelo-produtos.csv">⬇ Baixar modelo</a>
          <button type="button" className="btn sm" onClick={() => setText(EXEMPLO)}>Colar exemplo</button>
          <label className="btn sm" style={{ cursor: 'pointer' }}>Escolher arquivo<input type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => readFile(e.target.files?.[0])} /></label>
        </div>
        <Field label="Conteúdo da planilha"><textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXEMPLO} style={{ fontFamily: 'monospace', fontSize: 12 }} /></Field>
        {result && (
          <div className={`alert ${result.errorCount ? 'warn' : 'ok'}`}>
            {result.created} criado(s), {result.updated} atualizado(s){result.errorCount ? `, ${result.errorCount} com erro` : ''}.
            {result.errors.length > 0 && <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Fechar</button>
          <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={async () => {
            const r = await run(() => post('/ai/products/import', { text }));
            if (r) { setResult(r); onDone(); }
          }}>{busy ? 'Importando…' : 'Importar'}</button>
        </div>
      </div>
    </Modal>
  );
}
