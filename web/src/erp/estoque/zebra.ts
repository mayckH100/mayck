/**
 * Impressão DIRETA na Zebra (v1.34.0), sem baixar arquivo. "Localizar impressora" procura e pareia; a escolha fica
 * guardada NESTE aparelho (localStorage) e "Imprimir" manda o ZPL direto. Caminhos, na ordem de preferência:
 *  1) Bluetooth (BLE) pelo Chrome no Android — serviço "Zebra Parser Data" das Zebra Link-OS (ZQ, ZD com BLE...),
 *     ZPL enviado em blocos pequenos;
 *  2) USB pelo Chrome no computador (WebUSB, fabricante Zebra 0x0A5F, interface de impressora, envio em blocos);
 *  3) Zebra Browser Print instalado no computador (descobre impressoras USB e de REDE/IP cadastradas nele);
 *  4) Rede/IP: o navegador não fala direto com a porta 9100 da impressora (página HTTPS não pode abrir conexão crua
 *     nem chamar http://IP); o caminho local viável é o Browser Print com a impressora de rede adicionada nele.
 *  Só como último recurso (e dizendo o porquê), baixar o arquivo .zpl.
 * Nada disto foi testado com impressora física pela MCK até a v1.34.0 (ver docs/ERP.md › v1.34.0).
 */

export type Conexao = 'bluetooth' | 'usb' | 'browserprint';
export interface ImpressoraSalva { conexao: Conexao; nome: string; id?: string; serie?: string; device?: Record<string, unknown> }
export type Status = 'procurando' | 'conectando' | 'conectada' | 'imprimindo' | 'impresso' | 'erro';

const CHAVE = 'mck:zebra:impressora';
// Zebra Link-OS BLE: serviço "Zebra Parser Data" e característica "Write to printer".
export const ZEBRA_BLE_SERVICO = '38eb4a80-c570-11e3-9507-0002a5d5c51b';
export const ZEBRA_BLE_ESCREVER = '38eb4a82-c570-11e3-9507-0002a5d5c51b';
export const ZEBRA_USB_VENDOR = 0x0a5f;
const BP = ['http://localhost:9100', 'https://localhost:9101'];

/** Erro com o que fazer, para mostrar na tela. */
export class ErroZebra extends Error { constructor(msg: string, public oQueFazer: string, public cancelado = false) { super(msg); } }

const nav = () => navigator as unknown as { bluetooth?: any; usb?: any };
export const suporte = () => ({ bluetooth: typeof navigator !== 'undefined' && !!nav().bluetooth, usb: typeof navigator !== 'undefined' && !!nav().usb, iphone: typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent) });

export function impressoraSalva(): ImpressoraSalva | null {
  try { const s = JSON.parse(localStorage.getItem(CHAVE) ?? 'null'); return s && s.conexao ? s : null; } catch { return null; }
}
function salvar(i: ImpressoraSalva) { localStorage.setItem(CHAVE, JSON.stringify(i)); return i; }
export function esquecerImpressora() { localStorage.removeItem(CHAVE); ble = null; usbDev = null; }

/** Divide o ZPL em blocos de bytes (UTF-8). */
export function blocos(zpl: string, tamanho: number): Uint8Array[] {
  const b = new TextEncoder().encode(zpl);
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += tamanho) out.push(b.slice(i, i + tamanho));
  return out;
}
const cancelado = (e: unknown) => (e as { name?: string })?.name === 'NotFoundError' && /cancel/i.test(String((e as Error).message));

// ---------------- 1) Bluetooth (BLE) ----------------
let ble: { device: any; char: any } | null = null;
const FILTROS_BLE = [{ services: [ZEBRA_BLE_SERVICO] }, ...['XX', 'ZQ', 'ZD', 'ZT', 'ZR', 'Zebra', 'ZEBRA', 'QLn', 'iMZ'].map((namePrefix) => ({ namePrefix }))];

export async function localizarBluetooth(todos = false): Promise<ImpressoraSalva> {
  if (!nav().bluetooth) throw new ErroZebra('Este navegador não tem Bluetooth para sites.', suporte().iphone ? 'No iPhone/iPad o Safari não permite: use um computador com o Zebra Browser Print ou um celular Android com Chrome.' : 'Use o Chrome no Android (ou Chrome/Edge no computador) com o Bluetooth ligado.');
  let device: any;
  try {
    device = await nav().bluetooth.requestDevice(todos ? { acceptAllDevices: true, optionalServices: [ZEBRA_BLE_SERVICO, 0x180a] } : { filters: FILTROS_BLE, optionalServices: [ZEBRA_BLE_SERVICO, 0x180a] });
  } catch (e) {
    if (cancelado(e)) throw new ErroZebra('Nenhuma impressora escolhida.', 'Ligue a Zebra, deixe o Bluetooth dela ativo (perto do celular) e toque em Localizar de novo. Se ela não aparecer, use "Mostrar todos os aparelhos".', true);
    throw new ErroZebra(`Bluetooth: ${(e as Error).message}`, 'Ligue o Bluetooth e a localização do celular e permita o Bluetooth para este site.');
  }
  await conectarBle(device);
  return salvar({ conexao: 'bluetooth', nome: device.name || 'Zebra (Bluetooth)', id: device.id });
}

async function conectarBle(device: any) {
  try {
    const gatt = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const serv = await gatt.getPrimaryService(ZEBRA_BLE_SERVICO);
    const char = await serv.getCharacteristic(ZEBRA_BLE_ESCREVER);
    ble = { device, char };
  } catch (e) {
    ble = null;
    throw new ErroZebra(`Não consegui conectar na impressora por Bluetooth (${(e as Error).message}).`, 'Confira se é uma Zebra com Bluetooth LE (Link-OS, ex.: ZQ310/ZQ520/ZQ620/ZD421 com BLE). Modelos só com Bluetooth clássico não funcionam pelo navegador: use USB/Browser Print. Desligue e ligue a impressora e tente de novo.');
  }
}

async function bleProntoPara(i: ImpressoraSalva) {
  if (ble?.device?.gatt?.connected && (!i.id || ble.device.id === i.id)) return;
  if (ble?.device && (!i.id || ble.device.id === i.id)) return conectarBle(ble.device);
  // Depois de recarregar a página: tenta achar o aparelho já autorizado; senão pede de novo (o toque em Imprimir permite).
  const conhecidos: any[] = nav().bluetooth?.getDevices ? await nav().bluetooth.getDevices().catch(() => []) : [];
  const d = conhecidos.find((x) => x.id === i.id);
  if (d) return conectarBle(d);
  await localizarBluetooth();
}

async function enviarBle(zpl: string) {
  const c = ble!.char;
  let tam = 180;
  const partes = () => blocos(zpl, tam);
  let lista = partes();
  for (let k = 0; k < lista.length; k++) {
    try {
      if (c.writeValueWithResponse) await c.writeValueWithResponse(lista[k]); else await c.writeValue(lista[k]);
    } catch (e) {
      // MTU pequeno: recomeça em blocos de 20 bytes (o ZPL só imprime no ^XZ; nada sai pela metade se ainda não foi o fim).
      if (k === 0 && tam > 20) { tam = 20; lista = partes(); k = -1; continue; }
      throw new ErroZebra(`A impressão foi interrompida (${(e as Error).message}).`, 'Aproxime o celular da impressora, confira papel e bateria e toque em Imprimir de novo.');
    }
  }
}

// ---------------- 2) USB (WebUSB) ----------------
let usbDev: any = null;
export async function localizarUsb(): Promise<ImpressoraSalva> {
  if (!nav().usb) throw new ErroZebra('Este navegador não acessa USB.', 'Use o Chrome ou Edge no computador (Windows, Mac, Linux, Chromebook) ou o Zebra Browser Print.');
  let d: any;
  try { d = await nav().usb.requestDevice({ filters: [{ vendorId: ZEBRA_USB_VENDOR }] }); } catch (e) {
    if ((e as { name?: string }).name === 'NotFoundError') throw new ErroZebra('Nenhuma Zebra USB escolhida (ou nenhuma encontrada).', 'Ligue a impressora no cabo USB e toque em Localizar de novo. Se ela não aparecer, use o Zebra Browser Print.', true);
    throw new ErroZebra(`USB: ${(e as Error).message}`, 'Tente o Zebra Browser Print.');
  }
  await abrirUsb(d);
  return salvar({ conexao: 'usb', nome: d.productName || 'Zebra (USB)', serie: d.serialNumber || undefined });
}
async function abrirUsb(d: any) {
  try {
    if (!d.opened) await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    usbDev = d;
  } catch (e) {
    usbDev = null;
    throw new ErroZebra(`O computador não liberou a impressora USB para o navegador (${(e as Error).message}).`, 'No Windows o driver da Zebra (ZDesigner) costuma prender a USB: use o Zebra Browser Print (recomendado no Windows). No Mac/Linux/Chromebook, feche outros programas que usam a impressora e tente de novo.');
  }
}
async function usbProntoPara(i: ImpressoraSalva) {
  if (usbDev?.opened) return;
  const ds: any[] = await nav().usb?.getDevices?.().catch(() => []) ?? [];
  const d = ds.find((x) => x.vendorId === ZEBRA_USB_VENDOR && (!i.serie || x.serialNumber === i.serie)) ?? ds.find((x) => x.vendorId === ZEBRA_USB_VENDOR);
  if (d) return abrirUsb(d);
  await localizarUsb();
}
async function enviarUsb(zpl: string) {
  const d = usbDev;
  const ints: any[] = d.configuration?.interfaces ?? [];
  const alvo = ints.find((i) => i.alternates?.[0]?.interfaceClass === 7) ?? ints.find((i) => i.alternates?.[0]?.endpoints?.some((e: any) => e.direction === 'out'));
  const ep = alvo?.alternates?.[0]?.endpoints?.find((e: any) => e.direction === 'out' && e.type === 'bulk') ?? alvo?.alternates?.[0]?.endpoints?.find((e: any) => e.direction === 'out');
  if (!alvo || !ep) throw new ErroZebra('A impressora USB não tem a saída de impressão esperada.', 'Use o Zebra Browser Print.');
  try { if (!alvo.claimed) await d.claimInterface(alvo.interfaceNumber); } catch (e) {
    throw new ErroZebra(`O sistema não liberou a impressora (${(e as Error).message}).`, 'No Windows, use o Zebra Browser Print. Em outros sistemas, feche programas que usam a impressora.');
  }
  for (const b of blocos(zpl, 16 * 1024)) await d.transferOut(ep.endpointNumber, b);
}

// ---------------- 3) Zebra Browser Print (USB e rede/IP) ----------------
async function bpFetch(caminho: string, init?: RequestInit, ms = 2500): Promise<Response | null> {
  for (const base of BP) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
    try { const r = await fetch(`${base}${caminho}`, { ...init, signal: ctrl.signal }); clearTimeout(t); if (r.ok) return r; } catch { clearTimeout(t); }
  }
  return null;
}
/** Impressoras que o Browser Print enxerga (USB, rede/IP, driver). */
export async function listarBrowserPrint(): Promise<Record<string, unknown>[]> {
  const r = await bpFetch('/available');
  if (!r) throw new ErroZebra('Zebra Browser Print não encontrado neste computador.', 'Instale o Zebra Browser Print (gratuito, site da Zebra), abra o programa e aceite este site quando ele perguntar. Para impressora de rede (IP), adicione-a nas configurações do Browser Print.');
  const j = await r.json().catch(() => ({}));
  const lista = (j?.printer ?? []) as Record<string, unknown>[];
  if (!lista.length) {
    const d = await bpFetch('/default?type=printer').then((x) => x?.json()).catch(() => null);
    if (d?.uid || d?.name) return [d];
  }
  return lista;
}
export async function escolherBrowserPrint(device: Record<string, unknown>): Promise<ImpressoraSalva> {
  return salvar({ conexao: 'browserprint', nome: `${String(device.name ?? 'Zebra')}${device.connection ? ` (${String(device.connection) === 'network' ? 'rede' : String(device.connection)})` : ''}`, device });
}
async function enviarBrowserPrint(i: ImpressoraSalva, zpl: string) {
  // text/plain evita o preflight de CORS no Browser Print.
  const r = await bpFetch('/write', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ device: i.device, data: zpl }) }, 15000);
  if (!r) throw new ErroZebra('O Zebra Browser Print não respondeu.', 'Confira se o programa está aberto no computador, se a impressora está ligada e se este site foi aceito no Browser Print.');
}

/** Envia o ZPL para a impressora guardada. Lança ErroZebra com o que fazer. */
export async function imprimirNaSalva(zpl: string, onStatus?: (s: Status) => void): Promise<ImpressoraSalva> {
  const i = impressoraSalva();
  if (!i) throw new ErroZebra('Nenhuma impressora escolhida neste aparelho.', 'Toque em "Localizar impressora".');
  onStatus?.('conectando');
  if (i.conexao === 'bluetooth') { await bleProntoPara(i); onStatus?.('imprimindo'); await enviarBle(zpl); }
  else if (i.conexao === 'usb') { await usbProntoPara(i); onStatus?.('imprimindo'); await enviarUsb(zpl); }
  else { onStatus?.('imprimindo'); await enviarBrowserPrint(i, zpl); }
  onStatus?.('impresso');
  return i;
}

/** Sem impressora guardada: tenta o Browser Print padrão (computador com o programa) antes de pedir para localizar. */
export async function tentarBrowserPrintPadrao(): Promise<ImpressoraSalva | null> {
  const d = await bpFetch('/default?type=printer', undefined, 1500).then((x) => x?.json()).catch(() => null);
  return d?.uid || d?.name ? escolherBrowserPrint(d) : null;
}

/** Último recurso: baixa o .zpl (a tela explica o porquê antes). */
export function baixarZpl(zpl: string) {
  const url = URL.createObjectURL(new Blob([zpl], { type: 'text/plain' }));
  const a = document.createElement('a'); a.href = url; a.download = `etiquetas-${Date.now()}.zpl`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Etiqueta de teste (confere a conexão sem gastar etiqueta de lote). */
export const ZPL_TESTE = '^XA^CI28^FO30,30^A0N,32,32^FDMCK ERP - teste de impressao^FS^FO30,80^A0N,24,24^FDImpressora conectada^FS^XZ';
