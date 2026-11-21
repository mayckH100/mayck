/**
 * Peças de tela do MCK ERP (v1.37.0): cabeçalho padrão (título + "?" de ajuda + um botão principal + menu "⋯"),
 * indicadores, pendências e lista de subcategorias. Objetivo do dono: menos texto, mais organização.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth';
import { podeItem, type Area } from './ErpNav';

/** Botão "?" com a explicação da tela (some o texto longo do cabeçalho). Abre ao tocar; fecha ao tocar fora ou Esc. */
export function Ajuda({ children, rotulo = 'Ajuda' }: { children: ReactNode; rotulo?: string }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', fora); document.addEventListener('touchstart', fora); window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('touchstart', fora); window.removeEventListener('keydown', esc); };
  }, [aberto]);
  return (
    <span className="ajuda" ref={ref}>
      <button type="button" className="ajuda-btn" aria-label={rotulo} aria-expanded={aberto} onClick={() => setAberto((a) => !a)}>?</button>
      {aberto && <span className="ajuda-pop" role="tooltip">{children}</span>}
    </span>
  );
}

export interface AcaoMais { label: string; onClick?: () => void; href?: string; to?: string; download?: boolean; oculto?: boolean }

/** Menu "⋯" com as ações secundárias da tela (exportar, importar, regras…). */
export function MenuMais({ acoes, rotulo = 'Mais ações' }: { acoes: AcaoMais[]; rotulo?: string }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lista = acoes.filter((a) => !a.oculto);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', fora); document.addEventListener('touchstart', fora); window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('touchstart', fora); window.removeEventListener('keydown', esc); };
  }, [aberto]);
  if (!lista.length) return null;
  return (
    <div className="menu-mais" ref={ref}>
      <button type="button" className="btn mais-btn" aria-label={rotulo} aria-haspopup="menu" aria-expanded={aberto} onClick={() => setAberto((a) => !a)}>⋯</button>
      {aberto && (
        <div className="menu-pop" role="menu">
          {lista.map((a) => a.to
            ? <Link key={a.label} role="menuitem" to={a.to} onClick={() => setAberto(false)}>{a.label}</Link>
            : a.href
              ? <a key={a.label} role="menuitem" href={a.href} download={a.download || undefined} onClick={() => setAberto(false)}>{a.label}</a>
              : <button key={a.label} type="button" role="menuitem" onClick={() => { setAberto(false); a.onClick?.(); }}>{a.label}</button>)}
        </div>
      )}
    </div>
  );
}

/**
 * Cabeçalho padrão: título, "?" com a ajuda, filtros/busca (children), UM botão principal e o menu "⋯".
 * `acao` pode ser um elemento pronto (ex.: Link) ou { label, onClick }.
 */
export function Cabecalho({ titulo, ajuda, acao, mais, children }: { titulo: ReactNode; ajuda?: ReactNode; acao?: ReactNode | { label: string; onClick: () => void; disabled?: boolean }; mais?: AcaoMais[]; children?: ReactNode }) {
  const botao = acao && typeof acao === 'object' && 'label' in (acao as any) && 'onClick' in (acao as any)
    ? <button className="btn primary" disabled={(acao as any).disabled} onClick={(acao as any).onClick}>{(acao as any).label}</button>
    : (acao as ReactNode);
  return (
    <div className="page-head erp-cab">
      <div className="erp-titulo"><h1>{titulo}</h1>{ajuda && <Ajuda>{ajuda}</Ajuda>}</div>
      {(children || botao || mais?.length) && (
        <div className="erp-cab-acoes">
          {children}
          {botao}
          {mais && <MenuMais acoes={mais} />}
        </div>
      )}
    </div>
  );
}

export type Tom = 'ok' | 'alerta' | 'perigo' | 'neutro';

/** Indicador (cartão pequeno). Com `to`, o cartão inteiro é um atalho. */
export function Kpi({ rotulo, valor, detalhe, to, tom = 'neutro', carregando }: { rotulo: string; valor: ReactNode; detalhe?: ReactNode; to?: string; tom?: Tom; carregando?: boolean }) {
  const corpo = <><div className="kpi-l">{rotulo}</div><div className="kpi-v">{carregando ? '…' : valor}</div>{detalhe && <div className="kpi-d">{detalhe}</div>}</>;
  return to ? <Link className={`kpi tom-${tom}`} to={to} data-testid="kpi">{corpo}</Link> : <div className={`kpi tom-${tom}`} data-testid="kpi">{corpo}</div>;
}
export const Kpis = ({ children }: { children: ReactNode }) => <div className="kpis">{children}</div>;

/** `n` > 0 mostra a linha; `valor` (ex.: R$) aparece no lugar do número. */
export interface Pendencia { icone: string; texto: string; n: number; to: string; tom?: Tom; valor?: string }

/** Lista "Precisa de atenção": só o que tem algo (n > 0). Vazia → "Tudo em dia". */
export function Pendencias({ itens, carregando, titulo = 'Precisa de atenção' }: { itens: Pendencia[]; carregando?: boolean; titulo?: string }) {
  const lista = itens.filter((i) => i.n > 0);
  return (
    <section className="card pendencias" aria-label={titulo}>
      <h2>{titulo}</h2>
      {carregando && !lista.length ? <div className="small muted">Carregando…</div>
        : lista.length === 0 ? <div className="pend-ok">✓ Tudo em dia</div>
          : <ul>{lista.map((p) => (
            <li key={p.texto}><Link to={p.to} className={`pend tom-${p.tom ?? 'alerta'}`}>
              <span className="pend-ico" aria-hidden>{p.icone}</span>
              <span className="pend-txt">{p.texto}</span>
              <span className="pend-n">{p.valor ?? p.n}</span><span aria-hidden className="pend-seta">›</span>
            </Link></li>
          ))}</ul>}
    </section>
  );
}

/** Subcategorias da área em lista (tela-resumo no celular; em Configurações aparece sempre). */
export function ListaSubcategorias({ area, sempre = false }: { area: Area; sempre?: boolean }) {
  const { hasModule, can } = useAuth();
  const subs = area.subs.map((s) => ({ ...s, area: s.area ?? area.area })).filter((s) => podeItem(s, hasModule, can));
  if (!subs.length) return null;
  return (
    <nav className={`card erp-sublista${sempre ? '' : ' so-celular'}`} aria-label={`Seções de ${area.label}`} data-testid="erp-sublista">
      {subs.map((s) => <NavLink key={s.to} to={s.to}><span>{s.label}</span><span aria-hidden>›</span></NavLink>)}
    </nav>
  );
}
