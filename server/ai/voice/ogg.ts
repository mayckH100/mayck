/**
 * Áudio da IA (v1.23.0): PCM → OGG/Opus mono (nota de voz do WhatsApp) sem ffmpeg.
 *
 * Por que não ffmpeg: o Render (runtime Node nativo, plano Free) não tem ffmpeg no sistema e o
 * ffmpeg-static baixa um binário de ~70 MB no `npm ci` (falha de rede no build derruba o deploy).
 * O codificador Opus vem do pacote `opusscript` (libopus compilada para WebAssembly, MIT, ~1 MB,
 * sem compilação nativa, roda em qualquer Node ≥ 20). O contêiner Ogg (RFC 3533 + RFC 7845) é
 * montado aqui, em TypeScript puro: cabeçalho OpusHead, OpusTags, páginas com CRC e granule.
 */
import { createRequire } from 'node:module';

/** Taxas que o Opus aceita na entrada. */
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000] as const;
/** Atraso do codificador em amostras de 48 kHz (lookahead padrão da libopus, o mesmo do opusenc). */
export const OPUS_PRE_SKIP = 312;
const FRAME_MS = 20;

// ---------- CRC do Ogg (polinômio 0x04C11DB7, sem reflexão, valor inicial 0) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    t[i] = r >>> 0;
  }
  return t;
})();
export function oggCrc(buf: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** Monta uma página Ogg com os segmentos (lacing) dos pacotes dados. */
function oggPage(packets: Buffer[], opts: { granule: bigint; serial: number; seq: number; bos?: boolean; eos?: boolean }): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error('Página Ogg com segmentos demais');
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0; // versão
  header[5] = (opts.bos ? 0x02 : 0) | (opts.eos ? 0x04 : 0);
  header.writeBigInt64LE(opts.granule, 6);
  header.writeUInt32LE(opts.serial >>> 0, 14);
  header.writeUInt32LE(opts.seq >>> 0, 18);
  header.writeUInt32LE(0, 22); // CRC calculado abaixo
  header[26] = lacing.length;
  lacing.forEach((l, i) => { header[27 + i] = l; });
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/** Cabeçalho OpusHead (RFC 7845 §5.1), mono, família de mapeamento 0. */
export function opusHead(inputRate: number, preSkip = OPUS_PRE_SKIP, channels = 1): Buffer {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b[8] = 1; // versão
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(inputRate, 12);
  b.writeInt16LE(0, 16); // ganho
  b[18] = 0; // mapeamento
  return b;
}

/** Cabeçalho OpusTags (RFC 7845 §5.2) com o nome do "fornecedor" e sem comentários. */
export function opusTags(vendor = 'MCKBOT'): Buffer {
  const v = Buffer.from(vendor, 'utf8');
  const b = Buffer.alloc(8 + 4 + v.length + 4);
  b.write('OpusTags', 0, 'ascii');
  b.writeUInt32LE(v.length, 8);
  v.copy(b, 12);
  b.writeUInt32LE(0, 12 + v.length);
  return b;
}

/**
 * Empacota pacotes Opus (quadros de `frameMs`) num arquivo Ogg. `totalSamples48` = duração real em amostras
 * de 48 kHz (sem o preenchimento do último quadro), usada no granule final para cortar o silêncio extra.
 */
export function buildOggOpus(packets: Buffer[], opts: { inputRate: number; frameMs?: number; totalSamples48?: number; serial?: number; preSkip?: number }): Buffer {
  const frame48 = (48000 * (opts.frameMs ?? FRAME_MS)) / 1000;
  const preSkip = opts.preSkip ?? OPUS_PRE_SKIP;
  const serial = opts.serial ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const pages: Buffer[] = [];
  let seq = 0;
  pages.push(oggPage([opusHead(opts.inputRate, preSkip)], { granule: 0n, serial, seq: seq++, bos: true, eos: packets.length === 0 }));
  pages.push(oggPage([opusTags()], { granule: 0n, serial, seq: seq++ }));
  const encoded48 = packets.length * frame48;
  const finalGranule = BigInt(Math.min(encoded48, preSkip + (opts.totalSamples48 ?? encoded48)));
  // Até 50 pacotes (1 s) por página e no máximo 255 segmentos.
  let i = 0;
  while (i < packets.length) {
    const chunk: Buffer[] = [];
    let segs = 0;
    while (i < packets.length && chunk.length < 50) {
      const s = Math.floor(packets[i].length / 255) + 1;
      if (segs + s > 255) break;
      chunk.push(packets[i]);
      segs += s;
      i++;
    }
    const last = i >= packets.length;
    const granule = last ? finalGranule : BigInt(i * frame48);
    pages.push(oggPage(chunk, { granule, serial, seq: seq++, eos: last }));
  }
  return Buffer.concat(pages);
}

/** O buffer é um arquivo Ogg com Opus? */
export function isOggOpus(buf: Buffer): boolean {
  return buf.length > 47 && buf.toString('ascii', 0, 4) === 'OggS' && buf.indexOf('OpusHead', 0, 'ascii') > 0 && buf.indexOf('OpusHead', 0, 'ascii') < 64;
}

/** Duração (s) de um Ogg/Opus pelo granule da última página. null se não for Ogg/Opus válido. */
export function oggOpusDurationSec(buf: Buffer): number | null {
  if (!isOggOpus(buf)) return null;
  const head = buf.indexOf('OpusHead', 0, 'ascii');
  const preSkip = buf.readUInt16LE(head + 10);
  const last = buf.lastIndexOf('OggS', buf.length - 27, 'ascii');
  if (last < 0 || last + 14 > buf.length) return null;
  const granule = buf.readBigInt64LE(last + 6);
  if (granule < 0n) return null;
  return Math.max(0, (Number(granule) - preSkip) / 48000);
}

// ---------- PCM ----------
export interface Pcm { samples: Int16Array; rate: number }

/** Lê WAV (RIFF, PCM 16 bits) ou PCM cru s16le (taxa do mime "rate=24000"; padrão 24 kHz). Converte estéreo em mono. */
export function decodePcm(buf: Buffer, mime = ''): Pcm {
  if (buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12;
    let rate = 24000;
    let channels = 1;
    let bits = 16;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      let size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(body + 2);
        rate = buf.readUInt32LE(body + 4);
        bits = buf.readUInt16LE(body + 14);
      } else if (id === 'data') {
        if (bits !== 16) throw new Error(`WAV com ${bits} bits não suportado`);
        if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body; // streaming: tamanho desconhecido
        return toMono(new Int16Array(new Uint8Array(buf.subarray(body, body + size - (size % 2))).buffer), channels, rate);
      }
      off = body + size + (size % 2);
    }
    throw new Error('WAV sem bloco de dados');
  }
  const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000) || 24000;
  const copy = new Uint8Array(buf.subarray(0, buf.length - (buf.length % 2)));
  return { samples: new Int16Array(copy.buffer), rate };
}

function toMono(s: Int16Array, channels: number, rate: number): Pcm {
  if (channels <= 1) return { samples: s, rate };
  const out = new Int16Array(Math.floor(s.length / channels));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += s[i * channels + c];
    out[i] = Math.round(sum / channels);
  }
  return { samples: out, rate };
}

/** Reamostragem linear simples (só quando a taxa não é aceita pelo Opus). */
export function resample(p: Pcm, to: number): Pcm {
  if (p.rate === to) return p;
  const ratio = p.rate / to;
  const n = Math.floor(p.samples.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const a = Math.floor(x);
    const b = Math.min(a + 1, p.samples.length - 1);
    out[i] = Math.round(p.samples[a] + (p.samples[b] - p.samples[a]) * (x - a));
  }
  return { samples: out, rate: to };
}

/** Forma de onda (64 valores 0–100) que o WhatsApp desenha na nota de voz. */
export function waveform(samples: Int16Array, bars = 64): Uint8Array {
  const out = new Uint8Array(bars);
  if (!samples.length) return out;
  const block = Math.max(1, Math.floor(samples.length / bars));
  const vals: number[] = [];
  for (let b = 0; b < bars; b++) {
    let sum = 0;
    const start = b * block;
    const end = Math.min(samples.length, start + block);
    for (let i = start; i < end; i++) sum += Math.abs(samples[i]);
    vals.push(end > start ? sum / (end - start) : 0);
  }
  const max = Math.max(...vals) || 1;
  vals.forEach((v, i) => { out[i] = Math.floor((100 * v) / max); });
  return out;
}

type OpusEncoder = { encode(b: Buffer, frame: number): Buffer; setBitrate(b: number): void; delete(): void };
type OpusCtor = { new (rate: number, channels?: number, app?: number): OpusEncoder; Application: { VOIP: number } };
let OpusScriptCtor: OpusCtor | null = null;
/** Carrega o opusscript (WebAssembly) só quando o primeiro áudio é gerado. */
function opusScript(): OpusCtor {
  if (!OpusScriptCtor) OpusScriptCtor = createRequire(import.meta.url)('opusscript') as OpusCtor;
  return OpusScriptCtor;
}

export interface EncodedVoice { ogg: Buffer; seconds: number; waveform: Uint8Array }

/** PCM 16 bits mono → OGG/Opus mono (voz, 24 kbps, quadros de 20 ms). Puro e síncrono. */
export function pcmToOggOpus(input: Pcm, opts: { bitrate?: number } = {}): EncodedVoice {
  const pcm = (OPUS_RATES as readonly number[]).includes(input.rate) ? input : resample(input, 24000);
  const frame = (pcm.rate * FRAME_MS) / 1000;
  const Ctor = opusScript();
  const enc = new Ctor(pcm.rate, 1, Ctor.Application.VOIP);
  try {
    enc.setBitrate(opts.bitrate ?? 24000);
    const packets: Buffer[] = [];
    const bytes = Buffer.from(pcm.samples.buffer, pcm.samples.byteOffset, pcm.samples.byteLength);
    const frameBytes = frame * 2;
    for (let off = 0; off < bytes.length; off += frameBytes) {
      let chunk = bytes.subarray(off, off + frameBytes);
      if (chunk.length < frameBytes) { const pad = Buffer.alloc(frameBytes); chunk.copy(pad); chunk = pad; }
      packets.push(Buffer.from(enc.encode(Buffer.from(chunk), frame))); // cópia: a saída aponta para a memória do wasm
    }
    const total48 = Math.round((pcm.samples.length * 48000) / pcm.rate);
    return { ogg: buildOggOpus(packets, { inputRate: input.rate, totalSamples48: total48 }), seconds: pcm.samples.length / pcm.rate, waveform: waveform(pcm.samples) };
  } finally {
    enc.delete();
  }
}
