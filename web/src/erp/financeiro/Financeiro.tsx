/** Financeiro: painel (saldo, aging, fluxo), contas a receber/pagar com baixa e Pix, contas e conciliação OFX, DRE. */
import { useState } from 'react';
import { get, post } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, useToast } from '../../ui';
import ErpNav from '../ErpNav';
import { brl, toCents, fromCents } from '../format';
import { BuscaParceiro } from '../comum';

const ST: Record<string, string> = { EM_ABERTO: 'Em aberto', PARCIAL: 'Parcial', PAGO: 'Pago', CANCELADO: 'Cancelado' };
const dt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—');
const hojeIso = () => new Date().toISOString().slice(0, 10);

export default function Financeiro() {
  const [aba, setAba] = useState<'painel' | 'RECEBER' | 'PAGAR' | 'contas' | 'dre'>('painel');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Financeiro</h1><p className="muted">Faturamento gera contas a receber; NF-e de entrada gera contas a pagar. Baixa, Pix, conciliação e DRE.</p></div></div>
      <ErpNav />
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
        <div className="grid g2">
          <div className="card"><span className="muted small">Saldo em contas</span><h2>{brl(d.saldoCents)}</h2><div className="small">{d.contas.map((c: any) => `${c.nome}: ${brl(c.saldoCents)}`).join(' · ') || 'Cadastre uma conta em "Contas e conciliação"'}</div></div>
          <div className="card"><span className="muted small">Menor saldo projetado (30 dias)</span><h2>{brl(Math.min(...d.fluxo.map((f: any) => f.saldoCents)))}</h2></div>
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
  const l = useApi<any[]>(`/erp/financeiro/titulos?tipo=${tipo}&status=${filtro === 'TODOS' ? '' : filtro}${tipo === 'PAGAR' && nat ? `&natureza=${nat}` : ''}`, [filtro, nat]);
  const [novo, setNovo] = useState(false); const [baixar, setBaixar] = useState<string | null>(null);
  return (
    <>
      <div className="row" style={{ marginBottom: 10, gap: 6 }}>
        <button className="btn primary" onClick={() => setNovo(true)}>+ {tipo === 'RECEBER' ? 'Conta a receber' : 'Conta a pagar'}</button>
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtro"><option value="ABERTOS">Em aberto</option><option value="PAGO">Pagos</option><option value="CANCELADO">Cancelados</option><option value="TODOS">Todos</option></select>
        {tipo === 'PAGAR' && ([['', 'Todas'], ['FORNECEDOR', 'Fornecedores'], ['CONTAS', 'Contas da empresa']] as const).map(([v, r]) => <button key={v} className={`btn sm ${nat === v ? 'primary' : ''}`} onClick={() => setNat(v)}>{r}</button>)}
      </div>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nada por aqui">{tipo === 'RECEBER' ? 'Pedidos faturados entram aqui sozinhos.' : 'NF-e de entrada lançadas entram aqui sozinhas.'}</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Vencimento</th><th>{tipo === 'RECEBER' ? 'Cliente' : 'Fornecedor / conta'}</th><th>Descrição</th><th>Valor</th><th>Saldo</th><th>Status</th><th></th></tr></thead>
          <tbody>{d.map((t) => <tr key={t.id}><td style={{ color: t.vencido ? '#dc2626' : undefined }}>{dt(t.vencimento)}</td><td>{t.natureza && t.natureza !== 'FORNECEDOR' ? <span className="badge">{NATUREZA[t.natureza] ?? 'Conta'}</span> : t.parceiro ?? '—'}</td><td className="small">{t.descricao}</td><td>{brl(t.valorCents)}</td><td>{brl(t.saldoCents)}</td><td>{ST[t.status]}</td><td><button className="btn sm" onClick={() => setBaixar(t.id)}>Abrir</button></td></tr>)}</tbody></table>
          <p className="small">Total em aberto: <b>{brl(d.reduce((a, t) => a + t.saldoCents, 0))}</b></p></div>
      )}</Async>
      {novo && <NovoTitulo tipo={tipo} onClose={() => setNovo(false)} onDone={() => { setNovo(false); l.reload(); }} />}
      {baixar && <Titulo id={baixar} onClose={() => { setBaixar(null); l.reload(); }} />}
    </>
  );
}

const NATUREZA: Record<string, string> = { FORNECEDOR: 'Fornecedor', AGUA: 'Água', LUZ: 'Luz', INTERNET: 'Internet', TELEFONE: 'Telefone', ALUGUEL: 'Aluguel', IMPOSTO: 'Imposto', OUTRA_CONTA: 'Outra conta' };

function NovoTitulo({ tipo, onClose, onDone }: { tipo: string; onClose: () => void; onDone: () => void }) {
  const cats = useApi<any[]>('/erp/financeiro/categorias');
  const [f, setF] = useState<any>({ parceiro: null, descricao: '', valor: '', venc: hojeIso(), prazos: '0', categoriaId: '', natureza: 'FORNECEDOR' });
  const { busy, run } = useAction();
  return (
    <Modal title={tipo === 'RECEBER' ? 'Nova conta a receber' : 'Nova conta a pagar'} onClose={onClose}>
      {tipo === 'PAGAR' && <Field label="Tipo de conta"><select value={f.natureza} onChange={(e) => setF({ ...f, natureza: e.target.value, parceiro: e.target.value === 'FORNECEDOR' ? f.parceiro : null })}>{Object.entries(NATUREZA).map(([v, r]) => <option key={v} value={v}>{v === 'FORNECEDOR' ? 'Fornecedor' : `Conta da empresa: ${r}`}</option>)}</select></Field>}
      {(tipo === 'RECEBER' || f.natureza === 'FORNECEDOR') && <Field label={tipo === 'RECEBER' ? 'Cliente (opcional)' : 'Fornecedor (opcional)'}>{f.parceiro ? <div className="row between"><strong>{f.parceiro.fantasia || f.parceiro.nome}</strong><button className="btn ghost sm" onClick={() => setF({ ...f, parceiro: null })}>Trocar</button></div> : <BuscaParceiro tipo={tipo === 'RECEBER' ? 'cliente' : 'fornecedor'} placeholder={tipo === 'RECEBER' ? 'Cliente (nome ou CPF/CNPJ)' : 'Fornecedor (nome ou CNPJ)'} onPick={(p) => setF({ ...f, parceiro: p })} />}</Field>}
      <Field label="Descrição"><input value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} placeholder="Aluguel de novembro" /></Field>
      <div className="grid g2">
        <Field label="Valor total (R$)"><input value={f.valor} onChange={(e) => setF({ ...f, valor: e.target.value })} inputMode="decimal" /></Field>
        <Field label="1º vencimento"><input type="date" value={f.venc} onChange={(e) => setF({ ...f, venc: e.target.value })} /></Field>
        <Field label="Parcelas (dias após o 1º)" hint="0 = à vista; 0,30,60 = três parcelas"><input value={f.prazos} onChange={(e) => setF({ ...f, prazos: e.target.value })} /></Field>
        <Field label="Categoria"><select value={f.categoriaId} onChange={(e) => setF({ ...f, categoriaId: e.target.value })}><option value="">{tipo === 'PAGAR' ? 'Automática pelo tipo' : '—'}</option>{(cats.data ?? []).filter((c: any) => c.tipo === (tipo === 'RECEBER' ? 'RECEITA' : 'DESPESA')).map((c: any) => <option key={c.id} value={c.id}>{c.codigo} {c.nome}</option>)}</select></Field>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || f.descricao.length < 2 || toCents(f.valor) <= 0} onClick={async () => { if (await run(() => post('/erp/financeiro/titulos', { tipo, parceiroId: f.parceiro?.id ?? null, descricao: f.descricao, valorCents: toCents(f.valor), primeiroVencimento: f.venc, prazos: String(f.prazos).split(/[,;\s/]+/).filter(Boolean).map(Number).filter((n: number) => Number.isFinite(n)), categoriaId: f.categoriaId || null, ...(tipo === 'PAGAR' ? { natureza: f.natureza } : {}) }), 'Lançado')) onDone(); }}>Salvar</button></div>
    </Modal>
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
      <div className="row" style={{ marginBottom: 10, gap: 6 }}>{can('OWNER', 'ADMIN') && <button className="btn primary" onClick={() => setNova(true)}>+ Conta</button>}<button className="btn" onClick={() => setTransf(true)}>Transferir entre contas</button></div>
      <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma conta">Cadastre o banco e o caixa da empresa. A chave Pix serve para gerar o Pix copia-e-cola das cobranças.</Empty></div> : (
        <div className="card table-wrap"><table><thead><tr><th>Conta</th><th>Banco</th><th>Saldo</th><th></th></tr></thead>
          <tbody>{d.map((c) => <tr key={c.id}><td>{c.nome}</td><td className="small">{[c.banco, c.agencia, c.conta].filter(Boolean).join(' · ') || c.tipo}</td><td>{brl(c.saldoCents)}</td><td><button className="btn sm" onClick={() => setConc(c)}>Extrato e conciliação</button></td></tr>)}</tbody></table></div>
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
  const [p, setP] = useState({ de: new Date().toISOString().slice(0, 8) + '01', ate: hojeIso(), regime: 'competencia' });
  const st = useApi<any>(`/erp/financeiro/dre?de=${p.de}&ate=${p.ate}&regime=${p.regime}`, [p.de, p.ate, p.regime]);
  const linhas: [string, string, boolean?][] = [['RECEITA_BRUTA', 'Receita bruta'], ['DEDUCAO', '(−) Deduções'], ['receitaLiquida', 'Receita líquida', true], ['CUSTO', '(−) Custos'], ['lucroBruto', 'Lucro bruto', true], ['OPERACIONAL', '(−) Despesas operacionais'], ['resultadoOperacional', 'Resultado operacional', true], ['FINANCEIRA', '(±) Resultado financeiro'], ['resultadoAntesImpostos', 'Resultado antes dos impostos', true], ['IMPOSTO', '(−) IRPJ e CSLL'], ['resultadoLiquido', 'Resultado líquido', true]];
  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <input type="date" value={p.de} onChange={(e) => setP({ ...p, de: e.target.value })} aria-label="De" />
        <input type="date" value={p.ate} onChange={(e) => setP({ ...p, ate: e.target.value })} aria-label="Até" />
        <select value={p.regime} onChange={(e) => setP({ ...p, regime: e.target.value })} aria-label="Regime"><option value="competencia">Competência</option><option value="caixa">Caixa</option></select>
      </div>
      <Async state={st}>{(d) => <div className="card"><table><tbody>{linhas.map(([k, l, tot]) => <tr key={k} style={{ fontWeight: tot ? 700 : 400 }}><td>{l}</td><td style={{ textAlign: 'right', color: d[k] < 0 ? '#dc2626' : undefined }}>{brl(d[k])}</td></tr>)}</tbody></table><p className="small muted">DRE gerencial pelo plano de contas. Lançamentos sem categoria entram como receita bruta (recebimentos) ou despesa operacional (pagamentos).</p></div>}</Async>
    </>
  );
}
