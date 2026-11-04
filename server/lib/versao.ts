import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, dataBr, rotuloVersao } from '../changelog.js';

/** Informação de versão exposta em GET /api/versao (sem login, sem dados sensíveis). */
export type VersaoInfo = {
  ok: true;
  versao: string;
  commit: string;
  commitCurto: string;
  /** Data/hora do build (ISO 8601) ou null se desconhecida. */
  build: string | null;
  /** Data do build em dd/mm/aaaa (horário de Brasília) ou null. */
  data: string | null;
  /** Rótulo pronto: "Versão 1.12.0 · abc1234 · 04/11/2026". */
  rotulo: string;
};

const SHA = /^[0-9a-f]{7,40}$/i;

type BuildInfo = { commit?: string; buildDate?: string };

/** build-info.json gravado pelo build da web (vite.config.ts) em dist/web. */
function lerBuildInfo(): BuildInfo {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidatos = [path.resolve(here, '../../web/build-info.json'), path.resolve(here, '../../dist/web/build-info.json'), path.resolve(process.cwd(), 'dist/web/build-info.json')];
  for (const f of candidatos) {
    try { if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as BuildInfo; } catch { /* arquivo inválido: ignora */ }
  }
  return {};
}

function gitHead(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    return SHA.test(out) ? out : null;
  } catch { return null; }
}

let cache: VersaoInfo | null = null;

/**
 * Commit: RENDER_GIT_COMMIT (o que está no ar) > build-info.json > git rev-parse > "dev".
 * Data: a do build (build-info.json); sem build, fica sem data.
 */
export function versaoInfo(env: NodeJS.ProcessEnv = process.env, fresh = false): VersaoInfo {
  if (cache && !fresh) return cache;
  const info = lerBuildInfo();
  const envCommit = (env.RENDER_GIT_COMMIT || env.GIT_COMMIT || '').trim();
  const commit = (SHA.test(envCommit) && envCommit) || (info.commit && SHA.test(info.commit) ? info.commit : '') || gitHead() || 'dev';
  const build = info.buildDate && !Number.isNaN(new Date(info.buildDate).getTime()) ? info.buildDate : null;
  const data = dataBr(build);
  const result: VersaoInfo = {
    ok: true,
    versao: APP_VERSION,
    commit,
    commitCurto: SHA.test(commit) ? commit.slice(0, 7) : commit,
    build,
    data,
    rotulo: rotuloVersao(APP_VERSION, commit, data),
  };
  if (!fresh) cache = result;
  return result;
}
