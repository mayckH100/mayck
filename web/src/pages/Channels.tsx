import { useEffect, useRef, useState } from 'react';
import { get, post, patch, del } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, fmtDate, StatusBadge, useToast, copy } from '../ui';

export default function Channels() {
  const state = useApi<any[]>('/channels');
  const { can } = useAuth();
  const admin = can('OWNER', 'ADMIN');
  const [cfg, setCfg] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const [qrFor, setQrFor] = useState<any>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  return (
    <>
      <div className="page-head">
        <div><h1>Canais WhatsApp</h1><p className="muted">Conecte seu número pelo <strong>QR code</strong>, do mesmo jeito que o WhatsApp Web. A API oficial da Meta continua disponível como opção avançada.</p></div>
        {admin && <button className="btn primary" disabled={busy} onClick={() => run(() => post('/channels', { name: 'WhatsApp principal', provider: 'whatsapp_qr' }), 'Canal criado — agora clique em "Conectar por QR code"').then(state.reload)}>+ Adicionar número</button>}
      </div>
      <Async state={state}>{(list) => list.length === 0 ? (
        <div className="card"><Empty title="Nenhum número configurado">Adicione um número e conecte pelo QR code usando o WhatsApp do seu celular. Enquanto isso, o status fica "não conectado" e nada é enviado.</Empty></div>
      ) : (
        <div className="grid g2">
          {list.map((c) => (
            <div key={c.id} className="card stack">
              <div className="row between"><strong>{c.name}</strong><StatusBadge status={c.status} /></div>
              {c.provider === 'whatsapp_qr' ? (
                <>
                  <div className="small">{c.status === 'CONNECTED' ? <>Número conectado: <strong>{c.displayPhone ?? '—'}</strong></> : (c.displayPhone ? <span className="muted">Último número: {c.displayPhone}</span> : 'Conexão por QR code (WhatsApp Web)')}</div>
                  {c.status !== 'CONNECTED' && c.lastError && <div className="alert warn small">{c.lastError}</div>}
                </>
              ) : (
                <>
                  <div className="small">{c.displayPhone ?? 'Número ainda não verificado'}{c.phoneNumberId && <span className="muted"> · Phone Number ID {c.phoneNumberId}</span>} <span className="badge">API oficial</span></div>
                  {c.status !== 'CONNECTED' && <div className="alert warn small">Não conectado: {c.lastError ?? 'preencha as credenciais e clique em "Verificar conexão".'}</div>}
                </>
              )}
              <div className="grid g4" style={{ gap: 8 }}>
                {[['Hoje', c.stats.today], ['7 dias', c.stats.d7], ['30 dias', c.stats.d30], ['Total', c.stats.total]].map(([l, v]) => <div key={l as string} className="stat"><div className="l">{l}</div><div className="v" style={{ fontSize: 18 }}>{v}</div></div>)}
              </div>
              {admin && (
                <div className="row">
                  {c.status !== 'CONNECTED' && <button className="btn sm primary" onClick={() => setQrFor(c)}>Conectar por QR code</button>}
                  {c.provider === 'whatsapp_qr' && c.status !== 'NOT_CONNECTED' && <button className="btn sm" disabled={busy} onClick={() => { if (confirm('Desconectar este número? O aparelho será removido de "Aparelhos conectados" no celular e será preciso ler o QR code de novo.')) run(() => post(`/channels/${c.id}/qr/disconnect`), 'Número desconectado').then(state.reload); }}>Desconectar</button>}
                  <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm('Excluir este canal?')) run(() => del(`/channels/${c.id}`), 'Canal excluído').then(state.reload); }}>Excluir</button>
                </div>
              )}
              {admin && (
                <details>
                  <summary className="small muted" style={{ cursor: 'pointer' }}>Avançado / API oficial (opcional)</summary>
                  <div className="stack" style={{ marginTop: 8 }}>
                    <p className="small muted">Use a WhatsApp Cloud API da Meta no lugar do QR code. Exige app na Meta, token permanente e webhook (veja docs/DEPLOY.md). Ao salvar as credenciais, este canal passa a usar a API oficial e a sessão por QR code é encerrada.</p>
                    <div className="row">
                      <button className="btn sm" onClick={() => setCfg(c)}>Configurar API oficial</button>
                      {c.provider !== 'whatsapp_qr' && <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/channels/${c.id}/verify`)).then((r) => { state.reload(); if (r) toast(r.status === 'CONNECTED' ? 'Conexão verificada com a Meta' : `Falha na verificação: ${r.lastError}`, r.status === 'CONNECTED' ? 'ok' : 'err'); })}>Verificar conexão</button>}
                      <button className="btn sm" onClick={() => setDiag(c)}>Diagnóstico</button>
                      {c.provider !== 'whatsapp_qr' && c.status === 'CONNECTED' && <button className="btn sm" disabled={busy} onClick={() => { if (confirm('Desconectar? O token de acesso será apagado.')) run(() => post(`/channels/${c.id}/disconnect`), 'Canal desconectado').then(state.reload); }}>Desconectar API</button>}
                    </div>
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}</Async>
      {qrFor && (
        <QrConnect channel={qrFor} onClose={() => { setQrFor(null); state.reload(); }} />
      )}
      {cfg && (
        <ChannelConfig channel={cfg} onClose={() => setCfg(null)} onSaved={() => { setCfg(null); state.reload(); }} />
      )}
      {diag && (
        <Modal title={`Diagnóstico — ${diag.name}`} onClose={() => setDiag(null)}>
          <table className="small"><tbody>
            <tr><td>Tipo de conexão</td><td>{diag.provider === 'whatsapp_qr' ? 'QR code (WhatsApp Web)' : 'API oficial (Cloud API)'}</td></tr>
            <tr><td>Status</td><td><StatusBadge status={diag.status} /></td></tr>
            {diag.provider === 'whatsapp_qr' && <tr><td>Conectado desde</td><td>{fmtDate(diag.connectedAt)}</td></tr>}
            <tr><td>Último erro</td><td>{diag.lastError ?? '—'}</td></tr>
            <tr><td>{diag.provider === 'whatsapp_qr' ? 'Última mensagem recebida' : 'Último webhook recebido'}</td><td>{fmtDate(diag.lastWebhookAt)}</td></tr>
            <tr><td>Última verificação</td><td>{fmtDate(diag.lastCheckedAt)}</td></tr>
            <tr><td>Token de acesso</td><td>{diag.hasAccessToken ? `salvo (${diag.accessTokenPreview})` : 'não informado'}</td></tr>
            <tr><td>App Secret</td><td>{diag.hasAppSecret ? 'salvo (cifrado)' : 'não informado'}</td></tr>
            <tr><td>Versão da Graph API</td><td>{diag.graphApiVersion}</td></tr>
            <tr><td>URL do webhook</td><td className="mono">{diag.webhookUrl} <button className="btn sm" onClick={() => copy(diag.webhookUrl, toast)}>Copiar</button></td></tr>
          </tbody></table>
        </Modal>
      )}
    </>
  );
}

function ChannelConfig({ channel, onClose, onSaved }: { channel: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: channel.name, phoneNumberId: channel.phoneNumberId ?? '', wabaId: channel.wabaId ?? '', accessToken: '', appSecret: '' });
  const { busy, run } = useAction();
  const toast = useToast();
  return (
    <Modal title="Configurar WhatsApp Cloud API" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const body: any = { name: f.name, phoneNumberId: f.phoneNumberId || undefined, wabaId: f.wabaId };
        if (f.accessToken) body.accessToken = f.accessToken;
        if (f.appSecret) body.appSecret = f.appSecret;
        const r = await run(() => patch(`/channels/${channel.id}`, body), 'Credenciais salvas (cifradas). Agora clique em "Verificar conexão".');
        if (r) onSaved();
      }}>
        <div className="alert info small">Passo a passo completo no guia <strong>docs/DEPLOY.md</strong>. Você precisa de um app na Meta (developers.facebook.com) com o produto WhatsApp.</div>
        <Field label="Nome do canal"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone Number ID" hint="WhatsApp › Configuração da API › ID do número de telefone"><input inputMode="numeric" value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value.trim() })} /></Field>
        <Field label="WhatsApp Business Account ID (opcional)"><input inputMode="numeric" value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value.trim() })} /></Field>
        <Field label="Token de acesso permanente" hint={channel.hasAccessToken ? `Salvo: ${channel.accessTokenPreview}. Preencha só para trocar.` : 'Token de usuário do sistema com permissão whatsapp_business_messaging'}><input type="password" autoComplete="off" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} /></Field>
        <Field label="App Secret" hint={channel.hasAppSecret ? 'Salvo. Preencha só para trocar.' : 'Configurações do app › Básico › Chave secreta do app (valida a assinatura X-Hub-Signature-256)'}><input type="password" autoComplete="off" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} /></Field>
        <div className="card stack" style={{ padding: 10 }}>
          <strong className="small">Configure o webhook no app da Meta</strong>
          <div className="small">URL de retorno: <span className="mono">{channel.webhookUrl}</span> <button type="button" className="btn sm" onClick={() => copy(channel.webhookUrl, toast)}>Copiar</button></div>
          <div className="small">Token de verificação: <span className="mono">{channel.verifyToken}</span> <button type="button" className="btn sm" onClick={() => copy(channel.verifyToken, toast)}>Copiar</button></div>
          <div className="small muted">Assine o campo <strong>messages</strong>. A URL precisa ser HTTPS pública (seu domínio no Render).</div>
          <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => post(`/channels/${channel.id}/rotate-verify-token`), 'Novo token gerado').then((r) => r && onSaved())}>Gerar novo token de verificação</button>
        </div>
        <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar credenciais'}</button>
      </form>
    </Modal>
  );
}

/** Tela de pareamento: gera o QR e consulta o status a cada 3 segundos. */
function QrConnect({ channel, onClose }: { channel: any; onClose: () => void }) {
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<number | null>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await get(`/channels/${channel.id}/qr`);
        if (!alive) return;
        setInfo(r);
        if (r.status === 'CONNECTED') { toast(`WhatsApp conectado: ${r.phone ?? ''}`, 'ok'); return; }
        if (r.status === 'NOT_CONNECTED' && r.lastError) return; // QR expirou: usuário decide gerar outro
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
      if (alive) timer.current = window.setTimeout(poll, 3000);
    };
    (async () => {
      try {
        const r = await post(`/channels/${channel.id}/qr/start`);
        if (!alive) return;
        setInfo(r);
      } catch (e) {
        if (alive) setErr((e as Error).message);
        return;
      }
      timer.current = window.setTimeout(poll, 1500);
    })();
    return () => { alive = false; if (timer.current) window.clearTimeout(timer.current); };
  }, [channel.id, attempt]);

  const restart = () => { setErr(null); setInfo(null); setAttempt((n) => n + 1); };
  const status = info?.status;

  return (
    <Modal title={`Conectar por QR code — ${channel.name}`} onClose={onClose}>
      <div className="stack">
        {err && <div className="alert warn small">{err}</div>}
        {status === 'CONNECTED' ? (
          <>
            <div className="alert info">✅ WhatsApp conectado{info.phone ? <> ao número <strong>{info.phone}</strong></> : null}. As mensagens recebidas já entram no Inbox, nos fluxos e na IA.</div>
            <button className="btn primary" onClick={onClose}>Concluir</button>
          </>
        ) : (
          <>
            <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Abra o <strong>WhatsApp</strong> no celular do número que você quer conectar.</li>
              <li>Toque em <strong>Mais opções (⋮)</strong> no Android ou <strong>Configurações</strong> no iPhone.</li>
              <li>Toque em <strong>Aparelhos conectados</strong> › <strong>Conectar aparelho</strong>.</li>
              <li>Aponte a câmera do celular para o QR code abaixo.</li>
            </ol>
            <div style={{ display: 'flex', justifyContent: 'center', minHeight: 260, alignItems: 'center' }}>
              {info?.qr ? (
                <img src={info.qr} alt="QR code para conectar o WhatsApp" width={260} height={260} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
              ) : status === 'NOT_CONNECTED' && info?.lastError ? (
                <div className="stack" style={{ alignItems: 'center' }}>
                  <div className="alert warn small">{info.lastError}</div>
                  <button className="btn primary" onClick={restart}>Gerar novo QR code</button>
                </div>
              ) : (
                <span className="muted small">{status === 'CONNECTING' ? 'Conectando ao WhatsApp…' : 'Gerando QR code…'}</span>
              )}
            </div>
            <p className="small muted">O QR code muda sozinho a cada poucos segundos — é normal. Depois de ler, aguarde alguns segundos até aparecer "Conectado". O celular precisa ter o WhatsApp instalado e com internet só para o pareamento; depois a conexão continua mesmo com o celular desligado, mas o WhatsApp desconecta aparelhos se o celular ficar 14 dias sem ser usado.</p>
            <p className="small muted">Atenção: o modo QR não é a API oficial da Meta. Use para atendimento e evite disparos em massa para não ter o número restringido pelo WhatsApp.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
