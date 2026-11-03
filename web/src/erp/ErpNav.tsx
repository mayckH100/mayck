/** Submenu do MCK ERP: cada módulo entra aqui conforme as etapas forem liberadas. */
import { NavLink } from 'react-router-dom';

const ITENS = [
  { to: '/erp', label: 'Painel CRM', end: true },
  { to: '/erp/funil', label: 'Funil de vendas' },
  { to: '/erp/clientes', label: 'Clientes e fornecedores' },
];
const PROXIMOS = ['Vendas', 'Estoque', 'Produção', 'Compras', 'Fiscal', 'Financeiro'];

export default function ErpNav() {
  return (
    <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
      {ITENS.map((i) => <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `btn sm ${isActive ? 'primary' : ''}`}>{i.label}</NavLink>)}
      {PROXIMOS.map((p) => <span key={p} className="btn sm" style={{ opacity: 0.45, cursor: 'default' }} title="Próximas etapas do ERP">{p}</span>)}
    </div>
  );
}
