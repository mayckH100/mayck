/**
 * Leitura unificada (v1.34.0): o MESMO componente em Venda balcão, Localizar pedido, Rastreio, Inventário, Entrada de
 * estoque / conferência de recebimento e Separação de pedido.
 *  - Leitor de código de barras/QR USB ou Bluetooth (modo teclado: "digita" o código + Enter);
 *  - Câmera do celular (leitor nativo do navegador: Chrome no Android; lê sem parar, cada leitura conta);
 *  - Digitação.
 * Retorno de cada leitura: bipe + vibração (ok) ou bipe grave duplo + vibração longa (erro), e a mensagem na tela.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from '../../ui';

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type BDCtor = new (o: { formats: string[] }) => Detector;
let audio: AudioContext | null = null;

/** Bipe curto (ok) ou duplo grave (erro) + vibração. Nunca lança (aparelho sem som/vibração segue sem). */
export function sinal(ok: boolean) {
  try { navigator.vibrate?.(ok ? 60 : [200, 80, 200]); } catch { /* sem vibração */ }
  try {
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audio = audio ?? new AC();
    const tocar = (inicio: number, freq: number, dur: number) => {
      const o = audio!.createOscillator(); const g = audio!.createGain();
      o.frequency.value = freq; o.type = 'square'; g.gain.value = 0.05;
      o.connect(g); g.connect(audio!.destination); o.start(audio!.currentTime + inicio); o.stop(audio!.currentTime + inicio + dur);
    };
    if (ok) tocar(0, 1800, 0.08); else { tocar(0, 300, 0.15); tocar(0.22, 300, 0.15); }
  } catch { /* sem som */ }
}

/** O navegador lê código pela câmera? (Chrome Android sim; iPhone/Safari e Firefox não.) */
export const cameraLeCodigo = () => typeof window !== 'undefined' && !!(window as unknown as { BarcodeDetector?: BDCtor }).BarcodeDetector;

/**
 * Câmera do celular lendo código de barras (EAN, Code 128/GS1-128, ITF da chave do DANFE, UPC...) e QR, sem instalar nada.
 * Lê sem parar: o mesmo código só conta de novo depois de 1,5 s.
 */
export function LeitorCamera({ onLer, onClose, continuo = true, dica }: { onLer: (codigo: string) => void; onClose: () => void; continuo?: boolean; dica?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ultimo, setUltimo] = useState('');
  const cb = useRef(onLer); cb.current = onLer;
  useEffect(() => {
    let parar = false; let stream: MediaStream | null = null; let ult = ''; let quando = 0;
    const BD = (window as unknown as { BarcodeDetector?: BDCtor }).BarcodeDetector;
    if (!BD) { setErro('Este navegador não lê código pela câmera (iPhone e alguns navegadores não têm o leitor). Use o Chrome no Android, um leitor de código de barras (USB/Bluetooth) ou digite o código.'); return; }
    const det = new BD({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix', 'pdf417'] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!video.current) return;
        video.current.srcObject = stream; await video.current.play();
        while (!parar) {
          const r = await det.detect(video.current).catch(() => []);
          const v = r[0]?.rawValue;
          if (v && (v !== ult || Date.now() - quando > 1500)) {
            ult = v; quando = Date.now(); setUltimo(v);
            cb.current(v);
            if (!continuo) { parar = true; break; }
          }
          await new Promise((ok) => setTimeout(ok, 180));
        }
      } catch { setErro('Não foi possível abrir a câmera. Permita o uso da câmera para este site (cadeado ao lado do endereço) e tente de novo.'); }
    })();
    return () => { parar = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [continuo]);
  return (
    <Modal title="Ler com a câmera" onClose={onClose}>
      {erro ? <p>{erro}</p> : <>
        <video ref={video} muted playsInline style={{ width: '100%', maxHeight: '55vh', background: '#000', borderRadius: 8 }} />
        <p className="small muted">{dica ?? 'Aponte para o código de barras ou QR.'}{continuo ? ' Cada leitura conta 1.' : ''}</p>
        {ultimo && <p className="small">Último lido: <code>{ultimo.replace(/[\x00-\x1f]/g, ' ').slice(0, 60)}</code></p>}
      </>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Pronto</button></div>
    </Modal>
  );
}

export type Retorno = { ok: boolean; msg?: string } | void | boolean;

/**
 * Campo de leitura: leitor (digita + Enter), digitação ou câmera. `onCodigo` pode devolver { ok, msg } (ou true/false)
 * para o bipe e a mensagem de retorno; lança = erro com a mensagem do erro.
 */
export function CampoLeitura({ onCodigo, placeholder = 'Leia o código de barras / QR ou digite', continuo = true, autoFocus = true, extra, dicaCamera, rotuloOk = 'OK' }: {
  onCodigo: (c: string) => Retorno | Promise<Retorno>; placeholder?: string; continuo?: boolean; autoFocus?: boolean; extra?: ReactNode; dicaCamera?: string; rotuloOk?: string;
}) {
  const [v, setV] = useState(''); const [cam, setCam] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const tratar = async (c: string) => {
    const codigo = c.replace(/[\r\n]+$/g, '');
    if (!codigo.trim()) return;
    try {
      const r = await onCodigo(codigo);
      const ok = typeof r === 'boolean' ? r : r ? r.ok : true;
      const t = typeof r === 'object' && r?.msg ? r.msg : null;
      sinal(ok); setMsg(t ? { ok, t } : ok ? null : { ok, t: 'Código não reconhecido' });
    } catch (e) { sinal(false); setMsg({ ok: false, t: (e as Error).message }); }
  };
  return (
    <div className="campo-leitura">
      <form className="row" style={{ gap: 6, flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); const c = v; setV(''); ref.current?.focus(); tratar(c); }}>
        <input ref={ref} autoFocus={autoFocus} value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} style={{ flex: 1, minWidth: 0 }} aria-label="Código lido" inputMode="text" autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" />
        {extra}
        <button type="button" className="btn" onClick={() => setCam(true)} aria-label="Ler com a câmera" title="Ler com a câmera do celular">📷</button>
        <button className="btn primary">{rotuloOk}</button>
      </form>
      {msg && <div role="status" className="small" style={{ marginTop: 4, padding: '6px 8px', borderRadius: 6, background: msg.ok ? '#ecfdf5' : '#fef2f2', color: msg.ok ? '#065f46' : '#991b1b', fontWeight: 600 }}>{msg.ok ? '✔ ' : '⚠️ '}{msg.t}</div>}
      {cam && <LeitorCamera continuo={continuo} dica={dicaCamera} onLer={(c) => { tratar(c); if (!continuo) setCam(false); }} onClose={() => { setCam(false); ref.current?.focus(); }} />}
    </div>
  );
}
