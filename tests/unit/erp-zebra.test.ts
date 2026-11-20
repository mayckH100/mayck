import { describe, it, expect } from 'vitest';
import { blocos, ZEBRA_BLE_SERVICO, ZEBRA_BLE_ESCREVER, ZEBRA_USB_VENDOR, ZPL_TESTE } from '../../web/src/erp/estoque/zebra';

describe('Zebra direta (v1.34.0)', () => {
  it('divide o ZPL em blocos de bytes sem perder nada (acentos em UTF-8)', () => {
    const zpl = `^XA^CI28^FDLeite Integral ação^FS${'x'.repeat(500)}^XZ`;
    const b = blocos(zpl, 20);
    expect(b.every((x) => x.length <= 20)).toBe(true);
    const junto = new Uint8Array(b.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of b) { junto.set(x, o); o += x.length; }
    expect(new TextDecoder().decode(junto)).toBe(zpl);
    expect(blocos('', 20)).toEqual([]);
  });
  it('identificadores da Zebra (BLE Link-OS e USB) e etiqueta de teste', () => {
    expect(ZEBRA_BLE_SERVICO).toBe('38eb4a80-c570-11e3-9507-0002a5d5c51b');
    expect(ZEBRA_BLE_ESCREVER).toBe('38eb4a82-c570-11e3-9507-0002a5d5c51b');
    expect(ZEBRA_USB_VENDOR).toBe(0x0a5f);
    expect(ZPL_TESTE.startsWith('^XA')).toBe(true);
    expect(ZPL_TESTE.endsWith('^XZ')).toBe(true);
  });
});
