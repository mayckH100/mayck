import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post } from '../api';
import { useAuth, type SubscriptionView, type SubStatus } from '../auth';
import { useApi, Async, Loading, useAction } from '../ui';
import { CYCLE_LABEL, PLAN_PRODUCTS, PRODUCT_LABEL, SubBadge, daysLeft, fmtBRL, fmtDay, type Cycle, type PlanProduct } from '../billing';

interface BillingStatus {
  subscriptions: SubscriptionView[];
  prices: Record<PlanProduct, Record<Cycle, number>>;
  trialDays: number;
  configured: boolean;
}
interface ConfirmResult { ok: boolean; renewed: boolean; duplicated?: boolean; reason?: string; subscriptions: SubscriptionView[] }

const DESC: Record<PlanProduct, string> = {
  MCKBOT: 'Automação de atendimento no WhatsApp: Inbox, fluxos, Kanban e IA.',
  MCKMENSAGEM: 'Envio de mensagens e campanhas pelo MCKMENSAGEM.',
  COMBO: 'Os dois produtos juntos, com desconto. Renova MCKBOT e MCKMENSAGEM de uma vez.',
};

function reasonText(r: ConfirmResult): { kind: 'ok' | 'warn' | 'err'; text: string } {
  if (r.renewed) return { kind: 'ok', text: 'Pagamento aprovado! Sua assinatura foi renovada.' };
  if (r.duplicated) return { kind: 'ok', text: 'Este pagamento já tinha sido confirmado. Sua assinatura está atualizada.' };
  const reason = r.reason ?? '';
  if (reason === 'status_pending' || reason === 'status_in_process' || reason === 'status_authorized')
    return { kind: 'warn', text: 'Pagamento em análise ou aguardando compensação (Pix/boleto). Assim que for aprovado, a assinatura é renovada automaticamente.' };
  if (reason === 'status_rejected') return { kind: 'err', text: 'O pagamento foi recusado. Tente novamente com outra forma de pagamento.' };
  if (reason === 'status_cancelled') return { kind: 'err', text: 'O pagamento foi cancelado.' };
  if (reason === 'valor_divergente') return { kind: 'err', text: 'O valor pago não confere com o preço do plano. Fale com o suporte.' };
  if (reason === 'outra_organizacao') return { kind: 'err', text: 'Este pagamento pertence a outra organização.' };
  return { kind: 'warn', text: `Não foi possível confirmar o pagamento agora (${reason || 'motivo desconhecido'}). Se o valor foi debitado, a renovação acontece automaticamente em alguns minutos.` };
}

/** Status do combo: o "pior" dos dois produtos e a menor validade. */
function comboView(subs: SubscriptionView[]): { status: SubStatus; validUntil: string } | null {
  if (subs.length === 0) return null;
  const order: SubStatus[] = ['BLOQUEADA', 'VENCIDA', 'TRIAL', 'ATIVA'];
  const status = order.find((s) => subs.some((x) => x.status === s)) ?? 'ATIVA';
  const validUntil = subs.map((s) => s.validUntil).sort()[0];
  return { status, validUntil };
}

function ProductCard({ product, sub, prices, configured }: { product: PlanProduct; sub: { status: SubStatus; validUntil: string; cycle?: string } | null; prices: Record<Cycle, number>; configured: boolean }) {
  const [cycle, setCycle] = useState<Cycle>('MENSAL');
  const { busy, run } = useAction();
  const left = sub ? daysLeft(sub.validUntil) : 0;
  const saving = prices.MENSAL * 12 - prices.ANUAL;
  const pay = async () => {
    const r = await run(() => post<{ init_point: string }>('/billing/checkout', { product, cycle }));
    if (r?.init_point) window.location.href = r.init_point;
  };
  return (
    <div className="card stack" style={product === 'COMBO' ? { borderColor: 'var(--brand-2)' } : undefined}>
      <div className="row between"><h2 style={{ margin: 0 }}>{PRODUCT_LABEL[product]}</h2>{sub && <SubBadge status={sub.status} />}</div>
      <p className="small muted" style={{ margin: 0 }}>{DESC[product]}</p>
      {sub && (
        <div className="small">
          {sub.status === 'BLOQUEADA' ? <>Acesso bloqueado pelo administrador. Fale com o suporte.</>
            : left > 0 ? <>Válida até <strong>{fmtDay(sub.validUntil)}</strong> ({left} dia{left === 1 ? '' : 's'} restante{left === 1 ? '' : 's'})</>
              : <>Venceu em <strong>{fmtDay(sub.validUntil)}</strong></>}
          {sub.cycle && sub.status === 'ATIVA' && <> · ciclo {CYCLE_LABEL[sub.cycle]?.toLowerCase()}</>}
        </div>
      )}
      <div className="grid g2" style={{ gap: 8 }}>
        {(['MENSAL', 'ANUAL'] as Cycle[]).map((c) => (
          <label key={c} className="card" style={{ padding: 10, cursor: 'pointer', boxShadow: 'none', borderColor: cycle === c ? 'var(--brand)' : undefined }}>
            <div className="row"><input type="radio" name={`cycle-${product}`} checked={cycle === c} onChange={() => setCycle(c)} /> <strong>{CYCLE_LABEL[c]}</strong></div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtBRL(prices[c])}</div>
            <div className="small muted">{c === 'MENSAL' ? 'por mês' : saving > 0 ? `por ano · economize ${fmtBRL(saving)}` : 'por ano'}</div>
          </label>
        ))}
      </div>
      <button className="btn primary" disabled={!configured || busy} onClick={pay}>
        {busy ? 'Abrindo pagamento…' : `Pagar ${fmtBRL(prices[cycle])} (Pix ou cartão)`}
      </button>
    </div>
  );
}

export default function Plan() {
  const state = useApi<BillingStatus>('/billing/status');
  const usage = useApi<any>('/plans');
  const { refresh } = useAuth();
  const [sp, setSp] = useSearchParams();
  const paymentId = sp.get('payment_id') ?? sp.get('collection_id');
  const billingBack = sp.get('billing'); // retorno do Mercado Pago: success | pending | failure
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const done = useRef<string | null>(null);

  useEffect(() => {
    const key = paymentId ?? billingBack;
    if (!key || done.current === key) return;
    done.current = key;
    if (!paymentId || paymentId === 'null' || !/^\d+$/.test(paymentId)) {
      const st = sp.get('status') ?? sp.get('collection_status') ?? billingBack;
      setResult(st === 'pending'
        ? { kind: 'warn', text: 'Pagamento pendente. Assim que o Mercado Pago aprovar, sua assinatura é renovada automaticamente.' }
        : { kind: 'warn', text: st === 'rejected' || st === 'failure' ? 'O pagamento não foi concluído. Você pode tentar novamente quando quiser.' : 'Pagamento não concluído. Você pode tentar novamente quando quiser.' });
      setSp(new URLSearchParams(), { replace: true });
      return;
    }
    setConfirming(true);
    post<ConfirmResult>('/billing/confirm', { paymentId })
      .then((r) => { setResult(reasonText(r)); state.setData((d) => (d ? { ...d, subscriptions: r.subscriptions } : d)); refresh(); })
      .catch((e) => setResult({ kind: 'err', text: (e as Error).message }))
      .finally(() => { setConfirming(false); setSp(new URLSearchParams(), { replace: true }); });
  }, [paymentId, billingBack]);

  return (
    <>
      <div className="page-head"><div><h1>Plano e assinatura</h1><p className="muted">Situação das suas assinaturas, preços e pagamento por Pix ou cartão (Mercado Pago).</p></div></div>
      {confirming && <div className="card" style={{ marginBottom: 12 }}><Loading text="Confirmando seu pagamento com o Mercado Pago…" /></div>}
      {result && <div className={`alert ${result.kind}`} role="status" style={{ marginBottom: 12 }}>{result.text}</div>}
      <Async state={state}>{(b) => {
        const subs = b.subscriptions;
        const combo = comboView(subs);
        return (
          <div className="stack">
            {!b.configured && <div className="alert warn">Pagamento ainda não configurado. O pagamento online estará disponível em breve; enquanto isso, fale com o suporte para ativar ou renovar a sua assinatura.</div>}
            <div className="grid g3">
              {PLAN_PRODUCTS.map((p) => {
                const s = p === 'COMBO' ? combo : subs.find((x) => x.product === p) ?? null;
                return <ProductCard key={p} product={p} sub={s} prices={b.prices[p]} configured={b.configured} />;
              })}
            </div>
            <p className="small muted">O pagamento é processado pelo Mercado Pago. Ao renovar antes do vencimento, o novo período é somado ao que ainda resta. Novos clientes têm {b.trialDays} dia(s) de teste grátis.</p>
            {usage.data?.plans && (() => {
              const p = usage.data;
              const cur = p.plans.find((x: any) => x.id === p.current);
              if (!cur) return null;
              return (
                <div className="card stack">
                  <h2 style={{ margin: 0 }}>Uso dos limites</h2>
                  {(['channels', 'members', 'flows'] as const).map((k) => (
                    <div key={k}>
                      <div className="row between small"><span>{{ channels: 'Números WhatsApp', members: 'Membros da equipe', flows: 'Fluxos' }[k]}</span><span>{p.usage[k]} / {cur.limits[k]}</span></div>
                      <div className="bar"><span style={{ width: `${Math.min(100, (p.usage[k] / cur.limits[k]) * 100)}%` }} /></div>
                    </div>
                  ))}
                  <p className="small muted">As mensagens do WhatsApp são cobradas diretamente pela Meta na sua conta WhatsApp Business. A IA usa a sua própria chave do provedor.</p>
                </div>
              );
            })()}
          </div>
        );
      }}</Async>
    </>
  );
}
