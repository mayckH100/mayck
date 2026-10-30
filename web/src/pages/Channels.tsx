import { useEffect, useRef, useState, type FormEvent } from 'react';
import { get, post, patch, del } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, fmtDate, StatusBadge, useToast, copy } from '../ui';

/** "Quem responde automaticamente" no canal: só fluxos, só IA, ou fluxos + IA (padrão). */
const AUTO_REPLY_OPTIONS: { v: 'flows' | 'ai' | 'both'; label: string; help: string }[] = [
  { v: 'flows', label: 'Só fluxos', help: 'Só os fluxos respondem as mensagens deste número; a IA nunca responde sozinha.' },
  { v: 'ai', label: 'Só IA', help: 'Nenhum fluxo é disparado neste número; só a IA responde (quando estiver ligada em IA).' },
  { v: 'both', label: 'Fluxos + IA', help: 'Padrão: os fluxos respondem primeiro e a IA responde o que nenhum fluxo pegar.' },
];

function AutoReplyModeSelector({ c, admin, busy, onPick }: { c: any; admin: boolean; busy: boolean; onPick: (v: string, label: string) => void }) {
  const current = c.autoReplyMode ?? 'both';
  return (
    <div className="stack small" style={{ gap: 6 }} title={admin ? undefined : 'Só Proprietário ou Administrador pode alterar'}>
      <strong>Quem responde automaticamente</strong>
      <div className="row" role="radiogroup" aria-label="Quem responde automaticamente" style={{ gap: 4, flexWrap: 'wrap' }}>
        {AUTO_REPLY_OPTIONS.map((o) => (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={current === o.v}
            className={`btn sm${current === o.v ? ' primary' : ''}`}
            disabled={!admin || busy}
            onClick={() => { if (current !== o.v) onPick(o.v, o.label); }}
          >{o.label}</button>
        ))}
      </div>
      <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
        {AUTO_REPLY_OPTIONS.map((o) => <li key={o.v} style={current === o.v ? { fontWeight: 600 } : undefined}>{o.label}: {o.help}</li>)}
      </ul>
    </div>
  );
}

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
        <div><h1>Canais WhatsApp</h1><p className="muted">Conecte seu número pelo <strong>QR code</strong> ou pelo <strong>código de 8 caracteres</strong> (Conectar com número de telefone), do mesmo jeito que o WhatsApp Web. A API oficial da Meta continua disponível como opção avançada.</p></div>
        {admin && <button className="btn primary" disabled={busy} onClick={() => run(() => post('/channels', { name: 'WhatsApp principal', provider: 'whatsapp_qr' }), 'Canal criado — agora clique em "Conectar WhatsApp"').then(state.reload)}>+ Adicionar número</button>}
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
                  <label className="row small" style={{ gap: 8, alignItems: 'flex-start', cursor: admin ? 'pointer' : 'default' }} title={admin ? undefined : 'Só Proprietário ou Administrador pode alterar'}>
                    <input
                      type="checkbox"
                      checked={!!c.replySavedContacts}
                      disabled={!admin || busy}
                      onChange={(e) => { const v = e.target.checked; run(() => patch(`/channels/${c.id}`, { replySavedContacts: v }), v ? 'O robô vai responder todos os contatos' : 'O robô não vai responder contatos salvos na agenda do celular').then(state.reload); }}
                    />
                    <span>
                      <strong>Responder contatos salvos na agenda do celular</strong>
                      <span className="muted" style={{ display: 'block' }}>
                        {c.replySavedContacts
                          ? 'O robô, a IA e os fluxos respondem todo mundo.'
                          : 'Desmarcado: quem está salvo na agenda do celular conectado não recebe resposta automática (a mensagem aparece no Inbox para você responder). Contatos não salvos continuam recebendo.'}
                        {c.addressBook && (c.addressBook.syncedAt || c.addressBook.savedContacts > 0)
                          ? ` · ${c.addressBook.savedContacts} contato(s) salvo(s) sincronizado(s).`
                          : (c.status === 'CONNECTED' ? ' · Sincronizando a agenda do celular (pode levar 1–2 minutos após conectar).' : '')}
                      </span>
                    </span>
                  </label>
                </>
              ) : (
                <>
                  <div className="small">{c.displayPhone ?? 'Número ainda não verificado'}{c.phoneNumberId && <span className="muted"> · Phone Number ID {c.phoneNumberId}</span>} <span className="badge">API oficial</span></div>
                  {c.status !== 'CONNECTED' && <div className="alert warn small">Não conectado: {c.lastError ?? 'preencha as credenciais e clique em "Verificar conexão".'}</div>}
                </>
              )}
              <AutoReplyModeSelector c={c} admin={admin} busy={busy} onPick={(v, label) => run(() => patch(`/channels/${c.id}`, { autoReplyMode: v }), `Quem responde automaticamente: ${label}`).then(state.reload)} />
              <div className="grid g4" style={{ gap: 8 }}>
                {[['Hoje', c.stats.today], ['7 dias', c.stats.d7], ['30 dias', c.stats.d30], ['Total', c.stats.total]].map(([l, v]) => <div key={l as string} className="stat"><div className="l">{l}</div><div className="v" style={{ fontSize: 18 }}>{v}</div></div>)}
              </div>
              {admin && (
                <div className="row">
                  {c.status !== 'CONNECTED' && <button className="btn sm primary" onClick={() => setQrFor(c)}>Conectar WhatsApp</button>}
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

/** Tela de conexão: duas abas — QR code ou código de pareamento pelo número (igual ao WhatsApp Web). */
function QrConnect({ channel, onClose }: { channel: any; onClose: () => void }) {
  const [tab, setTab] = useState<'qr' | 'code'>('qr');
  const [connected, setConnected] = useState<any>(null);
  return (
    <Modal title={`Conectar WhatsApp — ${channel.name}`} onClose={onClose}>
      <div className="stack">
        {connected ? (
          <>
            <div className="alert info">✅ WhatsApp conectado{connected.phone ? <> ao número <strong>{connected.phone}</strong></> : null}. As mensagens recebidas já entram no Inbox, nos fluxos e na IA.</div>
            <button className="btn primary" onClick={onClose}>Concluir</button>
          </>
        ) : (
          <>
            <div className="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'qr'} className={tab === 'qr' ? 'on' : ''} onClick={() => setTab('qr')}>QR code</button>
              <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>Código pelo número</button>
            </div>
            {tab === 'qr' ? <QrTab channel={channel} onConnected={setConnected} /> : <CodeTab channel={channel} onConnected={setConnected} />}
            <p className="small muted">Atenção: esta conexão não é a API oficial da Meta. Use para atendimento e evite disparos em massa para não ter o número restringido pelo WhatsApp. Depois de conectar, o WhatsApp desconecta aparelhos se o celular ficar 14 dias sem ser usado.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Aba QR code: gera o QR e consulta o status a cada 3 segundos. */
function QrTab({ channel, onConnected }: { channel: any; onConnected: (r: any) => void }) {
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
        if (r.status === 'CONNECTED') { toast(`WhatsApp conectado: ${r.phone ?? ''}`, 'ok'); onConnected(r); return; }
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
        if (r.status === 'CONNECTED') { onConnected(r); return; }
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
    <>
      {err && <div className="alert warn small">{err}</div>}
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
      <p className="small muted">O QR code muda sozinho a cada poucos segundos — é normal. Depois de ler, aguarde alguns segundos até aparecer "Conectado". Sem câmera ou lendo pelo próprio celular? Use a aba <strong>Código pelo número</strong>.</p>
    </>
  );
}

/** Valida DDI + número no navegador (o servidor valida de novo). */
function checkPairingPhone(ddi: string, number: string): string | null {
  const d = ddi.replace(/\D/g, ''), n = number.replace(/\D/g, '');
  if (!d) return 'Informe o DDI (código do país). Brasil: 55.';
  if (!n) return 'Informe o DDD e o número.';
  const all = d + n;
  if (all.length < 10 || all.length > 15) return 'Número inválido: confira DDD e número.';
  if (d === '55') {
    if (n.length !== 10 && n.length !== 11) return 'Use DDD + número, ex.: 11 99999-0000.';
    const ddd = Number(n.slice(0, 2));
    if (ddd < 11 || ddd % 10 === 0) return 'DDD inválido.';
    if (n.length === 11 && n[2] !== '9') return 'Celular com 9 dígitos deve começar com 9 depois do DDD.';
  }
  return null;
}

/** Aba "Código pelo número": pede o código de 8 caracteres e mostra com contagem de validade. */
function CodeTab({ channel, onConnected }: { channel: any; onConnected: (r: any) => void }) {
  const [ddi, setDdi] = useState('55');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ code: string; expiresAt: string; phone: string; remaining?: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [ended, setEnded] = useState<string | null>(null);
  const toast = useToast();
  const timer = useRef<number | null>(null);

  // Contagem regressiva + consulta do status enquanto o código estiver na tela.
  useEffect(() => {
    if (!res) return;
    let alive = true;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = async () => {
      try {
        const r = await get(`/channels/${channel.id}/qr`);
        if (!alive) return;
        if (r.status === 'CONNECTED') { toast(`WhatsApp conectado: ${r.phone ?? ''}`, 'ok'); onConnected(r); return; }
        if (!r.pairing && r.status !== 'CONNECTING') { setEnded(r.lastError ?? 'Este código não vale mais. Gere outro código.'); return; }
      } catch { /* tenta de novo */ }
      if (alive) timer.current = window.setTimeout(poll, 3000);
    };
    timer.current = window.setTimeout(poll, 3000);
    return () => { alive = false; window.clearInterval(tick); if (timer.current) window.clearTimeout(timer.current); };
  }, [res?.code, channel.id]);

  const generate = async (e?: FormEvent) => {
    e?.preventDefault();
    const invalid = checkPairingPhone(ddi, number);
    if (invalid) { setErr(invalid); return; }
    setBusy(true); setErr(null); setEnded(null);
    try {
      const r = await post(`/channels/${channel.id}/qr/pairing-code`, { phone: `+${ddi.replace(/\D/g, '')}${number.replace(/\D/g, '')}` });
      setRes(r); setNow(Date.now());
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const left = res ? Math.max(0, Math.round((new Date(res.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = !!res && (left === 0 || !!ended);

  return (
    <>
      {!res ? (
        <form className="stack" onSubmit={generate}>
          <p className="small" style={{ margin: 0 }}>Digite o número do WhatsApp que você quer conectar. Vamos gerar um código de 8 caracteres para digitar no celular — sem precisar ler QR code.</p>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label="DDI"><input aria-label="DDI" inputMode="numeric" style={{ width: 70 }} value={`+${ddi}`} onChange={(e) => setDdi(e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
            <div style={{ flex: 1 }}><Field label="DDD + número" hint="Ex.: 11 99999-0000"><input aria-label="DDD e número" inputMode="tel" autoComplete="tel-national" placeholder="11 99999-0000" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d\s()-]/g, '').slice(0, 20))} /></Field></div>
          </div>
          {err && <div className="alert warn small">{err}</div>}
          <button className="btn primary" disabled={busy}>{busy ? 'Gerando código… (até 20 s)' : 'Gerar código'}</button>
        </form>
      ) : (
        <div className="stack">
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>No celular do número <strong>{res.phone}</strong>, abra o <strong>WhatsApp</strong>.</li>
            <li>Toque em <strong>Mais opções (⋮)</strong> no Android ou <strong>Configurações</strong> no iPhone › <strong>Aparelhos conectados</strong> › <strong>Conectar aparelho</strong>.</li>
            <li>Toque em <strong>Conectar com número de telefone</strong> e digite o código abaixo.</li>
          </ol>
          <p className="small muted" style={{ margin: 0 }}>Se o celular disser que o número está incorreto, toque em <strong>Trocar número</strong> e digite sem o 9 extra depois do DDD (algumas contas antigas do WhatsApp usam o número com 8 dígitos).</p>
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div className="mono" aria-label="Código de pareamento" style={{ fontSize: 34, fontWeight: 700, letterSpacing: 4, opacity: expired ? 0.35 : 1, userSelect: 'all' }}>{res.code}</div>
            {expired ? (
              <div className="alert warn small" style={{ marginTop: 8 }}>{ended ?? 'O código expirou. Gere outro código.'}</div>
            ) : (
              <div className="small muted" style={{ marginTop: 6 }}>Válido por mais {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · aguardando você digitar no celular…</div>
            )}
          </div>
          <div className="row" style={{ justifyContent: 'center' }}>
            {!expired && <button type="button" className="btn sm" onClick={() => copy(res.code.replace('-', ''), toast)}>Copiar código</button>}
            <button type="button" className={`btn sm${expired ? ' primary' : ''}`} disabled={busy} onClick={() => generate()}>{busy ? 'Gerando…' : 'Gerar outro código'}</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => { setRes(null); setEnded(null); setErr(null); }}>Trocar número</button>
          </div>
          {err && <div className="alert warn small">{err}</div>}
          <p className="small muted">Gerar outro código invalida o anterior. Limite: 5 códigos por hora por canal{typeof res.remaining === 'number' ? ` (restam ${res.remaining})` : ''}.</p>
        </div>
      )}
    </>
  );
}
