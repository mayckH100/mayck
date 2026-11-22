/**
 * v1.44.0 — Inbox: assistente do atendente (Resumo e Sugerir resposta) e cobrança Pix na conversa.
 */
import { useState } from 'react';
import { post, put } from '../api';
import { useApi, useAction, Modal, Field, Loading, fmtDate, copy, useToast } from '../ui';

const TIPOS: [string, string, string][] = [
  ['cpf', 'CPF', '000.000.000-00'], ['cnpj', 'CNPJ', '00.000.000/0000-00'], ['email', 'E-mail', 'financeiro@suaempresa.com.br'],
  ['telefone', 'Telefone', '(11) 91234-5678'], ['aleatoria', 'Chave aleatória', '123e4567-e89b-12d3-a456-426614174000'],
];
const STATUS_PIX: Record<string, [string, string]> = { PENDENTE: ['Pendente', 'blue'], PAGA: ['Paga', 'green'], CANCELADA: ['Cancelada', ''] };

/** Assistente: estado da IA (para desabilitar os botões com dica). */
export function useAssistente() {
  return useApi<{ disponivel: boolean; motivo?: string }>('/inbox/assistente');
}

export function BotoesAssistente({ conversationId, disponivel, motivo, onSugestao }: { conversationId: string; disponivel: boolean; motivo?: string; onSugestao: (t: string) => void }) {
  const { busy, run } = useAction();
  const [resumo, setResumo] = useState<string | null>(null);
  const dica = disponivel ? undefined : motivo;
  return (
    <>
      <button type="button" className="btn sm" disabled={!disponivel || busy} title={dica ?? 'Resumo da conversa em poucas linhas, feito pela IA da empresa'}
        onClick={async () => { const r = await run(() => post<{ resumo: string }>(`/inbox/conversas/${conversationId}/resumo`, {}, { timeoutMs: 60000 })); if (r) setResumo(r.resumo); }}>
        📝 Resumo
      </button>
      <button type="button" className="btn sm" disabled={!disponivel || busy} title={dica ?? 'A IA escreve um rascunho no campo de mensagem; você revisa e envia'}
        onClick={async () => { const r = await run(() => post<{ sugestao: string }>(`/inbox/conversas/${conversationId}/sugestao`, {}, { timeoutMs: 60000 }), 'Rascunho pronto: revise antes de enviar'); if (r) onSugestao(r.sugestao); }}>
        {busy ? '⏳' : '✨'} Sugerir resposta
      </button>
      {resumo !== null && (
        <Modal title="Resumo da conversa" onClose={() => setResumo(null)}>
          <div style={{ whiteSpace: 'pre-wrap' }}>{resumo}</div>
          <p className="small muted">Feito pela IA da empresa com as mensagens desta conversa. Confira antes de usar.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setResumo(null)}>Fechar</button></div>
        </Modal>
      )}
    </>
  );
}

function ChavePixForm({ atual, onSaved }: { atual: any; onSaved: () => void }) {
  const [f, setF] = useState({ keyType: atual?.keyType ?? 'cnpj', key: atual?.key ?? '', name: atual?.name ?? '', city: atual?.city ?? '' });
  const { busy, run } = useAction();
  const ph = TIPOS.find((t) => t[0] === f.keyType)?.[2] ?? '';
  return (
    <div className="stack">
      <div className="grid g2">
        <Field label="Tipo da chave"><select value={f.keyType} onChange={(e) => setF({ ...f, keyType: e.target.value })}>{TIPOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Chave Pix"><input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder={ph} /></Field>
        <Field label="Nome do recebedor" hint="Como aparece no banco (até 25 letras no código)"><input value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Cidade"><input value={f.city} maxLength={40} onChange={(e) => setF({ ...f, city: e.target.value })} placeholder="São Paulo" /></Field>
      </div>
      <p className="small muted" style={{ margin: 0 }}>O dinheiro vai direto para a sua conta: o MCKBOT só monta o código Pix com a sua chave. Sem intermediário e sem taxa.</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={busy || !f.key.trim() || !f.name.trim() || !f.city.trim()} onClick={async () => { if (await run(() => put('/inbox/pix/config', f), 'Chave Pix salva')) onSaved(); }}>Salvar chave Pix</button>
      </div>
    </div>
  );
}

export function PixModal({ conversationId, podeConfigurar, onClose, onDone }: { conversationId: string; podeConfigurar: boolean; onClose: () => void; onDone: () => void }) {
  const cfg = useApi<any>('/inbox/pix/config');
  const lista = useApi<{ items: any[] }>(`/inbox/conversas/${conversationId}/pix`, [conversationId]);
  const [editar, setEditar] = useState(false);
  const [valor, setValor] = useState('');
  const [descricao, setDescricao] = useState('');
  const { busy, run } = useAction();
  const toast = useToast();
  const cobrar = async () => {
    const r = await run(() => post<any>(`/inbox/conversas/${conversationId}/pix`, { valor, descricao }), 'Cobrança Pix enviada ao cliente');
    if (r) { setValor(''); setDescricao(''); lista.reload(); onDone(); if (r.envio?.erro) toast(`Atenção: ${r.envio.erro}`, 'err'); }
  };
  const status = async (id: string, s: string) => { if (await run(() => post(`/inbox/pix/${id}/status`, { status: s }), s === 'PAGA' ? 'Marcada como paga' : 'Cobrança atualizada')) { lista.reload(); onDone(); } };
  return (
    <Modal title="💠 Cobrar Pix" onClose={onClose}>
      {!cfg.data ? <Loading /> : (!cfg.data.configurado || editar) ? (
        podeConfigurar
          ? <><p className="small muted" style={{ marginTop: 0 }}>Cadastre a chave Pix da empresa uma vez. Depois é só informar o valor.</p><ChavePixForm atual={cfg.data.configurado ? cfg.data : null} onSaved={() => { setEditar(false); cfg.reload(); }} /></>
          : <p>A chave Pix da empresa ainda não foi cadastrada. Peça ao Proprietário ou Administrador para cadastrar em Inbox › 💠 Cobrar Pix.</p>
      ) : (
        <div className="stack">
          <div className="small muted">Recebedor: <strong>{cfg.data.name}</strong> · {cfg.data.keyTypeLabel}: {cfg.data.key} {podeConfigurar && <button className="linklike small" onClick={() => setEditar(true)}>trocar chave</button>}</div>
          <div className="grid g2">
            <Field label="Valor (R$)"><input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="150,00" autoFocus /></Field>
            <Field label="Descrição (opcional)"><input value={descricao} maxLength={120} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex.: Pedido 123" /></Field>
          </div>
          <p className="small muted" style={{ margin: 0 }}>O cliente recebe o QR code e o código "Pix copia e cola". Confira o pagamento no extrato do banco e marque como paga.</p>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <button className="btn" onClick={onClose}>Fechar</button>
            <button className="btn primary" disabled={busy || !valor.trim()} onClick={cobrar}>Enviar cobrança</button>
          </div>
          {!!lista.data?.items.length && (
            <div className="table-wrap"><table className="small"><thead><tr><th>Valor</th><th>Descrição</th><th>Enviada</th><th>Situação</th><th /></tr></thead>
              <tbody>{lista.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.valor}</td><td>{c.description || '—'}</td><td>{fmtDate(c.createdAt)}</td>
                  <td><span className={`badge ${STATUS_PIX[c.status]?.[1] ?? ''}`}>{STATUS_PIX[c.status]?.[0] ?? c.status}</span>{c.paidAt && <div className="muted">{fmtDate(c.paidAt)}</div>}</td>
                  <td className="row" style={{ gap: 4 }}>
                    {c.status !== 'PAGA' && <button className="btn sm" disabled={busy} onClick={() => status(c.id, 'PAGA')}>✅ Paga</button>}
                    {c.status === 'PAGA' && <button className="btn sm" disabled={busy} onClick={() => status(c.id, 'PENDENTE')}>Desfazer</button>}
                    {c.status === 'PENDENTE' && <button className="btn sm" disabled={busy} onClick={() => status(c.id, 'CANCELADA')}>Cancelar</button>}
                    <button className="btn sm" title="Copiar o código Pix copia e cola" onClick={() => copy(c.code, toast)}>📋</button>
                  </td>
                </tr>
              ))}</tbody></table></div>
          )}
        </div>
      )}
    </Modal>
  );
}
