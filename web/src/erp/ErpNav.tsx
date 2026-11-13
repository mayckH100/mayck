/** Submenu do MCK ERP: uma barra de abas em uma linha (rola na horizontal no celular), mostrada pelo Shell em todas as telas /erp. */
import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';

export const ERP_ITENS: { to: string; label: string; end?: boolean; module?: string }[] = [
  { to: '/erp', label: 'Painel CRM', end: true },
  // Venda balcão (PDV) com entrada própria no menu: antes ficava só como botão dentro de Pedidos e o cliente não achava.
  { to: '/erp/balcao', label: 'Venda balcão (PDV)', module: 'erp_vendas' },
  { to: '/erp/funil', label: 'Funil de vendas' },
  { to: '/erp/clientes', label: 'Clientes' },
  { to: '/erp/fornecedores', label: 'Fornecedores' },
  { to: '/erp/pedidos', label: 'Pedidos' },
  { to: '/erp/produtos', label: 'Produtos' },
  { to: '/erp/estoque', label: 'Estoque' },
  { to: '/erp/compras', label: 'Compras' },
  { to: '/erp/producao', label: 'Produção' },
  { to: '/erp/financeiro', label: 'Financeiro' },
  { to: '/erp/fiscal', label: 'Fiscal' },
  { to: '/erp/maquininhas', label: 'Maquininhas', module: 'erp_vendas' },
  { to: '/erp/bi', label: 'BI' },
  { to: '/erp/alertas', label: 'Alertas' },
];
/** Aba ativa: a rota mais específica que bate (ex.: /erp/pedidos/123 → Pedidos). */
export function abaAtiva(path: string): string | null {
  let melhor: string | null = null;
  for (const i of ERP_ITENS) {
    const bate = i.end ? path === i.to : path === i.to || path.startsWith(`${i.to}/`);
    if (bate && (!melhor || i.to.length > melhor.length)) melhor = i.to;
  }
  return melhor;
}

export function ErpAbas() {
  const { hasModule } = useAuth();
  const loc = useLocation();
  const barra = useRef<HTMLDivElement>(null);
  const ativa = abaAtiva(loc.pathname);
  // Mantém a aba ativa à vista (sem rolar a página na vertical).
  useEffect(() => {
    const el = barra.current?.querySelector<HTMLElement>('a.active');
    const b = barra.current;
    if (!el || !b) return;
    const alvo = el.offsetLeft - (b.clientWidth - el.offsetWidth) / 2;
    if (typeof b.scrollTo === 'function') b.scrollTo({ left: Math.max(0, alvo), behavior: 'smooth' }); else b.scrollLeft = Math.max(0, alvo);
  }, [ativa]);
  const itens = ERP_ITENS.filter((i) => !i.module || hasModule(i.module));
  return (
    <div className="erp-abas" ref={barra} role="group" aria-label="Seções do MCK ERP" data-testid="erp-abas">
      {itens.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end} className={() => (i.to === ativa ? 'active' : '')} aria-current={i.to === ativa ? 'page' : undefined}>{i.label}</NavLink>
      ))}
    </div>
  );
}

export default ErpAbas;
