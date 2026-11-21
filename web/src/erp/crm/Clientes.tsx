/** Cadastros separados de Clientes e de Fornecedores, com preenchimento automático pelo CNPJ (Receita). */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, put } from '../../api';
import { useApi, Async, Empty, Modal, Field, useAction } from '../../ui';
import ImportarExportar from '../ImportarExportar';
import { useAuth } from '../../auth';
import { fmtDoc, toCents, fromCents } from '../format';
import { Ajuda } from '../pagina';

export default function Clientes({ papel = 'cliente' }: { papel?: 'cliente' | 'fornecedor' }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const tipo = papel;
  const forn = papel === 'fornecedor';
  const { can } = useAuth();
  const state = useApi<any>(`/erp/crm/parceiros?q=${encodeURIComponent(query)}&tipo=${tipo}`, [query, tipo]);
  const [novo, setNovo] = useState(false);
  const nav = useNavigate();
  return (
    <>
      <div className="page-head erp-cab">
        <div className="erp-titulo"><h1>{forn ? 'Fornecedores' : 'Clientes'}</h1><Ajuda>Digite o CNPJ e o resto vem da Receita.</Ajuda></div>
        <div className="erp-cab-acoes">
          <form className="busca-cab" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><input type="search" placeholder="Nome, CPF/CNPJ ou e-mail" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Pesquisar" /></form>
          <button className="btn primary" onClick={() => setNovo(true)}>{forn ? '+ Novo fornecedor' : '+ Novo cliente'}</button>
          <ImportarExportar entidade={forn ? 'fornecedores' : 'clientes'} podeImportar={can('OWNER', 'ADMIN')} onImportado={state.reload} />
        </div>
      </div>
      <Async state={state}>{(d) => d.items.length === 0 ? (
        <div className="card"><Empty title={query ? 'Nada encontrado' : 'Nenhum cadastro ainda'}>{forn ? 'Cadastre o primeiro fornecedor pelo CNPJ.' : 'Cadastre o primeiro cliente pelo CNPJ ou CPF.'}</Empty></div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Nome</th><th className="col-sec">CPF/CNPJ</th><th className="col-sec">Cidade</th><th className="col-sec">Situação</th><th>Status</th><th></th></tr></thead>
            <tbody>{d.items.map((p: any) => (
              <tr key={p.id}>
                <td><strong>{p.fantasia || p.nome}</strong>{p.fantasia && <div className="small muted">{p.nome}</div>}</td>
                <td className="col-sec">{fmtDoc(p.documento)}</td>
                <td className="col-sec">{p.municipio ? `${p.municipio}/${p.uf}` : '—'}</td>
                <td className="col-sec">{p.situacaoCadastral ?? '—'}</td>
                <td><span className={`badge ${p.status === 'ATIVO' ? 'green' : p.status === 'BLOQUEADO' ? 'red' : ''}`}>{p.status}</span></td>
                <td><button className="btn sm" onClick={() => nav(`/erp/${forn ? 'fornecedores' : 'clientes'}/${p.id}`)}>Abrir</button></td>
              </tr>
            ))}</tbody>
          </table>
          <div className="small muted" style={{ marginTop: 8 }}>{d.total} {forn ? 'fornecedor(es)' : 'cliente(s)'}</div>
        </div>
      )}</Async>
      {novo && <ParceiroForm papel={papel} onClose={() => setNovo(false)} onSaved={(p) => { setNovo(false); nav(`/erp/${forn ? 'fornecedores' : 'clientes'}/${p.id}`); }} />}
    </>
  );
}

const VAZIO = { documento: '', nome: '', fantasia: '', ehCliente: true, ehFornecedor: false, inscricaoEstadual: '', inscricaoMunicipal: '', condicaoPagamentoId: '', tabelaPrecoId: '', prazo: '0', regimeTributario: '', cnae: '', cnaeDescricao: '', situacaoCadastral: '', email: '', telefone: '', cep: '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: '', codigoMunicipio: '', uf: '', limite: '0,00', status: 'ATIVO', origem: '', observacoes: '' };

export function ParceiroForm({ inicial, papel, onClose, onSaved }: { inicial?: any; papel?: 'cliente' | 'fornecedor'; onClose: () => void; onSaved: (p: any) => void }) {
  const papelForm = papel ?? (inicial?.ehFornecedor && !inicial?.ehCliente ? 'fornecedor' : 'cliente');
  const [f, setF] = useState<any>(() => inicial ? { ...VAZIO, ...Object.fromEntries(Object.entries(inicial).map(([k, v]) => [k, v ?? ''])), limite: fromCents(inicial.limiteCreditoCents), prazo: String(inicial.prazoEntregaDias ?? 0) } : { ...VAZIO, ehCliente: papelForm === 'cliente', ehFornecedor: papelForm === 'fornecedor' });
  const [consultando, setConsultando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const { busy, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const digits = f.documento.replace(/\D/g, '');
  const { can } = useAuth();
  const gestor = can('OWNER', 'ADMIN');
  // v1.33.0: o que não pode mudar depois do uso (com o porquê) e condições comerciais.
  const travas = useApi<any>(inicial?.id ? `/erp/crm/parceiros/${inicial.id}/travas` : null, [inicial?.id]).data ?? {};
  const condicoes = useApi<any[]>('/erp/produtos/condicoes');
  const tabelas = useApi<any[]>(papelForm === 'cliente' ? '/erp/produtos/tabelas' : null);

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
    // Só os campos do cadastro (sem contatos, oportunidades, resumo… que vêm na tela 360).
    const CAMPOS = ['nome', 'fantasia', 'ehCliente', 'ehFornecedor', 'inscricaoEstadual', 'inscricaoMunicipal', 'cnae', 'cnaeDescricao', 'situacaoCadastral', 'email', 'telefone', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'municipio', 'codigoMunicipio', 'status', 'origem', 'observacoes'];
    const body = { ...Object.fromEntries(CAMPOS.map((k) => [k, f[k] === '' ? null : f[k]])), nome: f.nome, ehCliente: !!f.ehCliente, ehFornecedor: !!f.ehFornecedor, status: f.status || 'ATIVO', documento: digits, limiteCreditoCents: toCents(f.limite), regimeTributario: f.regimeTributario || null, uf: f.uf || null, tags: inicial?.tags ?? [], condicaoPagamentoId: f.condicaoPagamentoId || null, tabelaPrecoId: f.tabelaPrecoId || null, prazoEntregaDias: Number(f.prazo) || 0 };
    const p = await run(() => (inicial ? put(`/erp/crm/parceiros/${inicial.id}`, body) : post('/erp/crm/parceiros', body)), papelForm === 'fornecedor' ? 'Fornecedor salvo' : 'Cliente salvo');
    if (p) onSaved(p);
  }

  return (
    <Modal title={`${inicial ? 'Editar' : 'Novo'} ${papelForm === 'fornecedor' ? 'fornecedor' : 'cliente'}`} onClose={onClose}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label={`CPF ou CNPJ${travas.documento ? ' 🔒' : ''}`} hint={travas.documento ?? undefined}><input value={f.documento} onChange={set('documento')} placeholder="Só números" autoFocus={!inicial} disabled={!!travas.documento} inputMode="numeric" /></Field>
        {digits.length === 14 && !travas.documento && <button type="button" className="btn" disabled={consultando} onClick={buscarCnpj}>{consultando ? 'Consultando…' : 'Buscar na Receita'}</button>}
      </div>
      {aviso && <div className="small" style={{ color: '#b45309', margin: '4px 0' }}>{aviso}</div>}
      <Field label="Razão social / nome"><input value={f.nome} onChange={set('nome')} /></Field>
      <Field label="Nome fantasia"><input value={f.fantasia} onChange={set('fantasia')} /></Field>
      <div className="grid g2">
        <Field label="E-mail"><input value={f.email} onChange={set('email')} /></Field>
        <Field label="Telefone / WhatsApp"><input value={f.telefone} onChange={set('telefone')} /></Field>
        <Field label="Inscrição Estadual" hint="Deixe vazio se for isento"><input value={f.inscricaoEstadual} onChange={set('inscricaoEstadual')} /></Field>
        <Field label="Inscrição Municipal"><input value={f.inscricaoMunicipal} onChange={set('inscricaoMunicipal')} /></Field>
        <Field label="Regime"><select value={f.regimeTributario} onChange={set('regimeTributario')}><option value="">—</option><option value="MEI">MEI</option><option value="SIMPLES">Simples Nacional</option><option value="NORMAL">Lucro Presumido/Real</option></select></Field>
        <Field label="CEP"><input value={f.cep} onChange={set('cep')} /></Field>
        <Field label="UF"><input value={f.uf} onChange={set('uf')} maxLength={2} /></Field>
        <Field label="Logradouro"><input value={f.logradouro} onChange={set('logradouro')} /></Field>
        <Field label="Número"><input value={f.numero} onChange={set('numero')} /></Field>
        <Field label="Complemento"><input value={f.complemento} onChange={set('complemento')} /></Field>
        <Field label="Bairro"><input value={f.bairro} onChange={set('bairro')} /></Field>
        <Field label="Município"><input value={f.municipio} onChange={set('municipio')} /></Field>
        <Field label="Código IBGE do município" hint="7 dígitos; usado na nota fiscal (vem da Receita pelo CNPJ)"><input value={f.codigoMunicipio} onChange={set('codigoMunicipio')} inputMode="numeric" maxLength={7} /></Field>
        <Field label="Condição de pagamento padrão" hint={papelForm === 'cliente' ? 'Já vem marcada nos pedidos deste cliente' : 'Como você paga este fornecedor'}><select value={f.condicaoPagamentoId} onChange={set('condicaoPagamentoId')}><option value="">—</option>{(condicoes.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></Field>
        {papelForm === 'cliente' && <Field label="Tabela de preço"><select value={f.tabelaPrecoId} onChange={set('tabelaPrecoId')}><option value="">Preço normal</option>{(tabelas.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.nome}</option>)}</select></Field>}
        {papelForm === 'fornecedor' && <Field label="Prazo de entrega (dias)" hint="Usado em “O que comprar” quando o produto não tem prazo próprio"><input value={f.prazo} onChange={set('prazo')} inputMode="numeric" /></Field>}
        {papelForm === 'cliente' && <Field label={`Limite de crédito (R$)${gestor ? '' : ' 🔒'}`} hint={gestor ? undefined : 'Só o Proprietário ou o Administrador mudam'}><input value={f.limite} onChange={set('limite')} inputMode="decimal" disabled={!gestor} /></Field>}
        <Field label={`Status${gestor ? '' : ' 🔒'}`} hint={gestor ? undefined : 'Só o Proprietário ou o Administrador mudam'}><select value={f.status} onChange={set('status')} disabled={!gestor}><option value="ATIVO">Ativo</option><option value="INATIVO">Inativo</option><option value="BLOQUEADO">Bloqueado</option></select></Field>
      </div>
      {f.cnaeDescricao && <div className="small muted">CNAE {f.cnae}: {f.cnaeDescricao}</div>}
      <Field label="Origem (como chegou)"><input value={f.origem} onChange={set('origem')} placeholder="Indicação, site, WhatsApp…" /></Field>
      <Field label="Observações"><textarea value={f.observacoes} onChange={set('observacoes')} rows={2} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || !f.nome || !digits} onClick={salvar}>{busy ? 'Salvando…' : 'Salvar'}</button>
      </div>
    </Modal>
  );
}
