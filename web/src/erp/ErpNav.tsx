/** Submenu do MCK ERP: uma barra de abas em uma linha (rola na horizontal no celular), mostrada pelo Shell em todas as telas /erp. */
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { AtalhoLerCodigo } from './leitura/LerCodigo';

/** Item do menu do ERP. `pai` = subitem do grupo daquela rota (v1.35.0, pedido do dono). */
export type ErpItem = { to: string; label: string; end?: boolean; module?: string; pai?: string };

export const ERP_ITENS: ErpItem[] = [
  { to: '/erp', label: 'Painel CRM', end: true },
  // Venda balcão (PDV) com entrada própria no menu: antes ficava só como botão dentro de Pedidos e o cliente não achava.
  { to: '/erp/balcao', label: 'Venda balcão (PDV)', module: 'erp_vendas', end: true },
  // v1.35.0 (pedido do dono, 20/11): o leitor é subcategoria de Venda balcão (a tecla F2 continua em qualquer tela).
  { to: '/erp/balcao/ler', label: '📷 Ler código', module: 'erp_vendas', pai: '/erp/balcao' },
  { to: '/erp/funil', label: 'Funil de vendas' },
  { to: '/erp/clientes', label: 'Clientes' },
  { to: '/erp/fornecedores', label: 'Fornecedores' },
  { to: '/erp/pedidos', label: 'Pedidos' },
  // v1.34.0: localizar pedido por leitura (QR/código de barras) ou digitação. v1.35.0: dentro de Pedidos.
  { to: '/erp/pedidos/localizar', label: 'Localizar pedido', pai: '/erp/pedidos' },
  { to: '/erp/produtos', label: 'Produtos' },
  { to: '/erp/estoque', label: 'Estoque' },
  // v1.33.0: rastreabilidade de lote (busca única: produto, lote, lote do fornecedor, nota, pedido).
  { to: '/erp/rastreio', label: 'Rastreio de lote' },
  { to: '/erp/compras', label: 'Compras' },
  { to: '/erp/producao', label: 'Produção' },
  { to: '/erp/financeiro', label: 'Financeiro' },
  { to: '/erp/fiscal', label: 'Fiscal' },
  { to: '/erp/maquininhas', label: 'Maquininhas', module: 'erp_vendas' },
  { to: '/erp/bi', label: 'BI' },
  { to: '/erp/alertas', label: 'Alertas' },
];
/** Aba ativa: a rota mais específica que bate (ex.: /erp/pedidos/123 → Pedidos; /erp/pedidos/localizar → Localizar pedido). */
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
  const { hasModule } = useAuth();
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
  const pode = (i: ErpItem) => !i.module || hasModule(i.module);
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
