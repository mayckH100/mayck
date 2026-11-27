/** Painel do CRM: KPIs e funil com filtros de período e filial. */
import { useState } from 'react';
import { useApi, Async } from '../../ui';
import { brl } from '../format';
import { Link, useNavigate } from 'react-router-dom';
import { SeletorPeriodo, usePeriodo } from '../SeletorPeriodo';
import { classeStatus, statusInadimplencia, statusScore, StatusBadge, ROTULO_FAIXA_SCORE, type StatusCor } from '../status';
import { useAuth } from '../../auth';
import { AvisoInventarios } from '../estoque/Estoque';
import { BotaoImprimir } from '../impressao/BotaoPdf';
import { relatorioPainelCrm } from '../impressao/cadastros';

export default function Painel() {
  // v1.56.0: seletor de período padrão; o CRM continua abrindo nos últimos 90 dias, como antes.
  const [per, setPer] = usePeriodo('90d');
  const { de, ate } = per;
  const [filialId, setFilialId] = useState('');
  const filiais = useApi<any[]>('/erp/core/filiais');
  const qs = `de=${de}&ate=${ate}T23:59:59${filialId ? `&filialId=${filialId}` : ''}`;
  const state = useApi<any>(`/erp/crm/kpis?${qs}`, [qs]);
  const nav = useNavigate(); const { can, hasModule } = useAuth();
  return (
    <>
      {/* v1.33.0: aviso no app de inventário com diferença aguardando a aprovação do proprietário. */}
      {can('OWNER', 'ADMIN') && hasModule('erp_estoque') && <AvisoInventarios onAbrir={() => nav('/erp/estoque')} />}
      <div className="page-head">
        <div><h1>Painel CRM</h1><p className="muted">Indicadores comerciais do período, com filtros por filial.</p></div>
        <div className="row filtros" style={{ flexWrap: 'wrap', gap: 6 }}>
          <SeletorPeriodo valor={per} onChange={setPer} opcoes={['hoje', '7d', '30d', '90d', 'mes', 'personalizado']} />
          <select value={filialId} onChange={(e) => setFilialId(e.target.value)} aria-label="Filial">
            <option value="">Todas as filiais</option>
            {(filiais.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </select>
          <BotaoImprimir disabled={!state.data} montar={() => relatorioPainelCrm(state.data, { de, ate, filial: (filiais.data ?? []).find((f) => f.id === filialId)?.nome })} />
        </div>
      </div>
      <Async state={state}>{(d) => {
        const k = d.kpis;
        const max = Math.max(1, ...d.funil.map((f: any) => f.valorCents));
        return (
          <>
            <div className="grid g4">
              <Kpi l="Clientes ativos" v={k.clientesAtivos} s={`${k.clientesInativos} inativos`} />
              <Kpi l="Pipeline aberto" v={brl(k.pipelineCents)} s={`${k.oportunidadesAbertas} oportunidades`} />
              <Kpi l="Taxa de conversão" v={`${k.taxaConversao.toLocaleString('pt-BR')}%`} s={`${k.ganhas} ganhas · ${k.perdidas} perdidas`} />
              <Kpi l="Ticket médio" v={brl(k.ticketMedioCents)} s={`ciclo médio ${k.cicloMedioDias} dias`} />
              <Kpi l="CAC" v={brl(k.cacCents)} s="custo por cliente conquistado" />
              <Kpi l="Inadimplência" st={statusInadimplencia(k.inadimplenciaPct)}
                v={k.inadimplenciaPct == null ? '—' : `${k.inadimplenciaPct.toLocaleString('pt-BR')}%`}
                s={k.inadimplenciaPct == null ? 'só quem tem acesso ao Financeiro vê'
                  : k.inadimplenciaTotalCents ? `vencido sem pagar ${brl(k.inadimplenciaVencidoCents)} de ${brl(k.inadimplenciaTotalCents)} a receber no período`
                    : 'nada a receber com vencimento no período'} />
              <Kpi l="Score médio dos clientes" st={d.scores.medio == null ? 'neutro' : statusScore(d.scores.medio)}
                v={d.scores.medio ?? '—'}
                s={d.scores.medio == null ? 'sem histórico de compras ou contas ainda' : `${d.scores.bons} bons · ${d.scores.atencao} atenção · ${d.scores.risco} risco`} />
            </div>
            {d.scores.piores.length > 0 && (
              <div className="card" style={{ marginTop: 14 }}>
                <h3>Clientes que pedem atenção</h3>
                <ul className="score-lista">
                  {d.scores.piores.map((c: any) => (
                    <li key={c.id}><Link to={`/erp/clientes/${c.id}`}>
                      <span className="nome">{c.nome}<span className="small muted" style={{ display: 'block' }}>{c.motivo}</span></span>
                      <StatusBadge status={statusScore(c.score, c.faixa)}>{c.score} · {ROTULO_FAIXA_SCORE[c.faixa]}</StatusBadge>
                    </Link></li>
                  ))}
                </ul>
              </div>
            )}
            <div className="card" style={{ marginTop: 14 }}>
              <h3>Funil por etapa</h3>
              {d.funil.map((f: any) => (
                <div key={f.etapaId} style={{ margin: '8px 0' }}>
                  <div className="row between small"><span>{f.nome} · {f.quantidade}</span><strong>{brl(f.valorCents)}</strong></div>
                  <div style={{ height: 8, background: 'var(--line, #e5e7eb)', borderRadius: 4 }}><div style={{ width: `${(f.valorCents / max) * 100}%`, height: 8, background: '#3b82f6', borderRadius: 4 }} /></div>
                </div>
              ))}
            </div>
          </>
        );
      }}</Async>
    </>
  );
}

function Kpi({ l, v, s, st }: { l: string; v: string | number; s?: string; st?: StatusCor }) {
  return <div className={`card stat${st ? ` st-card ${classeStatus(st)}` : ''}`}><div className="l">{l}</div><div className="v">{v}</div>{s && <div className="small muted">{s}</div>}</div>;
}
