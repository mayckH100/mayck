/** Aba Relatórios do ERP: relatório do dia (vendas, caixa, CMV e alterações sensíveis), baixar CSV e enviar ao proprietário. */
import { useState } from 'react';
import { post } from '../../api';
import { useApi, Async, useAction } from '../../ui';
import { useAuth } from '../../auth';
import { brl } from '../format';

const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

export default function RelatoriosErp() {
  const [dia, setDia] = useState(hoje());
  const state = useApi<any>(`/erp/relatorios/dia?data=${dia}`, [dia]);
  const { can } = useAuth();
  const { busy, run } = useAction();
  return (
    <>
      <div className="page-head">
        <div><h1>Relatórios</h1><p className="muted">Resumo do dia. Todo dia às 22h ele vai sozinho para o proprietário por WhatsApp e e-mail.</p></div>
        <div className="row" style={{ gap: 6 }}>
          <input type="date" value={dia} max={hoje()} onChange={(e) => e.target.value && setDia(e.target.value)} aria-label="Dia" />
          <a className="btn" href={`/api/erp/relatorios/dia.csv?data=${dia}`} download>Baixar (planilha)</a>
          {can('OWNER', 'ADMIN') && <button className="btn primary" disabled={busy} onClick={() => run(() => post(`/erp/relatorios/dia/enviar?data=${dia}`), 'Relatório enviado ao proprietário')}>Enviar agora</button>}
        </div>
      </div>
      <Async state={state}>{(r) => (
        <>
          <div className="grid g4" style={{ marginBottom: 12 }}>
            <div className="card"><div className="small muted">Vendido</div><h2>{brl(r.vendas.totalCents)}</h2><div className="small">{r.vendas.pedidos} pedido(s){r.vendas.balcao ? ` · ${r.vendas.balcao} no balcão` : ''}</div></div>
            <div className="card"><div className="small muted">Recebido</div><h2>{brl(r.recebidoCents)}</h2></div>
            <div className="card"><div className="small muted">Pago</div><h2>{brl(r.pagoCents)}</h2></div>
            <div className="card"><div className="small muted">CMV (custo do que saiu)</div><h2>{brl(r.cmvCents)}</h2></div>
          </div>
          {Object.keys(r.porForma).length > 0 && <div className="card table-wrap" style={{ marginBottom: 12 }}><table><thead><tr><th>Forma</th><th>Recebido</th><th>Pago</th></tr></thead><tbody>{Object.entries(r.porForma).map(([f, v]: any) => <tr key={f}><td>{f}</td><td>{brl(v.receber)}</td><td>{brl(v.pagar)}</td></tr>)}</tbody></table></div>}
          <div className="card table-wrap"><h3 style={{ marginTop: 0 }}>Alterações sensíveis</h3>
            {r.alteracoes.length === 0 ? <p className="muted small">Nenhuma alteração sensível neste dia.</p> : <table><thead><tr><th>Hora</th><th>Quem</th><th>Alteração</th><th>Antes</th><th>Depois</th></tr></thead><tbody>{r.alteracoes.map((a: any, i: number) => <tr key={i}><td>{a.hora}</td><td>{a.quem}</td><td>{a.acao}</td><td className="small"><code>{a.antes}</code></td><td className="small"><code>{a.depois}</code></td></tr>)}</tbody></table>}
          </div>
        </>
      )}</Async>
    </>
  );
}
