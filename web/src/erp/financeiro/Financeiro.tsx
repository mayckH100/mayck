/** Financeiro: painel (saldo, aging, fluxo), contas a receber/pagar com baixa e Pix, contas e conciliação OFX, DRE. */
import { useState } from 'react';
import { get, post } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, useToast } from '../../ui';
import { brl, toCents, fromCents, fmtDoc } from '../format';
import { imprimir } from '../impressao/cabecalho';
import { esc } from '../impressao/modelo';
import { linhaFiltros, htmlTabela, htmlFicha, fmt } from '../impressao/listas';
import { BotaoImprimir, BotaoPdf } from '../impressao/BotaoPdf';
import NovoTitulo, { NATUREZA } from './NovoTitulo';
import Categorias from './Categorias';
import { SeletorPeriodo, usePeriodo } from '../SeletorPeriodo';
import { classeStatus, statusSaldo, statusTitulo, StatusBadge } from '../status';

const ST: Record<string, string> = { EM_ABERTO: 'Em aberto', PARCIAL: 'Parcial', PAGO: 'Pago', CANCELADO: 'Cancelado' };
const dt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—');
const hojeIso = () => new Date().toISOString().slice(0, 10);

/** v1.50.0: aba inicial pela rota (ex.: /erp/financeiro/…); as abas internas continuam como nas primeiras versões. */
export type AbaFinanceiro = 'painel' | 'RECEBER' | 'PAGAR' | 'contas' | 'dre';
export default function Financeiro({ aba: inicial }: { aba?: AbaFinanceiro } = {}) {
  const [aba, setAba] = useState<AbaFinanceiro>(inicial ?? 'painel');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Financeiro</h1><p className="muted">Faturamento gera contas a receber; NF-e de entrada gera contas a pagar. Baixa, Pix, conciliação e DRE.</p></div></div>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        {([['painel', 'Painel'], ['RECEBER', 'A receber'], ['PAGAR', 'A pagar'], ['contas', 'Contas e conciliação'], ['dre', 'DRE']] as const).map(([a, l]) => <button key={a} className={`btn sm ${aba === a ? 'primary' : ''}`} onClick={() => setAba(a)}>{l}</button>)}
      </div>
      {aba === 'painel' && <Painel />}
      {(aba === 'RECEBER' || aba === 'PAGAR') && <Titulos key={aba} tipo={aba} />}
      {aba === 'contas' && <Contas />}
      {aba === 'dre' && <Dre />}
    </div>
  );
}

function Painel() {
  const st = useApi<any>('/erp/financeiro/painel');
  const Faixas = ({ t, a }: { t: string; a: any }) => <div className="card"><strong className="small">{t}</strong><table><tbody>{[['A vencer', a.aVencer], ['Até 30 dias', a.ate30], ['31 a 60', a.ate60], ['61 a 90', a.ate90], ['Mais de 90', a.mais90]].map(([l, v]) => <tr key={l}><td>{l}</td><td>{brl(v)}</td></tr>)}</tbody></table></div>;
  return (
    <Async state={st}>{(d) => (
      <>
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}><BotaoImprimir className="btn sm" montar={() => htmlTabela({ titulo: 'Painel financeiro', filtros: [`Saldo em contas ${brl(d.saldoCents)}`, `Menor saldo projetado (30 dias) ${brl(Math.min(...d.fluxo.map((f: any) => f.saldoCents)))}`],
          colunas: [{ titulo: 'Dia', valor: (f: any) => dt(f.data) }, { titulo: 'Entradas', valor: (f: any) => brl(f.entradasCents), dir: true }, { titulo: 'Saídas', valor: (f: any) => brl(f.saidasCents), dir: true }, { titulo: 'Saldo', valor: (f: any) => brl(f.saldoCents), dir: true }],
          linhas: d.fluxo.filter((f: any, i: number) => i === 0 || f.entradasCents || f.saidasCents),
          extras: [{ titulo: 'Saldo por conta', linhas: d.contas, colunas: [{ titulo: 'Conta', valor: (c: any) => c.nome }, { titulo: 'Saldo', valor: (c: any) => brl(c.saldoCents), dir: true }] },
            { titulo: 'A receber e a pagar por atraso', linhas: [['A vencer', 'aVencer'], ['Até 30 dias', 'ate30'], ['31 a 60', 'ate60'], ['61 a 90', 'ate90'], ['Mais de 90', 'mais90']], colunas: [{ titulo: 'Faixa', valor: (x: string[]) => x[0] }, { titulo: 'A receber', valor: (x: string[]) => brl(d.receber?.[x[1]]), dir: true }, { titulo: 'A pagar', valor: (x: string[]) => brl(d.pagar?.[x[1]]), dir: true }] }] })} /></div>
        <div className="grid g2">
          <div className={`card st-card ${classeStatus(statusSaldo(d.saldoCents))}`}><span className="muted small">Saldo em contas</span><h2>{brl(d.saldoCents)}</h2><div className="small">{d.contas.map((c: any) => `${c.nome}: ${brl(c.saldoCents)}`).join(' · ') || 'Cadastre uma conta em "Contas e conciliação"'}</div></div>
          <div className={`card st-card ${classeStatus(statusSaldo(Math.min(...d.fluxo.map((f: any) => f.saldoCents))))}`}><span className="muted small">Menor saldo projetado (30 dias)</span><h2>{brl(Math.min(...d.fluxo.map((f: any) => f.saldoCents)))}</h2></div>
          <Faixas t="A receber por atraso" a={d.receber} />
          <Faixas t="A pagar por atraso" a={d.pagar} />
        </div>
        <div className="card table-wrap" style={{ marginTop: 10 }}><strong className="small">Fluxo de caixa projetado</strong>
          <table><thead><tr><th>Dia</th><th>Entradas</th><th>Saídas</th><th>Saldo</th></tr></thead><tbody>{d.fluxo.filter((f: any, i: number) => i === 0 || f.entradasCents || f.saidasCents).map((f: any) => <tr key={f.data}><td>{dt(f.data)}</td><td>{brl(f.entradasCents)}</td><td>{brl(f.saidasCents)}</td><td style={{ color: f.saldoCents < 0 ? '#dc2626' : undefined }}>{brl(f.saldoCents)}</td></tr>)}</tbody></table></div>
      </>
    )}</Async>
  );
}

function Titulos({ tipo }: { tipo: 'RECEBER' | 'PAGAR' }) {
  const [filtro, setFiltro] = useState('ABERTOS');
  const [nat, setNat] = useState(''); // a pagar: '' todas | FORNECEDOR | CONTAS (água, luz, internet...)
  // v1.54.0: período (vencimento) para a lista e a impressão; v1.56.0: seletor padrão (abre em "Todos", como antes).
  const [per, setPer] = usePeriodo('todos');
  const l = useApi<any[]>(`/erp/financeiro/titulos?tipo=${tipo}&status=${filtro === 'TODOS' ? '' : filtro}${tipo === 'PAGAR' && nat ? `&natureza=${nat}` : ''}${per.de ? `&de=${per.de}` : ''}${per.ate ? `&ate=${per.ate}` : ''}`, [filtro, nat, per.de, per.ate]);
  const [novo, setNovo] = useState(false); const [baixar, setBaixar] = useState<string | null>(null); const [cats, setCats] = useState(false);
  return (
    <>
      <div className="row" style={{ marginBottom: 10, gap: 6 }}>
        <button className="btn primary" onClick={() => setNovo(true)}>+ {tipo === 'RECEBER' ? 'Conta a receber' : 'Conta a pagar'}</button>
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtro"><option value="ABERTOS">Em aberto</option><option value="PAGO">Pagos</option><option value="CANCELADO">Cancelados</option><option value="TODOS">Todos</option></select>
        <button className="btn" onClick={() => setCats(true)}>Categorias</button>
        {tipo === 'PAGAR' && ([['', 'Todas'], ['FORNECEDOR', 'Fornecedores'], ['CONTAS', 'Contas da empresa']] as const).map(([v, r]) => <button key={v} className={`btn sm ${nat === v ? 'primary' : ''}`} onClick={() => setNat(v)}>{r}</button>)}
      </div>
      <div className="row" style={{ marginBottom: 10, gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="small muted">Vencimento:</span><SeletorPeriodo valor={per} onChange={setPer} rotulo="Vencimento" rotuloDatas="Vencimento" opcoes={['todos', 'hoje', '7d', '30d', 'mes', 'personalizado']} />
        <button className="btn sm" disabled={!l.data?.length} onClick={() => imprimirLista(tipo, l.data ?? [], { de: per.de, ate: per.ate, filtro })}>🖨️ Imprimir lista</button>
      </div>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nada por aqui">{tipo === 'RECEBER' ? 'Pedidos faturados entram aqui sozinhos.' : 'NF-e de entrada lançadas entram aqui sozinhas.'}</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Vencimento</th><th>{tipo === 'RECEBER' ? 'Cliente' : 'Fornecedor / conta'}</th><th>Descrição</th><th>Valor</th><th>Saldo</th><th>Status</th><th></th></tr></thead>
          <tbody>{d.map((t) => <tr key={t.id}><td className={t.vencido ? 'st-problema' : undefined}>{dt(t.vencimento)}</td><td>{t.natureza && t.natureza !== 'FORNECEDOR' ? <span className="badge">{t.tipoConta ?? NATUREZA[t.natureza] ?? 'Conta'}</span> : t.parceiro ?? '—'}</td><td className="small">{t.descricao}</td><td>{brl(t.valorCents)}</td><td>{brl(t.saldoCents)}</td><td><StatusBadge status={statusTitulo(t)}>{t.vencido ? 'Vencido' : ST[t.status]}</StatusBadge></td><td><button className="btn sm" onClick={() => setBaixar(t.id)}>Abrir</button></td></tr>)}</tbody></table>
          <p className="small">Total em aberto: <b>{brl(d.reduce((a, t) => a + t.saldoCents, 0))}</b></p></div>
      )}</Async>
      {novo && <NovoTitulo tipo={tipo} onClose={() => setNovo(false)} onDone={() => { setNovo(false); l.reload(); }} />}
      {cats && <Categorias tipoInicial={tipo === 'RECEBER' ? 'RECEITA' : 'DESPESA'} onClose={() => setCats(false)} />}
      {baixar && <Titulo id={baixar} onClose={() => { setBaixar(null); l.reload(); }} />}
    </>
  );
}

function Titulo({ id, onClose }: { id: string; onClose: () => void }) {
  const st = useApi<any>(`/erp/financeiro/titulos/${id}`, [id]);
  const contas = useApi<any[]>('/erp/financeiro/contas');
  const [b, setB] = useState<any>(null); const [pix, setPix] = useState<string | null>(null);
  const { busy, run } = useAction(); const toast = useToast(); const { can } = useAuth();
  return (
    <Modal title="Título" onClose={onClose}>
      <Async state={st}>{(t) => {
        const v = b ?? { contaId: contas.data?.[0]?.id ?? '', valor: fromCents(t.saldoCents), juros: fromCents((t.encargosHoje?.multaCents ?? 0) + (t.encargosHoje?.jurosCents ?? 0)), desconto: '0,00', data: hojeIso(), forma: 'PIX' };
        return (
          <>
            <p className="small"><b>{t.descricao}</b> · vence {dt(t.vencimento)} · {brl(t.valorCents)} · pago {brl(t.pagoCents)} · {ST[t.status]}</p>
            {t.encargosHoje?.dias > 0 && <p className="small" style={{ color: '#dc2626' }}>{t.encargosHoje.dias} dias de atraso: multa {brl(t.encargosHoje.multaCents)} + juros {brl(t.encargosHoje.jurosCents)}</p>}
            {['EM_ABERTO', 'PARCIAL'].includes(t.status) && <div className="card">
              <div className="grid g2">
                <Field label="Conta"><select value={v.contaId} onChange={(e) => setB({ ...v, contaId: e.target.value })}>{(contas.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>
                <Field label="Data"><input type="date" value={v.data} onChange={(e) => setB({ ...v, data: e.target.value })} /></Field>
                <Field label="Valor principal (R$)"><input value={v.valor} onChange={(e) => setB({ ...v, valor: e.target.value })} inputMode="decimal" /></Field>
                <Field label="Forma"><select value={v.forma} onChange={(e) => setB({ ...v, forma: e.target.value })}>{['PIX', 'BOLETO', 'TED', 'DINHEIRO', 'CARTAO', 'CHEQUE'].map((x) => <option key={x}>{x}</option>)}</select></Field>
                <Field label="Juros/multa (R$)"><input value={v.juros} onChange={(e) => setB({ ...v, juros: e.target.value })} inputMode="decimal" /></Field>
                <Field label="Desconto (R$)"><input value={v.desconto} onChange={(e) => setB({ ...v, desconto: e.target.value })} inputMode="decimal" /></Field>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                {t.tipo === 'RECEBER' && <button className="btn ghost" onClick={async () => { const r = await run(() => get<any>(`/erp/financeiro/titulos/${id}/pix`)); if (r) setPix(r.codigo); }}>Pix copia-e-cola</button>}
                <button className="btn primary" disabled={busy || !v.contaId} onClick={async () => { if (await run(() => post(`/erp/financeiro/titulos/${id}/baixar`, { contaId: v.contaId, valorCents: toCents(v.valor), jurosCents: toCents(v.juros), descontoCents: toCents(v.desconto), data: v.data, forma: v.forma }), 'Baixa registrada')) { setB(null); st.reload(); } }}>Registrar {t.tipo === 'RECEBER' ? 'recebimento' : 'pagamento'}</button>
              </div>
              {pix && <div className="card small" style={{ wordBreak: 'break-all' }}>{pix} <button className="btn sm" onClick={() => { navigator.clipboard.writeText(pix); toast('Copiado'); }}>Copiar</button></div>}
            </div>}
            {t.baixas.length > 0 && <table style={{ marginTop: 8 }}><thead><tr><th>Data</th><th>Principal</th><th>Juros</th><th>Desconto</th><th>Forma</th><th></th></tr></thead><tbody>{t.baixas.map((x: any) => <tr key={x.id} style={{ opacity: x.estornada ? 0.5 : 1 }}><td>{dt(x.data)}</td><td>{brl(x.valorCents)}</td><td>{brl(x.jurosCents)}</td><td>{brl(x.descontoCents)}</td><td>{x.forma}{x.estornada && ' · estornada'}</td><td>{!x.estornada && can('OWNER', 'ADMIN') && <button className="btn sm ghost" onClick={async () => { if (confirm('Estornar esta baixa?') && await run(() => post(`/erp/financeiro/baixas/${x.id}/estornar`, {}), 'Estornada')) st.reload(); }}>Estornar</button>}</td></tr>)}</tbody></table>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, gap: 6 }}>
              <BotaoImprimir title="Imprime a ficha do título com os dados salvos" montar={() => htmlFicha({ titulo: `${t.tipo === 'RECEBER' ? 'Conta a receber' : 'Conta a pagar'} · ${t.descricao}`, subtitulo: `vencimento ${dt(t.vencimento)}`,
                secoes: [{ campos: [['Descrição', t.descricao], [t.tipo === 'RECEBER' ? 'Cliente' : 'Fornecedor', t.parceiro?.nome], ['CPF/CNPJ', t.parceiro?.documento ? fmtDoc(t.parceiro.documento) : ''], ['Parcela', t.parcelas > 1 ? `${t.parcela}/${t.parcelas}` : ''],
                  ['Vencimento', dt(t.vencimento)], ['Valor', brl(t.valorCents)], ['Pago', brl(t.pagoCents)], ['Saldo', brl(Math.max(0, t.valorCents - t.pagoCents))], ['Status', ST[t.status] ?? t.status], ['Categoria', t.categoria?.nome ?? t.categoriaNome], ['Documento', t.documento]] }],
                tabelas: t.baixas.length ? [{ titulo: 'Baixas', linhas: t.baixas, colunas: [{ titulo: 'Data', valor: (x: any) => dt(x.data) }, { titulo: 'Forma', valor: (x: any) => FORMA_PG[x.forma] ?? x.forma }, { titulo: 'Conta', valor: (x: any) => x.contaNome }, { titulo: 'Principal', valor: (x: any) => brl(x.valorCents), dir: true }, { titulo: 'Juros', valor: (x: any) => brl(x.jurosCents), dir: true }, { titulo: 'Desconto', valor: (x: any) => brl(x.descontoCents), dir: true }, { titulo: 'Situação', valor: (x: any) => (x.estornada ? 'Estornada' : 'Válida') }] }] : [],
                observacoes: t.observacoes ?? '' })} />
            </div>
            {t.baixas.some((x: any) => !x.estornada) && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn" onClick={() => imprimirComprovante(t)}>🧾 {t.tipo === 'RECEBER' ? 'Recibo' : 'Comprovante'} de pagamento</button></div>}
            {t.pagoCents === 0 && t.status !== 'CANCELADO' && can('OWNER', 'ADMIN') && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn ghost" onClick={async () => { const motivo = prompt('Motivo do cancelamento'); if (motivo && await run(() => post(`/erp/financeiro/titulos/${id}/cancelar`, { motivo }), 'Cancelado')) st.reload(); }}>Cancelar título</button></div>}
          </>
        );
      }}</Async>
    </Modal>
  );
}

function Contas() {
  const l = useApi<any[]>('/erp/financeiro/contas');
  const [nova, setNova] = useState(false); const [conc, setConc] = useState<any>(null); const [transf, setTransf] = useState(false);
  const [f, setF] = useState<any>({ nome: '', tipo: 'BANCO', banco: '', agencia: '', conta: '', chavePix: '', saldo: '0,00' });
  const [t, setT] = useState<any>({ de: '', para: '', valor: '' });
  const { busy, run } = useAction(); const { can } = useAuth();
  return (
    <>
      <div className="row" style={{ marginBottom: 10, gap: 6 }}>{can('OWNER', 'ADMIN') && <button className="btn primary" onClick={() => setNova(true)}>+ Conta</button>}<button className="btn" onClick={() => setTransf(true)}>Transferir entre contas</button>
        <BotaoImprimir disabled={!l.data?.length} montar={() => htmlTabela({ titulo: 'Contas bancárias e caixas', linhas: l.data ?? [], total: `Saldo total ${brl((l.data ?? []).reduce((a, c) => a + (c.saldoCents ?? 0), 0))}`, colunas: [{ titulo: 'Conta', valor: (c: any) => c.nome }, { titulo: 'Tipo', valor: (c: any) => ({ BANCO: 'Banco', CAIXA: 'Caixa', CARTAO: 'Cartão' } as Record<string, string>)[c.tipo] ?? c.tipo }, { titulo: 'Banco', valor: (c: any) => c.banco }, { titulo: 'Agência', valor: (c: any) => c.agencia }, { titulo: 'Conta nº', valor: (c: any) => c.conta }, { titulo: 'Chave Pix', valor: (c: any) => c.chavePix }, { titulo: 'Saldo', valor: (c: any) => brl(c.saldoCents), dir: true }] })} /></div>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma conta">Cadastre o banco e o caixa da empresa. A chave Pix serve para gerar o Pix copia-e-cola das cobranças.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Conta</th><th>Banco</th><th>Saldo</th><th></th></tr></thead>
          <tbody>{d.map((c) => <tr key={c.id}><td>{c.nome}</td><td className="small">{[c.banco, c.agencia, c.conta].filter(Boolean).join(' · ') || c.tipo}</td><td>{brl(c.saldoCents)}</td><td className="row" style={{ gap: 4 }}><button className="btn sm" onClick={() => setConc(c)}>Extrato e conciliação</button><BotaoImprimir className="btn sm ghost" title="Ficha da conta" montar={() => htmlFicha({ titulo: `Conta · ${c.nome}`, secoes: [{ campos: [['Nome', c.nome], ['Tipo', ({ BANCO: 'Banco', CAIXA: 'Caixa', CARTAO: 'Cartão' } as Record<string, string>)[c.tipo] ?? c.tipo], ['Banco', c.banco], ['Agência', c.agencia], ['Conta', c.conta], ['Chave Pix', c.chavePix], ['Saldo atual', brl(c.saldoCents)]] }] })}>🖨️</BotaoImprimir></td></tr>)}</tbody></table></div>
      )}</Async>
      {nova && <Modal title="Nova conta" onClose={() => setNova(false)}>
        <div className="grid g2">
          <Field label="Nome"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Banco do Brasil PJ" /></Field>
          <Field label="Tipo"><select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}><option value="BANCO">Banco</option><option value="CAIXA">Caixa</option><option value="CARTAO">Cartão</option></select></Field>
          <Field label="Banco"><input value={f.banco} onChange={(e) => setF({ ...f, banco: e.target.value })} /></Field>
          <Field label="Agência"><input value={f.agencia} onChange={(e) => setF({ ...f, agencia: e.target.value })} /></Field>
          <Field label="Conta"><input value={f.conta} onChange={(e) => setF({ ...f, conta: e.target.value })} /></Field>
          <Field label="Chave Pix"><input value={f.chavePix} onChange={(e) => setF({ ...f, chavePix: e.target.value })} /></Field>
          <Field label="Saldo inicial (R$)"><input value={f.saldo} onChange={(e) => setF({ ...f, saldo: e.target.value })} inputMode="decimal" /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || f.nome.length < 2} onClick={async () => { if (await run(() => post('/erp/financeiro/contas', { nome: f.nome, tipo: f.tipo, banco: f.banco || null, agencia: f.agencia || null, conta: f.conta || null, chavePix: f.chavePix || null, saldoInicialCents: toCents(f.saldo) }), 'Conta criada')) { setNova(false); l.reload(); } }}>Salvar</button></div>
      </Modal>}
      {transf && <Modal title="Transferência entre contas" onClose={() => setTransf(false)}>
        <div className="grid g2">
          <Field label="De"><select value={t.de} onChange={(e) => setT({ ...t, de: e.target.value })}><option value="">—</option>{(l.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>
          <Field label="Para"><select value={t.para} onChange={(e) => setT({ ...t, para: e.target.value })}><option value="">—</option>{(l.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>
          <Field label="Valor (R$)"><input value={t.valor} onChange={(e) => setT({ ...t, valor: e.target.value })} inputMode="decimal" /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || !t.de || !t.para || toCents(t.valor) <= 0} onClick={async () => { if (await run(() => post('/erp/financeiro/transferencias', { deContaId: t.de, paraContaId: t.para, valorCents: toCents(t.valor) }), 'Transferido')) { setTransf(false); l.reload(); } }}>Transferir</button></div>
      </Modal>}
      {conc && <Conciliacao conta={conc} onClose={() => { setConc(null); l.reload(); }} />}
    </>
  );
}

function Conciliacao({ conta, onClose }: { conta: any; onClose: () => void }) {
  const st = useApi<any>(`/erp/financeiro/contas/${conta.id}/conciliacao`, [conta.id]);
  const { busy, run } = useAction();
  async function importar(file: File) { const ofx = await file.text(); const r = await run(() => post<any>(`/erp/financeiro/contas/${conta.id}/ofx`, { ofx })); if (r) { alert(`${r.lidas} lançamentos lidos, ${r.novas} novos.`); st.reload(); } }
  return (
    <Modal title={`Conciliação · ${conta.nome}`} onClose={onClose}>
      <label className="btn sm">Importar extrato OFX<input type="file" accept=".ofx,.OFX" hidden onChange={(e) => e.target.files?.[0] && importar(e.target.files[0])} /></label>
      <Async state={st}>{(c) => {
        const L = new Map(c.lancamentos.map((l: any) => [l.id, l]));
        const sug = new Map(c.sugestoes.map((s: any) => [s.extratoId, s.lancamentoId]));
        return c.extrato.length === 0 ? <p className="small muted">Nenhuma linha de extrato pendente. Baixe o OFX no internet banking e importe aqui.</p> : (
          <>
            <table style={{ marginTop: 8 }}><thead><tr><th>Data</th><th>Extrato</th><th>Valor</th><th>Casa com</th><th></th></tr></thead><tbody>{c.extrato.map((e: any) => { const l: any = L.get(sug.get(e.id) as string); return <tr key={e.id}><td>{dt(e.data)}</td><td className="small">{e.descricao}</td><td>{brl(e.valorCents)}</td><td className="small">{l ? `${dt(l.data)} · ${l.descricao}` : <span className="muted">sem par</span>}</td>
              <td>{l ? <button className="btn sm" disabled={busy} onClick={async () => { if (await run(() => post('/erp/financeiro/conciliar', { pares: [{ extratoId: e.id, lancamentoId: l.id }] }), 'Conciliado')) st.reload(); }}>Conciliar</button> : <button className="btn sm ghost" disabled={busy} onClick={async () => { const d = prompt('Descrição do lançamento', e.descricao); if (d && await run(() => post('/erp/financeiro/conciliar', { pares: [{ extratoId: e.id, criar: { descricao: d } }] }), 'Lançado e conciliado')) st.reload(); }}>Lançar</button>}</td></tr>; })}</tbody></table>
            {c.sugestoes.length > 1 && <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => post('/erp/financeiro/conciliar', { pares: c.sugestoes }), 'Sugestões conciliadas')) st.reload(); }}>Conciliar todas as sugestões ({c.sugestoes.length})</button></div>}
          </>
        );
      }}</Async>
    </Modal>
  );
}

function Dre() {
  // v1.56.0: seletor de período padrão (abre no mês atual, como antes).
  const [per, setPer] = usePeriodo('mes');
  const [regime, setRegime] = useState('competencia');
  const p = { de: per.de, ate: per.ate, regime };
  const st = useApi<any>(`/erp/financeiro/dre?de=${p.de}&ate=${p.ate}&regime=${p.regime}`, [p.de, p.ate, p.regime]);
  const linhas: [string, string, boolean?][] = [['RECEITA_BRUTA', 'Receita bruta'], ['DEDUCAO', '(−) Deduções'], ['receitaLiquida', 'Receita líquida', true], ['CUSTO', '(−) Custos'], ['lucroBruto', 'Lucro bruto', true], ['OPERACIONAL', '(−) Despesas operacionais'], ['resultadoOperacional', 'Resultado operacional', true], ['FINANCEIRA', '(±) Resultado financeiro'], ['resultadoAntesImpostos', 'Resultado antes dos impostos', true], ['IMPOSTO', '(−) IRPJ e CSLL'], ['resultadoLiquido', 'Resultado líquido', true]];
  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <SeletorPeriodo valor={per} onChange={setPer} />
        <select value={regime} onChange={(e) => setRegime(e.target.value)} aria-label="Regime"><option value="competencia">Competência</option><option value="caixa">Caixa</option></select>
        <BotaoImprimir disabled={!st.data} montar={() => htmlTabela({ titulo: 'DRE gerencial', filtros: [`Período: ${fmt.dia(p.de)} a ${fmt.dia(p.ate)}`, p.regime === 'caixa' ? 'Regime de caixa' : 'Regime de competência'], linhas, colunas: [{ titulo: 'Linha', valor: (x: [string, string, boolean?]) => (x[2] ? `= ${x[1]}` : x[1]) }, { titulo: 'Valor', valor: (x: [string, string, boolean?]) => brl(st.data?.[x[0]]), dir: true }] })} />
      </div>
      <Async state={st}>{(d) => <div className="card"><table><tbody>{linhas.map(([k, l, tot]) => <tr key={k} style={{ fontWeight: tot ? 700 : 400 }}><td>{l}</td><td style={{ textAlign: 'right', color: d[k] < 0 ? '#dc2626' : undefined }}>{brl(d[k])}</td></tr>)}</tbody></table><p className="small muted">DRE gerencial pelo plano de contas. Lançamentos sem categoria entram como receita bruta (recebimentos) ou despesa operacional (pagamentos).</p></div>}</Async>
    </>
  );
}

// v1.54.0: impressões do financeiro com o cabeçalho da empresa e o rodapé da MCK.
const FORMA_PG: Record<string, string> = { PIX: 'Pix', BOLETO: 'Boleto', TED: 'Transferência', DINHEIRO: 'Dinheiro', CARTAO: 'Cartão', CHEQUE: 'Cheque' };
const avisar = (e: unknown) => alert((e as Error).message);

/** Recibo (a receber) ou comprovante (a pagar) das baixas não estornadas. */
function imprimirComprovante(t: any) {
  const receber = t.tipo === 'RECEBER';
  const baixas = t.baixas.filter((x: any) => !x.estornada);
  const totalPago = baixas.reduce((a: number, x: any) => a + x.valorCents + (x.jurosCents ?? 0) - (x.descontoCents ?? 0), 0);
  const titulo = receber ? 'Recibo de pagamento' : 'Comprovante de pagamento';
  const quem = t.parceiro?.nome ?? '—';
  imprimir(() => ({
    titulo, subtitulo: `Título: ${t.descricao}${t.parcelas > 1 ? ` · parcela ${t.parcela}/${t.parcelas}` : ''} · vencimento ${dt(t.vencimento)}`,
    corpo: `<p>${receber ? 'Recebemos de' : 'Pago a'} <b>${esc(quem)}</b>${t.parceiro?.documento ? ` (${esc(fmtDoc(t.parceiro.documento))})` : ''} a quantia de <b>${brl(totalPago)}</b>, referente a ${esc(t.descricao)}.</p>
      <table><thead><tr><th>Data</th><th>Forma</th><th>Conta</th><th class="dir">Principal</th><th class="dir">Juros/multa</th><th class="dir">Desconto</th></tr></thead><tbody>${baixas.map((x: any) => `<tr><td>${esc(dt(x.data))}</td><td>${esc(FORMA_PG[x.forma] ?? x.forma)}</td><td>${esc(x.contaNome ?? '')}</td><td class="dir">${brl(x.valorCents)}</td><td class="dir">${brl(x.jurosCents)}</td><td class="dir">${brl(x.descontoCents)}</td></tr>`).join('')}</tbody></table>
      <div class="tot">Valor do título ${brl(t.valorCents)} · Pago ${brl(t.pagoCents)} · Saldo ${brl(Math.max(0, t.valorCents - t.pagoCents))}<br><b>${t.status === 'PAGO' ? 'Quitado' : 'Pagamento parcial'}</b></div>
      <p style="margin-top:40px;text-align:center">______________________________________<br>${receber ? 'Assinatura de quem recebeu' : 'Assinatura'}</p>`,
  }), 'width=800,height=900').catch(avisar);
}

/** Lista de contas a receber/pagar do filtro e período da tela. */
function imprimirLista(tipo: 'RECEBER' | 'PAGAR', d: any[], f: { de: string; ate: string; filtro: string }) {
  const nomeTipo = tipo === 'RECEBER' ? 'Contas a receber' : 'Contas a pagar';
  const periodo = f.de || f.ate ? `Vencimento ${f.de ? `de ${f.de.split('-').reverse().join('/')}` : ''} ${f.ate ? `até ${f.ate.split('-').reverse().join('/')}` : ''}` : 'Todos os vencimentos';
  const filtro = { ABERTOS: 'em aberto', PAGO: 'pagos', CANCELADO: 'cancelados', TODOS: 'todos' }[f.filtro] ?? '';
  imprimir(() => ({
    titulo: nomeTipo, subtitulo: linhaFiltros([periodo, filtro, `${d.length} título(s)`]),
    corpo: `<table><thead><tr><th>Vencimento</th><th>${tipo === 'RECEBER' ? 'Cliente' : 'Fornecedor / conta'}</th><th>Descrição</th><th class="dir">Valor</th><th class="dir">Saldo</th><th>Status</th></tr></thead><tbody>${d.map((t) => `<tr><td>${esc(dt(t.vencimento))}${t.vencido ? ' ⚠' : ''}</td><td>${esc(t.natureza && t.natureza !== 'FORNECEDOR' ? (t.tipoConta ?? NATUREZA[t.natureza] ?? 'Conta') : (t.parceiro ?? '—'))}</td><td>${esc(t.descricao)}</td><td class="dir">${brl(t.valorCents)}</td><td class="dir">${brl(t.saldoCents)}</td><td>${esc(ST[t.status] ?? t.status)}</td></tr>`).join('')}</tbody></table>
      <div class="tot">Total ${brl(d.reduce((a, t) => a + t.valorCents, 0))} · <b>Saldo em aberto ${brl(d.reduce((a, t) => a + t.saldoCents, 0))}</b></div>${d.some((t) => t.vencido) ? '<div class="small">⚠ vencido</div>' : ''}`,
  })).catch(avisar);
}
