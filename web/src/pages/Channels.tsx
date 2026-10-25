import { useState } from 'react';
import { post, patch, del } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, fmtDate, StatusBadge, useToast, copy } from '../ui';

export default function Channels() {
  const state = useApi<any[]>('/channels');
  const { can } = useAuth();
  const admin = can('OWNER', 'ADMIN');
  const [cfg, setCfg] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  return (
    <>
      <div className="page-head">
        <div><h1>Canais WhatsApp</h1><p className="muted">Conexão pela <strong>API oficial</strong> (WhatsApp Cloud API da Meta). Sem QR Code, sem risco de banimento por automação não oficial.</p></div>
        {admin && <button className="btn primary" disabled={busy} onClick={() => run(() => post('/channels', { name: 'WhatsApp principal' }), 'Canal criado — agora configure as credenciais').then(state.reload)}>+ Adicionar número</button>}
      </div>
      <Async state={state}>{(list) => list.length === 0 ? (
        <div className="card"><Empty title="Nenhum número configurado">Adicione um número e informe as credenciais da sua conta WhatsApp Business (Meta). Enquanto isso, o status fica "não conectado" e nada é enviado.</Empty></div>
      ) : (
        <div className="grid g2">
          {list.map((c) => (
            <div key={c.id} className="card stack">
              <div className="row between"><strong>{c.name}</strong><StatusBadge status={c.status} /></div>
              <div className="small">{c.displayPhone ?? 'Número ainda não verificado'}{c.phoneNumberId && <span className="muted"> · Phone Number ID {c.phoneNumberId}</span>}</div>
              {c.status !== 'CONNECTED' && <div className="alert warn small">Não conectado: {c.lastError ?? 'preencha as credenciais e clique em "Verificar conexão".'}</div>}
              <div className="grid g4" style={{ gap: 8 }}>
                {[['Hoje', c.stats.today], ['7 dias', c.stats.d7], ['30 dias', c.stats.d30], ['Total', c.stats.total]].map(([l, v]) => <div key={l as string} className="stat"><div className="l">{l}</div><div className="v" style={{ fontSize: 18 }}>{v}</div></div>)}
              </div>
              {admin && (
                <div className="row">
                  <button className="btn sm primary" onClick={() => setCfg(c)}>Configurações</button>
                  <button className="btn sm" disabled={busy} onClick={() => run(() => post(`/channels/${c.id}/verify`)).then((r) => { state.reload(); if (r) toast(r.status === 'CONNECTED' ? 'Conexão verificada com a Meta' : `Falha na verificação: ${r.lastError}`, r.status === 'CONNECTED' ? 'ok' : 'err'); })}>Verificar conexão</button>
                  <button className="btn sm" onClick={() => setDiag(c)}>Diagnóstico</button>
                  {c.status === 'CONNECTED' && <button className="btn sm" disabled={busy} onClick={() => { if (confirm('Desconectar? O token de acesso será apagado.')) run(() => post(`/channels/${c.id}/disconnect`), 'Canal desconectado').then(state.reload); }}>Desconectar</button>}
                  <button className="btn sm danger" disabled={busy} onClick={() => { if (confirm('Excluir este canal?')) run(() => del(`/channels/${c.id}`), 'Canal excluído').then(state.reload); }}>Excluir</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}</Async>
      {cfg && (
        <ChannelConfig channel={cfg} onClose={() => setCfg(null)} onSaved={() => { setCfg(null); state.reload(); }} />
      )}
      {diag && (
        <Modal title={`Diagnóstico — ${diag.name}`} onClose={() => setDiag(null)}>
          <table className="small"><tbody>
            <tr><td>Status</td><td><StatusBadge status={diag.status} /></td></tr>
            <tr><td>Último erro</td><td>{diag.lastError ?? '—'}</td></tr>
            <tr><td>Último webhook recebido</td><td>{fmtDate(diag.lastWebhookAt)}</td></tr>
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
