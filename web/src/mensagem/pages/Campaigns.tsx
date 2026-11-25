import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { post, patch, del, get, upload } from '../../api';
import { useApi, Async, Empty, Field, Modal, useAction, useToast, fmtDate, fmtNum } from '../../ui';
import { MetricsView } from './Dashboard';
import { AddContactsModal } from './LeadBulk';
import { CampaignGroups, RepescagemFields, type RepescagemForm } from './CampaignGroups';
import {
  CampaignBadge, LEAD_STATUS_LABEL, SAFE_DEFAULTS, campaignProgress, downloadCsv, fetchAllLeads, fmtPhone, slug,
  type Campaign, type ChannelLite, type Metrics, type NumeroEnvio,
} from '../common';
import { MAX_VARIACOES, AB_MINIMO_PADRAO, AB_LIMITES, DIAS_ROTULO, DIAS_TODOS, LETRAS, textoParaContato, saudacaoDe, variaveisDesconhecidas, normalizarDias } from '../../../../server/mckmensagem/variacoes';
import { AVISO_RISCO_FIXO } from '../../../../server/mckmensagem/campanhaCore';
import { LEGENDA_MAX, MIDIA_MAX_MB, RECORRENCIA_ROTULO, MAX_CANAIS_RODIZIO, descreverFiltroErp, erroFiltroErp, type FiltroErp, type Recorrencia } from '../../../../server/mckmensagem/campanhaCore';

const MCKBOT_CHANNELS = '/canais';

function ChannelSelect({ value, onChange, channels }: { value: string; onChange: (v: string) => void; channels: ChannelLite[] }) {
  return (
    <select required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>Selecione o número…</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>{c.label ?? c.name}{c.displayPhone ? ` (${c.displayPhone})` : ''}{c.status === 'CONNECTED' ? ' — conectado' : ' — desconectado'}</option>
      ))}
    </select>
  );
}

type Form = {
  name: string; message: string; channelId: string; dailyLimit: number; minIntervalSec: number; maxIntervalSec: number; windowStart: string; windowEnd: string; riscoRetomada: 'auto' | 'manual';
  /** v1.48.0 */ variacoes: string[]; abAutoVencedora: boolean; abMinimo: number; diasSemana: string;
  /** v1.49.0 */ recorrencia: '' | Recorrencia; recorrenciaFim: string; rodizio: boolean; canaisRodizio: string[];
  /** v1.51.0 */ envioFixo: boolean; confirmarRisco: boolean;
} & RepescagemForm;

const NIVEL_BADGE: Record<'BOM' | 'ATENCAO' | 'RISCO', { cls: string; txt: string }> = { BOM: { cls: 'green', txt: 'Saúde boa' }, ATENCAO: { cls: 'amber', txt: 'Atenção' }, RISCO: { cls: 'red', txt: 'Em risco' } };

/**
 * v1.51.0: "Escolher número de envio". Automático (padrão) = como antes (número principal + rodízio; número em Risco
 * pausa). Escolhido = a campanha sai só por esse número; em Risco, só depois de "Enviar mesmo assim".
 */
/** Número escolhido em Risco ainda sem "Enviar mesmo assim" (bloqueia o Salvar). */
function faltaConfirmarRisco(f: Form, lista: NumeroEnvio[], initial?: Campaign): boolean {
  const sel = lista.find((n) => n.id === f.channelId);
  const jaLiberado = !!initial?.riscoLiberado && initial.riscoLiberadoCanalId === f.channelId && !!initial.envioFixo;
  return f.envioFixo && sel?.nivel === 'RISCO' && !jaLiberado && !f.confirmarRisco;
}

function NumeroEnvioFields({ f, setF, initial, channels, numeros }: { f: Form; setF: (fn: (x: Form) => Form) => void; initial?: Campaign; channels: ChannelLite[]; numeros: ReturnType<typeof useApi<NumeroEnvio[]>> }) {
  const lista = numeros.data ?? [];
  const sel = lista.find((n) => n.id === f.channelId);
  const jaLiberado = !!initial?.riscoLiberado && initial.riscoLiberadoCanalId === f.channelId && !!initial.envioFixo;
  const precisaConfirmar = faltaConfirmarRisco(f, lista, initial);
  const escolher = (id: string) => setF((x) => ({ ...x, channelId: id, confirmarRisco: false }));
  return (
    <div className="card stack" style={{ padding: 12, background: '#fafbff' }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <strong>Número de envio</strong>
        {f.envioFixo
          ? <button type="button" className="btn sm ghost" onClick={() => setF((x) => ({ ...x, envioFixo: false, confirmarRisco: false }))}>↺ Voltar ao automático</button>
          : <button type="button" className="btn sm primary" onClick={() => setF((x) => ({ ...x, envioFixo: true, confirmarRisco: false }))}>📱 Escolher número de envio</button>}
      </div>
      {!f.envioFixo ? (
        <>
          <p className="small muted" style={{ margin: 0 }}><strong>Automático (padrão):</strong> envia pelo número principal abaixo (e pelo rodízio, se ligado). Número em nível Risco pausa a campanha para proteger contra bloqueio.</p>
          <Field label="Número principal">
            {channels.length === 0
              ? <div className="alert warn">Nenhum número de WhatsApp cadastrado. <a href={MCKBOT_CHANNELS}>Conecte um número no MCKBOT ↗</a></div>
              : <ChannelSelect value={f.channelId} onChange={(v) => setF((x) => ({ ...x, channelId: v }))} channels={channels} />}
          </Field>
        </>
      ) : (
        <>
          <p className="small muted" style={{ margin: 0 }}>A campanha sai <strong>só pelo número que você escolher</strong> (sem rodízio), inclusive se ele estiver em risco. Limites por hora/dia, intervalos, aquecimento e horário continuam valendo.</p>
          <Async state={numeros}>{() => lista.length === 0
            ? <div className="alert warn">Nenhum número de WhatsApp cadastrado. <a href={MCKBOT_CHANNELS}>Conecte um número no MCKBOT ↗</a></div>
            : (
              <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label="Escolher número de envio">
                {lista.map((n) => (
                  <label key={n.id} className="row small" style={{ gap: 8, padding: '6px 8px', borderRadius: 6, border: `1px solid ${n.id === f.channelId ? '#2f6fde' : '#e3e7ef'}`, cursor: 'pointer', flexWrap: 'wrap' }}>
                    <input type="radio" name="numero-envio" checked={n.id === f.channelId} onChange={() => escolher(n.id)} />
                    <strong>{n.label}</strong>{n.displayPhone ? <span className="muted">{n.displayPhone}</span> : null}
                    {n.conectado ? <span className="badge green">conectado</span> : <span className="badge red">desconectado</span>}
                    {n.nivel ? <span className={`badge ${NIVEL_BADGE[n.nivel].cls}`}>{n.nivel === 'RISCO' ? '⚠ ' : ''}{NIVEL_BADGE[n.nivel].txt}</span> : n.provider !== 'whatsapp_qr' ? <span className="badge">API oficial</span> : null}
                  </label>
                ))}
              </div>
            )}</Async>
          {sel && !sel.conectado && <div className="alert warn small">⏸ Este número está desconectado: nada será enviado por ele (e a campanha não troca de número) até reconectá-lo em <a href={MCKBOT_CHANNELS}>Canais ↗</a>.</div>}
          {f.envioFixo && sel?.nivel === 'RISCO' && (
            <div className="alert warn small stack" style={{ gap: 6 }}>
              <div>⚠ <strong>Número em risco.</strong> {AVISO_RISCO_FIXO}</div>
              {!!sel.motivos.length && <div className="muted">Motivos: {sel.motivos.join(' · ')}</div>}
              {jaLiberado && !f.confirmarRisco
                ? <div>✓ Confirmado{initial?.riscoLiberadoPorNome ? ` por ${initial.riscoLiberadoPorNome}` : ''}{initial?.riscoLiberadoEm ? ` em ${fmtBrt(initial.riscoLiberadoEm)}` : ''}.</div>
                : f.confirmarRisco
                  ? <div className="row" style={{ gap: 8 }}>✓ Você confirmou: enviar mesmo assim. <button type="button" className="btn sm ghost" onClick={() => setF((x) => ({ ...x, confirmarRisco: false }))}>Desfazer</button></div>
                  : <div><button type="button" className="btn sm danger" onClick={() => setF((x) => ({ ...x, confirmarRisco: true }))}>Enviar mesmo assim</button> <span className="muted">fica registrado quem confirmou e quando.</span></div>}
            </div>
          )}
          {precisaConfirmar && <div className="small" style={{ color: '#d64545' }}>Para salvar com este número, clique em “Enviar mesmo assim” ou escolha outro número.</div>}
        </>
      )}
    </div>
  );
}

/** v1.49.0: arquivo de cada versão no formulário (o já anexado, um novo escolhido, ou nenhum). */
type MidiaSlot = { id: string; nome: string; mime: string } | { file: File } | null;
const ehImagem = (m: MidiaSlot) => !!m && ('file' in m ? /^image\//.test(m.file.type) : /^image\//.test(m.mime));
const nomeSlot = (m: MidiaSlot) => (!m ? '' : 'file' in m ? m.file.name : m.nome);
const TIPOS_ACEITOS = 'image/jpeg,image/png,image/webp,application/pdf';

/** Prévia da imagem (ou do PDF) no balão do WhatsApp. */
function MidiaPrevia({ m, campaignId, versao }: { m: MidiaSlot; campaignId?: string; versao: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!m || !ehImagem(m)) { setUrl(null); return; }
    if ('file' in m) { const u = URL.createObjectURL(m.file); setUrl(u); return () => URL.revokeObjectURL(u); }
    setUrl(campaignId ? `/api/mckmensagem/campaigns/${campaignId}/midia/${m.id}` : null);
  }, [m, campaignId, versao]);
  if (!m) return null;
  if (url) return <img src={url} alt="" style={{ display: 'block', maxWidth: '100%', maxHeight: 220, borderRadius: 6, marginBottom: 6, objectFit: 'cover' }} />;
  return <div className="small" style={{ background: '#f1f3f7', borderRadius: 6, padding: '8px 10px', marginBottom: 6 }}>📄 {nomeSlot(m)}</div>;
}

/** Escolher/trocar/tirar o arquivo de uma versão. */
function MidiaCampo({ rotulo, m, onChange, herdado }: { rotulo: string; m: MidiaSlot; onChange: (m: MidiaSlot) => void; herdado?: boolean }) {
  const toast = useToast();
  const escolher = (f?: File | null) => {
    if (!f) return;
    const pdf = f.type === 'application/pdf';
    if (!TIPOS_ACEITOS.split(',').includes(f.type)) return toast('Use imagem JPG, PNG ou WEBP, ou PDF.', 'err');
    const max = pdf ? MIDIA_MAX_MB.pdf : MIDIA_MAX_MB.imagem;
    if (f.size > max * 1024 * 1024) return toast(`Arquivo grande demais: ${pdf ? 'PDF' : 'imagem'} até ${max} MB.`, 'err');
    onChange({ file: f });
  };
  return (
    <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
      <span>{rotulo}:</span>
      {m ? <><span className="badge">{ehImagem(m) ? '🖼' : '📄'} {nomeSlot(m)}</span><button type="button" className="btn sm ghost" onClick={() => onChange(null)}>Tirar</button></>
        : <span className="muted">{herdado ? 'usa o da versão A' : 'nenhum'}</span>}
      <label className="btn sm" style={{ cursor: 'pointer' }}>{m ? 'Trocar' : '📎 Anexar imagem ou PDF'}<input type="file" accept={TIPOS_ACEITOS} hidden onChange={(e) => { escolher(e.target.files?.[0]); e.target.value = ''; }} /></label>
    </div>
  );
}

/** v1.49.0: repetir a campanha e rodízio entre números. */
function RepeticaoRodizioFields({ f, set, initial, channels }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; initial?: Campaign; channels: ChannelLite[] }) {
  const outros = channels.filter((c) => c.id !== f.channelId);
  return (
    <div className="card stack" style={{ padding: 12, background: '#fafbff' }}>
      <strong>Repetir a campanha</strong>
      {initial?.recorrenciaOrigemId
        ? <p className="small muted" style={{ margin: 0 }}>Esta campanha é uma repetição de “{initial.origem?.name ?? 'outra campanha'}”. Para mudar a repetição, edite a original.</p>
        : <>
          <div className="grid g2" style={{ gap: 10 }}>
            <Field label="Repetir" hint="Cada repetição vira uma campanha nova, para o público atual (quem entrou depois também recebe; quem saiu, não).">
              <select value={f.recorrencia} onChange={(e) => set('recorrencia', e.target.value as Form['recorrencia'])}>
                <option value="">Não repetir</option>
                {(Object.keys(RECORRENCIA_ROTULO) as Recorrencia[]).map((r) => <option key={r} value={r}>{RECORRENCIA_ROTULO[r][0].toUpperCase() + RECORRENCIA_ROTULO[r].slice(1)}</option>)}
              </select>
            </Field>
            {f.recorrencia && <Field label="Até (opcional)" hint="Vazio = repete até você pausar a campanha."><input type="date" value={f.recorrenciaFim} onChange={(e) => set('recorrenciaFim', e.target.value)} /></Field>}
          </div>
          {f.recorrencia && <p className="small muted" style={{ margin: 0 }}>Começa a contar quando você inicia a campanha, na mesma hora. Se a repetição anterior ainda estiver enviando, aquela vez é pulada. Pausar a campanha também pausa as repetições.</p>}
        </>}
      {f.envioFixo ? <p className="small muted" style={{ margin: 0 }}>Rodízio entre números: desligado enquanto houver número de envio escolhido.</p> : <>
      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" checked={f.rodizio} disabled={!outros.length} onChange={(e) => set('rodizio', e.target.checked)} />
        <strong>Rodízio entre números</strong> <span className="muted">{outros.length ? 'divide os envios entre vários WhatsApp da empresa' : '(precisa de mais de um número conectado em Canais)'}</span>
      </label>
      {f.rodizio && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="small muted">Além do número principal, enviar também por (até {MAX_CANAIS_RODIZIO - 1}):</span>
          {outros.map((c) => {
            const on = f.canaisRodizio.includes(c.id);
            return (
              <label key={c.id} className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={on} disabled={!on && f.canaisRodizio.length >= MAX_CANAIS_RODIZIO - 1} onChange={() => set('canaisRodizio', on ? f.canaisRodizio.filter((x) => x !== c.id) : [...f.canaisRodizio, c.id])} />
                {c.label ?? c.name}{c.displayPhone ? ` (${c.displayPhone})` : ''} {c.status === 'CONNECTED' ? <span className="badge green">conectado</span> : <span className="badge red">desconectado</span>}
              </label>
            );
          })}
          <p className="small muted" style={{ margin: 0 }}>Cada número respeita o próprio limite por dia (o desta campanha), os intervalos e a Saúde do número; número desconectado ou em Risco fica de fora. O mesmo contato recebe sempre pelo mesmo número.</p>
        </div>
      )}
      </>}
    </div>
  );
}

/** Data/hora digitada (horário de Brasília, sem horário de verão) → ISO. */
function brtParaIso(v: string): string { return new Date(`${v}:00-03:00`).toISOString(); }
function fmtBrt(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
function diasTexto(d?: string): string {
  const n = normalizarDias(d);
  if (n === DIAS_TODOS) return 'todos os dias';
  if (n === '12345') return 'de segunda a sexta';
  if (n === '123456') return 'de segunda a sábado';
  return n.split('').map((x) => DIAS_ROTULO[Number(x)]).join(', ');
}

/** v1.48.0: versões B/C/D (teste A/B), vencedora automática e dias da semana. */
function VersoesFields({ f, set, midias, setMidia, onRemove }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; midias: MidiaSlot[]; setMidia: (i: number, m: MidiaSlot) => void; onRemove: (i: number) => void }) {
  const muda = (i: number, v: string) => set('variacoes', f.variacoes.map((x, j) => (j === i ? v : x)));
  return (
    <div className="card stack" style={{ padding: 12, background: '#fafbff' }}>
      <div className="row between"><strong>Versões da mensagem (teste A/B)</strong><span className="small muted">opcional</span></div>
      <p className="small muted" style={{ margin: 0 }}>Escreva outras versões do texto: cada contato recebe sempre uma delas (sorteio). Ajuda a não mandar o mesmo texto para todos e mostra qual versão tem mais respostas.</p>
      {f.variacoes.map((v, i) => (
        <Field key={i} label={`Versão ${LETRAS[i + 1]}`}>
          <div className="stack" style={{ gap: 4 }}>
            <textarea rows={3} maxLength={4000} value={v} onChange={(e) => muda(i, e.target.value)} placeholder="Outra forma de dizer a mesma coisa. Use {nome}, {saudacao} e {Olá|Oi}." />
            <MidiaCampo rotulo={`Imagem ou PDF da versão ${LETRAS[i + 1]}`} m={midias[i + 1] ?? null} herdado={!!midias[0]} onChange={(m) => setMidia(i + 1, m)} />
            <div className="row"><button type="button" className="btn sm ghost" onClick={() => onRemove(i)}>Remover versão {LETRAS[i + 1]}</button></div>
          </div>
        </Field>
      ))}
      {f.variacoes.length < MAX_VARIACOES && <div><button type="button" className="btn sm" onClick={() => set('variacoes', [...f.variacoes, ''])}>+ Adicionar versão {LETRAS[f.variacoes.length + 1]}</button></div>}
      {f.variacoes.some((v) => v.trim()) && (
        <label className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input type="checkbox" checked={f.abAutoVencedora} onChange={(e) => set('abAutoVencedora', e.target.checked)} />
          Escolher a vencedora sozinho depois de
          <input type="number" min={AB_LIMITES.min} max={AB_LIMITES.max} style={{ width: 80, padding: '4px 8px' }} value={f.abMinimo} onChange={(e) => set('abMinimo', Number(e.target.value))} />
          envios de cada versão (o resto da fila recebe a que teve mais respostas)
        </label>
      )}
      <div>
        <div className="small" style={{ marginBottom: 4 }}><strong>Dias em que a campanha envia</strong></div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {DIAS_ROTULO.map((d, i) => {
            const on = f.diasSemana.includes(String(i));
            return <button key={d} type="button" className={`btn sm ${on ? 'primary' : ''}`} aria-pressed={on} onClick={() => {
              const novo = on ? f.diasSemana.replace(String(i), '') : f.diasSemana + i;
              set('diasSemana', novo ? normalizarDias(novo) : f.diasSemana);
            }}>{d}</button>;
          })}
          <button type="button" className="btn sm ghost" onClick={() => set('diasSemana', '12345')}>Só dias úteis</button>
          <button type="button" className="btn sm ghost" onClick={() => set('diasSemana', DIAS_TODOS)}>Todos</button>
        </div>
      </div>
    </div>
  );
}

function CampaignForm({ initial, onClose, onSaved }: { initial?: Campaign; onClose: () => void; onSaved: (c: Campaign) => void }) {
  const channels = useApi<ChannelLite[]>('/channels');
  const numeros = useApi<NumeroEnvio[]>('/mckmensagem/numeros-envio');
  const connected = (channels.data ?? []).filter((c) => c.status === 'CONNECTED');
  const [f, setF] = useState<Form>(() => initial
    ? {
      name: initial.name, message: initial.message, channelId: initial.channelId, dailyLimit: initial.dailyLimit, minIntervalSec: initial.minIntervalSec, maxIntervalSec: initial.maxIntervalSec, windowStart: initial.windowStart, windowEnd: initial.windowEnd,
      repescagemAtiva: !!initial.repescagemAtiva, repescagemDias: initial.repescagemDias ?? 2, repescagemMax: initial.repescagemMax ?? 2, repescagemModelo: initial.repescagemModelo ?? '', riscoRetomada: initial.riscoRetomada ?? 'auto',
      variacoes: initial.variacoes ?? [], abAutoVencedora: !!initial.abAutoVencedora, abMinimo: initial.abMinimo ?? AB_MINIMO_PADRAO, diasSemana: normalizarDias(initial.diasSemana),
      recorrencia: initial.recorrencia ?? '', recorrenciaFim: initial.recorrenciaFim ? initial.recorrenciaFim.slice(0, 10) : '', rodizio: !!initial.rodizio, canaisRodizio: initial.canaisRodizio ?? [],
      envioFixo: !!initial.envioFixo, confirmarRisco: false,
    }
    : { name: '', message: 'Olá {nome}! ', channelId: '', ...SAFE_DEFAULTS, repescagemAtiva: true, repescagemDias: 2, repescagemMax: 2, repescagemModelo: '', riscoRetomada: 'auto', variacoes: [], abAutoVencedora: false, abMinimo: AB_MINIMO_PADRAO, diasSemana: DIAS_TODOS, recorrencia: '', recorrenciaFim: '', rodizio: false, canaisRodizio: [], envioFixo: false, confirmarRisco: false });
  // v1.49.0: arquivo por versão (posição 0 = versão A).
  const [midias, setMidias] = useState<MidiaSlot[]>(() => (initial?.midias ?? []).map((m) => (m ? { id: m.id, nome: m.nome, mime: m.mime } : null)));
  const setMidia = (i: number, m: MidiaSlot) => setMidias((xs) => { const out = [...xs]; while (out.length <= i) out.push(null); out[i] = m; return out; });
  const temMidia = midias.some(Boolean);
  const [previewName, setPreviewName] = useState('Ana Souza');
  const [previewVersao, setPreviewVersao] = useState(0);
  const [sorteio, setSorteio] = useState(1);
  const versoes = [f.message, ...f.variacoes.filter((v) => v.trim())];
  const versaoVista = Math.min(previewVersao, versoes.length - 1);
  const previa = textoParaContato(versoes[versaoVista] ?? '', { campaignId: 'previa', leadId: String(sorteio), nome: previewName, saudacao: saudacaoDe(new Date()) });
  const midiaVista = midias[versaoVista] ?? midias[0] ?? null;
  const midiaVistaIdx = midias[versaoVista] ? versaoVista : 0;
  const legendaLonga = temMidia && versoes.some((v) => v.length > LEGENDA_MAX);
  const desconhecidas = [...new Set(versoes.flatMap((v) => variaveisDesconhecidas(v)))];
  const { busy, run } = useAction();
  // Um único número conectado: já vem selecionado.
  useEffect(() => { if (!initial && connected.length === 1) setF((x) => (x.channelId ? x : { ...x, channelId: connected[0].id })); }, [channels.data]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const sel = channels.data?.find((c) => c.id === f.channelId);
  const risky = f.dailyLimit > 200 || f.minIntervalSec < 30;
  const intervalErr = f.minIntervalSec > f.maxIntervalSec;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Versões vazias saem; os arquivos acompanham as versões que ficaram.
    const ficam = f.variacoes.map((v, i) => ({ v: v.trim(), m: midias[i + 1] ?? null })).filter((x) => x.v);
    const slots: MidiaSlot[] = [midias[0] ?? null, ...ficam.map((x) => x.m)];
    const recorrencia = initial?.recorrenciaOrigemId ? {} : { recorrencia: f.recorrencia, recorrenciaFim: f.recorrencia && f.recorrenciaFim ? new Date(`${f.recorrenciaFim}T23:59:00-03:00`).toISOString() : null };
    const body = {
      ...f, ...recorrencia, dailyLimit: Number(f.dailyLimit), minIntervalSec: Number(f.minIntervalSec), maxIntervalSec: Number(f.maxIntervalSec), repescagemDias: Number(f.repescagemDias), repescagemMax: Number(f.repescagemMax), variacoes: ficam.map((x) => x.v), abMinimo: Math.min(AB_LIMITES.max, Math.max(AB_LIMITES.min, Number(f.abMinimo) || AB_MINIMO_PADRAO)),
      canaisRodizio: f.rodizio ? f.canaisRodizio.filter((id) => id !== f.channelId) : f.canaisRodizio,
      ...(initial ? { midias: slots.map((m) => (m && 'id' in m ? m.id : null)) } : {}),
    };
    if (initial?.recorrenciaOrigemId) { delete (body as Partial<typeof body>).recorrencia; delete (body as Partial<typeof body>).recorrenciaFim; }
    const r = await run(async () => {
      let c = initial ? await patch<Campaign>(`/mckmensagem/campaigns/${initial.id}`, body) : await post<Campaign>('/mckmensagem/campaigns', body);
      for (let i = 0; i < slots.length; i++) {
        const m = slots[i];
        if (m && 'file' in m) c = await upload<Campaign>(`/mckmensagem/campaigns/${c.id}/midia?versao=${i}`, m.file);
      }
      return c;
    }, initial ? 'Campanha atualizada' : 'Campanha criada');
    if (r) onSaved(r);
  };
  return (
    <Modal title={initial ? 'Editar campanha' : 'Nova campanha'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Nome da campanha"><input required maxLength={120} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Black Friday clientes VIP" /></Field>
        <NumeroEnvioFields f={f} setF={setF} initial={initial} channels={channels.data ?? []} numeros={numeros} />
        {!f.envioFixo && sel && sel.status !== 'CONNECTED' && <div className="alert warn">Este número está desconectado: nada será enviado até reconectá-lo em <a href={MCKBOT_CHANNELS}>Canais do MCKBOT ↗</a>.</div>}
        <Field label={f.variacoes.length ? 'Mensagem (versão A)' : 'Mensagem'} hint="Use {nome} (primeiro nome), {nome_completo}, {saudacao} (Bom dia/Boa tarde/Boa noite) e {Olá|Oi|E aí} para variar palavras. Inclua como sair, ex.: “Responda SAIR para não receber mais”.">
          <textarea required rows={5} maxLength={4000} value={f.message} onChange={(e) => set('message', e.target.value)} />
        </Field>
        <MidiaCampo rotulo={f.variacoes.length ? 'Imagem ou PDF (versão A)' : 'Imagem ou PDF (opcional)'} m={midias[0] ?? null} onChange={(m) => setMidia(0, m)} />
        {temMidia && <div className={`small ${legendaLonga ? '' : 'muted'}`} style={legendaLonga ? { color: '#d64545' } : undefined}>Com arquivo, o texto vai como legenda da imagem/PDF (até {LEGENDA_MAX.toLocaleString('pt-BR')} caracteres). Imagem JPG/PNG/WEBP até {MIDIA_MAX_MB.imagem} MB; PDF até {MIDIA_MAX_MB.pdf} MB.</div>}
        <div className="row small"><button type="button" className="btn sm" onClick={() => set('message', f.message + '{nome}')}>+ Inserir {'{nome}'}</button><button type="button" className="btn sm" onClick={() => set('message', f.message + '{saudacao}')}>+ {'{saudacao}'}</button><button type="button" className="btn sm" onClick={() => set('message', f.message + '{Olá|Oi|E aí}')} title="Cada contato recebe uma das palavras">+ Variação {'{Olá|Oi}'}</button><button type="button" className="btn sm" onClick={() => set('message', f.message.trimEnd() + '\n\nResponda SAIR para não receber mais mensagens.')}>+ Texto de saída</button><span className="muted">{f.message.length}/4000</span></div>
        <div>
          <div className="row between small" style={{ marginBottom: 6 }}>
            <strong>Prévia</strong>
            <label className="row small">Nome de teste: <input style={{ width: 140, padding: '4px 8px' }} value={previewName} onChange={(e) => setPreviewName(e.target.value)} placeholder="(sem nome)" /></label>
          </div>
          {versoes.length > 1 && (
            <div className="row small" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              {versoes.map((_, i) => <button key={i} type="button" className={`btn sm ${i === versaoVista ? 'primary' : ''}`} onClick={() => setPreviewVersao(i)}>Versão {LETRAS[i]}</button>)}
            </div>
          )}
          <div className="mm-preview"><div className="b"><MidiaPrevia m={midiaVista} campaignId={initial?.id} versao={midiaVistaIdx} />{previa || <span className="muted">Sua mensagem aparece aqui</span>}<div className="t">{f.windowStart} ✓✓</div></div></div>
          <div className="row small" style={{ marginTop: 6 }}><button type="button" className="btn sm ghost" onClick={() => setSorteio((x) => x + 1)}>🎲 Ver outra variação</button><span className="muted">Cada contato recebe sempre o mesmo texto.</span></div>
          {desconhecidas.length > 0 && <div className="alert warn small" style={{ marginTop: 6 }}>Não reconheço {desconhecidas.join(', ')}: vai sair escrito assim. Use {'{nome}'}, {'{nome_completo}'} ou {'{saudacao}'}.</div>}
        </div>
        <VersoesFields f={f} set={set} midias={midias} setMidia={setMidia} onRemove={(i) => { set('variacoes', f.variacoes.filter((_, j) => j !== i)); setMidias((xs) => xs.filter((_, j) => j !== i + 1)); }} />
        <RepeticaoRodizioFields f={f} set={set} initial={initial} channels={channels.data ?? []} />
        <h3 style={{ margin: '4px 0 0' }}>Limites de envio</h3>
        <div className="grid g3" style={{ gap: 10 }}>
          <Field label="Limite por dia"><input type="number" min={1} max={1000} required value={f.dailyLimit} onChange={(e) => set('dailyLimit', Number(e.target.value))} /></Field>
          <Field label="Intervalo mínimo (s)"><input type="number" min={10} max={3600} required value={f.minIntervalSec} onChange={(e) => set('minIntervalSec', Number(e.target.value))} /></Field>
          <Field label="Intervalo máximo (s)"><input type="number" min={10} max={7200} required value={f.maxIntervalSec} onChange={(e) => set('maxIntervalSec', Number(e.target.value))} /></Field>
        </div>
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label="Enviar a partir de"><input type="time" required value={f.windowStart} onChange={(e) => set('windowStart', e.target.value)} /></Field>
          <Field label="Até (horário de Brasília)"><input type="time" required value={f.windowEnd} onChange={(e) => set('windowEnd', e.target.value)} /></Field>
        </div>
        {intervalErr && <div className="alert err">O intervalo mínimo não pode ser maior que o máximo.</div>}
        <RepescagemFields f={f} set={(k, v) => setF((x) => ({ ...x, [k]: v }))} campaignId={initial?.id} />
        <Field label="Se o número entrar em nível Risco (Saúde do número)" hint="A campanha pausa sozinha para proteger o número contra bloqueio.">
          <select value={f.riscoRetomada} onChange={(e) => set('riscoRetomada', e.target.value as 'auto' | 'manual')}>
            <option value="auto">Pausar e retomar sozinha quando o nível melhorar</option>
            <option value="manual">Pausar e esperar eu clicar em Retomar</option>
          </select>
        </Field>
        <div className={`alert ${risky ? 'warn' : 'info'}`}>
          <strong>Boas práticas:</strong> envie só para quem autorizou, comece devagar (até {SAFE_DEFAULTS.dailyLimit}/dia em números novos), mantenha intervalos de {SAFE_DEFAULTS.minIntervalSec}–{SAFE_DEFAULTS.maxIntervalSec}s, respeite o horário comercial e ofereça sempre a opção de sair. Envios em massa sem consentimento podem bloquear o número.
          {risky && <div style={{ marginTop: 4 }}>⚠ Os limites escolhidos estão acima do recomendado.</div>}
          {JSON.stringify({ d: f.dailyLimit, a: f.minIntervalSec, b: f.maxIntervalSec, s: f.windowStart, e: f.windowEnd }) !== JSON.stringify({ d: SAFE_DEFAULTS.dailyLimit, a: SAFE_DEFAULTS.minIntervalSec, b: SAFE_DEFAULTS.maxIntervalSec, s: SAFE_DEFAULTS.windowStart, e: SAFE_DEFAULTS.windowEnd }) && (
            <div style={{ marginTop: 4 }}><button type="button" className="btn sm" onClick={() => setF({ ...f, ...SAFE_DEFAULTS })}>Usar padrões seguros</button></div>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || intervalErr || !f.channelId || legendaLonga || faltaConfirmarRisco(f, numeros.data ?? [], initial)}>{busy ? 'Salvando…' : initial ? 'Salvar alterações' : 'Criar campanha'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** v1.49.0: filtro do público pelas compras do MCK ERP (valor gasto, número de compras, última compra). */
type ErpForm = Record<keyof FiltroErp, string>;
const ERP_VAZIO: ErpForm = { gastoMin: '', gastoMax: '', comprasMin: '', comprasMax: '', ultimaCompraMaxDias: '', ultimaCompraMinDias: '' };
function erpDoForm(e: ErpForm): FiltroErp {
  const out: FiltroErp = {};
  for (const k of Object.keys(e) as (keyof FiltroErp)[]) { const v = e[k].trim().replace(',', '.'); if (v !== '' && Number.isFinite(Number(v))) out[k] = Number(v); }
  return out;
}
function ErpFiltroFields({ e, set }: { e: ErpForm; set: (e: ErpForm) => void }) {
  const [previa, setPrevia] = useState<{ disponivel: boolean; vinculados: number; atendem: number; contatos: number; motivo: string | null } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const filtro = erpDoForm(e);
  const chave = JSON.stringify(filtro);
  useEffect(() => {
    const err = erroFiltroErp(filtro);
    if (err) { setErro(err); return; }
    setErro(null);
    const t = setTimeout(() => { post<typeof previa>('/mckmensagem/segmento-erp/previa', filtro).then(setPrevia).catch((x) => setErro((x as Error).message)); }, 350);
    return () => clearTimeout(t);
  }, [chave]);
  const campo = (k: keyof FiltroErp, label: string, ph: string) => <Field label={label}><input inputMode="decimal" value={e[k]} placeholder={ph} onChange={(x) => set({ ...e, [k]: x.target.value })} /></Field>;
  return (
    <div className="card stack" style={{ padding: 12, background: '#fafbff' }}>
      {previa && !previa.disponivel
        ? <div className="alert warn small">{previa.motivo}</div>
        : <>
          <div className="grid g2" style={{ gap: 8 }}>
            {campo('gastoMin', 'Gastou no total, a partir de (R$)', 'ex.: 500')}{campo('gastoMax', 'até (R$)', '')}
            {campo('comprasMin', 'Número de compras, a partir de', 'ex.: 2')}{campo('comprasMax', 'até', '')}
            {campo('ultimaCompraMaxDias', 'Comprou nos últimos (dias)', 'ex.: 30')}{campo('ultimaCompraMinDias', 'Sem comprar há pelo menos (dias)', 'ex.: 90')}
          </div>
          <div className="small muted">Público: {descreverFiltroErp(filtro)}. Só contatos do MCK Mensagens com consentimento, ligados a um cliente do ERP (mesmo WhatsApp).</div>
        </>}
      {erro && <div className="alert err small">{erro}</div>}
      {previa?.disponivel && !erro && <div className="small"><strong>{fmtNum(previa.atendem)}</strong> contato(s) atendem ao filtro · {fmtNum(previa.vinculados)} de {fmtNum(previa.contatos)} estão ligados ao ERP</div>}
    </div>
  );
}

function StartModal({ c, onClose, onDone }: { c: Campaign; onClose: () => void; onDone: (c: Campaign) => void }) {
  const [mode, setMode] = useState<'linked' | 'tag' | 'erp'>(c.publico?.modo === 'erp' ? 'erp' : c.publico?.modo === 'etiqueta' ? 'tag' : 'linked');
  const [erp, setErp] = useState<ErpForm>(() => (c.publico?.modo === 'erp' ? { ...ERP_VAZIO, ...Object.fromEntries(Object.entries(c.publico.erp).map(([k, v]) => [k, v == null ? '' : String(v)])) } : ERP_VAZIO));
  const [tag, setTag] = useState(c.publico?.modo === 'etiqueta' ? c.publico.tag : '');
  const [quando, setQuando] = useState<'agora' | 'agendar'>('agora');
  const [data, setData] = useState('');
  const { busy, run } = useAction();
  const p = campaignProgress(c);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = mode === 'tag' ? { tag: tag.trim() } : mode === 'erp' ? { erp: erpDoForm(erp) } : {};
    if (quando === 'agendar' && data) body.agendarPara = brtParaIso(data);
    const r = await run(() => post<Campaign & { added: number; pending: number }>(`/mckmensagem/campaigns/${c.id}/start`, body), quando === 'agendar' && data ? `Campanha agendada para ${fmtBrt(brtParaIso(data))}` : undefined);
    if (r) onDone(r);
  };
  return (
    <Modal title={c.status === 'PAUSADA' ? 'Retomar campanha' : 'Iniciar campanha'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted" style={{ margin: 0 }}>Quem vai receber “{c.name}”? Só entram contatos com consentimento e sem opt-out; quem já está na fila não é duplicado.</p>
        <label className="mm-check" style={{ background: mode === 'linked' ? undefined : '#fff' }}><input type="radio" checked={mode === 'linked'} onChange={() => setMode('linked')} /><span>Contatos vinculados a esta campanha{p.pending ? <span className="small muted" style={{ fontWeight: 400 }}><br />{fmtNum(p.pending)} já na fila</span> : null}</span></label>
        <label className="mm-check" style={{ background: mode === 'tag' ? undefined : '#fff' }}><input type="radio" checked={mode === 'tag'} onChange={() => setMode('tag')} /><span>Contatos com a etiqueta…</span></label>
        {mode === 'tag' && <Field label="Etiqueta"><input required value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Ex.: vip" /></Field>}
        <label className="mm-check" style={{ background: mode === 'erp' ? undefined : '#fff' }}><input type="radio" checked={mode === 'erp'} onChange={() => setMode('erp')} /><span>Clientes pelas compras no MCK ERP<span className="small muted" style={{ fontWeight: 400 }}><br />valor gasto, número de compras e última compra</span></span></label>
        {mode === 'erp' && <ErpFiltroFields e={erp} set={setErp} />}
        {c.recorrencia && !c.recorrenciaOrigemId && <div className="alert info small">🔁 Repete {RECORRENCIA_ROTULO[c.recorrencia as Recorrencia]}{c.recorrenciaFim ? ` até ${fmtDate(c.recorrenciaFim)}` : ''}, a partir deste início, sempre para o público atual desta escolha.</div>}
        <Field label="Quando começar">
          <select value={quando} onChange={(e) => setQuando(e.target.value as 'agora' | 'agendar')}>
            <option value="agora">Agora</option>
            <option value="agendar">Agendar data e hora</option>
          </select>
        </Field>
        {quando === 'agendar' && <Field label="Começar em (horário de Brasília)" hint="Até 60 dias à frente. Você pode pausar antes de começar."><input type="datetime-local" required value={data} onChange={(e) => setData(e.target.value)} /></Field>}
        <div className="alert info small">Os envios respeitam o limite de {fmtNum(c.dailyLimit)}/dia, {diasTexto(c.diasSemana)}, intervalos de {c.minIntervalSec}–{c.maxIntervalSec}s e a janela das {c.windowStart} às {c.windowEnd}. Você pode pausar a qualquer momento.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Iniciando…' : quando === 'agendar' ? 'Agendar início' : c.status === 'PAUSADA' ? 'Retomar envios' : 'Iniciar envios'}</button>
        </div>
      </form>
    </Modal>
  );
}

function useCampaignActions(reload: () => void) {
  const { run } = useAction();
  const toast = useToast();
  const [starting, setStarting] = useState<Campaign | null>(null);
  const pause = async (c: Campaign) => { if (await run(() => post(`/mckmensagem/campaigns/${c.id}/pause`), 'Campanha pausada')) reload(); };
  const remove = async (c: Campaign, after?: () => void) => {
    if (!confirm(`Excluir a campanha “${c.name}”? A fila e o histórico de envios dela serão apagados (os contatos continuam na base).`)) return;
    if (await run(() => del(`/mckmensagem/campaigns/${c.id}`), 'Campanha excluída')) { reload(); after?.(); }
  };
  const exportReport = async (c: Campaign) => {
    try {
      const [m, leads] = await Promise.all([get<Metrics>(`/mckmensagem/metrics?campaignId=${c.id}`), fetchAllLeads({ campaignId: c.id })]);
      const p = campaignProgress(c);
      downloadCsv(`campanha-${slug(c.name)}.csv`, [
        ['campanha', c.name], ['status', c.status], ['enviadas', p.sent], ['falhas', p.failed], ['ignoradas', p.skipped], ['na_fila', p.pending],
        ['respostas', m.replies], ['taxa_resposta_%', m.responseRate], ['taxa_conversao_%', m.conversionRate], ['opt_outs', m.optOuts], [],
        ['telefone', 'nome', 'status', 'etiquetas', 'opt_out', 'consentimento', 'origem_consentimento'],
        ...leads.map((l) => [l.phone, l.name ?? '', LEAD_STATUS_LABEL[l.status] ?? l.status, l.tags.join('|'), l.optOutAt ? 'sim' : 'não', l.consentAt ?? '', l.consentSource]),
      ]);
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  // v1.46.1: devolve à fila só os que falharam por desconexão (nunca quem já recebeu).
  const [reenviando, setReenviando] = useState(false);
  const reenviarFalhas = async (c: Campaign) => {
    if (reenviando) return;
    setReenviando(true);
    try {
      const r = await post<{ devolvidos: number; jaRecebidos: number }>(`/mckmensagem/campaigns/${c.id}/reenviar-falhas-conexao`);
      toast(r.devolvidos
        ? `${fmtNum(r.devolvidos)} contato(s) voltaram para a fila${r.jaRecebidos ? ` · ${fmtNum(r.jaRecebidos)} já tinham recebido e não serão reenviados` : ''}.`
        : r.jaRecebidos ? `Nenhum para reenviar: ${fmtNum(r.jaRecebidos)} já tinham recebido a mensagem.` : 'Nenhum contato para reenviar.', 'ok');
      reload();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setReenviando(false); }
  };
  // v1.48.0: duplicar como rascunho e enviar teste.
  const [testando, setTestando] = useState<Campaign | null>(null);
  const duplicar = async (c: Campaign, after?: (nova: Campaign) => void) => {
    const r = await run(() => post<Campaign>(`/mckmensagem/campaigns/${c.id}/duplicar`), 'Campanha duplicada como rascunho');
    if (r) { reload(); after?.(r); }
  };
  // v1.51.1: "Enviar mesmo assim" direto na campanha que já existe (usa o número principal dela, sem rodízio).
  const assumirRisco = async (c: Campaign) => {
    if (!confirm(`Enviar a campanha “${c.name}” mesmo com o número em nível Risco?\n\nEla passa a sair só pelo número principal dela (sem rodízio). Isso aumenta a chance de bloqueio do chip pelo WhatsApp. Os limites por dia, intervalos e horário continuam valendo. Fica registrado quem confirmou e quando.`)) return;
    const r = await run(() => patch<Campaign>(`/mckmensagem/campaigns/${c.id}`, { envioFixo: true, channelId: c.channelId, confirmarRisco: true }),
      c.status === 'EM_ANDAMENTO' || c.status === 'AGENDADA' ? 'Envio liberado mesmo em risco' : 'Envio liberado mesmo em risco. Agora clique em ' + (c.status === 'CONCLUIDA' ? 'Reenviar' : c.status === 'PAUSADA' ? 'Retomar' : 'Iniciar') + '.');
    if (r) reload();
  };
  return { starting, setStarting, pause, remove, exportReport, reenviarFalhas, reenviando, testando, setTestando, duplicar, assumirRisco };
}

function Actions({ c, a, onEdit, compact, onDuplicated }: { c: Campaign; a: ReturnType<typeof useCampaignActions>; onEdit: () => void; compact?: boolean; onDuplicated?: (nova: Campaign) => void }) {
  const running = c.status === 'EM_ANDAMENTO' || c.status === 'AGENDADA';
  return (
    <div className="row">
      {running
        ? <button className="btn sm" onClick={() => a.pause(c)}>❚❚ Pausar</button>
        : <button className="btn sm primary" onClick={() => a.setStarting(c)}>▶ {c.status === 'PAUSADA' ? 'Retomar' : c.status === 'CONCLUIDA' ? 'Reenviar' : 'Iniciar'}</button>}
      <button className="btn sm" onClick={onEdit}>Editar</button>
      {!c.riscoLiberado && <button className="btn sm danger" title="Assumir o risco e enviar mesmo com o número em nível Risco" onClick={() => a.assumirRisco(c)}>⚠ Enviar mesmo assim</button>}
      {!compact && <button className="btn sm" onClick={() => a.setTestando(c)}>📱 Enviar teste</button>}
      {!compact && <button className="btn sm" onClick={() => a.duplicar(c, onDuplicated)}>Duplicar</button>}
      {!compact && <button className="btn sm" onClick={() => a.exportReport(c)}>Exportar</button>}
    </div>
  );
}

function Progress({ c }: { c: Campaign }) {
  const p = campaignProgress(c);
  return (
    <div>
      <div className="bar"><span style={{ width: `${p.pct}%` }} /></div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {p.total ? <>{fmtNum(p.sent)} enviadas · {fmtNum(p.pending)} na fila{p.failed ? ` · ${fmtNum(p.failed)} falhas` : ''}{p.skipped ? ` · ${fmtNum(p.skipped)} ignoradas` : ''} · {p.pct}%</> : 'Ainda sem destinatários'}
      </div>
    </div>
  );
}

/** v1.48.0: manda uma versão para um número (ex.: o seu) para ver como chega. Não entra na fila. */
function TesteModal({ c, onClose }: { c: Campaign; onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [nome, setNome] = useState('');
  const [versao, setVersao] = useState(0);
  const { busy, run } = useAction();
  const total = 1 + (c.variacoes?.length ?? 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => post(`/mckmensagem/campaigns/${c.id}/teste`, { phone, versao, nome: nome.trim() || undefined }), 'Teste enviado. Confira no WhatsApp.');
    if (r) onClose();
  };
  return (
    <Modal title="Enviar teste" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>Manda a mensagem para um número seu, do jeito que o contato vai receber. Não entra na fila nem nos resultados. Até 10 testes por hora.</p>
        <Field label="Seu WhatsApp (com DDD)"><input required inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 91234-5678" /></Field>
        <Field label="Nome usado no {nome} (opcional)"><input maxLength={80} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ana Souza" /></Field>
        {total > 1 && (
          <Field label="Versão">
            <select value={versao} onChange={(e) => setVersao(Number(e.target.value))}>{Array.from({ length: total }, (_, i) => <option key={i} value={i}>Versão {LETRAS[i]}</option>)}</select>
          </Field>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Enviando…' : 'Enviar teste'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** v1.48.0: resultado do teste A/B por versão. */
function AbCard({ c }: { c: Campaign }) {
  const versoes = [c.message, ...(c.variacoes ?? [])];
  if (versoes.length < 2) return null;
  const ab = c.ab ?? versoes.map((_, versao) => ({ versao, enviadas: 0, respostas: 0, taxa: 0 }));
  const lider = ab.reduce((m, r) => (r.enviadas && r.taxa > (m?.taxa ?? -1) ? r : m), null as null | (typeof ab)[number]);
  return (
    <div className="card stack">
      <div className="row between"><h2 style={{ margin: 0 }}>Teste A/B</h2>
        <span className="small muted">{c.abVencedora != null ? `Versão ${LETRAS[c.abVencedora]} venceu${c.abVencedoraEm ? ` em ${fmtDate(c.abVencedoraEm)}` : ''}: o resto da fila recebe ela.` : c.abAutoVencedora ? `Escolhe a vencedora sozinho depois de ${fmtNum(c.abMinimo ?? AB_MINIMO_PADRAO)} envios de cada versão.` : 'Cada contato recebe uma versão.'}</span>
      </div>
      <table><thead><tr><th>Versão</th><th style={{ textAlign: 'right' }}>Enviadas</th><th style={{ textAlign: 'right' }}>Respostas</th><th style={{ textAlign: 'right' }}>Taxa de resposta</th></tr></thead><tbody>
        {ab.map((r) => (
          <tr key={r.versao}>
            <td><strong>{LETRAS[r.versao]}</strong> {c.abVencedora === r.versao ? <span className="badge green">vencedora</span> : c.abVencedora == null && lider?.versao === r.versao && r.respostas > 0 ? <span className="badge">na frente</span> : null}
              <div className="small muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{versoes[r.versao]}</div></td>
            <td style={{ textAlign: 'right' }}>{fmtNum(r.enviadas)}</td><td style={{ textAlign: 'right' }}>{fmtNum(r.respostas)}</td><td style={{ textAlign: 'right' }}>{String(r.taxa).replace('.', ',')}%</td>
          </tr>
        ))}
      </tbody></table>
      <p className="small muted" style={{ margin: 0 }}>Com poucos envios a diferença pode ser sorte: espere pelo menos umas 30 mensagens por versão antes de decidir.</p>
    </div>
  );
}

function CampaignDetail({ id, list, reload }: { id: string; list: Campaign[]; reload: () => void }) {
  const nav = useNavigate();
  const c = list.find((x) => x.id === id);
  const metrics = useApi<Metrics>(c ? `/mckmensagem/metrics?campaignId=${id}` : null, [c?.updatedAt, c?.status]);
  const leads = useApi<{ items: any[]; total: number }>(c ? `/mckmensagem/leads?campaignId=${id}` : null, [c?.updatedAt]);
  const channels = useApi<ChannelLite[]>('/channels');
  const a = useCampaignActions(reload);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!c) return <Empty title="Campanha não encontrada"><NavLink to="/campanhas">Voltar para campanhas</NavLink></Empty>;
  const ch = channels.data?.find((x) => x.id === c.channelId);
  return (
    <>
      <div className="page-head">
        <div>
          <NavLink to="/campanhas" className="small">← Campanhas</NavLink>
          <h1 className="row">{c.name} <CampaignBadge status={c.status} /></h1>
          <p className="muted small">Criada em {fmtDate(c.createdAt)} · {ch ? <>{ch.label ?? ch.name}{ch.status !== 'CONNECTED' && <span className="badge red" style={{ marginLeft: 6 }}>desconectado</span>}</> : 'canal —'}</p>
        </div>
        <div className="row">
          <Actions c={c} a={a} onEdit={() => setEditing(true)} onDuplicated={(n) => nav(`/campanhas/${n.id}`)} />
          <button className="btn sm danger" onClick={() => a.remove(c, () => nav('/campanhas'))}>Excluir</button>
        </div>
      </div>
      <div className="stack">
        {c.riscoPausa && <div className="alert warn">⚠ {c.riscoPausa} <a href="/canais">Ver Saúde do número ↗</a>{' '}<span className="small">Para enviar por ele mesmo assim, toque em “⚠ Enviar mesmo assim”.</span></div>}
        {c.offlinePausa && <div className="alert warn">⏸ {c.offlinePausa} <a href="/canais">Conectar o WhatsApp ↗</a></div>}
        {c.envioFixo && <div className={`alert ${c.riscoLiberado ? 'warn' : 'info'} small`}>📱 Número de envio escolhido: {ch ? ch.label ?? ch.name : '—'} (sem rodízio).{c.riscoLiberado && <> Envio liberado mesmo em risco{c.riscoLiberadoPorNome ? ` por ${c.riscoLiberadoPorNome}` : ''}{c.riscoLiberadoEm ? ` em ${fmtBrt(c.riscoLiberadoEm)}` : ''}.</>}</div>}
        {c.status === 'AGENDADA' && c.iniciarEm && <div className="alert info">🗓 Começa sozinha em {fmtBrt(c.iniciarEm)} (horário de Brasília). Para cancelar, clique em Pausar.</div>}
        {c.midiaFaltando && <div className="alert warn">⚠ A imagem/PDF desta campanha foi excluída. Anexe de novo em Editar e clique em Retomar.</div>}
        {c.origem && <div className="alert info small">🔁 Repetição nº {c.recorrenciaExecucao} de <NavLink to={`/campanhas/${c.origem.id}`}>{c.origem.name}</NavLink>.</div>}
        {c.recorrencia && !c.recorrenciaOrigemId && (
          <div className="alert info small">🔁 Repete {RECORRENCIA_ROTULO[c.recorrencia as Recorrencia]}{c.recorrenciaFim ? ` até ${fmtDate(c.recorrenciaFim)}` : ''}.{' '}
            {c.recorrenciaProxima ? <>Próxima: {fmtBrt(c.recorrenciaProxima)} (Brasília).</> : c.status === 'PAUSADA' || c.status === 'RASCUNHO' ? 'Começa a contar quando a campanha for iniciada.' : 'Sem próximas repetições.'}
            {!!c.repeticoes && <> · {fmtNum(c.repeticoes)} repetição(ões) criadas (aparecem na lista de campanhas).</>}
          </div>
        )}
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Progresso</h2><Progress c={c} />
          {!!c.falhasConexao && (
            <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span className="small muted">{fmtNum(c.falhasConexao)} falharam porque o WhatsApp estava desconectado. Quem já recebeu nunca é reenviado.</span>
              <button className="btn sm" disabled={a.reenviando} onClick={() => a.reenviarFalhas(c)}>{a.reenviando ? 'Devolvendo…' : '↻ Reenviar os que falharam por desconexão'}</button>
            </div>
          )}
        </div>
        <Async state={metrics}>{(m) => <MetricsView m={m} />}</Async>
        <AbCard c={c} />
        <CampaignGroups c={c} />
        <div className="grid g2">
          <div className="card">
            <h2>Mensagem</h2>
            <div className="mm-preview"><div className="b"><MidiaPrevia m={c.midias?.[0] ? { id: c.midias[0].id, nome: c.midias[0].nome, mime: c.midias[0].mime } : null} campaignId={c.id} versao={0} />{textoParaContato(c.message, { campaignId: c.id, leadId: 'previa', nome: 'Ana', saudacao: saudacaoDe(new Date()) })}</div></div>
            {c.publico && c.publico.modo !== 'vinculados' && <p className="small muted" style={{ margin: '8px 0 0' }}>Público: {c.publico.modo === 'etiqueta' ? `etiqueta “${c.publico.tag}”` : `compras no ERP — ${descreverFiltroErp(c.publico.erp as FiltroErp)}`}</p>}
            {c.rodizio && !!c.canaisRodizio?.length && (
              <p className="small muted" style={{ margin: '8px 0 0' }}>Rodízio entre {c.canaisRodizio.length + 1} números: {[c.channelId, ...c.canaisRodizio].map((id) => {
                const n = channels.data?.find((x) => x.id === id);
                const env = c.enviadasPorNumero?.find((x) => x.channelId === id)?.enviadas ?? 0;
                return `${n ? n.label ?? n.name : 'número removido'} (${fmtNum(env)} enviadas)`;
              }).join(' · ')}</p>
            )}
            <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>Limite {fmtNum(c.dailyLimit)}/dia · intervalo {c.minIntervalSec}–{c.maxIntervalSec}s · das {c.windowStart} às {c.windowEnd} (Brasília), {diasTexto(c.diasSemana)}{c.variacoes?.length ? ` · ${c.variacoes.length + 1} versões` : ''} · repescagem {c.repescagemAtiva ? `ligada (${c.repescagemDias ?? 2} dias, até ${c.repescagemMax ?? 2}x)` : 'desligada'}</p>
          </div>
          <div className="card">
            <div className="row between"><h2 style={{ margin: 0 }}>Contatos vinculados{leads.data ? ` (${fmtNum(leads.data.total)})` : ''}</h2><span className="row"><button className="btn sm primary" onClick={() => setAdding(true)}>+ Adicionar contatos</button><NavLink to={`/contatos?campaignId=${c.id}`} className="small">Ver todos / remover →</NavLink></span></div>
            <Async state={leads}>{(d) => d.items.length === 0
              ? <p className="muted small" style={{ marginTop: 8 }}>Nenhum contato vinculado. Use “Adicionar contatos” para escolher vários de uma vez (com busca, etiqueta e status), ou inicie por etiqueta.</p>
              : (
                <table style={{ marginTop: 8 }}><tbody>
                  {d.items.slice(0, 8).map((l) => <tr key={l.id}><td>{l.name || '—'}<div className="small muted">{fmtPhone(l.phone)}</div></td><td style={{ textAlign: 'right' }}><span className="badge">{LEAD_STATUS_LABEL[l.status as keyof typeof LEAD_STATUS_LABEL]}</span></td></tr>)}
                </tbody></table>
              )}</Async>
          </div>
        </div>
      </div>
      {editing && <CampaignForm initial={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {a.starting && <StartModal c={a.starting} onClose={() => a.setStarting(null)} onDone={() => { a.setStarting(null); reload(); }} />}
      {a.testando && <TesteModal c={a.testando} onClose={() => a.setTestando(null)} />}
      {adding && <AddContactsModal c={c} onClose={() => setAdding(false)} onDone={() => { setAdding(false); leads.reload(); metrics.reload(); reload(); }} />}
    </>
  );
}

export default function MmCampaigns() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const state = useApi<Campaign[]>('/mckmensagem/campaigns');
  const a = useCampaignActions(state.reload);
  const [editing, setEditing] = useState<Campaign | 'new' | null>(sp.get('nova') ? 'new' : null);
  const closeForm = () => { setEditing(null); if (sp.get('nova')) setSp(new URLSearchParams(), { replace: true }); };

  if (id) return <Async state={state}>{(list) => <CampaignDetail id={id} list={list} reload={state.reload} />}</Async>;
  return (
    <>
      <div className="page-head">
        <div><h1>Campanhas</h1><p className="muted">Disparos personalizados com limites seguros, janela de horário e opt-out automático.</p></div>
        <button className="btn primary" onClick={() => setEditing('new')}>+ Nova campanha</button>
      </div>
      <Async state={state}>{(list) => list.length === 0 ? (
        <div className="card"><Empty title="Nenhuma campanha ainda">Crie a primeira campanha, escreva a mensagem com {'{nome}'} e escolha o número de WhatsApp.<div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => setEditing('new')}>Criar campanha</button></div></Empty></div>
      ) : (
        <div className="grid g2">
          {list.map((c) => (
            <div key={c.id} className="card mm-camp">
              <div className="head">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <NavLink to={`/campanhas/${c.id}`} style={{ fontWeight: 700, fontSize: 15 }}>{c.name}</NavLink>
                  <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{c.message}</div>
                </div>
                <CampaignBadge status={c.status} />
              </div>
              <Progress c={c} />
              {c.riscoPausa && <div className="small" style={{ color: '#b7791f' }} title={c.riscoPausa}>⚠ Pausada: número em nível Risco{c.status === 'PAUSADA' ? ' — clique em Retomar quando quiser' : ' — volta sozinha quando melhorar'}</div>}
              {c.repescagemPausa && <div className="small" style={{ color: '#b7791f' }}>⚠ Repescagem pausada — veja os detalhes</div>}
              {c.offlinePausa && <div className="small" style={{ color: '#b7791f' }} title={c.offlinePausa}>⏸ Aguardando: o WhatsApp desconectou — continua sozinha quando reconectar</div>}
              {c.status === 'AGENDADA' && c.iniciarEm && <div className="small" style={{ color: '#2f6fde' }}>🗓 Começa em {fmtBrt(c.iniciarEm)}</div>}
              {!!c.variacoes?.length && <div className="small muted">🔀 {c.variacoes.length + 1} versões{c.abVencedora != null ? ` · vencedora: ${LETRAS[c.abVencedora]}` : ''}</div>}
              {(!!c.midias?.some(Boolean) || !!c.recorrencia || !!c.origem || (c.rodizio && !!c.canaisRodizio?.length) || !!c.envioFixo) && (
                <div className="small muted">{[c.midias?.some(Boolean) && '📎 com imagem/PDF', c.recorrencia && `🔁 repete ${RECORRENCIA_ROTULO[c.recorrencia as Recorrencia]}`, c.origem && `🔁 repetição nº ${c.recorrenciaExecucao}`, !c.envioFixo && c.rodizio && c.canaisRodizio?.length && `🔄 ${c.canaisRodizio.length + 1} números`, c.envioFixo && (c.riscoLiberado ? '📱 número escolhido (liberado em risco)' : '📱 número escolhido')].filter(Boolean).join(' · ')}</div>
              )}
              <div className="row between">
                <Actions c={c} a={a} onEdit={() => setEditing(c)} compact />
                <div className="row">
                  <button className="btn sm ghost" onClick={() => a.exportReport(c)}>Exportar</button>
                  <button className="btn sm ghost" onClick={() => nav(`/campanhas/${c.id}`)}>Métricas →</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}</Async>
      {editing && <CampaignForm initial={editing === 'new' ? undefined : editing} onClose={closeForm} onSaved={(c) => { closeForm(); state.reload(); if (editing === 'new') nav(`/campanhas/${c.id}`); }} />}
      {a.starting && <StartModal c={a.starting} onClose={() => a.setStarting(null)} onDone={() => { a.setStarting(null); state.reload(); }} />}
    </>
  );
}
