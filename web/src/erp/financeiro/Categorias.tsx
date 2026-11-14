/** Gerenciar categorias, subcategorias e tipos de conta do Financeiro: criar, renomear, ativar/desativar e excluir. */
import { useState } from 'react';
import { put, del } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Modal, useAction, useToast } from '../../ui';
import { arvore, NovaCategoriaInline, NovoTipoContaInline, type Cat, type TipoConta } from './categoriasUi';

function Renomear({ nome, onSalvar, onCancel }: { nome: string; onSalvar: (n: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(nome);
  return (
    <div className="row" style={{ flexWrap: 'nowrap', flex: 1 }}>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label="Novo nome" onKeyDown={(e) => { if (e.key === 'Enter' && v.trim().length >= 2) onSalvar(v.trim()); if (e.key === 'Escape') onCancel(); }} />
      <button type="button" className="btn primary sm" disabled={v.trim().length < 2} onClick={() => onSalvar(v.trim())}>Salvar</button>
      <button type="button" className="btn ghost sm" onClick={onCancel}>✕</button>
    </div>
  );
}

export default function Categorias({ tipoInicial, onClose }: { tipoInicial: 'RECEITA' | 'DESPESA'; onClose: () => void }) {
  const cats = useApi<Cat[]>('/erp/financeiro/categorias');
  const tipos = useApi<TipoConta[]>('/erp/financeiro/tipos-conta');
  const [tipo, setTipo] = useState<'RECEITA' | 'DESPESA' | 'TIPOS'>(tipoInicial);
  const [nova, setNova] = useState<null | { sub: boolean; pai?: string }>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const { can } = useAuth(); const gestor = can('OWNER', 'ADMIN');
  const { busy, run } = useAction(); const toast = useToast();

  const renomearCat = async (c: Cat, nome: string) => { if (await run(() => put(`/erp/financeiro/categorias/${c.id}`, { nome }), 'Nome alterado')) { setEditando(null); cats.reload(); } };
  const alternarCat = async (c: Cat) => { if (await run(() => put(`/erp/financeiro/categorias/${c.id}`, { ativa: !c.ativa }), c.ativa ? 'Desativada' : 'Reativada')) cats.reload(); };
  const excluirCat = async (c: Cat) => {
    if (!confirm(`Excluir "${c.nome}"? Se ela já foi usada em alguma conta, será só desativada.`)) return;
    const r = await run(() => del<any>(`/erp/financeiro/categorias/${c.id}`));
    if (r) { toast(r.excluida ? 'Categoria excluída' : 'Categoria em uso: foi desativada'); cats.reload(); }
  };
  const renomearTipo = async (t: TipoConta, nome: string) => { if (await run(() => put(`/erp/financeiro/tipos-conta/${t.id}`, { nome }), 'Nome alterado')) { setEditando(null); tipos.reload(); } };
  const alternarTipo = async (t: TipoConta) => { if (await run(() => put(`/erp/financeiro/tipos-conta/${t.id}`, { ativo: !t.ativo }), t.ativo ? 'Desativado' : 'Reativado')) tipos.reload(); };
  const excluirTipo = async (t: TipoConta) => {
    if (!confirm(`Excluir o tipo "${t.nome}"? Se ele já foi usado em alguma conta, será só desativado.`)) return;
    const r = await run(() => del<any>(`/erp/financeiro/tipos-conta/${t.id}`));
    if (r) { toast(r.excluido ? 'Tipo de conta excluído' : 'Tipo em uso: foi desativado'); tipos.reload(); }
  };

  return (
    <Modal title="Categorias e tipos de conta" onClose={onClose}>
      <div className="row" style={{ marginBottom: 10 }}>
        {([['DESPESA', 'Despesas'], ['RECEITA', 'Receitas'], ['TIPOS', 'Tipos de conta']] as const).map(([v, r]) => <button key={v} type="button" className={`btn sm ${tipo === v ? 'primary' : ''}`} onClick={() => { setTipo(v); setNova(null); setEditando(null); }}>{r}</button>)}
      </div>
      {!gestor && <p className="small muted">Só o proprietário ou um administrador pode criar ou alterar.</p>}

      {tipo !== 'TIPOS' ? <Async state={cats}>{(lista) => (
        <div style={{ display: 'grid', gap: 8 }}>
          {gestor && !nova && <div className="row"><button type="button" className="btn sm" onClick={() => setNova({ sub: false })}>+ Nova categoria</button></div>}
          {nova && <NovaCategoriaInline key={`${nova.sub}-${nova.pai ?? ''}`} tipo={tipo} cats={lista} sub={nova.sub} paiInicial={nova.pai} onCancel={() => setNova(null)} onCriada={() => { setNova(null); cats.reload(); }} />}
          {arvore(lista, tipo, false).map(({ cat: c, nivel }) => (
            <div key={c.id} className="row" style={{ paddingLeft: nivel ? 22 : 0, borderBottom: '1px solid var(--line)', paddingBottom: 6, flexWrap: 'wrap' }}>
              {editando === c.id ? <Renomear nome={c.nome} onCancel={() => setEditando(null)} onSalvar={(n) => renomearCat(c, n)} /> : <>
                <span style={{ flex: '1 1 160px', opacity: c.ativa ? 1 : 0.55 }}>{nivel ? '↳ ' : ''}<b>{c.nome}</b> <span className="small muted">{c.codigo}</span> {!c.ativa && <span className="badge">Inativa</span>}</span>
                {gestor && <div className="row" style={{ gap: 4 }}>
                  {!nivel && c.ativa && <button type="button" className="btn ghost sm" onClick={() => setNova({ sub: true, pai: c.id })}>+ Sub</button>}
                  <button type="button" className="btn ghost sm" onClick={() => setEditando(c.id)}>Renomear</button>
                  <button type="button" className="btn ghost sm" disabled={busy} onClick={() => alternarCat(c)}>{c.ativa ? 'Desativar' : 'Reativar'}</button>
                  <button type="button" className="btn ghost sm danger" disabled={busy} onClick={() => excluirCat(c)}>Excluir</button>
                </div>}
              </>}
            </div>
          ))}
          <p className="small muted">Excluir só apaga a categoria que nunca foi usada. Se já tem conta ou lançamento nela, ela é desativada: some das novas contas, mas o histórico e o DRE continuam certos.</p>
        </div>
      )}</Async> : <Async state={tipos}>{(lista) => (
        <div style={{ display: 'grid', gap: 8 }}>
          <p className="small muted">Além dos tipos prontos (água, luz, internet, telefone, aluguel, imposto), você pode criar os seus.</p>
          {gestor && (nova ? <NovoTipoContaInline onCancel={() => setNova(null)} onCriado={() => { setNova(null); tipos.reload(); }} /> : <div className="row"><button type="button" className="btn sm" onClick={() => setNova({ sub: false })}>+ Novo tipo de conta</button></div>)}
          {lista.length === 0 && <p className="small muted">Nenhum tipo criado ainda.</p>}
          {lista.map((t) => (
            <div key={t.id} className="row" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
              {editando === t.id ? <Renomear nome={t.nome} onCancel={() => setEditando(null)} onSalvar={(n) => renomearTipo(t, n)} /> : <>
                <span style={{ flex: '1 1 160px', opacity: t.ativo ? 1 : 0.55 }}><b>{t.nome}</b> {!t.ativo && <span className="badge">Inativo</span>}</span>
                {gestor && <div className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn ghost sm" onClick={() => setEditando(t.id)}>Renomear</button>
                  <button type="button" className="btn ghost sm" disabled={busy} onClick={() => alternarTipo(t)}>{t.ativo ? 'Desativar' : 'Reativar'}</button>
                  <button type="button" className="btn ghost sm danger" disabled={busy} onClick={() => excluirTipo(t)}>Excluir</button>
                </div>}
              </>}
            </div>
          ))}
        </div>
      )}</Async>}
    </Modal>
  );
}
