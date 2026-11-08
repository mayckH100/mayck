/** Painel do CRM: KPIs e funil com filtros de período e filial. */
import { useState } from 'react';
import { useApi, Async } from '../../ui';
import { brl } from '../format';

const hoje = () => new Date().toISOString().slice(0, 10);
const diasAtras = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export default function Painel() {
  const [de, setDe] = useState(diasAtras(90));
  const [ate, setAte] = useState(hoje());
  const [filialId, setFilialId] = useState('');
  const filiais = useApi<any[]>('/erp/core/filiais');
  const qs = `de=${de}&ate=${ate}T23:59:59${filialId ? `&filialId=${filialId}` : ''}`;
  const state = useApi<any>(`/erp/crm/kpis?${qs}`, [qs]);
  return (
    <>
      <div className="page-head">
        <div><h1>Painel CRM</h1><p className="muted">Indicadores comerciais do período, com filtros por filial.</p></div>
        <div className="row filtros">
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)} aria-label="De" />
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} aria-label="Até" />
          <select value={filialId} onChange={(e) => setFilialId(e.target.value)} aria-label="Filial">
            <option value="">Todas as filiais</option>
            {(filiais.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </select>
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
              <Kpi l="Inadimplência" v={k.inadimplenciaPct == null ? '—' : `${k.inadimplenciaPct}%`} s="chega com o módulo Financeiro" />
            </div>
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

function Kpi({ l, v, s }: { l: string; v: string | number; s?: string }) {
  return <div className="card stat"><div className="l">{l}</div><div className="v">{v}</div>{s && <div className="small muted">{s}</div>}</div>;
}
