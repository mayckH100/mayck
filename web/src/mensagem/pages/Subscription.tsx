import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Loading } from '../../ui';
import { ProductCard, comboView, reasonText, type BillingStatus, type ConfirmResult } from '../../pages/Plan';

export default function MmSubscription() {
  const state = useApi<BillingStatus>('/billing/status');
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
        : { kind: 'warn', text: 'Pagamento não concluído. Você pode tentar novamente quando quiser.' });
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
      <div className="page-head"><div><h1>Assinatura</h1><p className="muted">Plano do MCK Mensagens. Pagamento por Pix ou cartão pelo Mercado Pago.</p></div></div>
      {confirming && <div className="card" style={{ marginBottom: 12 }}><Loading text="Confirmando seu pagamento com o Mercado Pago…" /></div>}
      {result && <div className={`alert ${result.kind}`} role="status" style={{ marginBottom: 12 }}>{result.text}</div>}
      <Async state={state}>{(b) => {
        const mm = b.subscriptions.find((s) => s.product === 'MCKMENSAGEM') ?? null;
        return (
          <div className="stack">
            {!b.configured && <div className="alert warn">Pagamento online ainda não configurado. Enquanto isso, fale com o suporte para ativar ou renovar a sua assinatura.</div>}
            <div className="grid g2">
              <ProductCard product="MCKMENSAGEM" label="MCK Mensagens" app="mensagem" sub={mm} prices={b.prices.MCKMENSAGEM} configured={b.configured}
                desc="Contatos com consentimento, campanhas personalizadas com {nome}, limites seguros e métricas de resposta e conversão." />
              <ProductCard product="COMBO" label="Combo MCKBOT + MCK Mensagens" app="mensagem" sub={comboView(b.subscriptions)} prices={b.prices.COMBO} configured={b.configured}
                desc="Atendimento automatizado (MCKBOT) e campanhas (MCK Mensagens) juntos, com desconto. Renova os dois de uma vez." />
            </div>
            <p className="small muted">Com a assinatura inativa você continua consultando e exportando seus contatos e métricas, mas não pode criar, importar nem disparar campanhas. Ao renovar antes do vencimento, o novo período é somado ao que resta. Novos clientes têm {b.trialDays} dia(s) de teste grátis.</p>
          </div>
        );
      }}</Async>
    </>
  );
}
