import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, post } from '../api';
import { useApi, Async, Empty, Field, fmtDate, useAction } from '../ui';

// ---------- Tipos ----------
type Provider = 'instagram' | 'youtube' | 'linkedin' | 'tiktok';
type Target = 'site' | Provider;
interface Account {
  provider: Provider; label: string; configured: boolean; message: string | null; connected: boolean;
  accountId: string | null; accountName: string | null; expiresAt: string | null; connectedAt: string | null;
}
interface TargetResult { ok: boolean; id?: string | null; url?: string | null; note?: string; error?: string; at: string }
interface SocialPost {
  id: string; title: string; body: string; mediaUrl: string | null; mediaType: 'image' | 'video' | null; targets: Target[];
  status: 'draft' | 'approved' | 'published' | 'partial' | 'failed'; results: Partial<Record<Target, TargetResult>>;
  publishedAt: string | null; createdAt: string;
}

const TARGET_LABEL: Record<Target, string> = { site: 'Site (/empresa/novidades)', instagram: 'Instagram', youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok' };
const SHORT: Record<Target, string> = { site: 'Site', instagram: 'Instagram', youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok' };
const STATUS: Record<SocialPost['status'], [string, string]> = {
  draft: ['', 'Rascunho'], approved: ['blue', 'Publicando…'], published: ['green', 'Publicado'], partial: ['amber', 'Publicado em parte'], failed: ['red', 'Falhou'],
};
/** Rota OAuth de cada rede (o Instagram conecta pelo Facebook Login). */
const CONNECT: Record<Provider, string> = { instagram: '/api/social/meta/connect', youtube: '/api/social/youtube/connect', linkedin: '/api/social/linkedin/connect', tiktok: '/api/social/tiktok/connect' };

// ---------- Contas ----------
function Connections({ state }: { state: ReturnType<typeof useApi<{ accounts: Account[] }>> }) {
  const { busy, run } = useAction();
  return (
    <div className="card stack">
      <div><h2 style={{ margin: 0 }}>Redes conectadas</h2><p className="small muted" style={{ margin: 0 }}>Conecte as contas oficiais da empresa. Os acessos ficam cifrados no servidor.</p></div>
      <Async state={state}>{(d) => (
        <div className="table-wrap"><table>
          <thead><tr><th>Rede</th><th>Situação</th><th>Conta</th><th></th></tr></thead>
          <tbody>{d.accounts.map((a) => (
            <tr key={a.provider}>
              <td><strong>{a.label}</strong></td>
              <td>
                {a.connected ? <span className="badge green">Conectado</span> : a.configured ? <span className="badge">Não conectado</span> : <span className="badge amber">Não configurado</span>}
                {!a.configured && a.message && <div className="small muted">{a.message}</div>}
                {a.expiresAt && <div className="small muted">Acesso válido até {fmtDate(a.expiresAt)}</div>}
              </td>
              <td className="small">{a.accountName ?? '—'}</td>
              <td>
                <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  {a.configured && <a className="btn sm primary" href={CONNECT[a.provider]}>{a.connected ? 'Reconectar' : 'Conectar'}</a>}
                  {a.connected && (
                    <button className="btn sm danger" disabled={busy} onClick={async () => {
                      if (!confirm(`Desconectar ${a.label}? As próximas publicações não irão para essa rede.`)) return;
                      if (await run(() => del(`/social/accounts/${a.provider}`), `${a.label} desconectado`)) state.reload();
                    }}>Desconectar</button>
                  )}
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}</Async>
    </div>
  );
}

// ---------- Nova publicação ----------
interface Draft { title: string; body: string; mediaUrl: string; mediaType: '' | 'image' | 'video'; targets: Target[] }
const EMPTY: Draft = { title: '', body: '', mediaUrl: '', mediaType: '', targets: ['site'] };

function NewPost({ accounts, onCreated }: { accounts: Account[]; onCreated: () => void }) {
  const [f, setF] = useState<Draft>(EMPTY);
  const { busy, run } = useAction();
  const available = (t: Target) => t === 'site' || !!accounts.find((a) => a.provider === t && a.connected);
  const toggle = (t: Target) => setF({ ...f, targets: f.targets.includes(t) ? f.targets.filter((x) => x !== t) : [...f.targets, t] });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const media = f.mediaUrl.trim();
    const r = await run(() => post('/social/posts', { title: f.title, body: f.body, mediaUrl: media || null, mediaType: media ? f.mediaType || null : null, targets: f.targets }), 'Rascunho salvo. Revise e clique em "Aprovar e publicar".');
    if (r) { setF(EMPTY); onCreated(); }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <div><h2 style={{ margin: 0 }}>Nova publicação</h2><p className="small muted" style={{ margin: 0 }}>Toda publicação começa como rascunho e só vai para as redes depois de você aprovar.</p></div>
      <Field label="Título"><input required maxLength={150} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex.: Nova função: IA que marca reuniões" /></Field>
      <Field label="Texto" hint="Vira a legenda (Instagram/LinkedIn) e a descrição (YouTube)."><textarea rows={5} maxLength={5000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      <div className="grid g2">
        <Field label="URL da imagem ou do vídeo" hint="Link público https (o Instagram e o YouTube baixam a mídia desse endereço)."><input type="url" value={f.mediaUrl} onChange={(e) => setF({ ...f, mediaUrl: e.target.value })} placeholder="https://..." /></Field>
        <Field label="Tipo da mídia">
          <select value={f.mediaType} onChange={(e) => setF({ ...f, mediaType: e.target.value as Draft['mediaType'] })}>
            <option value="">Sem mídia</option><option value="image">Imagem</option><option value="video">Vídeo</option>
          </select>
        </Field>
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <span className="small"><strong>Publicar em</strong></span>
        <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
          {(['site', 'instagram', 'youtube', 'linkedin', 'tiktok'] as Target[]).map((t) => (
            <label key={t} className="row small" title={available(t) ? '' : 'Conecte a rede acima para publicar nela'}>
              <input type="checkbox" checked={f.targets.includes(t)} disabled={!available(t) && !f.targets.includes(t)} onChange={() => toggle(t)} /> {TARGET_LABEL[t]}{!available(t) && ' (não conectado)'}
            </label>
          ))}
        </div>
        <span className="small muted">Instagram exige imagem ou vídeo; YouTube exige vídeo. Vídeos no YouTube podem ficar privados enquanto o app não for verificado pelo Google.</span>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={busy || !f.targets.length}>{busy ? 'Salvando…' : 'Salvar rascunho'}</button>
      </div>
    </form>
  );
}

// ---------- Histórico ----------
function Results({ p }: { p: SocialPost }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      {p.targets.map((t) => {
        const r = p.results[t];
        return (
          <div key={t} className="small">
            <strong>{SHORT[t]}:</strong>{' '}
            {!r ? <span className="muted">{p.status === 'approved' ? 'publicando…' : 'pendente'}</span>
              : r.ok ? <><span className="badge green">OK</span>{r.url && <> <a href={r.url} target="_blank" rel="noopener">ver</a></>}{r.note && <span className="muted"> · {r.note}</span>}</>
                : <><span className="badge red">Erro</span> <span className="muted">{r.error}</span></>}
          </div>
        );
      })}
    </div>
  );
}

function History({ state }: { state: ReturnType<typeof useApi<{ items: SocialPost[] }>> }) {
  const { busy, run } = useAction();
  const publishing = !!state.data?.items.some((p) => p.status === 'approved');
  // Enquanto houver publicação em andamento, atualiza a lista sozinho.
  useEffect(() => {
    if (!publishing) return;
    const t = setInterval(() => state.reload(), 4000);
    return () => clearInterval(t);
  }, [publishing, state.reload]);
  const publish = async (p: SocialPost) => {
    const retry = p.status !== 'draft';
    const msg = retry
      ? `Tentar publicar de novo "${p.title}" nos destinos que falharam?`
      : `Aprovar e publicar "${p.title}" em: ${p.targets.map((t) => SHORT[t]).join(', ')}?\n\nIsso publica de verdade nas redes da empresa.`;
    if (!confirm(msg)) return;
    if (await run(() => post(`/social/posts/${p.id}/publish`, { confirm: true }), 'Publicação aprovada. Publicando…')) state.reload();
  };
  return (
    <div className="card stack">
      <div className="row between"><h2 style={{ margin: 0 }}>Publicações</h2><button className="btn sm" onClick={state.reload}>Atualizar</button></div>
      <Async state={state}>{(d) => d.items.length === 0 ? <Empty title="Nenhuma publicação ainda"><p>Crie a primeira acima.</p></Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Criada</th><th>Publicação</th><th>Status</th><th>Resultado por destino</th><th></th></tr></thead>
          <tbody>{d.items.map((p) => (
            <tr key={p.id}>
              <td className="small">{fmtDate(p.createdAt)}{p.publishedAt && <div className="muted">publicada {fmtDate(p.publishedAt)}</div>}</td>
              <td style={{ maxWidth: 320 }}>
                <strong>{p.title}</strong>
                {p.body && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{p.body.length > 160 ? p.body.slice(0, 160) + '…' : p.body}</div>}
                {p.mediaUrl && <div className="small"><a href={p.mediaUrl} target="_blank" rel="noopener">{p.mediaType === 'video' ? 'Vídeo' : 'Imagem'}</a></div>}
              </td>
              <td><span className={`badge ${STATUS[p.status][0]}`}>{STATUS[p.status][1]}</span></td>
              <td><Results p={p} /></td>
              <td>
                <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  {p.status === 'draft' && <button className="btn sm primary" disabled={busy} onClick={() => publish(p)}>Aprovar e publicar</button>}
                  {(p.status === 'failed' || p.status === 'partial') && <button className="btn sm" disabled={busy} onClick={() => publish(p)}>Tentar de novo</button>}
                  {p.status !== 'approved' && (
                    <button className="btn sm danger" disabled={busy} onClick={async () => {
                      if (!confirm(p.status === 'draft' ? 'Excluir este rascunho?' : 'Excluir do histórico? Ela sai do site /empresa/novidades (nas redes, apague por lá).')) return;
                      if (await run(() => del(`/social/posts/${p.id}`), 'Publicação excluída')) state.reload();
                    }}>Excluir</button>
                  )}
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}</Async>
    </div>
  );
}

// ---------- Aba ----------
export default function NovidadesTab() {
  const [sp] = useSearchParams();
  const accounts = useApi<{ accounts: Account[] }>('/social/accounts');
  const posts = useApi<{ items: SocialPost[] }>('/social/posts');
  const social = sp.get('social');
  const msg = sp.get('msg');
  const rede = sp.get('rede') as Provider | null;
  return (
    <div className="stack">
      {social === 'ok' && <div className="alert ok">{rede ? SHORT[rede] ?? rede : 'Rede'} conectado com sucesso.</div>}
      {social === 'erro' && <div className="alert err">Não foi possível conectar{rede ? ` o ${SHORT[rede] ?? rede}` : ''}: {msg ?? 'erro desconhecido'}</div>}
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <p className="muted small" style={{ margin: 0 }}>Publique novidades da empresa no site e nas redes sociais oficiais, com aprovação antes de cada envio.</p>
        <a className="btn sm" href="/empresa/novidades" target="_blank" rel="noopener">Ver no site</a>
      </div>
      <Connections state={accounts} />
      {accounts.data && <NewPost accounts={accounts.data.accounts} onCreated={posts.reload} />}
      <History state={posts} />
    </div>
  );
}
