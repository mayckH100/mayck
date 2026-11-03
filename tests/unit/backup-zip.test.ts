import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { zipStore } from '../../server/lib/backup.js';

describe('zipStore (anexo do backup por e-mail)', () => {
  it('gera um .zip válido contendo o .bkp intacto', () => {
    const data = randomBytes(50_000);
    const zip = zipStore('mck-2026-11-02.bkp', data);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    writeFileSync(join(dir, 'a.zip'), zip);
    execFileSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])`, join(dir, 'a.zip'), dir]);
    expect(readFileSync(join(dir, 'mck-2026-11-02.bkp')).equals(data)).toBe(true);
  });
});
