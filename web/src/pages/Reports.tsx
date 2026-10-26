import { useState } from 'react';
import { useApi, Async, fmtNum, fmtDuration, Empty, StatusBadge } from '../ui';

function Bars({ series, keys }: { series: any[]; keys: { k: string; color: string; label: string }[] }) {
  const max = Math.max(1, ...series.map((s) => keys.reduce((a, k) => a + s[k.k], 0)));
  return (
    <>
      <div className="chart" role="img" aria-label="Gráfico diário">
        {series.map((s) => (
          <div key={s.date} className="c" title={`${s.date.split('-').reverse().join('/')}: ${keys.map((k) => `${k.label} ${s[k.k]}`).join(', ')}`}>
            {keys.map((k) => <span key={k.k} style={{ height: `${(s[k.k] / max) * 130}px`, background: k.color }} />)}
          </div>
        ))}
      </div>
      <div className="row small muted" style={{ marginTop: 6 }}>{keys.map((k) => <span key={k.k} className="row"><span style={{ width: 10, height: 10, background: k.color, borderRadius: 2, display: 'inline-block' }} />{k.label}</span>)}</div>
    </>
  );
}

export default function Reports() {
  const [days, setDays] = useState(30);
  const state = useApi<any>(`/reports?days=${days}`, [days]);
  return (
    <>
      <div className="page-head">
        <div><h1>Relatórios</h1><p className="muted">Volumes, desempenho de fluxos, IA, funil e equipe — calculados a partir do banco.</p></div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 160 }} aria-label="Período"><option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option><option value={90}>Últimos 90 dias</option></select>
      </div>
      <Async state={state}>{(r) => (
        <div className="stack">
          <div className="grid g4">
            <div className="card stat"><div className="l">Mensagens recebidas</div><div className="v">{fmtNum(r.totals.received)}</div></div>
            <div className="card stat"><div className="l">Mensagens enviadas</div><div className="v">{fmtNum(r.totals.sent)}</div><div className="small muted">robô {r.totals.sentByBot} · IA {r.totals.sentByAi} · equipe {r.totals.sentByAgents} · falhas {r.totals.failed}</div></div>
            <div className="card stat"><div className="l">Novas conversas</div><div className="v">{fmtNum(r.totals.newConversations)}</div><div className="small muted">{r.totals.closedConversations} encerradas · {r.totals.handedToHuman} com humano</div></div>
            <div className="card stat"><div className="l">Tempo médio da 1ª resposta</div><div className="v">{fmtDuration(r.totals.avgFirstResponseSeconds)}</div></div>
          </div>
          <div className="grid g2">
            <div className="card"><h2>Mensagens por dia</h2><Bars series={r.series} keys={[{ k: 'received', color: '#94a3b8', label: 'Recebidas' }, { k: 'sent', color: '#d90429', label: 'Enviadas' }, { k: 'failed', color: '#d64545', label: 'Falhas' }]} /></div>
            <div className="card"><h2>Conversas por dia</h2><Bars series={r.series} keys={[{ k: 'newConversations', color: '#2f6fde', label: 'Novas' }, { k: 'closed', color: '#0b7a5a', label: 'Encerradas' }]} /></div>
          </div>
          <div className="card table-wrap">
            <h2>Desempenho dos fluxos</h2>
            {r.flows.length === 0 ? <Empty title="Nenhum fluxo" /> : (
              <table><thead><tr><th>Fluxo</th><th>Status</th><th>Execuções</th><th>Concluídas</th><th>Transferidas</th><th>Falhas</th><th>Sucesso</th></tr></thead>
                <tbody>{r.flows.map((f: any) => <tr key={f.id}><td>{f.name}</td><td><StatusBadge status={f.status} /></td><td>{f.total}</td><td>{f.completed}</td><td>{f.handoff}</td><td>{f.failed}</td><td>{f.successRate === null ? '—' : `${f.successRate}%`}</td></tr>)}</tbody></table>
            )}
            <p className="small muted">Sucesso = (concluídas + transferidas conforme o fluxo) ÷ execuções finalizadas.</p>
          </div>
          <div className="grid g3">
            <div className="card"><h2>Funil (Kanban)</h2>
              <div className="stack">{(() => { const max = Math.max(1, ...r.funnel.map((s: any) => s.count)); return r.funnel.map((s: any) => (
                <div key={s.id ?? 'none'}><div className="row between small"><span>{s.name}</span><strong>{s.count}</strong></div><div className="bar"><span style={{ width: `${(s.count / max) * 100}%`, background: s.color }} /></div></div>
              )); })()}</div>
            </div>
            <div className="card"><h2>IA no período</h2>
              <div className="stack">
                <div className="row between"><span>Requisições</span><strong>{fmtNum(r.ai.requests)}</strong></div>
                <div className="row between"><span>Transferências</span><strong>{fmtNum(r.ai.handoffs)}</strong></div>
                <div className="row between"><span>Erros</span><strong>{fmtNum(r.ai.errors)}</strong></div>
                <div className="row between"><span>Tokens</span><strong>{fmtNum(r.ai.tokens)}</strong></div>
              </div>
            </div>
            <div className="card"><h2>Equipe</h2>
              <table className="small"><thead><tr><th>Pessoa</th><th>Mensagens enviadas</th></tr></thead><tbody>{r.agents.map((a: any) => <tr key={a.id}><td>{a.name}</td><td>{a.sent}</td></tr>)}</tbody></table>
            </div>
          </div>
        </div>
      )}</Async>
    </>
  );
}
