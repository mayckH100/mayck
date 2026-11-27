/**
 * Balança ligada ao computador (v1.58.0), sem marca fixa: cabo serial ou USB-serial, pelo Chrome/Edge no computador
 * (Web Serial). Pede o peso (ENQ, aceito por Toledo, Filizola, Urano, Elgin e outras) e também escuta a balança que manda
 * o peso sozinha. A velocidade (baud) fica salva neste computador.
 */
import { pesoDaBalanca, type LeituraPeso } from '../../../../server/erp/shared/balanca';

const CHAVE = 'mck.balanca.baud';
export const BAUDS = [2400, 4800, 9600, 19200] as const;
export const baudSalvo = () => Number(localStorage.getItem(CHAVE)) || 9600;
export const salvarBaud = (b: number) => localStorage.setItem(CHAVE, String(b));
export const temSerial = () => typeof navigator !== 'undefined' && 'serial' in navigator;

let porta: any = null;

async function abrir(escolher: boolean): Promise<any> {
  const serial = (navigator as any).serial;
  if (!porta) { const ja = await serial.getPorts(); porta = ja[0] ?? null; }
  if (!porta || escolher) porta = await serial.requestPort();
  if (!porta.readable) await porta.open({ baudRate: baudSalvo(), dataBits: 8, stopBits: 1, parity: 'none' });
  return porta;
}

/** Lê um peso da balança. `escolher` = abrir a lista de portas (primeira vez ou trocar de balança). */
export async function lerPeso(escolher = false): Promise<LeituraPeso> {
  if (!temSerial()) return { ok: false, erro: 'Este navegador não fala com a balança. Use o Chrome ou o Edge no computador, ou leia a etiqueta da balança.' };
  let p: any;
  try { p = await abrir(escolher); } catch (e) { return { ok: false, erro: (e as Error)?.name === 'NotFoundError' ? 'Nenhuma balança escolhida' : 'Não consegui abrir a balança. Confira o cabo.' }; }
  try {
    const w = p.writable.getWriter(); await w.write(new Uint8Array([0x05])); w.releaseLock();
  } catch { /* balança que só envia */ }
  const leitor = p.readable.getReader();
  const dec = new TextDecoder(); let texto = '';
  const limite = setTimeout(() => leitor.cancel().catch(() => {}), 1500);
  try {
    while (true) {
      const { value, done } = await leitor.read();
      if (done) break;
      texto += dec.decode(value);
      const r = pesoDaBalanca(texto);
      if (r.ok && /[\x03\r\n]|kg/i.test(texto)) break;
    }
  } catch { /* tempo esgotado */ } finally { clearTimeout(limite); leitor.releaseLock(); }
  return pesoDaBalanca(texto);
}

export async function fecharBalanca() { try { await porta?.close(); } catch { /* já fechada */ } porta = null; }
