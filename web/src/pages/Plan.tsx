import { useApi, Async } from '../ui';

export default function Plan() {
  const state = useApi<any>('/plans');
  return (
    <>
      <div className="page-head"><div><h1>Plano</h1><p className="muted">Seu plano atual e o uso dos limites.</p></div></div>
      <Async state={state}>{(p) => {
        const cur = p.plans.find((x: any) => x.id === p.current);
        return (
          <div className="stack">
            <div className="card stack">
              <div className="row between"><h2 style={{ margin: 0 }}>Plano {cur?.name}</h2><span className="badge green">Atual</span></div>
              {(['channels', 'members', 'flows'] as const).map((k) => (
                <div key={k}>
                  <div className="row between small"><span>{{ channels: 'Números WhatsApp', members: 'Membros da equipe', flows: 'Fluxos' }[k]}</span><span>{p.usage[k]} / {cur.limits[k]}</span></div>
                  <div className="bar"><span style={{ width: `${Math.min(100, (p.usage[k] / cur.limits[k]) * 100)}%` }} /></div>
                </div>
              ))}
              <p className="small muted">As mensagens do WhatsApp são cobradas diretamente pela Meta na sua conta WhatsApp Business (há conversas de atendimento gratuitas iniciadas pelo cliente). A IA usa a sua própria chave do provedor.</p>
            </div>
            <div className="grid g2">
              {p.plans.map((pl: any) => (
                <div key={pl.id} className="card stack">
                  <div className="row between"><h2 style={{ margin: 0 }}>{pl.name}</h2><strong>{pl.priceLabel}</strong></div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{pl.features.map((f: string) => <li key={f}>{f}</li>)}</ul>
                </div>
              ))}
            </div>
            {!p.billingConfigured && <div className="alert info">A cobrança online ainda não está configurada nesta instalação, por isso não há botão de assinatura. Para mudar de plano, o administrador da plataforma ajusta manualmente.</div>}
          </div>
        );
      }}</Async>
    </>
  );
}
