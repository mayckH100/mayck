/** Lista e cadastro de clientes/fornecedores com preenchimento automático pelo CNPJ (Receita). */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, put } from '../../api';
import { useApi, Async, Empty, Modal, Field, useAction } from '../../ui';
import ErpNav from '../ErpNav';
import { fmtDoc, toCents, fromCents } from '../format';

export default function Clientes() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [tipo, setTipo] = useState('');
  const state = useApi<any>(`/erp/crm/parceiros?q=${encodeURIComponent(query)}&tipo=${tipo}`, [query, tipo]);
  const [novo, setNovo] = useState(false);
  const nav = useNavigate();
  return (
    <>
      <div className="page-head">
        <div><h1>Clientes e fornecedores</h1><p className="muted">Cadastro 360º: digite o CNPJ e o resto vem da Receita.</p></div>
        <div className="row">
          <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><input placeholder="Nome, CPF/CNPJ ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 230 }} aria-label="Pesquisar" /></form>
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo"><option value="">Todos</option><option value="cliente">Clientes</option><option value="fornecedor">Fornecedores</option></select>
          <button className="btn primary" onClick={() => setNovo(true)}>+ Novo cadastro</button>
        </div>
      </div>
      <ErpNav />
      <Async state={state}>{(d) => d.items.length === 0 ? (
        <div className="card"><Empty title={query ? 'Nada encontrado' : 'Nenhum cadastro ainda'}>Cadastre o primeiro cliente pelo CNPJ ou CPF.</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>CPF/CNPJ</th><th>Cidade</th><th>Situação</th><th>Status</th><th></th></tr></thead>
            <tbody>{d.items.map((p: any) => (
              <tr key={p.id}>
                <td><strong>{p.fantasia || p.nome}</strong>{p.fantasia && <div className="small muted">{p.nome}</div>}</td>
                <td>{fmtDoc(p.documento)}</td>
                <td>{p.municipio ? `${p.municipio}/${p.uf}` : '—'}</td>
                <td>{p.situacaoCadastral ?? '—'}</td>
                <td><span className={`badge ${p.status === 'ATIVO' ? 'green' : p.status === 'BLOQUEADO' ? 'red' : ''}`}>{p.status}</span></td>
                <td><button className="btn sm" onClick={() => nav(`/erp/clientes/${p.id}`)}>Abrir</button></td>
              </tr>
            ))}</tbody>
          </table>
          <div className="small muted" style={{ marginTop: 8 }}>{d.total} cadastro(s)</div>
        </div>
      )}</Async>
      {novo && <ParceiroForm onClose={() => setNovo(false)} onSaved={(p) => { setNovo(false); nav(`/erp/clientes/${p.id}`); }} />}
    </>
  );
}

const VAZIO = { documento: '', nome: '', fantasia: '', ehCliente: true, ehFornecedor: false, inscricaoEstadual: '', regimeTributario: '', cnae: '', cnaeDescricao: '', situacaoCadastral: '', email: '', telefone: '', cep: '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: '', codigoMunicipio: '', uf: '', limite: '0,00', status: 'ATIVO', origem: '', observacoes: '' };

export function ParceiroForm({ inicial, onClose, onSaved }: { inicial?: any; onClose: () => void; onSaved: (p: any) => void }) {
  const [f, setF] = useState<any>(() => inicial ? { ...VAZIO, ...Object.fromEntries(Object.entries(inicial).map(([k, v]) => [k, v ?? ''])), limite: fromCents(inicial.limiteCreditoCents) } : VAZIO);
  const [consultando, setConsultando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const { busy, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const digits = f.documento.replace(/\D/g, '');

  async function buscarCnpj() {
    setConsultando(true); setAviso(null);
    try {
      const d = await get<any>(`/erp/crm/parceiros/cnpj/${digits}`);
      setF({ ...f, ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v ?? ''])), documento: digits });
      if (d.situacaoCadastral && d.situacaoCadastral !== 'ATIVA') setAviso(`Atenção: situação na Receita é ${d.situacaoCadastral}.`);
    } catch (e) { setAviso((e as Error).message); }
    finally { setConsultando(false); }
  }

  async function salvar() {
    const { limite, ...rest } = f;
    const body = { ...rest, documento: digits, limiteCreditoCents: toCents(limite), regimeTributario: f.regimeTributario || null, uf: f.uf || null, tags: inicial?.tags ?? [] };
    const p = await run(() => (inicial ? put(`/erp/crm/parceiros/${inicial.id}`, body) : post('/erp/crm/parceiros', body)), 'Cadastro salvo');
    if (p) onSaved(p);
  }

  return (
    <Modal title={inicial ? 'Editar cadastro' : 'Novo cadastro'} onClose={onClose}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="CPF ou CNPJ"><input value={f.documento} onChange={set('documento')} placeholder="Só números" autoFocus={!inicial} /></Field>
        {digits.length === 14 && <button type="button" className="btn" disabled={consultando} onClick={buscarCnpj}>{consultando ? 'Consultando…' : 'Buscar na Receita'}</button>}
      </div>
      {aviso && <div className="small" style={{ color: '#b45309', margin: '4px 0' }}>{aviso}</div>}
      <Field label="Razão social / nome"><input value={f.nome} onChange={set('nome')} /></Field>
      <Field label="Nome fantasia"><input value={f.fantasia} onChange={set('fantasia')} /></Field>
      <div className="row">
        <label className="row small"><input type="checkbox" checked={f.ehCliente} onChange={set('ehCliente')} /> Cliente</label>
        <label className="row small"><input type="checkbox" checked={f.ehFornecedor} onChange={set('ehFornecedor')} /> Fornecedor</label>
      </div>
      <div className="grid g2">
        <Field label="E-mail"><input value={f.email} onChange={set('email')} /></Field>
        <Field label="Telefone / WhatsApp"><input value={f.telefone} onChange={set('telefone')} /></Field>
        <Field label="Inscrição Estadual"><input value={f.inscricaoEstadual} onChange={set('inscricaoEstadual')} /></Field>
        <Field label="Regime"><select value={f.regimeTributario} onChange={set('regimeTributario')}><option value="">—</option><option value="MEI">MEI</option><option value="SIMPLES">Simples Nacional</option><option value="NORMAL">Lucro Presumido/Real</option></select></Field>
        <Field label="CEP"><input value={f.cep} onChange={set('cep')} /></Field>
        <Field label="UF"><input value={f.uf} onChange={set('uf')} maxLength={2} /></Field>
        <Field label="Logradouro"><input value={f.logradouro} onChange={set('logradouro')} /></Field>
        <Field label="Número"><input value={f.numero} onChange={set('numero')} /></Field>
        <Field label="Bairro"><input value={f.bairro} onChange={set('bairro')} /></Field>
        <Field label="Município"><input value={f.municipio} onChange={set('municipio')} /></Field>
        <Field label="Limite de crédito (R$)"><input value={f.limite} onChange={set('limite')} inputMode="decimal" /></Field>
        <Field label="Status"><select value={f.status} onChange={set('status')}><option value="ATIVO">Ativo</option><option value="INATIVO">Inativo</option><option value="BLOQUEADO">Bloqueado</option></select></Field>
      </div>
      {f.cnaeDescricao && <div className="small muted">CNAE {f.cnae}: {f.cnaeDescricao}</div>}
      <Field label="Observações"><textarea value={f.observacoes} onChange={set('observacoes')} rows={2} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || !f.nome || !digits} onClick={salvar}>{busy ? 'Salvando…' : 'Salvar'}</button>
      </div>
    </Modal>
  );
}
