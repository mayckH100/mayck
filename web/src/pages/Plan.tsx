import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post } from '../api';
import { useAuth, type SubscriptionView, type SubStatus } from '../auth';
import { useApi, Async, Loading, useAction } from '../ui';
import { CYCLE_LABEL, PLAN_PRODUCTS, PRODUCT_LABEL, SubBadge, clearStoredCoupon, couponLabel, daysLeft, fmtBRL, fmtDay, normalizeCoupon, storedCoupon, type AppliedCoupon, type Cycle, type PlanProduct } from '../billing';

export interface BillingStatus {
  subscriptions: SubscriptionView[];
  prices: Record<PlanProduct, Record<Cycle, number>>;
  trialDays: number;
  configured: boolean;
}
export interface ConfirmResult { ok: boolean; renewed: boolean; duplicated?: boolean; reason?: string; subscriptions: SubscriptionView[] }

const DESC: Record<PlanProduct, string> = {
  MCKBOT: 'Automação de atendimento no WhatsApp: Inbox, fluxos, Kanban e IA.',
  MCKMENSAGEM: 'Envio de mensagens e campanhas pelo MCKMENSAGEM.',
  COMBO: 'Os dois produtos juntos, com desconto. Renova MCKBOT e MCKMENSAGEM de uma vez.',
};

export function reasonText(r: ConfirmResult): { kind: 'ok' | 'warn' | 'err'; text: string } {
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
export function comboView(subs: SubscriptionView[]): { status: SubStatus; validUntil: string } | null {
  if (subs.length === 0) return null;
  const order: SubStatus[] = ['BLOQUEADA', 'VENCIDA', 'TRIAL', 'ATIVA'];
  const status = order.find((s) => subs.some((x) => x.status === s)) ?? 'ATIVA';
  const validUntil = subs.map((s) => s.validUntil).sort()[0];
  return { status, validUntil };
}

/**
 * Cupom de desconto da tela de assinatura: vem do link do parceiro (?cupom=CODIGO, guardado no cadastro)
 * ou é digitado pelo cliente. A validação e o preço final são do servidor (/billing/coupon).
 */
export function useCoupon() {
  const [sp] = useSearchParams();
  const initial = normalizeCoupon(sp.get('cupom')) || storedCoupon();
  const [code, setCode] = useState(initial);
  const [applied, setApplied] = useState<AppliedCoupon | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const apply = async (c = code) => {
    const norm = normalizeCoupon(c);
    setCode(norm); setError('');
    if (!norm) { setApplied(null); return; }
    setBusy(true);
    try { setApplied(await post<AppliedCoupon>('/billing/coupon', { code: norm })); } catch (e) { setApplied(null); setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = () => { setApplied(null); setCode(''); setError(''); clearStoredCoupon(); };
  useEffect(() => { if (initial) void apply(initial); }, []); // link de parceiro: aplica sozinho
  return { code, setCode, applied, error, busy, apply, remove, fromLink: !!initial };
}
export type CouponState = ReturnType<typeof useCoupon>;

export function CouponBox({ state }: { state: CouponState }) {
  const { code, setCode, applied, error, busy, apply, remove } = state;
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <form className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void apply(); }}>
        <label className="f" style={{ flex: '1 1 220px', margin: 0 }}>
          Cupom de desconto
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Ex.: PARCEIRO10" maxLength={30} aria-label="Cupom de desconto" autoCapitalize="characters" />
        </label>
        <button className="btn" disabled={busy || !code.trim()}>{busy ? 'Validando…' : 'Aplicar'}</button>
        {applied && <button type="button" className="btn sm" onClick={remove}>Remover cupom</button>}
      </form>
      {error && <div className="alert err small" role="alert" style={{ margin: 0 }}>{error}</div>}
      {applied && (
        <div className="alert ok small" role="status" style={{ margin: 0 }}>
          Cupom <strong>{applied.coupon.code}</strong> aplicado: {couponLabel(applied.coupon)}
          {applied.coupon.product !== 'ALL' && <> no plano {PRODUCT_LABEL[applied.coupon.product as PlanProduct] ?? applied.coupon.product}</>}
          {applied.coupon.cycles !== 'ALL' && <> ({CYCLE_LABEL[applied.coupon.cycles]?.toLowerCase()})</>}
          {applied.coupon.validUntil && <> · válido até {fmtDay(applied.coupon.validUntil)}</>}. O preço com desconto aparece em cada plano abaixo.
        </div>
      )}
    </div>
  );
}

export function ProductCard({ product, sub, prices, configured, app, desc, label, coupon }: { product: PlanProduct; sub: { status: SubStatus; validUntil: string; cycle?: string } | null; prices: Record<Cycle, number>; configured: boolean; app?: 'mckbot' | 'mensagem'; desc?: string; label?: string; coupon?: AppliedCoupon | null }) {
  const [cycle, setCycle] = useState<Cycle>('MENSAL');
  const { busy, run } = useAction();
  const left = sub ? daysLeft(sub.validUntil) : 0;
  const saving = prices.MENSAL * 12 - prices.ANUAL;
  const q = coupon?.quotes[product]?.[cycle] ?? null;
  const pay = async () => {
    const body: Record<string, string> = { product, cycle };
    if (app) body.app = app;
    if (q && coupon) body.coupon = coupon.coupon.code;
    const r = await run(() => post<{ init_point: string }>('/billing/checkout', body));
    if (r?.init_point) window.location.href = r.init_point;
  };
  return (
    <div className="card stack" style={product === 'COMBO' ? { borderColor: 'var(--brand-2)' } : undefined}>
      <div className="row between"><h2 style={{ margin: 0 }}>{label ?? PRODUCT_LABEL[product]}</h2>{sub && <SubBadge status={sub.status} />}</div>
      <p className="small muted" style={{ margin: 0 }}>{desc ?? DESC[product]}</p>
      {sub && (
        <div className="small">
          {sub.status === 'BLOQUEADA' ? <>Acesso bloqueado pelo administrador. Fale com o suporte.</>
            : left > 0 ? <>Válida até <strong>{fmtDay(sub.validUntil)}</strong> ({left} dia{left === 1 ? '' : 's'} restante{left === 1 ? '' : 's'})</>
              : <>Venceu em <strong>{fmtDay(sub.validUntil)}</strong></>}
          {sub.cycle && sub.status === 'ATIVA' && <> · ciclo {CYCLE_LABEL[sub.cycle]?.toLowerCase()}</>}
        </div>
      )}
      <div className="grid g2" style={{ gap: 8 }}>
        {(['MENSAL', 'ANUAL'] as Cycle[]).map((c) => {
          const cq = coupon?.quotes[product]?.[c] ?? null;
          return (
          <label key={c} className="card" style={{ padding: 10, cursor: 'pointer', boxShadow: 'none', borderColor: cycle === c ? 'var(--brand)' : undefined }}>
            <div className="row"><input type="radio" name={`cycle-${product}`} checked={cycle === c} onChange={() => setCycle(c)} /> <strong>{CYCLE_LABEL[c]}</strong></div>
            {cq ? <div><s className="small muted">{fmtBRL(cq.originalCents)}</s> <span style={{ fontSize: 18, fontWeight: 700 }}>{fmtBRL(cq.finalCents)}</span></div>
              : <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtBRL(prices[c])}</div>}
            <div className="small muted">{c === 'MENSAL' ? 'por mês' : saving > 0 ? `por ano · economize ${fmtBRL(saving)}` : 'por ano'}</div>
          </label>
          );
        })}
      </div>
      {q && coupon && (
        <div className="small" style={{ lineHeight: 1.6 }} aria-label="Resumo do desconto">
          <div className="row between"><span>Preço do plano</span><span>{fmtBRL(q.originalCents)}</span></div>
          <div className="row between" style={{ color: 'var(--green, #15803d)' }}><span>Cupom {coupon.coupon.code}</span><span>− {fmtBRL(q.discountCents)}</span></div>
          <div className="row between"><strong>Total</strong><strong>{fmtBRL(q.finalCents)}</strong></div>
        </div>
      )}
      {coupon && !q && <div className="small muted">O cupom {coupon.coupon.code} não vale para este plano/ciclo.</div>}
      <button className="btn primary" disabled={!configured || busy} onClick={pay}>
        {busy ? 'Abrindo pagamento…' : `Pagar ${fmtBRL(q ? q.finalCents : prices[cycle])} (Pix ou cartão)`}
      </button>
    </div>
  );
}

/** Resumo do plano atual: o que está ativo, até quando e como renova. */
export function CurrentPlan({ subs, prices, only }: { subs: SubscriptionView[]; prices: Record<PlanProduct, Record<Cycle, number>>; only?: SubscriptionView['product'][] }) {
  const list = only ? subs.filter((s) => only.includes(s.product)) : subs;
  const paid = list.filter((s) => s.status === 'ATIVA');
  const sameEnd = paid.length === 2 && paid[0].validUntil.slice(0, 10) === paid[1].validUntil.slice(0, 10) && paid[0].cycle === paid[1].cycle;
  return (
    <div className="card stack">
      <div className="row between"><h2 style={{ margin: 0 }}>Seu plano atual</h2>{paid.length === 0 && <span className="badge amber">Nenhum plano pago ativo</span>}</div>
      {sameEnd && <p className="small" style={{ margin: 0 }}>Você tem <strong>MCKBOT + MCK Mensagens</strong> (ciclo {CYCLE_LABEL[paid[0].cycle].toLowerCase()}).</p>}
      <div className="grid g2" style={{ gap: 10 }}>
        {list.map((s) => {
          const left = daysLeft(s.validUntil);
          const label = s.product === 'MCKMENSAGEM' ? 'MCK Mensagens' : 'MCKBOT';
          return (
            <div key={s.product} className="card" style={{ boxShadow: 'none', padding: 14 }}>
              <div className="row between"><strong>{label}</strong><SubBadge status={s.status} /></div>
              <div className="small" style={{ marginTop: 6, lineHeight: 1.6 }}>
                {s.status === 'BLOQUEADA' ? <>Acesso bloqueado pelo administrador. Fale com o suporte.</> : <>
                  {s.status === 'TRIAL' ? 'Teste grátis' : `Plano ${CYCLE_LABEL[s.cycle]?.toLowerCase()} · ${fmtBRL(prices[s.product][s.cycle])}`}<br />
                  {left > 0 ? <>Vence em <strong>{fmtDay(s.validUntil)}</strong> ({left} dia{left === 1 ? '' : 's'})</> : <>Venceu em <strong>{fmtDay(s.validUntil)}</strong></>}<br />
                  <span className="muted">Renovação: {s.status === 'ATIVA' ? 'manual, por Pix ou cartão. Renovando antes do vencimento, o novo período é somado ao que resta.' : 'assine um plano para continuar usando depois do vencimento.'}</span>
                </>}
              </div>
            </div>
          );
        })}
      </div>
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
  // Comparação de planos: só quando não há plano pago ativo, quando o cliente pede para trocar/renovar ou veio da vitrine (?plano=).
  const [compare, setCompare] = useState<boolean>(() => sp.has('plano') || sp.has('cupom'));
  const coupon = useCoupon();

  useEffect(() => {
    const key = paymentId ?? billingBack;
    if (!key || done.current === key) return;
    done.current = key;
    if (!paymentId || paymentId === 'null' || !/^\d+$/.test(paymentId)) {
      const st = sp.get('status') ?? sp.get('collection_status') ?? billingBack;
      setCompare(true);
      setResult(st === 'pending'
        ? { kind: 'warn', text: 'Pagamento pendente. Assim que o Mercado Pago aprovar, sua assinatura é renovada automaticamente.' }
        : { kind: 'warn', text: st === 'rejected' || st === 'failure' ? 'O pagamento não foi concluído. Você pode tentar novamente quando quiser.' : 'Pagamento não concluído. Você pode tentar novamente quando quiser.' });
      setSp(new URLSearchParams(), { replace: true });
      return;
    }
    setConfirming(true);
    post<ConfirmResult>('/billing/confirm', { paymentId })
      .then((r) => { setResult(reasonText(r)); if (r.renewed || r.duplicated) clearStoredCoupon(); state.setData((d) => (d ? { ...d, subscriptions: r.subscriptions } : d)); refresh(); })
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
        const paid = subs.filter((x) => x.status === 'ATIVA');
        const showCompare = compare || paid.length === 0 || !!coupon.applied;
        return (
          <div className="stack">
            <CurrentPlan subs={subs} prices={b.prices} />
            {paid.length > 0 && (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={() => setCompare((v) => !v)} aria-expanded={showCompare}>{showCompare ? 'Ocultar planos' : 'Renovar ou trocar de plano'}</button>
              </div>
            )}
            {showCompare && (
              <>
                {!b.configured && <div className="alert warn">Pagamento ainda não configurado. O pagamento online estará disponível em breve; enquanto isso, fale com o suporte para ativar ou renovar a sua assinatura.</div>}
                <h2 style={{ margin: '8px 0 0' }}>{paid.length ? 'Renovar ou trocar de plano' : 'Escolha seu plano'}</h2>
                <CouponBox state={coupon} />
                <div className="grid g3">
                  {PLAN_PRODUCTS.map((p) => {
                    const s = p === 'COMBO' ? combo : subs.find((x) => x.product === p) ?? null;
                    return <ProductCard key={p} product={p} sub={s} prices={b.prices[p]} configured={b.configured} coupon={coupon.applied} />;
                  })}
                </div>
                <p className="small muted">O pagamento é processado pelo Mercado Pago. Ao renovar antes do vencimento, o novo período é somado ao que ainda resta. Novos clientes têm {b.trialDays} dia(s) de teste grátis.</p>
              </>
            )}
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
