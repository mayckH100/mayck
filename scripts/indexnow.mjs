#!/usr/bin/env node
// IndexNow (Bing, Yandex, Seznam, Naver…): avisa os buscadores das URLs do sitemap. Gratuito, sem conta.
// Uso, depois de cada deploy:   node scripts/indexnow.mjs            (lê o sitemap publicado)
//                               node scripts/indexnow.mjs --dry-run  (só mostra o que enviaria)
// Variáveis opcionais: SITE_URL (padrão https://mckbot.onrender.com), INDEXNOW_KEY (padrão: arquivo <chave>.txt em web/public).
// A chave é pública por definição (o arquivo precisa estar acessível na raiz do site): não é segredo.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = (process.env.SITE_URL || 'https://mckbot.onrender.com').replace(/\/+$/, '');
const dry = process.argv.includes('--dry-run');

function findKey() {
  if (process.env.INDEXNOW_KEY) return process.env.INDEXNOW_KEY.trim();
  const pub = path.resolve(here, '../web/public');
  for (const f of readdirSync(pub)) {
    const m = f.match(/^([a-f0-9]{32})\.txt$/);
    if (m && readFileSync(path.join(pub, f), 'utf8').trim() === m[1]) return m[1];
  }
  throw new Error('Arquivo de chave do IndexNow não encontrado em web/public (<chave>.txt).');
}

async function main() {
  const key = findKey();
  const keyLocation = `${SITE}/${key}.txt`;
  // Confere se a chave está publicada (o IndexNow recusa com 403 se não estiver).
  const k = await fetch(keyLocation);
  const kText = k.ok ? (await k.text()).trim() : '';
  if (kText !== key) throw new Error(`Chave não publicada em ${keyLocation} (HTTP ${k.status}). Faça o deploy antes.`);

  const sm = await fetch(`${SITE}/sitemap.xml`);
  if (!sm.ok) throw new Error(`sitemap.xml respondeu HTTP ${sm.status}`);
  const urlList = [...(await sm.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (!urlList.length) throw new Error('sitemap.xml sem URLs');

  const body = { host: new URL(SITE).host, key, keyLocation, urlList };
  console.log(`[indexnow] ${urlList.length} URLs:`);
  for (const u of urlList) console.log('  ' + u);
  if (dry) return console.log('[indexnow] --dry-run: nada enviado.');

  const r = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const txt = await r.text().catch(() => '');
  // 200 = aceito; 202 = recebido, chave em validação; 4xx = erro (400 formato, 403 chave, 422 URL de outro host, 429 excesso).
  console.log(`[indexnow] resposta HTTP ${r.status}${txt ? ': ' + txt.slice(0, 300) : ''}`);
  if (r.status !== 200 && r.status !== 202) process.exit(1);
}

main().catch((e) => { console.error('[indexnow] erro:', e.message); process.exit(1); });
