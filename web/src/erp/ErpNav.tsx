/** Submenu do MCK ERP: cada módulo entra aqui conforme as etapas forem liberadas. */
import { NavLink } from 'react-router-dom';

const ITENS = [
  { to: '/erp', label: 'Painel CRM', end: true },
  { to: '/erp/funil', label: 'Funil de vendas' },
  { to: '/erp/clientes', label: 'Clientes e fornecedores' },
  { to: '/erp/pedidos', label: 'Pedidos' },
  { to: '/erp/produtos', label: 'Produtos' },
  { to: '/erp/estoque', label: 'Estoque' },
  { to: '/erp/compras', label: 'Compras' },
  { to: '/erp/producao', label: 'Produção' },
  { to: '/erp/financeiro', label: 'Financeiro' },
  { to: '/erp/fiscal', label: 'Fiscal' },
  { to: '/erp/bi', label: 'BI' },
];
const PROXIMOS: string[] = [];

export default function ErpNav() {
  return (
    <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
      {ITENS.map((i) => <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `btn sm ${isActive ? 'primary' : ''}`}>{i.label}</NavLink>)}
      {PROXIMOS.map((p) => <span key={p} className="btn sm" style={{ opacity: 0.45, cursor: 'default' }} title="Próximas etapas do ERP">{p}</span>)}
    </div>
  );
}
