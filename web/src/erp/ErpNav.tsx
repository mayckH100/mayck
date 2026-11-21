/**
 * Navegação do MCK ERP em dois níveis (v1.37.0, pedido do dono: "muito poluído de informação"; quer "tela principal e
 * subcategorias"). Poucas ÁREAS (Início, Vendas, Compras, Estoque, Produção, Financeiro, Fiscal, Configurações); cada
 * área abre numa tela-resumo e tem SUBCATEGORIAS. Desktop: submenu na barra lateral. Celular: chips no topo da tela
 * (subcategorias) e lista na tela-resumo. As rotas antigas continuam funcionando (mesmo endereço ou redirecionamento).
 * Lógica de rotas pura (testada em tests/unit/erp-areas.test.ts); o componente fica no fim do arquivo.
 */
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../auth';
import { AtalhoLerCodigo } from './leitura/LerCodigo';

/** Item do menu do ERP. `pai` = subcategoria da área com essa rota inicial. `area` = permissão de área do ERP. */
export type ErpItem = { to: string; label: string; end?: boolean; module?: string; pai?: string; icon?: string; roles?: Role[]; area?: ErpAreaPerm; ajuda?: string };
export type ErpAreaPerm = 'erp_vendas' | 'erp_estoque' | 'erp_compras' | 'erp_financeiro' | 'erp_relatorios';
export type AreaId = 'inicio' | 'vendas' | 'compras' | 'estoque' | 'producao' | 'financeiro' | 'fiscal' | 'config';
export interface Area { id: AreaId; label: string; icon: string; home: string; area?: ErpAreaPerm; module?: string; roles?: Role[]; ajuda: string; subs: ErpItem[] }

export const AREAS: Area[] = [
  { id: 'inicio', label: 'Início', icon: '⌂', home: '/erp', ajuda: 'O dia da empresa em um lugar: números principais e o que precisa de atenção.', subs: [
    { to: '/erp/bi', label: 'Indicadores (BI)', area: 'erp_relatorios' },
    { to: '/erp/relatorios', label: 'Relatório do dia', area: 'erp_relatorios', module: 'erp_relatorios' },
  ] },
  { id: 'vendas', label: 'Vendas', icon: '🛒', home: '/erp/vendas', ajuda: 'Venda balcão, pedidos, clientes e funil de oportunidades.', subs: [
    // Venda balcão primeiro: o cliente precisa achar (relato de 04/11).
    { to: '/erp/balcao', label: 'Venda balcão (PDV)', module: 'erp_vendas', area: 'erp_vendas', end: true },
    { to: '/erp/pedidos', label: 'Pedidos', area: 'erp_vendas' },
    { to: '/erp/pedidos/localizar', label: 'Localizar pedido', area: 'erp_vendas' },
    { to: '/erp/balcao/ler', label: 'Ler código', module: 'erp_vendas', area: 'erp_vendas' },
    { to: '/erp/clientes', label: 'Clientes' },
    { to: '/erp/funil', label: 'Funil de vendas' },
    { to: '/erp/crm', label: 'Painel CRM' },
  ] },
  { id: 'compras', label: 'Compras', icon: '📥', home: '/erp/compras', area: 'erp_compras', ajuda: 'Do que comprar até a mercadoria no estoque: solicitação, cotação, ordem de compra, entrega e conferência.', subs: [
    { to: '/erp/compras/o-que-comprar', label: 'O que comprar' },
    { to: '/erp/compras/ordens', label: 'Ordens de compra' },
    { to: '/erp/compras/solicitacoes', label: 'Solicitações' },
    { to: '/erp/compras/cotacoes', label: 'Cotações' },
    { to: '/erp/compras/avisos', label: 'Avisos' },
    { to: '/erp/fornecedores', label: 'Fornecedores' },
    { to: '/erp/compras/configuracoes', label: 'Prazos e avisos' },
  ] },
  { id: 'estoque', label: 'Estoque', icon: '📦', home: '/erp/estoque', area: 'erp_estoque', ajuda: 'Produtos, saldos, lotes, entradas, etiquetas e inventário. Disponível = físico − reservado − quarentena.', subs: [
    { to: '/erp/produtos', label: 'Produtos' },
    { to: '/erp/estoque/saldos', label: 'Saldos' },
    { to: '/erp/estoque/lotes', label: 'Saldo por lote' },
    { to: '/erp/rastreio', label: 'Rastreio de lote' },
    { to: '/erp/estoque/entrada-xml', label: 'Entrada por XML' },
    { to: '/erp/estoque/etiquetas', label: 'Etiquetas' },
    { to: '/erp/estoque/inventario', label: 'Inventário' },
    { to: '/erp/estoque/movimentacoes', label: 'Movimentações' },
    { to: '/erp/estoque/depositos', label: 'Depósitos e endereços' },
  ] },
  { id: 'producao', label: 'Produção', icon: '🏭', home: '/erp/producao', area: 'erp_compras', ajuda: 'Estrutura do produto, ordem de produção com consumo e lote, e MRP do que comprar e produzir.', subs: [
    { to: '/erp/producao/ordens', label: 'Ordens de produção' },
    { to: '/erp/producao/estruturas', label: 'Estruturas e roteiros' },
    { to: '/erp/producao/mrp', label: 'MRP' },
  ] },
  { id: 'financeiro', label: 'Financeiro', icon: '💰', home: '/erp/financeiro', area: 'erp_financeiro', ajuda: 'Faturamento gera contas a receber; NF-e de entrada gera contas a pagar. Baixa, Pix, conciliação e DRE.', subs: [
    { to: '/erp/financeiro/receber', label: 'A receber' },
    { to: '/erp/financeiro/pagar', label: 'A pagar' },
    { to: '/erp/financeiro/fluxo', label: 'Fluxo de caixa' },
    { to: '/erp/financeiro/contas', label: 'Contas e conciliação' },
    { to: '/erp/financeiro/dre', label: 'DRE' },
  ] },
  { id: 'fiscal', label: 'Fiscal', icon: '🧾', home: '/erp/fiscal', area: 'erp_financeiro', ajuda: 'NF-e emitida com o certificado A1 da própria empresa, direto na SEFAZ. Comece em homologação.', subs: [
    { to: '/erp/fiscal/notas', label: 'NF-e emitidas' },
    { to: '/erp/fiscal/emitente', label: 'Emitente e certificado' },
    { to: '/erp/fiscal/regras', label: 'Regras de tributação' },
  ] },
  { id: 'config', label: 'Configurações', icon: '⚙', home: '/erp/configuracoes', ajuda: 'Alertas por WhatsApp, maquininhas de cartão, funcionários e prazos de compras.', subs: [
    { to: '/erp/alertas', label: 'Alertas por WhatsApp', area: 'erp_relatorios' },
    { to: '/erp/maquininhas', label: 'Maquininhas', module: 'erp_vendas', area: 'erp_vendas' },
    { to: '/erp/funcionarios', label: 'Funcionários', module: 'equipe', roles: ['OWNER', 'ADMIN'] },
  ] },
];

/** Todos os itens (área + subcategorias), na ordem do menu. A área herda a permissão para as subcategorias. */
export const ERP_ITENS: ErpItem[] = AREAS.flatMap((a) => [
  { to: a.home, label: a.label, icon: a.icon, end: a.home === '/erp', area: a.area, module: a.module, roles: a.roles },
  ...a.subs.map((s) => ({ ...s, pai: a.home, area: s.area ?? a.area })),
]);

/**
 * Rotas antigas → novas (v1.37.0). Só as que deixaram de ser tela: o resto mantém o endereço. Mantém ?q= etc.
 * /erp era o Painel CRM e agora é o Início (o painel CRM foi para Vendas › Painel CRM).
 */
export const ROTAS_ANTIGAS: Record<string, string> = {
  '/erp/localizar': '/erp/pedidos/localizar',
  '/erp/painel': '/erp/crm',
  '/erp/estoque/xml': '/erp/estoque/entrada-xml',
  '/erp/estoque/inventarios': '/erp/estoque/inventario',
  '/erp/estoque/movimentos': '/erp/estoque/movimentacoes',
  '/erp/compras/pedidos': '/erp/compras/ordens',
  '/erp/compras/prazos': '/erp/compras/configuracoes',
  '/erp/fiscal/nfe': '/erp/fiscal/notas',
  '/erp/fiscal/config': '/erp/fiscal/emitente',
  '/erp/financeiro/painel': '/erp/financeiro/fluxo',
  '/erp/bi/painel': '/erp/bi',
};

const bate = (i: ErpItem, path: string) => (i.end ? path === i.to : path === i.to || path.startsWith(`${i.to}/`));

/** Item ativo: a rota mais específica que bate (ex.: /erp/pedidos/123 → Pedidos; /erp/pedidos/localizar → Localizar pedido). */
export function abaAtiva(path: string): string | null {
  let melhor: string | null = null;
  for (const i of ERP_ITENS) if (bate(i, path) && (!melhor || i.to.length > melhor.length)) melhor = i.to;
  return melhor;
}

/** Área (rota inicial) da tela. Telas de detalhe sem item próprio caem na área certa. */
export function grupoAtivo(path: string): string | null {
  if (path.startsWith('/erp/caixa/') || path.startsWith('/erp/balcao/')) return '/erp/vendas';
  const a = abaAtiva(path);
  if (!a) return path === '/erp' || path.startsWith('/erp/') ? '/erp' : null;
  return ERP_ITENS.find((i) => i.to === a)?.pai ?? a;
}
export const areaDaRota = (path: string): Area | null => { const g = grupoAtivo(path); return AREAS.find((a) => a.home === g) ?? null; };
/** Subcategorias de uma área (pela rota inicial). */
export const subitensDe = (to: string) => ERP_ITENS.filter((i) => i.pai === to);
/** Está na tela-resumo da área (rota inicial exata)? */
export const ehResumoDaArea = (path: string) => AREAS.some((a) => a.home === path.replace(/\/$/, '') || (a.home === '/erp' && path === '/erp/'));
/** Rótulo para o topo: "Compras › Ordens de compra"; na tela-resumo só "Compras". */
export function rotuloDaRota(path: string): string | null {
  const area = areaDaRota(path);
  if (!area) return null;
  const a = abaAtiva(path);
  const item = a ? ERP_ITENS.find((i) => i.to === a) : null;
  if (path.startsWith('/erp/caixa/')) return `${area.label} › Caixa`;
  if (!item || !item.pai) return area.label;
  return `${area.label} › ${item.label}`;
}

/** Acesso às áreas do ERP como o servidor (requireErpArea): sem nenhuma área marcada (permissão antiga) vê tudo. */
export const AREAS_PERM: ErpAreaPerm[] = ['erp_vendas', 'erp_estoque', 'erp_compras', 'erp_financeiro', 'erp_relatorios'];
export function podeArea(area: ErpAreaPerm | undefined, hasModule: (m: string) => boolean) {
  if (!area) return true;
  if (!AREAS_PERM.some((m) => hasModule(m))) return true;
  return hasModule(area);
}
export function podeItem(i: Pick<ErpItem, 'area' | 'module' | 'roles'>, hasModule: (m: string) => boolean, can: (...r: Role[]) => boolean) {
  return podeArea(i.area, hasModule) && (!i.module || hasModule(i.module)) && (!i.roles || can(...i.roles));
}

/**
 * Subcategorias da área no topo do conteúdo: só no celular (no computador ficam na barra lateral).
 * Na tela-resumo não aparece: lá a própria tela lista as subcategorias. F2 (ler código) vale em qualquer tela do ERP.
 */
export function ErpAbas() {
  const { hasModule, can } = useAuth();
  const loc = useLocation();
  const barra = useRef<HTMLDivElement>(null);
  const area = areaDaRota(loc.pathname);
  const ativa = abaAtiva(loc.pathname);
  const resumo = ehResumoDaArea(loc.pathname);
  useEffect(() => {
    const el = barra.current?.querySelector<HTMLElement>('a.active');
    const b = barra.current;
    if (!el || !b) return;
    const alvo = el.offsetLeft - (b.clientWidth - el.offsetWidth) / 2;
    if (typeof b.scrollTo === 'function') b.scrollTo({ left: Math.max(0, alvo) }); else b.scrollLeft = Math.max(0, alvo);
  }, [ativa]);
  const subs = area ? area.subs.map((s) => ({ ...s, area: s.area ?? area.area })).filter((s) => podeItem(s, hasModule, can)) : [];
  return (
    <>
      <AtalhoLerCodigo />
      {area && !resumo && subs.length > 0 && (
        <nav className="erp-chips" ref={barra} aria-label={`Dentro de ${area.label}`} data-testid="erp-subabas">
          <NavLink to={area.home} end className="erp-chip-area">‹ {area.label}</NavLink>
          {subs.map((i) => <NavLink key={i.to} to={i.to} className={() => (i.to === ativa ? 'active' : '')} aria-current={i.to === ativa ? 'page' : undefined}>{i.label}</NavLink>)}
        </nav>
      )}
    </>
  );
}

export default ErpAbas;
