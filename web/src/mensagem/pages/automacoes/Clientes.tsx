import { useState } from 'react';
import { useApi, Async, Modal, Field, useAction, fmtNum, Empty } from '../../../ui';
import { post, patch, del } from '../../../api';
import { useAuth } from '../../../auth';
import { API, useReadOnly, OcBadge, fmtDT, CANAL_LABEL, CAT_LABEL, AutoBadge, type Cliente } from './shared';

const STATUS = ['ATIVO', 'INATIVO', 'INADIMPLENTE', 'CANCELADO'];
const ST_LABEL: Record<string, string> = { ATIVO: 'Ativo', INATIVO: 'Inativo', INADIMPLENTE: 'Inadimplente', CANCELADO: 'Cancelado' };

export default function Clientes() {
  const ro = useReadOnly();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi<{ items: Cliente[]; total: number; pageSize: number }>(`${API}/clientes?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}`);
  const [edit, setEdit] = useState<Cliente | 'novo' | null>(null);
  const [ver, setVer] = useState<string | null>(null);
  const [imp, setImp] = useState(false);
  return (
    <div className="stack">
      <div className="row between">
        <div className="row" style={{ flex: 1 }}>
          <input placeholder="Buscar por nome, telefone, e-mail, CPF/CNPJ ou ID" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 380 }} />
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: 'auto' }}>
            <option value="">Todos os status</option>{STATUS.map((s) => <option key={s} value={s}>{ST_LABEL[s]}</option>)}
          </select>
        </div>
        {!ro && (
          <div className="row">
            <a className="btn" href={`/api${API}/clientes/export`}>Exportar CSV</a>
            <button className="btn" onClick={() => setImp(true)}>Importar CSV</button>
            <button className="btn primary" onClick={() => setEdit('novo')}>+ Novo cliente</button>
          </div>
        )}
      </div>
      <div className="card table-wrap">
        <Async state={list}>{(d) => d.items.length === 0 ? <Empty title="Nenhum cliente encontrado">Cadastre um cliente ou importe uma planilha CSV.</Empty> : (
          <>
            <table>
              <thead><tr><th>Nome</th><th>WhatsApp</th><th>E-mail</th><th>Plano</th><th>Status</th><th>Consentimento</th><th /></tr></thead>
              <tbody>{d.items.map((c) => (
                <tr key={c.id}>
                  <td><button className="btn ghost sm" onClick={() => setVer(c.id)} style={{ padding: 0 }}><strong>{c.nome}</strong></button>{c.empresa && <div className="small muted">{c.empresa}</div>}</td>
                  <td>{c.whatsapp ?? c.telefone ?? '—'}</td><td>{c.email ?? '—'}</td><td>{c.plano ?? '—'}</td>
                  <td><span className="badge">{ST_LABEL[c.status] ?? c.status}</span></td>
                  <td>{c.consentimento ? <span className="badge green">Sim</span> : <span className="badge red">Não</span>}{c.marketingOptOut && <span className="badge amber" style={{ marginLeft: 4 }}>Sem marketing</span>}</td>
                  <td>{!ro && <button className="btn sm" onClick={() => setEdit(c)}>Editar</button>}</td>
                </tr>
              ))}</tbody>
            </table>
            <div className="row between small muted" style={{ marginTop: 8 }}>
              <span>{fmtNum(d.total)} cliente(s)</span>
              <span className="row">
                <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button> Página {page}
                <button className="btn sm" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>›</button>
              </span>
            </div>
          </>
        )}</Async>
      </div>
      {edit && <ClienteForm cliente={edit === 'novo' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {ver && <ClienteDetalhe id={ver} onClose={() => setVer(null)} />}
      {imp && <ImportModal onClose={() => setImp(false)} onDone={() => list.reload()} />}
    </div>
  );
}

function ClienteForm({ cliente, onClose, onSaved }: { cliente: Cliente | null; onClose: () => void; onSaved: () => void }) {
  const { busy, run } = useAction();
  const { can } = useAuth();
  const [f, setF] = useState<any>(() => ({
    nome: '', documento: '', telefone: '', whatsapp: '', email: '', emailSecundario: '', empresa: '', plano: '', dataContratacao: '', dataVencimento: '',
    valor: '', parcelas: '', formaPagamento: '', status: 'ATIVO', observacoes: '', prefWhatsapp: true, prefEmail: true, consentimento: false, marketingOptOut: false,
    ...(cliente ? Object.fromEntries(Object.entries(cliente).map(([k, v]) => [k, v ?? ''])) : {}),
    ...(cliente ? { dataContratacao: cliente.dataContratacao?.slice(0, 10) ?? '', dataVencimento: cliente.dataVencimento?.slice(0, 10) ?? '' } : {}),
  }));
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = () => run(async () => {
    const body: any = {};
    for (const k of ['nome', 'documento', 'telefone', 'whatsapp', 'email', 'emailSecundario', 'empresa', 'plano', 'dataContratacao', 'dataVencimento', 'formaPagamento', 'status', 'observacoes']) body[k] = f[k] ?? '';
    for (const k of ['prefWhatsapp', 'prefEmail', 'consentimento', 'marketingOptOut']) body[k] = !!f[k];
    body.valor = f.valor === '' ? null : Number(String(f.valor).replace(',', '.'));
    body.parcelas = f.parcelas === '' ? null : Number(f.parcelas);
    if (cliente) await patch(`${API}/clientes/${cliente.id}`, body); else await post(`${API}/clientes`, body);
    onSaved();
  }, 'Cliente salvo');
  const remove = () => cliente && confirm(`Excluir ${cliente.nome}? Os envios pendentes serão cancelados; o histórico é mantido.`) && run(async () => { await del(`${API}/clientes/${cliente.id}`); onSaved(); }, 'Cliente excluído');
  return (
    <Modal title={cliente ? 'Editar cliente' : 'Novo cliente'} onClose={onClose}>
      <div className="stack">
        <Field label="Nome completo ou razão social *"><input value={f.nome} onChange={set('nome')} /></Field>
        <div className="grid g2">
          <Field label="WhatsApp (com DDI)" hint="ex.: +55 11 99999-8888"><input value={f.whatsapp} onChange={set('whatsapp')} /></Field>
          <Field label="Telefone"><input value={f.telefone} onChange={set('telefone')} /></Field>
          <Field label="E-mail principal"><input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="E-mail secundário"><input type="email" value={f.emailSecundario} onChange={set('emailSecundario')} /></Field>
          <Field label="CPF ou CNPJ"><input value={f.documento} onChange={set('documento')} /></Field>
          <Field label="Empresa"><input value={f.empresa} onChange={set('empresa')} /></Field>
          <Field label="Plano ou serviço"><input value={f.plano} onChange={set('plano')} /></Field>
          <Field label="Forma de pagamento"><input value={f.formaPagamento} onChange={set('formaPagamento')} /></Field>
          <Field label="Data de contratação"><input type="date" value={f.dataContratacao} onChange={set('dataContratacao')} /></Field>
          <Field label="Data de vencimento"><input type="date" value={f.dataVencimento} onChange={set('dataVencimento')} /></Field>
          <Field label="Valor contratado (R$)"><input inputMode="decimal" value={f.valor} onChange={set('valor')} /></Field>
          <Field label="Parcelas"><input type="number" min={1} value={f.parcelas} onChange={set('parcelas')} /></Field>
          <Field label="Status"><select value={f.status} onChange={set('status')}>{STATUS.map((s) => <option key={s} value={s}>{ST_LABEL[s]}</option>)}</select></Field>
        </div>
        <Field label="Observações internas"><textarea rows={2} value={f.observacoes} onChange={set('observacoes')} /></Field>
        <label className="mm-check"><input type="checkbox" checked={!!f.consentimento} onChange={set('consentimento')} /> O cliente autorizou receber mensagens (consentimento registrado)</label>
        <div className="row">
          <label className="row small"><input type="checkbox" checked={!!f.prefWhatsapp} onChange={set('prefWhatsapp')} style={{ width: 'auto' }} /> Aceita WhatsApp</label>
          <label className="row small"><input type="checkbox" checked={!!f.prefEmail} onChange={set('prefEmail')} style={{ width: 'auto' }} /> Aceita e-mail</label>
          <label className="row small"><input type="checkbox" checked={!!f.marketingOptOut} onChange={set('marketingOptOut')} style={{ width: 'auto' }} /> Não quer receber marketing</label>
        </div>
        <div className="row between">
          {cliente && can('OWNER') ? <button className="btn danger" onClick={remove} disabled={busy}>Excluir</button> : <span />}
          <div className="row"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save} disabled={busy || !f.nome.trim()}>Salvar</button></div>
        </div>
      </div>
    </Modal>
  );
}

function ClienteDetalhe({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`${API}/clientes/${id}`);
  return (
    <Modal title="Cliente" onClose={onClose}>
      <Async state={d}>{(c) => (
        <div className="stack">
          <div><h3 style={{ margin: 0 }}>{c.nome}</h3><div className="small muted">{[c.whatsapp, c.email, c.plano, c.empresa].filter(Boolean).join(' · ')}</div></div>
          <div><strong className="small">Automações</strong>
            {c.automacoes.length ? c.automacoes.map((a: any) => <div key={a.id} className="row small">{a.nome} <span className="badge">{CAT_LABEL[a.categoria as 'LEMBRETE']}</span> <AutoBadge s={a.status} /></div>) : <div className="small muted">Nenhuma.</div>}
          </div>
          <div><strong className="small">Próximos envios</strong>
            {c.proximas.length ? c.proximas.map((o: any) => <div key={o.id} className="small">{fmtDT(o.executarEm)} · {CANAL_LABEL[o.canal as 'EMAIL']}</div>) : <div className="small muted">Nenhum.</div>}
          </div>
          <div><strong className="small">Histórico de mensagens</strong>
            {c.historico.length ? c.historico.map((h: any) => (
              <div key={h.id} className="small" style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>
                <div className="row between"><span>{fmtDT(h.enviadoEm ?? h.updatedAt)} · {CANAL_LABEL[h.canal as 'EMAIL']}</span><OcBadge s={h.status} /></div>
                <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{h.conteudo}</div>{h.erro && <div style={{ color: 'var(--danger)' }}>{h.erro}</div>}
              </div>
            )) : <div className="small muted">Nada enviado ainda.</div>}
          </div>
        </div>
      )}</Async>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const [consent, setConsent] = useState(false);
  const [res, setRes] = useState<any>(null);
  return (
    <Modal title="Importar clientes (CSV)" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Primeira linha com os nomes das colunas: <code>nome,whatsapp,telefone,email,documento,empresa,plano,dataVencimento,valor,parcelas,consentimento</code>. Clientes já cadastrados (mesmo telefone, e-mail ou CPF/CNPJ) não são duplicados: só os campos vazios são completados.</p>
        <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="nome,whatsapp,email&#10;João da Silva,11999998888,joao@email.com" />
        <label className="mm-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Todos os clientes da lista autorizaram receber mensagens</label>
        {res && <div className="alert ok">{res.criados} criado(s), {res.atualizados} atualizado(s).{res.erros.length > 0 && <div className="small">{res.erros.slice(0, 5).join(' · ')}</div>}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Fechar</button>
          <button className="btn primary" disabled={busy || !text.trim()} onClick={() => run(async () => { setRes(await post(`${API}/clientes/import`, { text, consentimentoDeclarado: consent })); onDone(); })}>Importar</button>
        </div>
      </div>
    </Modal>
  );
}
