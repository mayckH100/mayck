/** BI: o negócio no período em uma tela (vendas, margem, ABC, estoque, compras, produção, financeiro, CRM) e CSV. */
import { useState } from 'react';
import { useApi, Async } from '../../ui';
import ErpNav from '../ErpNav';
import { brl, qtd } from '../format';

const pct = (bp: number) => `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const iso = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);

function Kpi({ t, v, s }: { t: string; v: string; s?: string }) {
  return <div className="card"><span className="muted small">{t}</span><h2 style={{ margin: '4px 0' }}>{v}</h2>{s && <span className="small">{s}</span>}</div>;
}

export default function Bi() {
  const [p, setP] = useState({ de: iso(new Date(Date.now() - 29 * 86_400_000)), ate: iso(new Date()) });
  const st = useApi<any>(`/erp/bi/resumo?de=${p.de}&ate=${p.ate}`, [p.de, p.ate]);
  const baixar = async (tipo: string) => { const r = await fetch(`/api/erp/bi/exportar?tipo=${tipo}&de=${p.de}&ate=${p.ate}`, { credentials: 'same-origin' }); const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `bi-${tipo}-${p.de}-${p.ate}.csv`; a.click(); };
  return (
    <div className="page">
      <div className="page-head"><div><h1>BI</h1><p className="muted">Vendas pela data do faturamento. Margem pelo custo médio da baixa de estoque.</p></div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input type="date" value={p.de} onChange={(e) => setP({ ...p, de: e.target.value })} aria-label="De" />
          <input type="date" value={p.ate} onChange={(e) => setP({ ...p, ate: e.target.value })} aria-label="Até" />
          <button className="btn sm" onClick={() => baixar('pedidos')}>CSV pedidos</button><button className="btn sm" onClick={() => baixar('produtos')}>CSV produtos</button>
        </div></div>
      <ErpNav />
      <Async state={st}>{(d) => {
        const max = Math.max(1, ...d.vendas.serie.map((x: any) => x.valorCents));
        return <>
          <div className="grid g2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
            <Kpi t="Receita" v={brl(d.vendas.receitaCents)} s={`${d.vendas.pedidos} pedidos · ticket ${brl(d.vendas.ticketMedioCents)}`} />
            <Kpi t="Margem bruta" v={pct(d.vendas.margemBrutaBp)} s={`${brl(d.vendas.margemBrutaCents)} · CMV ${brl(d.vendas.cmvCents)}`} />
            <Kpi t="Estoque" v={brl(d.estoque.valorCents)} s={d.estoque.coberturaDias !== null ? `cobertura ${d.estoque.coberturaDias} dias` : 'sem venda no período'} />
            <Kpi t="Inadimplência" v={pct(d.financeiro.inadimplenciaBp)} s={`vencido ${brl(d.financeiro.receberVencidoCents)} de ${brl(d.financeiro.receberAbertoCents)}`} />
            <Kpi t="A pagar em 7 dias" v={brl(d.financeiro.pagarProximos7DiasCents)} />
            <Kpi t="Compras" v={brl(d.compras.totalCents)} s={`${d.compras.pedidos} pedidos`} />
            <Kpi t="Produção" v={`${d.producao.opsEncerradas} OPs`} s={`refugo ${pct(d.producao.refugoBp)} · ${d.producao.opsAbertas} abertas`} />
            <Kpi t="CRM" v={brl(d.crm.pipelineCents)} s={`${d.crm.abertas} abertas · conversão ${pct(d.crm.conversaoBp)}`} />
          </div>
          <div className="card" style={{ marginTop: 10 }}><strong className="small">Receita por dia</strong>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120, marginTop: 8 }}>{d.vendas.serie.map((x: any) => <div key={x.data} title={`${x.data.split('-').reverse().join('/')}: ${brl(x.valorCents)}`} style={{ flex: 1, height: `${Math.max(2, (x.valorCents / max) * 100)}%`, background: x.valorCents ? 'var(--accent, #2563eb)' : '#e5e7eb', borderRadius: 2 }} />)}</div>
          </div>
          <div className="grid g2" style={{ marginTop: 10 }}>
            <div className="card table-wrap"><strong className="small">Curva ABC · A {d.vendas.contagemAbc.A} · B {d.vendas.contagemAbc.B} · C {d.vendas.contagemAbc.C}</strong>
              <table><thead><tr><th>Produto</th><th>Classe</th><th>Venda</th><th>Margem</th><th>Acum.</th></tr></thead><tbody>{d.vendas.curvaAbc.slice(0, 15).map((x: any) => <tr key={x.id}><td>{x.sku} · {x.nome}</td><td><b>{x.classe}</b></td><td>{brl(x.valorCents)}</td><td>{brl(x.margemCents)}</td><td>{(x.acumulado * 100).toFixed(0)}%</td></tr>)}</tbody></table></div>
            <div className="card table-wrap"><strong className="small">Maiores clientes</strong>
              <table><tbody>{d.vendas.topClientes.map((c: any) => <tr key={c.id}><td>{c.nome}</td><td>{brl(c.valorCents)}</td><td>{pct(c.participacaoBp)}</td></tr>)}</tbody></table></div>
            <div className="card table-wrap"><strong className="small">Abaixo do mínimo ({d.estoque.qtdAbaixoMinimo})</strong>
              <table><tbody>{d.estoque.abaixoMinimo.map((x: any) => <tr key={x.id}><td>{x.sku} · {x.nome}</td><td>{qtd(x.saldoMil)} de {qtd(x.minimoMil)}</td></tr>)}</tbody></table></div>
            <div className="card table-wrap"><strong className="small">Vencendo em 30 dias · {brl(d.estoque.valorVencendoCents)}</strong>
              <table><tbody>{d.estoque.vencendo30Dias.map((x: any) => <tr key={x.lote + x.sku}><td>{x.sku} · lote {x.lote}</td><td>{new Date(x.validade).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</td><td>{qtd(x.qtdMil)}</td></tr>)}</tbody></table></div>
            <div className="card table-wrap"><strong className="small">Maiores fornecedores</strong>
              <table><tbody>{d.compras.topFornecedores.map((f: any) => <tr key={f.id}><td>{f.nome}</td><td>{brl(f.valorCents)}</td></tr>)}</tbody></table></div>
          </div>
        </>;
      }}</Async>
    </div>
  );
}
