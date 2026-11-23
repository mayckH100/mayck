/**
 * v1.47.0 — "Voz do vendedor": biblioteca de áudios gravados (a IA escolhe o certo pelo contexto) e voz clonada
 * (a IA responde com áudio na voz do vendedor/responsável). Tela em IA › Voz › "Voz do vendedor" (/ia/voz).
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put, del, uploadAudio, getBlob } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Modal, Field, useAction, fmtDate } from '../ui';
import { fileToWav, startRecording, type Recorder } from '../lib/audioRec';

const SUGESTOES = [
  ['Boas-vindas', 'Primeira mensagem do cliente ou quando ele só diz oi'],
  ['Como funciona', 'Cliente pergunta como funciona o serviço/compra'],
  ['Formas de pagamento', 'Cliente pergunta como pode pagar (Pix, cartão, dinheiro)'],
  ['Entrega e prazo', 'Cliente pergunta sobre entrega, frete ou prazo'],
  ['Horário de atendimento', 'Cliente pergunta que horas abre/fecha'],
  ['Endereço / como chegar', 'Cliente pergunta onde fica a loja'],
  ['Garantia e troca', 'Cliente pergunta sobre garantia, troca ou devolução'],
  ['Está caro / desconto', 'Cliente acha caro ou pede desconto'],
  ['Vou pensar', 'Cliente diz que vai pensar ou responde depois'],
  ['Agradecimento pela compra', 'Cliente confirmou a compra ou o pagamento'],
  ['Pedido de avaliação', 'Depois da entrega, para pedir uma avaliação'],
  ['Retomar contato', 'Cliente sumiu e voltou a falar'],
];
const STATUS: Record<string, { label: string; cls: string }> = {
  AGUARDANDO_AMOSTRA: { label: 'Falta gravar a amostra', cls: 'amber' },
  NA_FILA: { label: 'Na fila do servidor de voz', cls: 'amber' },
  PROCESSANDO: { label: 'Aprendendo a voz…', cls: 'blue' },
  PRONTA: { label: 'Prévia pronta: ouça e ative', cls: 'blue' },
  ATIVA: { label: 'Ativa (a IA usa esta voz)', cls: 'green' },
  ERRO: { label: 'Não deu certo', cls: 'red' },
};
const fmtSeg = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Gravador simples: gravar/parar ou escolher arquivo; devolve WAV. */
function Gravador({ maxSec, minSec = 1, onPronto, label = 'Gravar' }: { maxSec: number; minSec?: number; onPronto: (a: { wav: Blob; seconds: number } | null) => void; label?: string }) {
  const rec = useRef<Recorder | null>(null);
  const [t, setT] = useState(0);
  const [lvl, setLvl] = useState(0);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('');
  useEffect(() => () => { rec.current?.cancel(); if (url) URL.revokeObjectURL(url); }, []);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => {
      const r = rec.current; if (!r) return;
      setT(r.seconds()); setLvl(r.level());
      if (r.seconds() >= maxSec) void parar();
    }, 200);
    return () => clearInterval(id);
  }, [on]);
  const pronto = (a: { wav: Blob; seconds: number }) => {
    if (a.seconds < minSec) { setErr(`Ficou com ${Math.round(a.seconds)} s. O mínimo é ${minSec} s.`); onPronto(null); return; }
    if (a.seconds > maxSec + 2) { setErr(`Passou de ${fmtSeg(maxSec)}. Corte ou grave de novo.`); onPronto(null); return; }
    if (url) URL.revokeObjectURL(url);
    setUrl(URL.createObjectURL(a.wav)); setErr(''); onPronto(a);
  };
  const gravar = async () => {
    setErr(''); onPronto(null);
    try { rec.current = await startRecording(); setT(0); setOn(true); } catch (e) { setErr((e as Error).message); }
  };
  async function parar() {
    const r = rec.current; if (!r) return;
    rec.current = null; setOn(false);
    pronto(await r.stop());
  }
  const arquivo = async (f?: File | null) => {
    if (!f) return;
    setErr('');
    try { pronto(await fileToWav(f)); } catch (e) { setErr((e as Error).message); onPronto(null); }
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {!on ? <button type="button" className="btn" onClick={gravar}>🎙️ {label}</button> : <button type="button" className="btn danger" onClick={() => void parar()}>⏹ Parar ({fmtSeg(t)} / {fmtSeg(maxSec)})</button>}
        {on && <span aria-hidden style={{ display: 'inline-block', width: 80, height: 8, background: '#e5e7eb', borderRadius: 4 }}><span style={{ display: 'block', height: 8, width: `${Math.min(100, lvl * 160)}%`, background: '#16a34a', borderRadius: 4 }} /></span>}
        {!on && <label className="btn sm">📁 Enviar arquivo<input type="file" accept="audio/*,.ogg,.opus,.mp3,.m4a,.wav" hidden onChange={(e) => void arquivo(e.target.files?.[0])} /></label>}
      </div>
      {url && !on && <audio controls src={url} style={{ height: 36, maxWidth: '100%' }} />}
      {err && <div className="alert err small" role="alert">{err}</div>}
    </div>
  );
}

function Tocar({ path }: { path: string }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url) return <audio controls autoPlay src={url} style={{ height: 32, maxWidth: 260 }} />;
  return <button type="button" className="btn sm" disabled={busy} onClick={async () => { setBusy(true); try { setUrl(URL.createObjectURL(await getBlob(path))); } catch { /* sem áudio */ } finally { setBusy(false); } }}>{busy ? '…' : '▶ Ouvir'}</button>;
}

function NovoClip({ onClose, onSaved, sugestao }: { onClose: () => void; onSaved: () => void; sugestao?: string[] }) {
  const [title, setTitle] = useState(sugestao?.[0] ?? '');
  const [when, setWhen] = useState(sugestao?.[1] ?? '');
  const [transcript, setTranscript] = useState('');
  const [audio, setAudio] = useState<{ wav: Blob; seconds: number } | null>(null);
  const { busy, run } = useAction();
  return (
    <Modal title="Novo áudio gravado" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        if (!audio) return;
        const ok = await run(() => uploadAudio('/ai/voz/clips', audio.wav, { 'x-clip-title': title, 'x-clip-when': when, 'x-clip-transcript': transcript }), 'Áudio salvo');
        if (ok) { onSaved(); onClose(); }
      }}>
        <Field label="Nome do áudio"><input required minLength={2} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Formas de pagamento" /></Field>
        <Field label="Quando a IA deve usar" hint="Escreva a situação: a IA lê isto para escolher o áudio certo."><textarea rows={2} maxLength={300} value={when} onChange={(e) => setWhen(e.target.value)} placeholder="Ex.: cliente pergunta como pode pagar" /></Field>
        <Field label="O que você fala no áudio (opcional)" hint="Se deixar em branco, a IA transcreve sozinha. Ajuda a IA a não prometer nada além do que o áudio diz."><textarea rows={2} maxLength={1000} value={transcript} onChange={(e) => setTranscript(e.target.value)} /></Field>
        <Gravador maxSec={120} onPronto={setAudio} />
        <p className="small muted" style={{ margin: 0 }}>Dica: fale natural, como num áudio de WhatsApp, em lugar silencioso. Até 2 minutos. Sai para o cliente como áudio gravado (com o microfone), igual ao que você manda.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !audio || title.trim().length < 2}>{busy ? 'Salvando…' : 'Salvar áudio'}</button>
        </div>
      </form>
    </Modal>
  );
}

function EditarClip({ c, onClose, onSaved }: { c: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ title: c.title, whenToUse: c.whenToUse, transcript: c.transcript });
  const { busy, run } = useAction();
  return (
    <Modal title="Editar áudio" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => put(`/ai/voz/clips/${c.id}`, f), 'Áudio atualizado'); if (ok) { onSaved(); onClose(); } }}>
        <Field label="Nome do áudio"><input required minLength={2} maxLength={80} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Quando a IA deve usar"><textarea rows={2} maxLength={300} value={f.whenToUse} onChange={(e) => setF({ ...f, whenToUse: e.target.value })} /></Field>
        <Field label="O que você fala no áudio"><textarea rows={3} maxLength={1000} value={f.transcript} onChange={(e) => setF({ ...f, transcript: e.target.value })} /></Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy}>Salvar</button></div>
      </form>
    </Modal>
  );
}

function Biblioteca({ d, reload, ro }: { d: any; reload: () => void; ro: boolean }) {
  const [novo, setNovo] = useState<string[] | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const [remove, setRemove] = useState<any>(null);
  const { busy, run } = useAction();
  const titles = new Set((d.clips as any[]).map((c) => c.title.toLowerCase()));
  const faltam = SUGESTOES.filter(([t]) => !titles.has(t.toLowerCase()));
  return (
    <section className="card stack">
      {novo && <NovoClip sugestao={novo} onClose={() => setNovo(null)} onSaved={reload} />}
      {edit && <EditarClip c={edit} onClose={() => setEdit(null)} onSaved={reload} />}
      {remove && (
        <Modal title="Excluir áudio" onClose={() => setRemove(null)}>
          <div className="stack"><p style={{ margin: 0 }}>Excluir o áudio <strong>{remove.title}</strong>? A IA deixa de usá-lo.</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setRemove(null)}>Voltar</button><button className="btn danger" disabled={busy} onClick={async () => { if (await run(() => del(`/ai/voz/clips/${remove.id}`), 'Áudio excluído')) { setRemove(null); reload(); } }}>Excluir</button></div></div>
        </Modal>
      )}
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>🎧 Áudios gravados</h2>
        {!ro && <button className="btn primary" disabled={d.clips.length >= d.limites.maxClips} onClick={() => setNovo([])}>+ Gravar áudio</button>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>Você grava os áudios mais comuns (uns 20) e a IA escolhe o certo pela conversa e manda como áudio gravado, na sua voz de verdade. O que o áudio não cobre, ela escreve logo depois. O mesmo áudio não se repete na mesma conversa. Grátis.</p>
      <label className="row"><input type="checkbox" disabled={ro || busy} checked={!!d.settings.voiceLibraryEnabled} onChange={async (e) => { if (await run(() => put('/ai/voz/biblioteca', { enabled: e.target.checked }), e.target.checked ? 'A IA vai usar os áudios gravados' : 'Áudios gravados desligados')) reload(); }} /> <strong>A IA pode responder com estes áudios</strong></label>
      {!d.settings.enabled && <div className="alert warn small">A IA está desligada. Ligue em <Link to="/ia">Inteligência artificial</Link> para os áudios serem usados.</div>}
      {d.clips.length ? (
        <div className="table-wrap"><table><thead><tr><th>Áudio</th><th>Quando usar</th><th>Duração</th><th>Usos</th><th>Ativo</th><th /></tr></thead><tbody>
          {d.clips.map((c: any) => (
            <tr key={c.id}>
              <td><strong>{c.title}</strong>{c.transcript && <div className="small muted" style={{ maxWidth: 320 }}>“{c.transcript.slice(0, 140)}{c.transcript.length > 140 ? '…' : ''}”</div>}</td>
              <td className="small">{c.whenToUse || '—'}</td>
              <td>{fmtSeg(c.seconds)}</td>
              <td>{c.useCount}{c.lastUsedAt && <div className="small muted">{fmtDate(c.lastUsedAt)}</div>}</td>
              <td><input type="checkbox" aria-label="Ativo" disabled={ro} checked={c.active} onChange={async (e) => { if (await run(() => put(`/ai/voz/clips/${c.id}`, { active: e.target.checked }))) reload(); }} /></td>
              <td><div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><Tocar path={`/ai/voz/clips/${c.id}/audio`} />{!ro && <><button className="btn sm" onClick={() => setEdit(c)}>Editar</button><button className="btn sm danger" onClick={() => setRemove(c)}>Excluir</button></>}</div></td>
            </tr>
          ))}
        </tbody></table></div>
      ) : <p className="muted" style={{ margin: 0 }}>Nenhum áudio ainda. Comece pelos sugeridos abaixo.</p>}
      {!ro && faltam.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small muted">Sugestões para gravar (toque para gravar):</span>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{faltam.map((s) => <button key={s[0]} type="button" className="btn sm" onClick={() => setNovo(s)}>+ {s[0]}</button>)}</div>
        </div>
      )}
    </section>
  );
}

function CadastrarVoz({ d, onClose, onSaved }: { d: any; onClose: () => void; onSaved: () => void }) {
  const [etapa, setEtapa] = useState<1 | 2>(1);
  const [f, setF] = useState({ ownerName: '', ownerRole: 'Vendedor', ownerEmail: '', genero: 'masculina', assinatura: '', aceite: false, souDonoOuTenhoTermo: false });
  const [perfil, setPerfil] = useState<{ id: string; script: string; consentText: string } | null>(null);
  const [amostra, setAmostra] = useState<{ wav: Blob; seconds: number } | null>(null);
  const { busy, run } = useAction();
  const termo = (d.termo.modelo as string).replace('[nome do dono da voz]', f.ownerName || '[nome do dono da voz]');
  return (
    <Modal title="Cadastrar voz clonada" onClose={onClose}>
      {etapa === 1 ? (
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => post('/ai/voz/perfis', { ...f, ownerEmail: f.ownerEmail || undefined }));
          if (r) { setPerfil(r); setEtapa(2); onSaved(); }
        }}>
          <p className="small muted" style={{ margin: 0 }}>Passo 1 de 2 — autorização do dono da voz. A voz é dado pessoal sensível (LGPD): só cadastre com o aceite dele.</p>
          <div className="grid g2">
            <Field label="Nome completo do dono da voz"><input required minLength={5} maxLength={100} value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
            <Field label="Função"><input maxLength={60} value={f.ownerRole} onChange={(e) => setF({ ...f, ownerRole: e.target.value })} placeholder="Vendedor, dono, gerente…" /></Field>
          </div>
          <div className="grid g2">
            <Field label="E-mail do dono da voz (opcional)"><input type="email" maxLength={120} value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
            <Field label="A voz é" hint="Ajuda a deixar a voz criada mais parecida."><select value={f.genero} onChange={(e) => setF({ ...f, genero: e.target.value })}><option value="masculina">Masculina</option><option value="feminina">Feminina</option></select></Field>
          </div>
          <div className="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-soft, #f6f7f9)', padding: 10, borderRadius: 8, maxHeight: 200, overflow: 'auto' }}>{termo}</div>
          <label className="row"><input type="checkbox" checked={f.aceite} onChange={(e) => setF({ ...f, aceite: e.target.checked })} /> O dono da voz leu e aceita o termo acima</label>
          <label className="row"><input type="checkbox" checked={f.souDonoOuTenhoTermo} onChange={(e) => setF({ ...f, souDonoOuTenhoTermo: e.target.checked })} /> Sou o dono da voz, ou ele está aqui e autorizou</label>
          <Field label="Assinatura: o dono da voz digita o nome completo" hint="Precisa ser igual ao nome acima. Fica registrado com data, hora e de onde foi aceito."><input required value={f.assinatura} onChange={(e) => setF({ ...f, assinatura: e.target.value })} /></Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !f.aceite || !f.souDonoOuTenhoTermo}>Aceitar e continuar</button></div>
        </form>
      ) : (
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          if (!amostra || !perfil) return;
          const ok = await run(() => uploadAudio(`/ai/voz/perfis/${perfil.id}/amostra`, amostra.wav), 'Amostra enviada: a voz está sendo criada');
          if (ok) { onSaved(); onClose(); }
        }}>
          <p className="small muted" style={{ margin: 0 }}>Passo 2 de 2 — grave de 1 a 3 minutos (ideal: 2) lendo o texto abaixo, com calma, em lugar silencioso, com o celular a um palmo da boca. A primeira frase é a autorização falada.</p>
          <div style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-soft, #f6f7f9)', padding: 10, borderRadius: 8, maxHeight: 220, overflow: 'auto', lineHeight: 1.5 }}>{perfil?.script}</div>
          <Gravador maxSec={d.limites.maxSample} minSec={d.limites.minSample} onPronto={setAmostra} label="Gravar amostra" />
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Depois</button><button className="btn primary" disabled={busy || !amostra}>{busy ? 'Enviando…' : 'Enviar amostra'}</button></div>
        </form>
      )}
    </Modal>
  );
}

function AmostraDeNovo({ p, d, onClose, onSaved }: { p: any; d: any; onClose: () => void; onSaved: () => void }) {
  const [script, setScript] = useState('');
  const [amostra, setAmostra] = useState<{ wav: Blob; seconds: number } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { get(`/ai/voz/perfis/${p.id}/termo`).then((r: any) => setScript(r.script)).catch(() => undefined); }, [p.id]);
  return (
    <Modal title={`Amostra da voz de ${p.ownerName}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (!amostra) return; if (await run(() => uploadAudio(`/ai/voz/perfis/${p.id}/amostra`, amostra.wav), 'Amostra enviada')) { onSaved(); onClose(); } }}>
        <p className="small muted" style={{ margin: 0 }}>Grave de 1 a 3 minutos lendo o texto, em lugar silencioso.</p>
        <div style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-soft, #f6f7f9)', padding: 10, borderRadius: 8, maxHeight: 220, overflow: 'auto', lineHeight: 1.5 }}>{script}</div>
        <Gravador maxSec={d.limites.maxSample} minSec={d.limites.minSample} onPronto={setAmostra} label="Gravar amostra" />
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !amostra}>Enviar amostra</button></div>
      </form>
    </Modal>
  );
}

function VozClonada({ d, reload, ro }: { d: any; reload: () => void; ro: boolean }) {
  const [novo, setNovo] = useState(false);
  const [amostra, setAmostra] = useState<any>(null);
  const [excluir, setExcluir] = useState<any>(null);
  const [motivo, setMotivo] = useState('Pedido do dono da voz');
  const { busy, run } = useAction();
  const w = d.worker;
  // Atualiza sozinho enquanto alguma voz está sendo criada.
  const andamento = (d.profiles as any[]).some((p) => p.status === 'NA_FILA' || p.status === 'PROCESSANDO');
  useEffect(() => { if (!andamento) return; const id = setInterval(reload, 8000); return () => clearInterval(id); }, [andamento]);
  return (
    <section className="card stack">
      {novo && <CadastrarVoz d={d} onClose={() => setNovo(false)} onSaved={reload} />}
      {amostra && <AmostraDeNovo p={amostra} d={d} onClose={() => setAmostra(null)} onSaved={reload} />}
      {excluir && (
        <Modal title="Excluir voz clonada" onClose={() => setExcluir(null)}>
          <div className="stack">
            <p style={{ margin: 0 }}>Apagar a voz de <strong>{excluir.ownerName}</strong>? A amostra, a voz criada e os áudios guardados são apagados agora. Fica só o registro do aceite e da exclusão (LGPD). Não dá para desfazer.</p>
            <Field label="Motivo"><input maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Field>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setExcluir(null)}>Voltar</button><button className="btn danger" disabled={busy} onClick={async () => { if (await run(() => post(`/ai/voz/perfis/${excluir.id}/excluir`, { motivo }), 'Voz excluída')) { setExcluir(null); reload(); } }}>Excluir voz</button></div>
          </div>
        </Modal>
      )}
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>🗣️ Voz clonada</h2>
        {!ro && <button className="btn primary" disabled={d.profiles.length >= d.limites.maxProfiles} onClick={() => setNovo(true)}>+ Cadastrar voz</button>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>A IA responde com áudio na voz do vendedor ou do responsável, falando qualquer resposta. Roda no nosso próprio servidor de voz (sem serviço pago, a amostra não sai da MCK). Precisa do aceite por escrito do dono da voz e de 1 a 3 minutos de gravação. Você ouve a prévia antes de ativar e pode excluir quando quiser.</p>
      <div className={`alert small ${w.online ? 'ok' : 'warn'}`} role="status">
        {!w.configured ? 'Servidor de voz ainda não ligado. Você já pode cadastrar a voz: ela é criada assim que o servidor for ligado. Até lá a IA responde por texto (ou com os áudios gravados).'
          : !w.online ? 'Servidor de voz fora do ar agora. As respostas vão por texto (ou áudio gravado) até ele voltar; nada se perde.'
          : `Servidor de voz no ar${w.pronto ? '' : ' (carregando o modelo)'}${w.fila ? ` · ${w.fila} na fila` : ''}.`}
      </div>
      {d.profiles.length ? (
        <div className="table-wrap"><table><thead><tr><th>Dono da voz</th><th>Situação</th><th>Amostra</th><th>Aceite</th><th /></tr></thead><tbody>
          {d.profiles.map((p: any) => (
            <tr key={p.id}>
              <td><strong>{p.ownerName}</strong><div className="small muted">{p.ownerRole}</div></td>
              <td><span className={`badge ${STATUS[p.status]?.cls ?? ''}`}>{STATUS[p.status]?.label ?? p.status}</span>{p.error && <div className="small muted" style={{ maxWidth: 280 }}>{p.error === 'remover_no_servidor' ? '' : p.error}</div>}</td>
              <td>{p.sampleSeconds ? fmtSeg(p.sampleSeconds) : '—'}</td>
              <td className="small">{fmtDate(p.consentAt)}</td>
              <td><div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {p.hasPreview && <Tocar path={`/ai/voz/perfis/${p.id}/previa`} />}
                {!ro && p.status === 'PRONTA' && <button className="btn sm primary" disabled={busy} onClick={async () => { if (await run(() => post(`/ai/voz/perfis/${p.id}/ativar`), 'Voz ativada: a IA vai responder com áudio nesta voz')) reload(); }}>Ativar</button>}
                {!ro && (p.status === 'AGUARDANDO_AMOSTRA' || p.status === 'ERRO' || p.status === 'PRONTA') && <button className="btn sm" onClick={() => setAmostra(p)}>{p.status === 'AGUARDANDO_AMOSTRA' ? 'Gravar amostra' : 'Gravar de novo'}</button>}
                {!ro && p.status === 'ERRO' && p.sampleSeconds > 0 && <button className="btn sm" disabled={busy} onClick={async () => { if (await run(() => post(`/ai/voz/perfis/${p.id}/reprocessar`), 'Tentando de novo')) reload(); }}>Tentar de novo</button>}
                {!ro && <button className="btn sm danger" onClick={() => setExcluir(p)}>Excluir</button>}
              </div></td>
            </tr>
          ))}
        </tbody></table></div>
      ) : <p className="muted" style={{ margin: 0 }}>Nenhuma voz cadastrada.</p>}
      {d.profiles.some((p: any) => p.status === 'ATIVA') && <p className="small muted" style={{ margin: 0 }}>Com a voz ativa, o motor da voz em <Link to="/ia">IA › Voz</Link> fica “Voz clonada”. “Quando responder em áudio” continua valendo (espelhar, sempre ou nunca). Se o servidor de voz demorar ou cair, a resposta vai por texto.</p>}
    </section>
  );
}

export default function VozVendedor() {
  const state = useApi<any>('/ai/voz');
  const { can } = useAuth();
  const ro = !can('OWNER', 'ADMIN');
  return (
    <div className="stack">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>Voz do vendedor</h1>
        <Link to="/ia" className="btn sm">← Inteligência artificial</Link>
      </div>
      {ro ? <div className="alert warn">Só o Proprietário ou um Admin pode gravar áudios e cadastrar vozes.</div> : (
        <Async state={state}>{(d) => (
          <>
            <Biblioteca d={d} reload={state.reload} ro={ro} />
            <VozClonada d={d} reload={state.reload} ro={ro} />
          </>
        )}</Async>
      )}
    </div>
  );
}
