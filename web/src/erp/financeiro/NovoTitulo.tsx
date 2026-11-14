/**
 * Modal "Nova conta a pagar / a receber" (mesmo componente para os dois).
 * Parcelamento simples: valor total + quantidade de parcelas + 1º vencimento → prévia com valor e data de cada parcela,
 * editável antes de salvar. Se a soma editada não bater com o total, a tela avisa e não deixa salvar
 * (com um botão para usar a soma como novo total ou refazer as parcelas).
 */
import { useMemo, useState } from 'react';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Modal, Field, useAction } from '../../ui';
import { brl, toCents, fromCents } from '../format';
import { BuscaParceiro } from '../comum';
import { gerarParcelas, conferirParcelas, isoValida, MAX_PARCELAS } from '../../../../server/erp/financeiro/parcelas';
import { arvore, NovaCategoriaInline, NovoTipoContaInline, type Cat, type TipoConta } from './categoriasUi';

export const NATUREZA: Record<string, string> = { FORNECEDOR: 'Fornecedor', AGUA: 'Água', LUZ: 'Luz', INTERNET: 'Internet', TELEFONE: 'Telefone', ALUGUEL: 'Aluguel', IMPOSTO: 'Imposto', OUTRA_CONTA: 'Outra conta' };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const hojeIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Exemplo da descrição que combina com o tipo de conta e o mês do 1º vencimento. */
export function exemploDescricao(tipo: string, natureza: string, nomeTipoProprio: string | null, vencIso: string) {
  const mes = isoValida(vencIso) ? MESES[+vencIso.slice(5, 7) - 1] : MESES[new Date().getMonth()];
  if (tipo === 'RECEBER') return `Ex.: Serviço prestado em ${mes}`;
  if (nomeTipoProprio) return `Ex.: ${nomeTipoProprio} de ${mes}`;
  const m: Record<string, string> = { FORNECEDOR: 'Ex.: Compra de mercadorias', AGUA: `Ex.: Conta de água de ${mes}`, LUZ: `Ex.: Conta de luz de ${mes}`, INTERNET: `Ex.: Internet de ${mes}`, TELEFONE: `Ex.: Telefone de ${mes}`, ALUGUEL: `Ex.: Aluguel de ${mes}`, IMPOSTO: `Ex.: Imposto de ${mes}`, OUTRA_CONTA: 'Ex.: O que é esta conta' };
  return m[natureza] ?? 'Ex.: O que é esta conta';
}

type Linha = { venc: string; valor: string };

export default function NovoTitulo({ tipo, onClose, onDone }: { tipo: 'RECEBER' | 'PAGAR'; onClose: () => void; onDone: () => void }) {
  const cats = useApi<Cat[]>('/erp/financeiro/categorias');
  const tipos = useApi<TipoConta[]>(tipo === 'PAGAR' ? '/erp/financeiro/tipos-conta' : null);
  const { can } = useAuth(); const gestor = can('OWNER', 'ADMIN');
  const tipoCat = tipo === 'RECEBER' ? 'RECEITA' : 'DESPESA';
  const [f, setF] = useState({ parceiro: null as any, descricao: '', valor: '', venc: hojeIso(), qtd: '1', intervalo: 'MENSAL' as 'MENSAL' | 'DIAS', dias: '30', categoriaId: '', natureza: 'FORNECEDOR' });
  const [linhas, setLinhas] = useState<Linha[] | null>(null); // null = prévia automática; lista = parcelas editadas à mão
  const [criando, setCriando] = useState<null | 'cat' | 'sub' | 'tipo'>(null);
  const { busy, run } = useAction();

  /** Muda um campo que define as parcelas: a prévia volta a ser calculada automaticamente. */
  const base = (p: Partial<typeof f>) => { setF({ ...f, ...p }); setLinhas(null); };
  const totalCents = toCents(f.valor);
  const qtd = Math.min(MAX_PARCELAS, Math.max(1, Math.floor(Number(f.qtd)) || 1));
  const auto = useMemo<Linha[]>(() => (totalCents > 0 && isoValida(f.venc)
    ? gerarParcelas(totalCents, qtd, f.venc, f.intervalo === 'DIAS' ? { tipo: 'DIAS', dias: Math.max(1, Number(f.dias) || 30) } : { tipo: 'MENSAL' }).map((p) => ({ venc: p.vencimento, valor: fromCents(p.valorCents) }))
    : []), [totalCents, qtd, f.venc, f.intervalo, f.dias]);
  const lista = linhas ?? auto;
  const parcelas = lista.map((l) => ({ vencimento: l.venc, valorCents: toCents(l.valor) }));
  const conf = conferirParcelas(parcelas, totalCents);
  const editar = (i: number, p: Partial<Linha>) => setLinhas(lista.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const tipoProprio = f.natureza.startsWith('tc:') ? (tipos.data ?? []).find((t) => `tc:${t.id}` === f.natureza) ?? null : null;
  const fornecedor = tipo === 'RECEBER' || f.natureza === 'FORNECEDOR';
  const opcoesCat = arvore(cats.data ?? [], tipoCat);
  const podeSalvar = !busy && f.descricao.trim().length >= 2 && totalCents > 0 && conf.ok;

  async function salvar() {
    const natureza = tipoProprio ? 'OUTRA_CONTA' : f.natureza;
    const corpo = { tipo, parceiroId: fornecedor ? f.parceiro?.id ?? null : null, descricao: f.descricao.trim(), valorCents: totalCents, primeiroVencimento: parcelas[0]?.vencimento ?? f.venc, parcelas, categoriaId: f.categoriaId || null, ...(tipo === 'PAGAR' ? { natureza, tipoContaId: tipoProprio?.id ?? null } : {}) };
    if (await run(() => post('/erp/financeiro/titulos', corpo), parcelas.length > 1 ? `${parcelas.length} parcelas lançadas` : 'Lançado')) onDone();
  }

  return (
    <Modal title={tipo === 'RECEBER' ? 'Nova conta a receber' : 'Nova conta a pagar'} onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        {tipo === 'PAGAR' && <div style={{ display: 'grid', gap: 6 }}>
          <Field label="Tipo de conta">
            <select value={criando === 'tipo' ? '__novo_tipo' : f.natureza} onChange={(e) => { const v = e.target.value; if (v === '__novo_tipo') { setCriando('tipo'); return; } setCriando(null); setF({ ...f, natureza: v, parceiro: v === 'FORNECEDOR' ? f.parceiro : null }); }}>
              <option value="FORNECEDOR">Fornecedor</option>
              <optgroup label="Conta da empresa">
                {Object.entries(NATUREZA).filter(([v]) => v !== 'FORNECEDOR').map(([v, r]) => <option key={v} value={v}>{r}</option>)}
                {(tipos.data ?? []).filter((t) => t.ativo).map((t) => <option key={t.id} value={`tc:${t.id}`}>{t.nome}</option>)}
              </optgroup>
              {gestor && <option value="__novo_tipo">+ Novo tipo de conta…</option>}
            </select>
          </Field>
          {criando === 'tipo' && <NovoTipoContaInline onCancel={() => setCriando(null)} onCriado={(t) => { setCriando(null); tipos.reload(); setF({ ...f, natureza: `tc:${t.id}`, parceiro: null }); }} />}
        </div>}

        {fornecedor && <Field label={tipo === 'RECEBER' ? 'Cliente (opcional)' : 'Fornecedor (opcional)'}>{f.parceiro ? <div className="row between"><strong>{f.parceiro.fantasia || f.parceiro.nome}</strong><button type="button" className="btn ghost sm" onClick={() => setF({ ...f, parceiro: null })}>Trocar</button></div> : <BuscaParceiro tipo={tipo === 'RECEBER' ? 'cliente' : 'fornecedor'} placeholder={tipo === 'RECEBER' ? 'Cliente (nome ou CPF/CNPJ)' : 'Fornecedor (nome ou CNPJ)'} onPick={(p) => setF({ ...f, parceiro: p })} />}</Field>}

        <Field label="Descrição"><input value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} placeholder={exemploDescricao(tipo, f.natureza, tipoProprio?.nome ?? null, f.venc)} /></Field>

        <div className="grid g2" style={{ gap: 12 }}>
          <Field label="Valor total (R$)"><input value={f.valor} onChange={(e) => base({ valor: e.target.value })} inputMode="decimal" placeholder="0,00" /></Field>
          <Field label="1º vencimento"><input type="date" value={f.venc} onChange={(e) => base({ venc: e.target.value })} /></Field>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span className="small" style={{ fontWeight: 600, color: '#33433e' }}>Quantidade de parcelas</span>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <button type="button" className="btn" aria-label="Menos uma parcela" disabled={qtd <= 1} onClick={() => base({ qtd: String(qtd - 1) })}>−</button>
            <input type="number" inputMode="numeric" min={1} max={MAX_PARCELAS} value={f.qtd} onChange={(e) => base({ qtd: e.target.value })} onBlur={() => setF((x) => ({ ...x, qtd: String(qtd) }))} aria-label="Quantidade de parcelas" style={{ textAlign: 'center', maxWidth: 90 }} />
            <button type="button" className="btn" aria-label="Mais uma parcela" disabled={qtd >= MAX_PARCELAS} onClick={() => base({ qtd: String(qtd + 1) })}>+</button>
            <span className="small muted">{qtd === 1 ? 'à vista (1 parcela)' : `${qtd} parcelas`}</span>
          </div>
          {qtd > 1 && <div className="row">
            <select value={f.intervalo} onChange={(e) => base({ intervalo: e.target.value as 'MENSAL' | 'DIAS' })} aria-label="Intervalo entre parcelas" style={{ width: 'auto', flex: '1 1 180px' }}>
              <option value="MENSAL">Todo mês, no mesmo dia</option>
              <option value="DIAS">A cada X dias</option>
            </select>
            {f.intervalo === 'DIAS' && <><input type="number" inputMode="numeric" min={1} max={365} value={f.dias} onChange={(e) => base({ dias: e.target.value })} aria-label="Dias entre parcelas" style={{ maxWidth: 80 }} /><span className="small muted">dias</span></>}
          </div>}
        </div>

        {lista.length > 0 && <div className="card" style={{ padding: 10, display: 'grid', gap: 6 }}>
          <div className="row between"><strong className="small">{lista.length === 1 ? 'Parcela' : `Parcelas (${lista.length})`}</strong>{linhas && <button type="button" className="btn ghost sm" onClick={() => setLinhas(null)}>Refazer parcelas</button>}</div>
          {lista.length > 1 && !linhas && <span className="small muted">Toque na data ou no valor para ajustar uma parcela.</span>}
          {lista.map((l, i) => (
            <div key={i} className="row" style={{ flexWrap: 'nowrap', gap: 6 }} aria-label={`Parcela ${i + 1} de ${lista.length}`}>
              <span className="small" style={{ minWidth: 40, fontWeight: 600 }}>{i + 1}/{lista.length}</span>
              <span className="small muted">R$</span>
              <input value={l.valor} onChange={(e) => editar(i, { valor: e.target.value })} inputMode="decimal" aria-label={`Valor da parcela ${i + 1}`} style={{ flex: '1 1 0', minWidth: 0, textAlign: 'right', maxWidth: 130 }} />
              <input type="date" value={l.venc} onChange={(e) => editar(i, { venc: e.target.value })} aria-label={`Vencimento da parcela ${i + 1}`} style={{ flex: '1 1 0', minWidth: 0 }} />
            </div>
          ))}
          {!conf.ok && totalCents > 0 && <div className="small" role="alert" style={{ color: '#dc2626', display: 'grid', gap: 6 }}>
            {conf.diferencaCents !== 0
              ? <span>A soma das parcelas é {brl(conf.somaCents)}, mas o valor total é {brl(totalCents)} ({conf.diferencaCents > 0 ? `faltam ${brl(conf.diferencaCents)}` : `passou ${brl(-conf.diferencaCents)}`}). Ajuste as parcelas para salvar.</span>
              : <span>{conf.erro}</span>}
            {conf.diferencaCents !== 0 && conf.somaCents > 0 && <div className="row">
              <button type="button" className="btn sm" onClick={() => setF({ ...f, valor: fromCents(conf.somaCents) })}>Usar {brl(conf.somaCents)} como valor total</button>
              <button type="button" className="btn ghost sm" onClick={() => setLinhas(null)}>Refazer parcelas</button>
            </div>}
          </div>}
        </div>}

        <div style={{ display: 'grid', gap: 6 }}>
          <Field label="Categoria">
            <select value={criando === 'cat' ? '__nova_cat' : criando === 'sub' ? '__nova_sub' : f.categoriaId} onChange={(e) => { const v = e.target.value; if (v === '__nova_cat') return setCriando('cat'); if (v === '__nova_sub') return setCriando('sub'); setCriando(null); setF({ ...f, categoriaId: v }); }}>
              <option value="">{tipo === 'PAGAR' ? 'Automática pelo tipo de conta' : 'Sem categoria'}</option>
              {opcoesCat.map(({ cat, nivel }) => <option key={cat.id} value={cat.id}>{nivel ? `\u00A0\u00A0\u00A0↳ ${cat.nome}` : cat.nome}</option>)}
              {gestor && <option value="__nova_cat">+ Nova categoria…</option>}
              {gestor && opcoesCat.some((o) => o.nivel === 0) && <option value="__nova_sub">+ Nova subcategoria…</option>}
            </select>
          </Field>
          {(criando === 'cat' || criando === 'sub') && <NovaCategoriaInline key={criando} tipo={tipoCat} cats={cats.data ?? []} sub={criando === 'sub'} paiInicial={(cats.data ?? []).find((c) => c.id === f.categoriaId)?.paiId ?? f.categoriaId} onCancel={() => setCriando(null)} onCriada={(c) => { setCriando(null); cats.reload(); setF({ ...f, categoriaId: c.id }); }} />}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn primary" style={{ minWidth: 140 }} disabled={!podeSalvar} onClick={salvar}>{lista.length > 1 ? `Salvar ${lista.length} parcelas` : 'Salvar'}</button>
        </div>
      </div>
    </Modal>
  );
}
