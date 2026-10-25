import { Link } from 'react-router-dom';
import { useApi, Async, fmtNum, fmtDate, fmtDuration, StatusBadge, Empty } from '../ui';

function Stat({ label, value, sub, to }: { label: string; value: string; sub?: string; to?: string }) {
  const inner = <div className="card stat"><div className="l">{label}</div><div className="v">{value}</div>{sub && <div className="small muted">{sub}</div>}</div>;
  return to ? <Link to={to} style={{ color: 'inherit', textDecoration: 'none' }}>{inner}</Link> : inner;
}

export default function Dashboard() {
  const state = useApi<any>('/dashboard');
  return (
    <>
      <div className="page-head">
        <div><h1>Visão geral</h1><p className="muted">Indicadores calculados em tempo real a partir do banco de dados.</p></div>
        <button className="btn" onClick={state.reload} disabled={state.loading}>{state.loading ? 'Atualizando…' : 'Atualizar'}</button>
      </div>
      <Async state={state}>{(d) => (
        <div className="stack">
          <div className="grid g4">
            <Stat label="Conversas abertas" value={fmtNum(d.conversations.open)} to="/inbox" />
            <Stat label="Aguardando humano" value={fmtNum(d.conversations.pending)} sub="Transferidas pelo robô/IA" to="/inbox" />
            <Stat label="Conversas encerradas" value={fmtNum(d.conversations.closed)} />
            <Stat label="Contatos" value={fmtNum(d.contacts)} to="/contatos" />
            <Stat label="Mensagens recebidas (24h)" value={fmtNum(d.messages.receivedToday)} sub={`${fmtNum(d.messages.received7d)} em 7 dias`} />
            <Stat label="Mensagens enviadas (24h)" value={fmtNum(d.messages.sentToday)} sub={`${fmtNum(d.messages.sent7d)} em 7 dias · ${fmtNum(d.messages.failed7d)} falharam`} />
            <Stat label="Fluxos ativos" value={`${d.flows.active}/${d.flows.total}`} to="/fluxos" />
            <Stat label="Sucesso das execuções (7d)" value={d.runs7d.successRate === null ? '—' : `${d.runs7d.successRate}%`} sub={`${d.runs7d.completed} concluídas · ${d.runs7d.handoff} transferidas · ${d.runs7d.failed} falhas`} />
          </div>
          <div className="grid g3">
            <div className="card">
              <h2>Status das integrações</h2>
              <div className="stack">
                {d.integrations.whatsapp.length === 0 && <div className="row between"><span>WhatsApp Cloud API</span><span className="badge">Não conectado</span></div>}
                {d.integrations.whatsapp.map((c: any) => (
                  <div key={c.id} className="row between"><span>WhatsApp · {c.name}{c.displayPhone ? ` (${c.displayPhone})` : ''}</span><StatusBadge status={c.status} /></div>
                ))}
                <div className="row between"><span>IA ({d.integrations.ai.provider ?? '—'})</span>
                  <span className={`badge ${d.integrations.ai.enabled && d.integrations.ai.configured ? 'green' : ''}`}>{!d.integrations.ai.configured ? 'Sem chave' : d.integrations.ai.enabled ? 'Ativa' : 'Desativada'}</span></div>
                {d.integrations.partners.map((p: any) => (
                  <div key={p.id} className="row between"><span>{p.name}</span><span className={`badge ${p.lastTestStatus === 'ok' ? 'green' : p.lastTestStatus ? 'red' : ''}`}>{p.lastTestStatus ?? 'Não testada'}</span></div>
                ))}
                <Link to="/canais" className="small">Gerenciar canais →</Link>
              </div>
            </div>
            <div className="card">
              <h2>Uso de IA (30 dias)</h2>
              <div className="stack">
                <div className="row between"><span>Requisições</span><strong>{fmtNum(d.aiUsage30d.requests)}</strong></div>
                <div className="row between"><span>Erros</span><strong>{fmtNum(d.aiUsage30d.errors)}</strong></div>
                <div className="row between"><span>Tokens</span><strong>{fmtNum(d.aiUsage30d.tokens)}</strong></div>
                <div className="row between"><span>1ª resposta média (7d)</span><strong>{fmtDuration(d.avgFirstResponseSeconds)}</strong></div>
              </div>
            </div>
            <div className="card">
              <h2>Falhas recentes</h2>
              {d.recentFailures.runs.length === 0 && d.recentFailures.messages.length === 0 && <Empty title="Nenhuma falha registrada" />}
              <div className="stack">
                {d.recentFailures.runs.map((r: any) => (
                  <div key={r.id} className="small"><Link to={`/inbox/${r.conversationId}`}><strong>{r.flowName}</strong></Link> · {fmtDate(r.updatedAt)}<div className="muted">{r.error}</div></div>
                ))}
                {d.recentFailures.messages.map((m: any) => (
                  <div key={m.id} className="small"><Link to={`/inbox/${m.conversationId}`}>Mensagem não enviada</Link> · {fmtDate(m.createdAt)}<div className="muted">{m.error}</div></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}</Async>
    </>
  );
}
