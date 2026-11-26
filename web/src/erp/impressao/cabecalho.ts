/**
 * v1.54.0 — impressão com a identidade da empresa: busca a configuração uma vez (GET /api/erp/documentos/config),
 * abre a janela já no clique (sem bloqueio de pop-up), monta o documento com cabeçalho + rodapé e chama a impressão.
 * No Android (Chrome) a mesma janela abre o "Imprimir / Salvar como PDF".
 */
import { get } from '../../api';
import type { ConfigDocumento } from '../../../../server/erp/shared/documento';
import { esc, paginaHtml, type Formato } from './modelo';

let cache: Promise<ConfigDocumento | null> | null = null;
/** Configuração do cabeçalho (uma busca por sessão da tela; falha → documento sai só com o rodapé). */
export function configDocumento(): Promise<ConfigDocumento | null> {
  if (!cache) cache = get<any>('/erp/documentos/config').then((r) => r.config as ConfigDocumento).catch(() => { cache = null; return null; });
  return cache;
}
/** Depois de salvar a configuração: a próxima impressão busca de novo. */
export function limparCacheDocumento(c?: ConfigDocumento) { cache = c ? Promise.resolve(c) : null; }

export interface Documento { titulo: string; corpo: string; formato?: Formato; css?: string; nomeReserva?: string }

/**
 * Chame DIRETO no clique. `montar` pode buscar dados (assíncrono); erros aparecem na própria janela e são relançados.
 */
export async function imprimir(montar: () => Documento | Promise<Documento>, tamanho = 'width=900,height=1000') {
  const w = window.open('', '_blank', tamanho);
  if (!w) throw new Error('O navegador bloqueou a janela de impressão: permita pop-ups para este site');
  w.document.write('<p style="font-family:Arial">Preparando…</p>');
  try {
    const [cfg, d] = await Promise.all([configDocumento(), montar()]);
    w.document.open();
    w.document.write(paginaHtml({ ...d, config: cfg }));
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 500);
  } catch (e) {
    w.document.body.innerHTML = `<p style="font-family:Arial;color:#b91c1c">${esc((e as Error).message)}</p>`;
    throw e;
  }
}
