import { NavLink } from 'react-router-dom';
import { useApi, Async, fmtNum } from '../../ui';
import { LEAD_STATUS, LEAD_STATUS_COLOR, LEAD_STATUS_LABEL, CampaignBadge, campaignProgress, type Campaign, type Metrics } from '../common';

const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="card mm-kpi"><div className="l">{label}</div><div className="v">{value}</div>{sub && <div className="s">{sub}</div>}</div>;
}

export function MetricsView({ m }: { m: Metrics }) {
  const max = Math.max(1, ...LEAD_STATUS.map((s) => m.byStatus[s] ?? 0));
  return (
    <>
      <div className="grid g4">
        <Kpi label="Contatos" value={fmtNum(m.totalLeads)} sub={`${fmtNum(m.optOuts)} pediram para sair`} />
        <Kpi label="Mensagens enviadas" value={fmtNum(m.sent)} sub={m.failed ? `${fmtNum(m.failed)} falharam` : 'Nenhuma falha'} />
        <Kpi label="Taxa de resposta" value={pct(m.responseRate)} sub={`${fmtNum(m.replies)} responderam`} />
        <Kpi label="Taxa de conversão" value={pct(m.conversionRate)} sub={`${fmtNum(m.byStatus.CONVERTIDO ?? 0)} convertidos`} />
      </div>
      <div className="card">
        <h2>Contatos por status</h2>
        <div className="mm-funnel">
          {LEAD_STATUS.map((s) => {
            const v = m.byStatus[s] ?? 0;
            return (
              <div className="r" key={s}>
                <span>{LEAD_STATUS_LABEL[s]}</span>
                <div className="bar" style={{ height: 12 }}><span style={{ width: `${(v / max) * 100}%`, background: LEAD_STATUS_COLOR[s] }} /></div>
                <strong style={{ textAlign: 'right' }}>{fmtNum(v)}</strong>
              </div>
            );
          })}
        </div>
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>As taxas consideram os contatos já alcançados (contatados, que responderam e convertidos).</p>
      </div>
    </>
  );
}

export default function MmDashboard() {
  const metrics = useApi<Metrics>('/mckmensagem/metrics');
  const camps = useApi<Campaign[]>('/mckmensagem/campaigns');
  const active = (camps.data ?? []).filter((c) => c.status === 'EM_ANDAMENTO' || c.status === 'AGENDADA');
  return (
    <>
      <div className="page-head">
        <div><h1>Painel</h1><p className="muted">Resultados das suas campanhas e da base de contatos.</p></div>
        <div className="row">
          <NavLink to="/contatos" className="btn">Importar contatos</NavLink>
          <NavLink to="/campanhas?nova=1" className="btn primary" style={{ color: '#fff' }}>+ Nova campanha</NavLink>
        </div>
      </div>
      <div className="stack">
        <Async state={metrics}>{(m) => (
          <>
            <MetricsView m={m} />
            {m.totalLeads === 0 && (
              <div className="alert info">Comece adicionando contatos que autorizaram receber mensagens: cadastre um a um ou importe uma planilha CSV em <NavLink to="/contatos">Contatos</NavLink>.</div>
            )}
          </>
        )}</Async>
        <div className="card">
          <div className="row between" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Campanhas ativas <span className="badge">{active.length}</span></h2>
            <NavLink to="/campanhas" className="small">Ver todas →</NavLink>
          </div>
          <Async state={camps}>{() => active.length === 0
            ? <p className="muted" style={{ margin: 0 }}>Nenhuma campanha em andamento no momento.</p>
            : (
              <div className="stack">
                {active.map((c) => {
                  const p = campaignProgress(c);
                  return (
                    <NavLink key={c.id} to={`/campanhas/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                      <div className="row between"><strong>{c.name}</strong><CampaignBadge status={c.status} /></div>
                      <div className="bar" style={{ margin: '6px 0 4px' }}><span style={{ width: `${p.pct}%` }} /></div>
                      <div className="small muted">{fmtNum(p.sent)} enviadas · {fmtNum(p.pending)} na fila · {p.pct}% concluído</div>
                    </NavLink>
                  );
                })}
              </div>
            )}</Async>
        </div>
      </div>
    </>
  );
}
