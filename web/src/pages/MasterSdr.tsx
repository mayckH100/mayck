import { put } from '../api';
import { useApi, Async, useAction } from '../ui';

/** Painel Master › SDR com IA: liga/desliga o módulo por plano. Preços não mudam aqui. */
const PLANOS: [string, string, string][] = [
  ['COMBO', 'Plano Completo (MCK ERP + MCKBOT + MCK Mensagens)', 'Inclui o período de teste do Plano Completo. Padrão: ligado.'],
  ['MCKBOT', 'Só MCKBOT', 'Padrão: desligado.'],
  ['MCKMENSAGEM', 'Só MCK Mensagens', 'Padrão: desligado.'],
];

export default function MasterSdr() {
  const state = useApi<Record<string, boolean>>('/master/sdr');
  const { run, busy } = useAction();
  return (
    <div className="card stack">
      <h3>SDR com IA por plano</h3>
      <p className="small muted">A empresa da própria MCK e o superadmin têm o SDR sempre. Desligar um plano tira o acesso na hora (os dados dos leads ficam guardados) e para os envios automáticos dessas empresas.</p>
      <Async state={state}>{(d) => (
        <div className="stack">
          {PLANOS.map(([k, label, hint]) => (
            <label key={k} className="row" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={!!d[k]} disabled={busy} style={{ width: 'auto', marginTop: 3 }}
                onChange={async (e) => { const r = await run(() => put<Record<string, boolean>>('/master/sdr', { [k]: e.target.checked }), 'Salvo'); if (r) state.setData(r); }} />
              <span><strong>{label}</strong><br /><span className="small muted">{hint}</span></span>
            </label>
          ))}
        </div>
      )}</Async>
    </div>
  );
}
