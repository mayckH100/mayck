/**
 * v1.47.0 — Gravação e conversão de áudio no navegador (sem servidor, sem custo).
 * Tudo vira WAV mono 24 kHz 16 bits; o servidor transforma em OGG/Opus (nota de voz do WhatsApp).
 * Arquivos MP3/M4A/OGG/WAV são decodificados pelo próprio navegador.
 */
export const RATE = 24000;

export function encodeWav(samples: Float32Array, rate = RATE): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

async function toMono24k(audio: AudioBuffer): Promise<Float32Array> {
  const len = Math.ceil(audio.duration * RATE);
  const off = new OfflineAudioContext(1, Math.max(1, len), RATE);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

/** Arquivo (MP3, M4A, OGG, WAV, WEBM) → WAV 24 kHz mono + duração. */
export async function fileToWav(file: Blob): Promise<{ wav: Blob; seconds: number }> {
  const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const mono = await toMono24k(audio);
    return { wav: encodeWav(mono), seconds: mono.length / RATE };
  } catch {
    throw new Error('Não deu para ler este áudio. Envie MP3, M4A, OGG ou WAV.');
  } finally {
    ctx.close().catch(() => undefined);
  }
}

export interface Recorder { stop(): Promise<{ wav: Blob; seconds: number }>; cancel(): void; seconds(): number; level(): number }

/** Grava pelo microfone (pede permissão). */
export async function startRecording(): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não permite gravar. Envie um arquivo de áudio.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch {
    throw new Error('Permita o uso do microfone no navegador para gravar.');
  }
  const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let total = 0;
  let lvl = 0;
  proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(d);
    total += d.length;
    let peak = 0; for (let i = 0; i < d.length; i += 32) peak = Math.max(peak, Math.abs(d[i]));
    lvl = peak;
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  const end = () => { try { proc.disconnect(); src.disconnect(); } catch { /* já desligado */ } stream.getTracks().forEach((t) => t.stop()); };
  return {
    seconds: () => total / ctx.sampleRate,
    level: () => lvl,
    cancel: () => { end(); ctx.close().catch(() => undefined); },
    async stop() {
      end();
      const all = new Float32Array(total);
      let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      const buf = ctx.createBuffer(1, Math.max(1, all.length), ctx.sampleRate);
      buf.copyToChannel(all, 0);
      const mono = await toMono24k(buf);
      ctx.close().catch(() => undefined);
      return { wav: encodeWav(mono), seconds: mono.length / RATE };
    },
  };
}
