import { Link } from 'react-router-dom';

export default function Guide() {
  return (
    <>
      <div className="page-head"><div><h1>Boas práticas no WhatsApp</h1><p className="muted">Como usar a API oficial sem perder qualidade do número.</p></div></div>
      <div className="grid g2">
        <div className="card"><h2>Janela de 24 horas</h2><p>Depois que o cliente envia uma mensagem, você pode responder livremente por 24 horas. Fora dessa janela, a Meta só aceita <strong>modelos (templates) aprovados</strong>. O MCKBOT bloqueia o envio livre fora da janela e oferece o envio de modelo no Inbox.</p></div>
        <div className="card"><h2>Qualidade do número</h2><p>A Meta mede bloqueios e denúncias. Responda rápido, não envie mensagens que o cliente não pediu e respeite quem pede para sair: quando o contato envia <strong>SAIR</strong> ou <strong>PARAR</strong>, o MCKBOT marca opt-out e para as automações para ele.</p></div>
        <div className="card"><h2>Modelos aprovados</h2><p>Crie modelos no Gerenciador do WhatsApp (business.facebook.com) para lembretes, confirmações e reengajamento. Use categorias corretas (utilidade, marketing, autenticação) — elas afetam o preço e a aprovação.</p></div>
        <div className="card"><h2>IA responsável</h2><p>Coloque preços, prazos e políticas na base de conhecimento. Sem isso, a IA não responde esses assuntos e transfere para um atendente — melhor do que inventar.</p></div>
        <div className="card"><h2>LGPD</h2><p>Na página de cada contato é possível exportar todos os dados (direito de acesso) e apagá-los definitivamente (direito de eliminação). As ações ficam registradas na auditoria.</p></div>
        <div className="card"><h2>Começar</h2><p>1) <Link to="/canais">Conecte o número</Link> · 2) <Link to="/ia">Configure a IA</Link> · 3) <Link to="/fluxos">Crie os fluxos</Link> · 4) <Link to="/equipe">Convide a equipe</Link>.</p></div>
      </div>
    </>
  );
}
