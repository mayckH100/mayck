import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AI_TEMPLATES, aiTemplateById } from '../lib/aiTemplates';
import { post, put, del, get, postBlob } from '../api';
import { useAuth } from '../auth';
import { useApi, Async, Empty, useAction, Modal, Field, fmtDate, fmtNum } from '../ui';

// Padrão Gemini: modelo recomendado pelo Google para projetos novos (out/2026), disponível no plano gratuito.
const MODELS: Record<string, string> = { gemini: 'gemini-3.5-flash-lite', openai: '', mck: 'mck-ia' };

export default function Ai() {
  const [sp0] = useSearchParams();
  const [tab, setTab] = useState<'config' | 'kb' | 'test' | 'usage'>(sp0.get('aba') === 'testar' ? 'test' : 'config');
  return (
    <>
      <div className="page-head"><div><h1>Inteligência artificial</h1><p className="muted">Instruções, tom de voz, base de conhecimento, provedor/modelo, limites e transferência para humano.</p></div></div>
      <div className="tabs">
        {([['config', 'Configuração'], ['kb', 'Base de conhecimento'], ['test', 'Testar'], ['usage', 'Uso']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'config' && <Config />}
      {tab === 'kb' && <Knowledge />}
      {tab === 'test' && <TestAi />}
      {tab === 'usage' && <Usage />}
    </>
  );
}

function Config() {
  const state = useApi<any>('/ai/settings');
  const { can, me } = useAuth();
  const superAdmin = !!me?.user.isSuperAdmin;
  const [f, setF] = useState<any>(null);
  const [apiKey, setApiKey] = useState('');
  const [tpl, setTpl] = useState('');
  const [tplApplied, setTplApplied] = useState('');
  const [tplAsk, setTplAsk] = useState<{ text: string; label: string } | null>(null);
  const [voiceKey, setVoiceKey] = useState('');
  const [sp] = useSearchParams();
  const wantTemplate = sp.get('modelo') === '1';
  const tplRef = useRef<HTMLSelectElement>(null);
  const { busy, run } = useAction();
  // Vindo dos "Primeiros passos" (?modelo=1): leva direto ao seletor de modelos.
  useEffect(() => { if (wantTemplate && f && tplRef.current) { tplRef.current.scrollIntoView({ block: 'center' }); tplRef.current.focus(); } }, [wantTemplate, !!f]);
  const applyTemplate = () => {
    const t = aiTemplateById(tpl);
    if (!t) return;
    // Já há instruções diferentes: pergunta num Modal antes de substituir (sem window.confirm).
    if (f.instructions?.trim() && f.instructions.trim() !== t.text) { setTplAsk({ text: t.text, label: t.label }); return; }
    setF({ ...f, instructions: t.text });
    setTplApplied(t.label);
  };
  useEffect(() => { if (state.data) setF({ ...state.data, handoffKeywords: state.data.handoffKeywords.join(', '), baseUrl: state.data.baseUrl ?? '' }); }, [state.data]);
  const ro = !can('OWNER', 'ADMIN');
  return (
    <Async state={state}>{(s) => !f ? null : (
      <form className="grid g2" onSubmit={async (e) => {
        e.preventDefault();
        const body: any = {
          enabled: f.enabled, autoReply: f.autoReply, provider: f.provider, model: f.model, baseUrl: f.provider === 'openai' ? f.baseUrl : '',
          instructions: f.instructions, tone: f.tone, temperature: Number(f.temperature), maxTokens: Number(f.maxTokens), dailyLimit: Number(f.dailyLimit), monthlyTokenLimit: Number(f.monthlyTokenLimit),
          handoffKeywords: f.handoffKeywords.split(',').map((x: string) => x.trim()).filter(Boolean), fallbackMessage: f.fallbackMessage,
          failureMessage: f.failureMessage ?? '', competitorNotes: f.competitorNotes ?? '', webSearch: !!f.webSearch, kanbanAuto: !!f.kanbanAuto,
          ...(superAdmin ? { useMckSite: !!f.useMckSite } : {}),
          voiceEnabled: !!f.voiceEnabled, voiceReplyMode: f.voiceReplyMode, voiceProvider: f.voiceProvider, voiceName: f.voiceName ?? '',
          voiceModel: f.voiceModel ?? '', voiceStyle: f.voiceStyle ?? '', voiceMaxSeconds: Number(f.voiceMaxSeconds) || 45,
          transcribeAudio: !!f.transcribeAudio, transcribeProvider: f.transcribeProvider ?? 'auto',
        };
        if (apiKey) body.apiKey = apiKey;
        if (voiceKey) body.voiceApiKey = voiceKey;
        const r = await run(() => put('/ai/settings', body), 'Configurações da IA salvas');
        if (r) { setApiKey(''); setVoiceKey(''); state.setData(r); }
      }}>
        {tplAsk && (
          <Modal title="Substituir as Instruções?" onClose={() => setTplAsk(null)}>
            <div className="stack">
              <p style={{ margin: 0 }}>As Instruções atuais serão trocadas pelo modelo <strong>{tplAsk.label}</strong>. A troca só vale depois de clicar em Salvar.</p>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setTplAsk(null)}>Voltar</button>
                <button type="button" className="btn primary" onClick={() => { setF({ ...f, instructions: tplAsk.text }); setTplApplied(tplAsk.label); setTplAsk(null); }}>Substituir</button>
              </div>
            </div>
          </Modal>
        )}
        <fieldset disabled={ro} className="card stack" style={{ margin: 0 }}>
          <h2>Provedor e modelo</h2>
          {f.provider === 'mck' && <div className={`alert ${s.mckIaReady ? 'info' : 'warn'}`}>{s.mckIaReady ? 'MCK IA: a inteligência artificial própria da MCK DESENVOLVIMENTO. Não precisa de chave.' : 'A MCK IA ainda não foi ativada na plataforma. Use o Google Gemini com a sua chave por enquanto.'}</div>}
          {f.provider === 'mck' && s.provider === 'mck' && s.mckQuota && <MckQuotaInfo q={s.mckQuota} />}
          {!s.hasApiKey && f.provider !== 'mck' && <div className="alert warn">Nenhuma chave configurada: a IA não responde até você salvar uma chave. O Google Gemini tem camada gratuita (crie a chave em aistudio.google.com).</div>}
          <Field label="Provedor"><select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value, model: MODELS[e.target.value] ?? f.model })}><option value="mck">MCK IA (inclusa, sem chave)</option><option value="gemini">Google Gemini</option><option value="openai">OpenAI ou compatível (Groq, OpenRouter, etc.)</option></select></Field>
          {f.provider !== 'mck' && <Field label="Modelo" hint={f.provider === 'gemini' ? 'Ex.: gemini-3.5-flash-lite (gratuito) ou gemini-3.8-flash. Lista em ai.google.dev/gemini-api/docs/models' : 'Nome exato do modelo no seu provedor'}><input required value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>}
          {f.provider === 'openai' && <Field label="URL base (opcional)" hint="Deixe vazio para api.openai.com. Para compatíveis, ex.: https://api.groq.com/openai/v1"><input type="url" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} /></Field>}
          {f.provider !== 'mck' && <Field label="Chave de API" hint={s.hasApiKey ? `Chave salva (cifrada): ${s.apiKeyPreview}. Preencha só para trocar.` : 'Guardada cifrada (AES-256-GCM).'}><input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.hasApiKey ? '••••••••' : 'Cole sua chave'} /></Field>}
          {s.hasApiKey && !ro && <button type="button" className="btn sm danger" disabled={busy} onClick={async () => { const r = await run(() => put('/ai/settings', { clearApiKey: true }), 'Chave removida'); if (r) state.setData(r); }}>Remover chave</button>}
          <div className="grid g2">
            <Field label="Temperatura"><input type="number" step="0.1" min={0} max={2} value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })} /></Field>
            <Field label="Máx. tokens por resposta"><input type="number" min={50} max={4000} value={f.maxTokens} onChange={(e) => setF({ ...f, maxTokens: e.target.value })} /></Field>
            <Field label="Limite de respostas por dia"><input type="number" min={0} value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: e.target.value })} /></Field>
            <Field label="Limite de tokens por mês"><input type="number" min={0} value={f.monthlyTokenLimit} onChange={(e) => setF({ ...f, monthlyTokenLimit: e.target.value })} /></Field>
          </div>
        </fieldset>
        <fieldset disabled={ro} className="card stack" style={{ margin: 0 }}>
          <h2>Comportamento</h2>
          <label className="row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> IA ativada (permite o bloco "Resposta com IA" nos fluxos)</label>
          <label className="row"><input type="checkbox" checked={f.autoReply} onChange={(e) => setF({ ...f, autoReply: e.target.checked })} /> Responder automaticamente quando nenhum fluxo for acionado</label>
          <Field label="Usar modelo do meu segmento" hint="Preenche as Instruções com um texto pronto para editar. Troque cada [preencha] pelos dados da sua empresa (preços, horários, endereço) e clique em Salvar.">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select ref={tplRef} value={tpl} onChange={(e) => setTpl(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="Segmento">
                <option value="">Escolha o seu segmento…</option>
                {AI_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <button type="button" className="btn sm" disabled={!tpl} onClick={applyTemplate}>Usar modelo</button>
            </div>
          </Field>
          {tplApplied && <div className="alert info small" role="status">Modelo "{tplApplied}" colocado nas Instruções. Troque os [preencha] pelos seus dados e clique em <strong>Salvar configurações</strong>.</div>}
          <Field label="Instruções" hint="Quem é a empresa, o que vende, preços e como atender. A IA também usa a base de conhecimento."><textarea rows={tplApplied ? 14 : 6} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
          <Field label="Tom de voz"><input value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })} /></Field>
          <div className="alert info small">A IA só transfere para um atendente quando o <strong>cliente pede</strong> (ex.: "quero falar com um atendente", "humano", "pessoa"). Se ela não souber responder ou falhar, manda o texto de falha abaixo e continua atendendo. Transferências que você colocou nos fluxos (bloco "Transferir para humano") continuam valendo.</div>
          <Field label="Palavras que pedem humano" hint="Separadas por vírgula. Valem em mensagens curtas ou em pedidos (ex.: 'quero atendente'); 'pessoa jurídica' não transfere."><input value={f.handoffKeywords} onChange={(e) => setF({ ...f, handoffKeywords: e.target.value })} /></Field>
          <Field label="Mensagem de transferência (quando o cliente pede um atendente)"><textarea rows={2} required value={f.fallbackMessage} onChange={(e) => setF({ ...f, fallbackMessage: e.target.value })} /></Field>
          <Field label="Mensagem quando a IA não consegue responder (sem transferir)" hint="Vazio = 'Desculpe, não consegui responder agora. Pode me explicar de outro jeito? Se preferir falar com uma pessoa da equipe, é só escrever atendente.'"><textarea rows={2} value={f.failureMessage ?? ''} onChange={(e) => setF({ ...f, failureMessage: e.target.value })} /></Field>
          <h3 style={{ margin: '8px 0 0' }}>Concorrentes e funil</h3>
          <Field label="Diferenciais vs concorrentes" hint="Quando o cliente comparar com outra empresa, a IA responde com respeito, destaca estes pontos e não inventa nada sobre o concorrente."><textarea rows={4} value={f.competitorNotes ?? ''} onChange={(e) => setF({ ...f, competitorNotes: e.target.value })} placeholder="Ex.: atendimento 24h, entrega no mesmo dia, garantia de 1 ano…" /></Field>
          <label className="row"><input type="checkbox" checked={!!f.webSearch} onChange={(e) => setF({ ...f, webSearch: e.target.checked })} /> Pesquisar na web (Google) quando o cliente citar um concorrente — grátis só no Gemini 2.5 Flash/Flash-Lite (500 pesquisas/dia); em outros modelos fica desligado</label>
          <label className="row"><input type="checkbox" checked={!!f.kanbanAuto} onChange={(e) => setF({ ...f, kanbanAuto: e.target.checked })} /> A IA move o contato para a etapa seguinte do Kanban quando a conversa mostrar que ele avançou (nunca volta etapa nem marca Ganho/Perdido; cada mudança fica anotada na conversa)</label>
          {superAdmin && <label className="row"><input type="checkbox" checked={!!f.useMckSite} onChange={(e) => setF({ ...f, useMckSite: e.target.checked })} /> Usar o site da MCK DESENVOLVIMENTO (MCKBOT, MCK Mensagens, Planos, Ajuda, Contato) e os preços atuais como conhecimento — só para a organização da MCK (opção do administrador da plataforma)</label>}
          <div className="alert info small">A IA informa valores, planos, prazos e passo a passo usando as Instruções acima e a base de conhecimento. Mantenha os preços atualizados nesses lugares.</div>
          {!ro && <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar configurações'}</button>}
        </fieldset>
        <VoiceSettings f={f} setF={setF} s={s} ro={ro} voiceKey={voiceKey} setVoiceKey={setVoiceKey} busy={busy}
          clearVoiceKey={async () => { const r = await run(() => put('/ai/settings', { clearVoiceApiKey: true }), 'Chave da ElevenLabs removida'); if (r) state.setData(r); }} />
      </form>
    )}</Async>
  );
}

const ENGINES: Record<string, { label: string; hint: string }> = {
  gemini: { label: 'Google Gemini (grátis)', hint: 'Usa a chave do Gemini da IA de texto (ou a MCK IA). Camada gratuita do Google.' },
  openai: { label: 'OpenAI', hint: 'Usa a chave da OpenAI da IA de texto (Provedor: OpenAI). Cobrado pela OpenAI na sua conta.' },
  elevenlabs: { label: 'ElevenLabs (voz mais humana)', hint: 'Usa a sua chave da ElevenLabs (conta própria; o plano grátis deles tem uma cota mensal de caracteres).' },
};
const STT: Record<string, string> = { auto: 'Igual à IA de texto', gemini: 'Google Gemini', openai: 'OpenAI (Whisper)', elevenlabs: 'ElevenLabs (Scribe)' };

/** Seção "Voz": ouvir áudios dos clientes e responder com nota de voz (motor, voz, estilo, prévia). */
function VoiceSettings({ f, setF, s, ro, voiceKey, setVoiceKey, busy, clearVoiceKey }: { f: any; setF: (v: any) => void; s: any; ro: boolean; voiceKey: string; setVoiceKey: (v: string) => void; busy: boolean; clearVoiceKey: () => void }) {
  const engine = f.voiceProvider ?? 'gemini';
  const [voices, setVoices] = useState<{ id: string; label: string }[]>([]);
  const [vErr, setVErr] = useState('');
  const [needsKey, setNeedsKey] = useState(false);
  const [preview, setPreview] = useState<{ url: string } | null>(null);
  const [pBusy, setPBusy] = useState(false);
  const [pErr, setPErr] = useState('');
  const fRef = useRef(f);
  fRef.current = f;
  // A lista de vozes muda com o motor (ElevenLabs: vozes da conta do cliente, depois de salvar a chave).
  useEffect(() => {
    if (ro) return;
    let alive = true;
    setVErr('');
    get(`/ai/voice/voices?provider=${engine}`).then((r: any) => {
      if (!alive) return;
      setVoices(r.voices ?? []);
      setNeedsKey(!!r.needsKey);
      const cur = fRef.current;
      if ((r.voices ?? []).length && !(r.voices as any[]).some((v) => v.id === cur.voiceName)) setF({ ...cur, voiceName: r.defaultVoice || r.voices[0].id });
    }).catch((e: Error) => { if (alive) { setVoices([]); setVErr(e.message); } });
    return () => { alive = false; };
  }, [engine, s.hasVoiceApiKey, ro]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const listen = async () => {
    setPBusy(true); setPErr('');
    try {
      const blob = await postBlob('/ai/voice/preview', { voiceProvider: engine, voiceName: f.voiceName ?? '', voiceModel: f.voiceModel ?? '', voiceStyle: f.voiceStyle ?? '' }, { timeoutMs: 75000 });
      const url = URL.createObjectURL(blob);
      setPreview({ url });
      new Audio(url).play().catch(() => undefined);
    } catch (e) {
      setPErr((e as Error).message || 'Não foi possível gerar a prévia.');
    } finally {
      setPBusy(false);
    }
  };
  return (
    <fieldset disabled={ro} className="card stack" style={{ margin: 0, gridColumn: '1 / -1' }}>
      <h2>Voz</h2>
      <p className="small muted" style={{ margin: 0 }}>A IA ouve os áudios dos clientes e pode responder com áudio, como uma pessoa. Links e detalhes (preços, listas) vão por escrito logo depois do áudio. Cada áudio ouvido ou gerado conta no limite de respostas da IA.</p>
      <div className="grid g2">
        <div className="stack">
          <h3 style={{ margin: 0 }}>Ouvir</h3>
          <label className="row"><input type="checkbox" checked={!!f.transcribeAudio} onChange={(e) => setF({ ...f, transcribeAudio: e.target.checked })} /> Ouvir os áudios dos clientes (a transcrição aparece no Inbox e a IA responde ao que foi dito)</label>
          <Field label="Quem transcreve" hint="Áudios de até 2 minutos. Se não der para ouvir, a IA pede para o cliente escrever."><select value={f.transcribeProvider ?? 'auto'} onChange={(e) => setF({ ...f, transcribeProvider: e.target.value })}>{Object.entries(STT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <div className="stack">
          <h3 style={{ margin: 0 }}>Falar</h3>
          <label className="row"><input type="checkbox" checked={!!f.voiceEnabled} onChange={(e) => setF({ ...f, voiceEnabled: e.target.checked })} /> Responder com áudio (nota de voz)</label>
          <Field label="Quando responder em áudio" hint="Automático: se o cliente pedir áudio (“pode ser por áudio?”) ou texto (“prefiro por escrito”), a IA passa a responder assim naquela conversa."><select value={f.voiceReplyMode ?? 'espelhar'} onChange={(e) => setF({ ...f, voiceReplyMode: e.target.value })}>
            <option value="espelhar">Espelhar o cliente (áudio responde áudio, texto responde texto)</option>
            <option value="sempre_audio">Sempre em áudio</option>
            <option value="nunca_audio">Nunca em áudio (só ouvir)</option>
          </select></Field>
        </div>
      </div>
      <div className="grid g2">
        <Field label="Motor da voz" hint={ENGINES[engine]?.hint}><select value={engine} onChange={(e) => setF({ ...f, voiceProvider: e.target.value, voiceName: '' })}>{Object.entries(ENGINES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Voz" hint={engine === 'elevenlabs' ? 'Vozes da sua conta ElevenLabs (inclui as que você adicionou da biblioteca).' : 'Feminina ou masculina; ouça a prévia para escolher.'}>
          <select value={f.voiceName ?? ''} onChange={(e) => setF({ ...f, voiceName: e.target.value })} disabled={!voices.length}>
            {!voices.length && <option value="">{needsKey ? 'Salve a chave da ElevenLabs para ver as vozes' : vErr ? 'Não foi possível carregar' : 'Carregando…'}</option>}
            {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </Field>
      </div>
      {vErr && <div className="alert warn small" role="alert">{vErr}</div>}
      {engine === 'elevenlabs' && (
        <div className="grid g2">
          <Field label="Chave da ElevenLabs" hint={s.hasVoiceApiKey ? 'Chave configurada (guardada cifrada). Preencha só para trocar.' : 'Crie em elevenlabs.io › API Keys. Guardada cifrada; nunca aparece de novo na tela.'}>
            <input type="password" autoComplete="off" value={voiceKey} onChange={(e) => setVoiceKey(e.target.value)} placeholder={s.hasVoiceApiKey ? 'configurada' : 'Cole sua chave'} />
          </Field>
          <Field label="Modelo da ElevenLabs" hint="Multilingual v2: mais natural. Flash v2.5: mais rápido e gasta metade dos créditos.">
            <select value={f.voiceModel || 'eleven_multilingual_v2'} onChange={(e) => setF({ ...f, voiceModel: e.target.value })}>
              <option value="eleven_multilingual_v2">Multilingual v2 (mais natural)</option>
              <option value="eleven_flash_v2_5">Flash v2.5 (mais rápido)</option>
            </select>
          </Field>
          {s.hasVoiceApiKey && !ro && <div><button type="button" className="btn sm danger" disabled={busy} onClick={clearVoiceKey}>Remover chave da ElevenLabs</button></div>}
        </div>
      )}
      <div className="grid g2">
        <Field label="Jeito de falar" hint={engine === 'elevenlabs' ? 'Na ElevenLabs o jeito de falar vem da voz escolhida (este texto não é usado).' : 'Ex.: animada, calma, formal, bem-humorada.'}><textarea rows={2} maxLength={500} value={f.voiceStyle ?? ''} onChange={(e) => setF({ ...f, voiceStyle: e.target.value })} /></Field>
        <Field label="Duração máxima do áudio (segundos)" hint="Respostas mais longas vão por escrito."><input type="number" min={10} max={120} value={f.voiceMaxSeconds ?? 45} onChange={(e) => setF({ ...f, voiceMaxSeconds: e.target.value })} /></Field>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn" disabled={pBusy || ro || (engine === 'elevenlabs' && !s.hasVoiceApiKey)} onClick={listen}>{pBusy ? 'Gerando áudio…' : '▶ Ouvir prévia'}</button>
        {preview && <audio controls src={preview.url} style={{ height: 36 }} />}
        <span className="small muted">A prévia usa a voz escolhida acima (mesmo antes de salvar) e conta no uso da IA.</span>
      </div>
      {pErr && <div className="alert err small" role="alert"><strong>Prévia:</strong> {pErr}</div>}
      {!ro && <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar configurações'}</button>}
    </fieldset>
  );
}

/** Cota diária da MCK IA: uso de hoje e aviso simples quando atinge o limite. */
export function MckQuotaInfo({ q }: { q: { limit: number; used: number; reached: boolean; tierLabel: string } }) {
  if (q.reached) return <div className="alert warn" role="status"><strong>Limite diário da MCK IA atingido.</strong> Volta amanhã ou use sua própria chave (Google Gemini ou OpenAI) no campo Provedor.</div>;
  return <div className="small muted">Respostas da MCK IA hoje: <strong>{fmtNum(q.used)}</strong>{q.limit ? ` de ${fmtNum(q.limit)} (${q.tierLabel})` : ' (sem limite diário)'}.</div>;
}

function Knowledge() {
  const state = useApi<any[]>('/ai/knowledge');
  const { can } = useAuth();
  const [edit, setEdit] = useState<any>(null);
  const [remove, setRemove] = useState<any>(null);
  const { busy, run } = useAction();
  const ro = !can('OWNER', 'ADMIN');
  return (
    <>
      {remove && (
        <Modal title="Excluir documento" onClose={() => setRemove(null)}>
          <div className="stack">
            <p style={{ margin: 0 }}>Excluir <strong>{remove.title}</strong> da base de conhecimento?</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setRemove(null)} disabled={busy}>Voltar</button>
              <button type="button" className="btn danger" disabled={busy} onClick={async () => { const ok = await run(() => del(`/ai/knowledge/${remove.id}`), 'Documento excluído'); if (ok) { setRemove(null); state.reload(); } }}>{busy ? 'Excluindo…' : 'Excluir'}</button>
            </div>
          </div>
        </Modal>
      )}
      <div className="row between" style={{ marginBottom: 12 }}>
        <p className="muted" style={{ margin: 0 }}>Cole FAQ, tabela de preços, políticas e horários. O texto é dividido em trechos e os mais relevantes vão para a IA a cada pergunta. Produtos com preço e estoque ficam em <a href="/produtos">Produtos</a>.</p>
        {!ro && <button className="btn primary" onClick={() => setEdit({ title: '', content: '' })}>+ Documento</button>}
      </div>
      <Async state={state}>{(docs) => docs.length === 0 ? <div className="card"><Empty title="Base de conhecimento vazia">Sem documentos, a IA não sabe responder perguntas sobre preços e políticas (ela avisa que vai confirmar com a equipe).</Empty></div> : (
        <div className="grid g2">
          {docs.map((d) => (
            <div key={d.id} className="card stack">
              <div className="row between"><strong>{d.title}</strong><span className="badge">{d.chunks} trecho(s)</span></div>
              <p className="small muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 90, overflow: 'hidden' }}>{d.content}</p>
              <div className="row between small"><span className="muted">Atualizado {fmtDate(d.updatedAt)}</span>
                {!ro && <div className="row"><button className="btn sm" onClick={() => setEdit(d)}>Editar</button><button className="btn sm danger" disabled={busy} onClick={() => setRemove(d)}>Excluir</button></div>}</div>
            </div>
          ))}
        </div>
      )}</Async>
      {edit && (
        <Modal title={edit.id ? 'Editar documento' : 'Novo documento'} onClose={() => setEdit(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => (edit.id ? put(`/ai/knowledge/${edit.id}`, { title: edit.title, content: edit.content }) : post('/ai/knowledge', { title: edit.title, content: edit.content })), 'Documento salvo e indexado');
            if (ok) { setEdit(null); state.reload(); }
          }}>
            <Field label="Título"><input required maxLength={200} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Conteúdo"><textarea required rows={12} value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} /></Field>
            <button className="btn primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
          </form>
        </Modal>
      )}
    </>
  );
}

function TestAi() {
  const { can } = useAuth();
  const [msg, setMsg] = useState('');
  const [res, setRes] = useState<any>(null);
  const [fail, setFail] = useState('');
  const [busy, setBusy] = useState(false);
  if (!can('OWNER', 'ADMIN')) return <div className="card"><Empty title="Somente administradores podem testar a IA" /></div>;
  const ask = async () => {
    setBusy(true); setFail(''); setRes(null);
    try {
      // O servidor tem tempo máximo próprio (≈ 45 s); 75 s aqui é a rede de segurança da tela.
      setRes(await post('/ai/test', { message: msg }, { timeoutMs: 75000, timeoutMessage: 'A IA não respondeu a tempo (mais de 75 s). Tente de novo; se repetir, veja a aba Uso.' }));
    } catch (e) {
      setFail((e as Error).message || 'Não foi possível consultar a IA.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <p className="muted">Simula uma pergunta de cliente usando sua configuração real (consome a sua cota do provedor). Nada é enviado no WhatsApp.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (!busy) ask(); }}>
        <input required value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Ex.: Qual o horário de atendimento?" style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy}>{busy ? 'Consultando…' : 'Perguntar'}</button>
      </form>
      {fail && <div className="alert err" role="alert"><strong>Não foi possível testar:</strong> {fail}</div>}
      {res && (
        <div className="stack">
          <div className={`alert ${res.handoff ? 'warn' : 'ok'}`}><strong>{res.handoff ? 'Transferiria para humano' : 'Resposta'}:</strong> {res.text ?? '(nenhum texto)'}{res.reason && <div className="small">Motivo: {res.reason}</div>}{res.error && <div className="small">Erro do provedor: {res.error}</div>}</div>
          <h3>Trechos usados da base</h3>
          {!res.sources?.length ? <p className="small muted">Nenhum trecho relevante encontrado.</p> : res.sources.map((s: any, i: number) => <div key={i} className="small"><strong>{s.title}</strong> (relevância {s.score}) — {s.text}</div>)}
        </div>
      )}
    </div>
  );
}

function Usage() {
  const state = useApi<any>('/ai/usage');
  return (
    <Async state={state}>{(u) => (
      <div className="stack">
        <div className="grid g4">
          <div className="card stat"><div className="l">Requisições (30d)</div><div className="v">{fmtNum(u.total)}</div></div>
          <div className="card stat"><div className="l">Falhas</div><div className="v">{fmtNum(u.failed)}</div></div>
          <div className="card stat"><div className="l">Transferências</div><div className="v">{fmtNum(u.handoffs)}</div></div>
          <div className="card stat"><div className="l">Tokens (entrada + saída)</div><div className="v">{fmtNum(u.promptTokens + u.completionTokens)}</div><div className="small muted">Latência média {u.avgLatencyMs} ms</div></div>
        </div>
        <div className="card table-wrap">
          <h2>Últimas chamadas</h2>
          {u.recent.length === 0 ? <Empty title="Nenhuma chamada de IA ainda" /> : (
            <table><thead><tr><th>Quando</th><th>Modelo</th><th>Tokens</th><th>Resultado</th></tr></thead>
              <tbody>{u.recent.map((r: any) => <tr key={r.id}><td>{fmtDate(r.createdAt)}</td><td>{r.model ? `${r.provider}/${r.model}` : r.provider}</td><td>{r.promptTokens + r.completionTokens}</td><td>{r.success ? <span className="badge green">ok</span> : <span className="badge red">erro</span>} {r.handoff && <span className="badge blue">transferiu</span>} <span className="small muted">{r.error}</span></td></tr>)}</tbody></table>
          )}
        </div>
      </div>
    )}</Async>
  );
}
