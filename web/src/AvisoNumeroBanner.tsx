import { Link } from 'react-router-dom';
import { useAuth } from './auth';

/**
 * Lembrete visível quando a organização não tem nenhum "Número de aviso (WhatsApp)":
 * sem ele, ninguém recebe no celular a transferência para humano, reunião, tarefa ou pedido.
 * Proprietário/Admin vê o atalho para cadastrar o WhatsApp particular; demais membros veem quem pode configurar.
 */
export default function AvisoNumeroBanner({ where }: { where?: string }) {
  const { me, can } = useAuth();
  if (!me?.org || me.org.handoffNotifyPhones?.length) return null;
  const admin = can('OWNER', 'ADMIN');
  return (
    <div className="alert warn row between" role="alert" data-testid="aviso-numero-banner" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
      <span>
        <strong>Receba os avisos no seu WhatsApp particular.</strong> Nenhum número de aviso configurado: ninguém é avisado no celular quando a IA transfere para humano, é marcada uma reunião, criada uma tarefa ou feito um pedido{where ? ` ${where}` : ''}.
      </span>
      {admin
        ? <Link className="btn sm primary" to="/perfil#avisos-atendimento">Cadastrar meu WhatsApp</Link>
        : <span className="small muted">Peça ao Proprietário ou Administrador para cadastrar em Perfil › Números de aviso.</span>}
    </div>
  );
}
