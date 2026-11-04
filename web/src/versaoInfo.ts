import { APP_VERSION, CHANGELOG, dataBr, rotuloVersao } from '../../server/changelog';

declare const __MCK_BUILD__: { commit: string; buildDate: string } | undefined;

/** Commit e data do build injetados pelo vite.config.ts (sem build: "dev"). */
const BUILD = typeof __MCK_BUILD__ !== 'undefined' && __MCK_BUILD__ ? __MCK_BUILD__ : { commit: 'dev', buildDate: '' };

export const VERSAO = {
  versao: APP_VERSION,
  commit: BUILD.commit,
  data: dataBr(BUILD.buildDate),
  rotulo: rotuloVersao(APP_VERSION, BUILD.commit, dataBr(BUILD.buildDate)),
};

export { CHANGELOG };
