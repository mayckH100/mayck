/**
 * v1.55.0 — botões padrão de PDF do MCK ERP. Abrem a janela já no clique (sem bloqueio de pop-up) e chamam a impressão do
 * navegador (no Android: "Salvar como PDF"). O documento sai com o cabeçalho da empresa e o rodapé fixo da MCK.
 *  - BotaoPdf: "📄 Exportar PDF" ao lado de cada exportação (planilha/CSV).
 *  - BotaoImprimir: "🖨️ Imprimir / PDF" em listas e fichas de cadastro.
 *  - pdfDoExport: busca o MESMO arquivo da exportação (rota já protegida da própria empresa) e transforma em PDF.
 */
import type { ReactNode } from 'react';
import { imprimir, type Documento } from './cabecalho';
import { htmlDeCsv } from './listas';

type Montar = () => Documento | Promise<Documento>;
const avisar = (e: unknown) => alert((e as Error).message);

export function BotaoImprimir({ montar, children = '🖨️ Imprimir / PDF', className = 'btn', disabled, title }: { montar: Montar; children?: ReactNode; className?: string; disabled?: boolean; title?: string }) {
  return <button type="button" className={className} disabled={disabled} title={title ?? 'Abre a impressão: escolha “Salvar como PDF” para gerar o arquivo'} onClick={() => { imprimir(montar).catch(avisar); }}>{children}</button>;
}

export function BotaoPdf(p: { montar: Montar; children?: ReactNode; className?: string; disabled?: boolean; title?: string }) {
  return <BotaoImprimir {...p}>{p.children ?? '📄 Exportar PDF'}</BotaoImprimir>;
}

/** Monta o PDF a partir da rota de exportação CSV (mesmo conteúdo e filtros do arquivo). */
export function pdfDoExport(url: string, titulo: string, filtros: (string | false | null | undefined)[] = []): Montar {
  return async () => {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) { let m = 'Não foi possível gerar o PDF'; try { m = (await r.json()).error ?? m; } catch { /* corpo não é JSON */ } throw new Error(m); }
    return htmlDeCsv({ titulo, filtros, csv: await r.text() });
  };
}
