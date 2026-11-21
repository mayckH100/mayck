/**
 * Seta ← "voltar um nível" do cabeçalho do MCK ERP (v1.37.1, pedido do dono: "coloca uma seta para voltar tela por tela").
 * - Subcategoria → resumo da área; detalhe → a lista de onde veio; resumo da área → Início. No Início não aparece.
 * - Se a tela anterior no histórico do próprio app é o destino certo (o nível acima, ou, num detalhe, a tela do ERP de
 *   onde a pessoa veio), usa navigate(-1): o botão voltar do Android e a seta ficam coerentes. Senão abre a rota pai.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { rotaPai, ERP_ITENS, abaAtiva } from './ErpNav';

const CHAVE = 'mck:erp-rastro';
type Rastro = Record<string, string>;
const idxAtual = (): number | null => { const i = (window.history.state as any)?.idx; return typeof i === 'number' ? i : null; };
function ler(): Rastro { try { return JSON.parse(sessionStorage.getItem(CHAVE) ?? '{}') ?? {}; } catch { return {}; } }

/** Guarda qual tela está em cada posição do histórico (só nesta aba). Chamado uma vez no layout do ERP. */
export function useRastroErp() {
  const loc = useLocation();
  useEffect(() => {
    const i = idxAtual();
    if (i === null) return;
    const r = ler();
    r[String(i)] = loc.pathname;
    for (const k of Object.keys(r)) if (Number(k) > i + 50 || Number(k) < i - 50) delete r[k];
    try { sessionStorage.setItem(CHAVE, JSON.stringify(r)); } catch { /* sem sessionStorage */ }
  }, [loc.key, loc.pathname]);
}

/** É um detalhe (rota mais funda que o item do menu, ex.: /erp/pedidos/123)? */
const ehDetalhe = (path: string) => { const a = abaAtiva(path); return path.startsWith('/erp/caixa/') || (!!a && a !== path.replace(/\/+$/, '')); };

/** Decide a volta: -1 (histórico) ou a rota pai. Puro, para teste. */
export function destinoVoltar(path: string, anterior: string | null): { voltar: true } | { ir: string } | null {
  const pai = rotaPai(path);
  if (!pai) return null;
  if (anterior && anterior !== path) {
    if (anterior === pai) return { voltar: true };
    // detalhe aberto de outra tela do ERP (Início, Localizar, cliente…): volta para ela
    if (ehDetalhe(path) && (anterior === '/erp' || anterior.startsWith('/erp/')) && rotaPai(anterior) !== path) return { voltar: true };
  }
  return { ir: pai };
}

export function Voltar({ rotulo }: { rotulo?: string }) {
  const loc = useLocation();
  const nav = useNavigate();
  const pai = rotaPai(loc.pathname);
  if (!pai) return null;
  const nomePai = pai === '/erp' ? 'Início' : ERP_ITENS.find((i) => i.to === pai)?.label ?? 'tela anterior';
  const clicar = () => {
    const i = idxAtual();
    const anterior = i !== null && i > 0 ? ler()[String(i - 1)] ?? null : null;
    const d = destinoVoltar(loc.pathname, anterior);
    if (!d) return;
    if ('voltar' in d) nav(-1); else nav(d.ir);
  };
  return (
    <button type="button" className="erp-voltar" onClick={clicar} aria-label={rotulo ?? `Voltar para ${nomePai}`} title={`Voltar para ${nomePai}`} data-testid="erp-voltar">
      <span aria-hidden>←</span>
    </button>
  );
}

export default Voltar;
