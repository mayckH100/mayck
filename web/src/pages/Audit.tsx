import { useApi, Async, Empty, fmtDate } from '../ui';

const LABEL: Record<string, string> = {
  'auth.login': 'Login', 'auth.login_failed': 'Login falhou', 'auth.register': 'Cadastro', 'flow.create': 'Fluxo criado', 'flow.save': 'Fluxo salvo', 'flow.activate': 'Fluxo ativado', 'flow.pause': 'Fluxo pausado',
  'flow.delete': 'Fluxo excluído', 'flow.duplicate': 'Fluxo duplicado', 'flow.restore': 'Versão restaurada', 'flow.import': 'Fluxo importado', 'flow.manual_start': 'Fluxo disparado manualmente',
  'channel.create': 'Canal criado', 'channel.update': 'Canal alterado', 'channel.verify': 'Canal verificado', 'channel.delete': 'Canal excluído', 'channel.disconnect': 'Canal desconectado',
  'ai.settings_update': 'IA configurada', 'ai.knowledge_create': 'Documento criado', 'ai.knowledge_update': 'Documento alterado', 'ai.knowledge_delete': 'Documento excluído',
  'lgpd.export': 'LGPD: dados exportados', 'lgpd.delete': 'LGPD: dados apagados', 'team.invite': 'Convite criado', 'team.remove': 'Membro removido', 'team.role_change': 'Papel alterado', 'team.invite_accepted': 'Convite aceito',
  'inbox.send': 'Mensagem enviada', 'inbox.close': 'Conversa encerrada', 'inbox.take': 'Conversa assumida', 'inbox.to_bot': 'Devolvida ao robô', 'contact.create': 'Contato criado', 'contact.update': 'Contato alterado', 'contact.import': 'Contatos importados', 'kanban.move': 'Kanban: contato movido',
};

export default function Audit() {
  const state = useApi<any[]>('/audit');
  return (
    <>
      <div className="page-head"><div><h1>Auditoria</h1><p className="muted">Últimas 200 ações registradas nesta organização.</p></div><button className="btn" onClick={state.reload}>Atualizar</button></div>
      <Async state={state}>{(logs) => logs.length === 0 ? <div className="card"><Empty title="Nenhum registro" /></div> : (
        <div className="card table-wrap">
          <table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhes</th><th>IP</th></tr></thead>
            <tbody>{logs.map((l) => (
              <tr key={l.id}><td>{fmtDate(l.createdAt)}</td><td>{l.user?.name ?? '—'}</td><td>{LABEL[l.action] ?? l.action}</td><td className="mono">{l.entity ? `${l.entity} ${l.entityId ?? ''}` : ''} {l.meta !== '{}' ? l.meta : ''}</td><td className="small">{l.ip}</td></tr>
            ))}</tbody></table>
        </div>
      )}</Async>
    </>
  );
}
