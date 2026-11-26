/**
 * Submenu do MCK ERP: uma barra de abas em uma linha (rola na horizontal no celular), mostrada pelo Shell em todas as telas /erp.
 * v1.50.0 (pedido do dono, 23/11: "quero layout ERP das primeiras versões, ficou muito confuso o novo"): volta o layout
 * de abas da v1.36.0 (antes das áreas/telas-resumo da v1.37.0). Os endereços da v1.37 continuam abrindo a aba certa
 * (ROTAS_V137 e as rotas com aba inicial no App) e os sinônimos antigos redirecionam (ROTAS_ANTIGAS).
 */
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../auth';
import { AtalhoLerCodigo } from './leitura/LerCodigo';

/** Item do menu do ERP. `pai` = subitem do grupo daquela rota (v1.35.0, pedido do dono). */
export type ErpItem = { to: string; label: string; end?: boolean; module?: string; pai?: string; roles?: Role[]; areas?: ErpAreaPerm[] };

// v1.56.0: áreas que liberam cada aba (mesma regra de requireErpArea no servidor: principal + alternativas).
const A_VENDAS: ErpAreaPerm[] = ['erp_vendas', 'erp_estoque', 'erp_financeiro'];
const A_ESTOQUE: ErpAreaPerm[] = ['erp_estoque', 'erp_vendas', 'erp_compras'];

export const ERP_ITENS: ErpItem[] = [
  { to: '/erp', label: 'Painel CRM', end: true },
  // Venda balcão (PDV) com entrada própria no menu: antes ficava só como botão dentro de Pedidos e o cliente não achava.
  { to: '/erp/balcao', label: 'Venda balcão (PDV)', module: 'erp_vendas', end: true },
  // v1.35.0 (pedido do dono, 20/11): o leitor é subcategoria de Venda balcão (a tecla F2 continua em qualquer tela).
  { to: '/erp/balcao/ler', label: '📷 Ler código', module: 'erp_vendas', pai: '/erp/balcao' },
  // v1.50.0: o "Início" da v1.37 (números do dia, BI e "Precisa de atenção") virou a aba Resumo, no layout antigo.
  { to: '/erp/resumo', label: 'Resumo', end: true },
  { to: '/erp/funil', label: 'Funil de vendas' },
  { to: '/erp/clientes', label: 'Clientes' },
  { to: '/erp/fornecedores', label: 'Fornecedores' },
  { to: '/erp/pedidos', label: 'Pedidos', areas: A_VENDAS },
  // v1.34.0: localizar pedido por leitura (QR/código de barras) ou digitação. v1.35.0: dentro de Pedidos.
  { to: '/erp/pedidos/localizar', label: 'Localizar pedido', pai: '/erp/pedidos', areas: A_VENDAS },
  { to: '/erp/produtos', label: 'Produtos', areas: A_ESTOQUE },
  { to: '/erp/estoque', label: 'Estoque', areas: A_ESTOQUE },
  // v1.33.0: rastreabilidade de lote (busca única: produto, lote, lote do fornecedor, nota, pedido).
  { to: '/erp/rastreio', label: 'Rastreio de lote', areas: A_ESTOQUE },
  { to: '/erp/compras', label: 'Compras', areas: ['erp_compras', 'erp_estoque', 'erp_financeiro'] },
  { to: '/erp/producao', label: 'Produção', areas: ['erp_compras', 'erp_estoque'] },
  { to: '/erp/financeiro', label: 'Financeiro', areas: ['erp_financeiro'] },
  { to: '/erp/fiscal', label: 'Fiscal', areas: ['erp_financeiro'] },
  { to: '/erp/maquininhas', label: 'Maquininhas', module: 'erp_vendas' },
  { to: '/erp/bi', label: 'BI', areas: ['erp_relatorios'] },
  { to: '/erp/alertas', label: 'Alertas', areas: ['erp_relatorios'] },
  // v1.54.0: logo e dados da empresa nos documentos impressos (só Proprietário/Administrador).
  { to: '/erp/documentos-impressos', label: 'Documentos impressos', roles: ['OWNER', 'ADMIN'] },
];
/** Aba ativa: a rota mais específica que bate (ex.: /erp/pedidos/123 → Pedidos; /erp/pedidos/localizar → Localizar pedido). */
/**
 * Endereços que existiam só no layout da v1.37 (áreas e telas-resumo) → tela equivalente do layout antigo.
 * As subcategorias (ex.: /erp/compras/ordens) continuam como rota e abrem a aba interna certa (ver App.tsx).
 */
export const ROTAS_V137: Record<string, string> = {
  '/erp/inicio': '/erp/resumo',
  '/erp/vendas': '/erp/pedidos',
  '/erp/crm': '/erp',
  '/erp/configuracoes': '/erp/alertas',
};
/** Sinônimos e endereços antigos (QR lidos antes da 1.35.0, links salvos) → tela certa. Mantém ?q= etc. */
export const ROTAS_ANTIGAS: Record<string, string> = {
  ...ROTAS_V137,
  '/erp/localizar': '/erp/pedidos/localizar',
  '/erp/painel': '/erp',
  '/erp/estoque/xml': '/erp/estoque/entrada-xml',
  '/erp/estoque/nfe': '/erp/estoque/entrada-xml',
  '/erp/estoque/inventarios': '/erp/estoque/inventario',
  '/erp/estoque/movimentos': '/erp/estoque/movimentacoes',
  '/erp/compras/pedidos': '/erp/compras/ordens',
  '/erp/compras/prazos': '/erp/compras/configuracoes',
  '/erp/fiscal/nfe': '/erp/fiscal/notas',
  '/erp/fiscal/config': '/erp/fiscal/emitente',
  '/erp/financeiro/painel': '/erp/financeiro',
  '/erp/bi/painel': '/erp/bi',
  '/erp/indicadores': '/erp/bi',
  '/erp/inicio/indicadores': '/erp/bi',
  '/erp/inicio/bi': '/erp/bi',
  '/erp/painel-bi': '/erp/bi',
  '/erp/bi/indicadores': '/erp/bi',
  '/erp/avisos': '/erp/compras/avisos',
  '/erp/relatorio': '/erp/relatorios',
  '/erp/relatorio-do-dia': '/erp/relatorios',
};

/** Permissão por área do ERP (mesma regra do servidor, requireErpArea): sem nenhuma área marcada (permissão antiga) vê tudo. */
export type ErpAreaPerm = 'erp_vendas' | 'erp_estoque' | 'erp_compras' | 'erp_financeiro' | 'erp_relatorios';
export const AREAS_PERM: ErpAreaPerm[] = ['erp_vendas', 'erp_estoque', 'erp_compras', 'erp_financeiro', 'erp_relatorios'];
export function podeArea(area: ErpAreaPerm | undefined, hasModule: (m: string) => boolean) {
  if (!area) return true;
  if (!AREAS_PERM.some((m) => hasModule(m))) return true;
  return hasModule(area);
}
export function podeItem(i: { area?: ErpAreaPerm; module?: string; roles?: Role[] }, hasModule: (m: string) => boolean, can: (...r: Role[]) => boolean) {
  return podeArea(i.area, hasModule) && (!i.module || hasModule(i.module)) && (!i.roles || can(...i.roles));
}

/** Aba visível? módulo/papel do item + pelo menos uma das áreas dele (permissão antiga sem áreas vê tudo). */
export function podeAba(i: ErpItem, hasModule: (m: string) => boolean, can: (...r: Role[]) => boolean) {
  const areaOk = !i.areas || !AREAS_PERM.some((m) => hasModule(m)) || i.areas.some((a) => hasModule(a));
  return areaOk && (!i.module || hasModule(i.module)) && (!i.roles || can(...i.roles));
}

export function abaAtiva(path: string): string | null {
  let melhor: string | null = null;
  for (const i of ERP_ITENS) {
    const bate = i.end ? path === i.to : path === i.to || path.startsWith(`${i.to}/`);
    if (bate && (!melhor || i.to.length > melhor.length)) melhor = i.to;
  }
  return melhor;
}
/** Grupo (item de cima) da aba ativa: subitem → o pai. Pedido do pedido (/erp/pedidos/9) → Pedidos. */
export function grupoAtivo(path: string): string | null {
  const a = abaAtiva(path) ?? (path.startsWith('/erp/balcao/') ? '/erp/balcao' : null);
  if (!a) return null;
  return ERP_ITENS.find((i) => i.to === a)?.pai ?? a;
}
/** Subitens de um grupo (vazio = grupo sem subitens). */
export const subitensDe = (to: string) => ERP_ITENS.filter((i) => i.pai === to);

export function ErpAbas() {
  const { hasModule, can } = useAuth();
  const loc = useLocation();
  const barra = useRef<HTMLDivElement>(null);
  const ativa = abaAtiva(loc.pathname);
  const grupo = grupoAtivo(loc.pathname);
  // Mantém a aba ativa à vista (sem rolar a página na vertical).
  useEffect(() => {
    const el = barra.current?.querySelector<HTMLElement>('a.active');
    const b = barra.current;
    if (!el || !b) return;
    const alvo = el.offsetLeft - (b.clientWidth - el.offsetWidth) / 2;
    if (typeof b.scrollTo === 'function') b.scrollTo({ left: Math.max(0, alvo), behavior: 'smooth' }); else b.scrollLeft = Math.max(0, alvo);
  }, [grupo]);
  const pode = (i: ErpItem) => podeAba(i, hasModule, can);
  const itens = ERP_ITENS.filter((i) => !i.pai && pode(i));
  const pai = grupo ? ERP_ITENS.find((i) => i.to === grupo) : null;
  const subs = pai ? subitensDe(pai.to).filter(pode) : [];
  return (
    <>
      {/* F2 abre o leitor em qualquer tela do ERP (o item do menu fica dentro de Venda balcão). */}
      <AtalhoLerCodigo />
      <div className="erp-abas" ref={barra} role="group" aria-label="Seções do MCK ERP" data-testid="erp-abas">
        {itens.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={() => (i.to === grupo ? 'active' : '')} aria-current={i.to === ativa ? 'page' : undefined}>{i.label}</NavLink>
        ))}
      </div>
      {pai && subs.length > 0 && (
        <div className="erp-abas erp-subabas" role="group" aria-label={`Dentro de ${pai.label}`} data-testid="erp-subabas">
          <NavLink to={pai.to} end className={() => (ativa === pai.to ? 'active' : '')}>{pai.label}</NavLink>
          {subs.map((i) => <NavLink key={i.to} to={i.to} className={() => (i.to === ativa ? 'active' : '')} aria-current={i.to === ativa ? 'page' : undefined}>{i.label}</NavLink>)}
        </div>
      )}
    </>
  );
}

export default ErpAbas;
