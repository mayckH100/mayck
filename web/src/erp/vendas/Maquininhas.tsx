/** Maquininhas de cartão do PDV: escolher o provedor, colar o access token da PRÓPRIA conta, listar e escolher o terminal
 * padrão do caixa (e colocá-lo em modo PDV). Stone, PagBank e Cielo aparecem como "em breve". */
import { useState } from 'react';
import { get, post, put, del } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Field, useAction, useToast, copy } from '../../ui';

export default function Maquininhas() {
  const st = useApi<any>('/erp/vendas/maquininhas/config');
  const { can } = useAuth(); const gestor = can('OWNER', 'ADMIN');
  const { busy, run } = useAction(); const toast = useToast();
  const [prov, setProv] = useState<string | null>(null);
  const [token, setToken] = useState(''); const [segredo, setSegredo] = useState('');
  const [terminais, setTerminais] = useState<any[] | null>(null);

  const buscar = async () => { const t = await run(() => get<any[]>('/erp/vendas/maquininhas/terminais')); if (t) setTerminais(t); };

  return (
    <div className="page">
      <div className="page-head"><div><h1>Maquininhas</h1><p className="muted">Envie a cobrança do cartão direto do PDV para a maquininha. A venda só é registrada quando o pagamento é aprovado.</p></div></div>
      <Async state={st}>{(d) => {
        const cfg = d.config;
        const atual = prov ?? cfg?.provedor ?? 'mercadopago_point';
        const p = d.provedores.find((x: any) => x.id === atual);
        const salvar = async (extra: object, msg = 'Configuração salva') => { const r = await run(() => put('/erp/vendas/maquininhas/config', { provedor: atual, ...extra }), msg); if (r) { setToken(''); setSegredo(''); st.reload(); } return r; };
        return <>
          <div className="card">
            <h3>1. Provedor</h3>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {d.provedores.map((x: any) => <button key={x.id} type="button" className={`btn sm ${atual === x.id ? 'primary' : ''}`} onClick={() => { setProv(x.id); setTerminais(null); }}>{x.nome}{x.disponivel ? '' : ' · em breve'}</button>)}
            </div>
            <p className="small muted" style={{ marginTop: 6 }}>{p?.ajuda}</p>
          </div>

          {p && !p.disponivel && <div className="card" style={{ marginTop: 10 }}><p>{p.nome}: integração <b>em breve</b>. Ela precisa de credenciamento junto ao provedor antes de ser liberada. Por enquanto, use o Mercado Pago Point ou lance o cartão manualmente no PDV.</p></div>}

          {p?.disponivel && <>
            <div className="card" style={{ marginTop: 10 }}>
              <h3>2. Credencial da sua conta</h3>
              {cfg?.temToken && cfg.provedor === atual ? <p className="small">Access token salvo: <code>{cfg.token}</code> (fica cifrado; só é usado para cobrar nas maquininhas desta empresa).</p> : <p className="small muted">Nenhum token salvo.</p>}
              {gestor && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <input type="password" style={{ minWidth: 320 }} placeholder="APP_USR-… (access token de produção)" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" aria-label="Access token" />
                <button className="btn primary" disabled={busy || token.trim().length < 20} onClick={() => salvar({ accessToken: token.trim() }, 'Token salvo')}>Salvar token</button>
                {cfg && <button className="btn ghost" disabled={busy} onClick={async () => { if (confirm('Remover a maquininha? O PDV volta ao lançamento manual do cartão.') && await run(() => del('/erp/vendas/maquininhas/config'), 'Maquininha removida')) { setTerminais(null); st.reload(); } }}>Remover</button>}
              </div>}
            </div>

            {cfg?.temToken && cfg.provedor === atual && <div className="card" style={{ marginTop: 10 }}>
              <h3>3. Maquininha do caixa</h3>
              <p className="small">Terminal padrão: <b>{cfg.terminalPadraoId ?? 'nenhum'}</b>{cfg.terminalPadraoId && !cfg.ativo ? ' (desligado)' : ''}</p>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn" disabled={busy} onClick={buscar}>Buscar maquininhas da conta</button>
                {gestor && cfg.terminalPadraoId && <button className="btn ghost" disabled={busy} onClick={() => salvar({ ativo: !cfg.ativo }, cfg.ativo ? 'Maquininha desligada no PDV' : 'Maquininha ligada no PDV')}>{cfg.ativo ? 'Desligar no PDV' : 'Ligar no PDV'}</button>}
              </div>
              {terminais && (terminais.length === 0 ? <p className="small muted">Nenhuma maquininha encontrada nesta conta. Vincule a maquininha a uma loja e a um caixa no app do Mercado Pago.</p> : <div className="table-wrap" style={{ marginTop: 6 }}><table><thead><tr><th>Terminal</th><th>Modo</th><th>Caixa</th><th></th></tr></thead><tbody>
                {terminais.map((t) => <tr key={t.id}>
                  <td className="small">{t.id}</td>
                  <td>{t.prontoParaPdv ? 'PDV ✓' : (t.modo ?? '—')}</td>
                  <td className="small">{t.caixa ?? '—'}</td>
                  <td className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    {gestor && !t.prontoParaPdv && <button className="btn sm" disabled={busy} onClick={async () => { if (await run(() => post(`/erp/vendas/maquininhas/terminais/${encodeURIComponent(t.id)}/modo-pdv`), 'Modo PDV ativado. Reinicie a maquininha se ela pedir.')) buscar(); }}>Ativar modo PDV</button>}
                    {gestor && <button className={`btn sm ${cfg.terminalPadraoId === t.id ? 'primary' : ''}`} disabled={busy || cfg.terminalPadraoId === t.id} onClick={() => salvar({ terminalPadraoId: t.id, ativo: true }, 'Maquininha escolhida para o caixa')}>{cfg.terminalPadraoId === t.id ? 'Padrão do caixa' : 'Usar no caixa'}</button>}
                  </td>
                </tr>)}
              </tbody></table></div>)}
            </div>}

            {cfg?.temToken && cfg.provedor === atual && <div className="card" style={{ marginTop: 10 }}>
              <h3>4. Notificações (recomendado)</h3>
              <p className="small">No painel do Mercado Pago (Suas integrações → sua aplicação → Webhooks → Configurar notificações), em <b>Modo de produção</b>, cole a URL abaixo e marque o evento <b>Order (Mercado Pago)</b>. Assim o PDV confirma o pagamento na hora; sem isso, ele confere sozinho a cada poucos segundos.</p>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><code className="small" style={{ wordBreak: 'break-all' }}>{cfg.webhookUrl}</code><button className="btn sm" onClick={() => copy(cfg.webhookUrl, toast)}>Copiar</button></div>
              {gestor && <Field label="Assinatura secreta das notificações (opcional)" hint={cfg.temWebhookSecret ? 'Salva. As notificações sem assinatura válida são recusadas.' : 'Cole a "assinatura secreta" gerada pelo Mercado Pago para validar cada notificação.'}>
                <div className="row" style={{ gap: 6 }}>
                  <input type="password" value={segredo} onChange={(e) => setSegredo(e.target.value)} autoComplete="off" aria-label="Assinatura secreta" />
                  <button className="btn" disabled={busy || !segredo.trim()} onClick={() => salvar({ webhookSecret: segredo.trim() }, 'Assinatura salva')}>Salvar</button>
                  {cfg.temWebhookSecret && <button className="btn ghost" disabled={busy} onClick={() => salvar({ webhookSecret: '' }, 'Assinatura removida')}>Remover</button>}
                </div>
              </Field>}
            </div>}
          </>}
          {!gestor && <p className="small muted" style={{ marginTop: 10 }}>Só o dono ou um administrador altera a configuração da maquininha.</p>}
        </>;
      }}</Async>
    </div>
  );
}
