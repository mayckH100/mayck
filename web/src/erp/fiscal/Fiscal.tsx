/** Fiscal: NF-e emitidas (transmitir, refazer, cancelar, XML, DANFE), emitente + certificado A1 e regras de tributação. */
import { useState } from 'react';
import JsBarcode from 'jsbarcode';
import { get, post, put, del } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, useToast, fmtDate } from '../../ui';
import ErpNav from '../ErpNav';
import { brl } from '../format';
import { BuscaProduto } from '../comum';

const ST: Record<string, string> = { ASSINADA: 'Assinada (não transmitida)', AUTORIZADA: 'Autorizada', REJEITADA: 'Rejeitada', CANCELADA: 'Cancelada' };
const chaveFmt = (c: string) => c.replace(/(\d{4})/g, '$1 ').trim();

export default function Fiscal() {
  const [aba, setAba] = useState<'nfe' | 'cfg' | 'regras'>('nfe');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Fiscal</h1><p className="muted">NF-e emitida com o certificado A1 da própria empresa, direto na SEFAZ. Comece em homologação.</p></div></div>
      <ErpNav />
      <div className="row" style={{ marginBottom: 10 }}>{([['nfe', 'NF-e emitidas'], ['cfg', 'Emitente e certificado'], ['regras', 'Regras de tributação']] as const).map(([a, l]) => <button key={a} className={`btn sm ${aba === a ? 'primary' : ''}`} onClick={() => setAba(a)}>{l}</button>)}</div>
      {aba === 'nfe' && <ListaNfe />}
      {aba === 'cfg' && <Config />}
      {aba === 'regras' && <Regras />}
    </div>
  );
}

export async function imprimirDanfe(id: string) {
  const d = await get<any>(`/erp/fiscal/nfe/${id}/danfe`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  JsBarcode(svg, d.chave, { format: 'CODE128C', displayValue: false, height: 50, width: 1.2, margin: 0 });
  const doc = new DOMParser().parseFromString(d.xml, 'application/xml');
  const tx = (el: Element | Document, t: string) => el.getElementsByTagName(t)[0]?.textContent ?? '';
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const itens = Array.from(doc.getElementsByTagName('det')).map((det) => `<tr><td>${esc(tx(det, 'cProd'))}</td><td>${esc(tx(det, 'xProd'))}</td><td>${tx(det, 'NCM')}</td><td>${tx(det, 'CFOP')}</td><td>${tx(det, 'uCom')}</td><td>${Number(tx(det, 'qCom')).toLocaleString('pt-BR')}</td><td>${Number(tx(det, 'vUnCom')).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td><td>${Number(tx(det, 'vProd')).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td></tr>`).join('');
  const v = (t: string) => Number(tx(doc.getElementsByTagName('ICMSTot')[0] ?? doc, t) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const w = window.open('', '_blank', 'width=900,height=1000'); if (!w) return;
  w.document.write(`<!doctype html><html><head><title>DANFE ${d.numero}</title><style>body{font-family:Arial;font-size:11px;margin:16px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #000;padding:3px;vertical-align:top}.h{font-size:9px;color:#333}h2{margin:0}</style></head><body>
  ${d.ambiente === 2 ? '<p style="color:#c00;font-weight:bold">AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL</p>' : ''}${d.status === 'CANCELADA' ? '<p style="color:#c00;font-weight:bold">NF-e CANCELADA</p>' : ''}
  <table><tr><td style="width:45%"><h2>${esc(d.emitente.razaoSocial)}</h2>${esc(d.emitente.logradouro)}, ${esc(d.emitente.numero)} · ${esc(d.emitente.bairro)}<br>${esc(d.emitente.municipio)}/${d.emitente.uf} · CEP ${d.emitente.cep}</td>
  <td style="text-align:center"><h2>DANFE</h2>Documento Auxiliar da Nota Fiscal Eletrônica<br>1 - SAÍDA<br><b>Nº ${d.numero} · Série ${d.serie}</b></td>
  <td>${svg.outerHTML}<div class="h">CHAVE DE ACESSO</div><b>${chaveFmt(d.chave)}</b><div class="h">Consulta de autenticidade no portal nacional da NF-e (www.nfe.fazenda.gov.br/portal)</div></td></tr>
  <tr><td colspan="2"><span class="h">NATUREZA DA OPERAÇÃO</span><br>${esc(tx(doc, 'natOp'))}</td><td><span class="h">PROTOCOLO DE AUTORIZAÇÃO</span><br>${d.protocolo ?? 'NÃO AUTORIZADA'} ${d.autorizadaEm ? new Date(d.autorizadaEm).toLocaleString('pt-BR') : ''}</td></tr>
  <tr><td><span class="h">INSCRIÇÃO ESTADUAL</span><br>${d.emitente.ie}</td><td colspan="2"><span class="h">CNPJ</span><br>${d.emitente.cnpj}</td></tr></table>
  <p><b>DESTINATÁRIO</b></p><table><tr><td>${esc(d.destinatario?.nome ?? '')}</td><td>CNPJ/CPF ${d.destinatario?.documento ?? ''}</td><td>IE ${d.destinatario?.inscricaoEstadual ?? ''}</td></tr><tr><td colspan="2">${esc([d.destinatario?.logradouro, d.destinatario?.numero, d.destinatario?.bairro].filter(Boolean).join(', '))}</td><td>${esc(d.destinatario?.municipio ?? '')}/${d.destinatario?.uf ?? ''}</td></tr></table>
  <p><b>CÁLCULO DO IMPOSTO</b></p><table><tr><td><span class="h">BASE ICMS</span><br>${v('vBC')}</td><td><span class="h">VALOR ICMS</span><br>${v('vICMS')}</td><td><span class="h">VALOR PRODUTOS</span><br>${v('vProd')}</td><td><span class="h">FRETE</span><br>${v('vFrete')}</td><td><span class="h">DESCONTO</span><br>${v('vDesc')}</td><td><span class="h">IPI</span><br>${v('vIPI')}</td><td><span class="h">VALOR TOTAL DA NOTA</span><br><b>${v('vNF')}</b></td></tr></table>
  <p><b>DADOS DOS PRODUTOS</b></p><table><tr><th>Código</th><th>Descrição</th><th>NCM</th><th>CFOP</th><th>Un</th><th>Qtd</th><th>V. unit.</th><th>V. total</th></tr>${itens}</table>
  <p><b>DADOS ADICIONAIS</b></p><table><tr><td>${esc(tx(doc, 'infCpl'))}</td></tr></table></body></html>`);
  w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 400);
}

/** Ações da NF-e (usado na lista e no pedido). */
function useAcoesNfe(reload: () => void) {
  const { busy, run } = useAction(); const toast = useToast();
  const transmitir = async (id: string) => { const r = await run(() => post<any>(`/erp/fiscal/nfe/${id}/transmitir`, {})); if (r) { toast(r.status === 'AUTORIZADA' ? `Autorizada · protocolo ${r.protocolo}` : `${r.cStat ?? ''} ${r.motivo ?? 'Sem resposta'}`, r.status === 'AUTORIZADA' ? undefined : 'err'); reload(); } return r; };
  const regerar = async (id: string) => { if (await run(() => post(`/erp/fiscal/nfe/${id}/regerar`, {}), 'NF-e refeita e assinada')) reload(); };
  const cancelar = async (id: string) => { const j = prompt('Justificativa do cancelamento (mínimo 15 caracteres)'); if (j && await run(() => post(`/erp/fiscal/nfe/${id}/cancelar`, { justificativa: j }), 'NF-e cancelada')) reload(); };
  const baixarXml = async (n: any) => { const r = await fetch(`/api/erp/fiscal/nfe/${n.id}/xml`, { credentials: 'include' }); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${n.chave}-nfe.xml`; a.click(); };
  return { busy, transmitir, regerar, cancelar, baixarXml };
}

function BotoesNfe({ n, a, gestor }: { n: any; a: ReturnType<typeof useAcoesNfe>; gestor: boolean }) {
  return <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
    {n.status === 'ASSINADA' && <button className="btn sm primary" disabled={a.busy} onClick={() => a.transmitir(n.id)}>Transmitir à SEFAZ</button>}
    {n.status === 'REJEITADA' && <button className="btn sm" disabled={a.busy} onClick={() => a.regerar(n.id)}>Refazer após corrigir</button>}
    {n.status === 'AUTORIZADA' && gestor && <button className="btn sm ghost" disabled={a.busy} onClick={() => a.cancelar(n.id)}>Cancelar</button>}
    <button className="btn sm ghost" onClick={() => imprimirDanfe(n.id)}>DANFE</button>
    <button className="btn sm ghost" onClick={() => a.baixarXml(n)}>XML</button>
  </span>;
}

function ListaNfe() {
  const l = useApi<any[]>('/erp/fiscal/nfe'); const a = useAcoesNfe(() => l.reload()); const { can } = useAuth();
  return <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhuma NF-e emitida">Emita pelo pedido de venda, depois da conferência.</Empty></div> : (
    <div className="card table-wrap"><table><thead><tr><th>Nº</th><th>Destinatário</th><th>Total</th><th>Status</th><th>Emitida</th><th></th></tr></thead>
      <tbody>{d.map((n) => <tr key={n.id}><td>{n.numero}/{n.serie}{n.ambiente === 2 && <span className="badge">homolog.</span>}</td><td>{n.destinatario}</td><td>{brl(n.totalCents)}</td><td>{ST[n.status] ?? n.status}{n.motivo && n.status !== 'AUTORIZADA' && <div className="small muted">{n.cStat} {n.motivo}</div>}</td><td>{fmtDate(n.createdAt)}</td><td><BotoesNfe n={n} a={a} gestor={can('OWNER', 'ADMIN')} /></td></tr>)}</tbody></table></div>
  )}</Async>;
}

/** Bloco da NF-e dentro do pedido: emitir, transmitir e faturar com o número autorizado. */
export function NfeDoPedido({ pedido, onFaturar }: { pedido: any; onFaturar: (nfNumero: string) => void }) {
  const l = useApi<any[]>(`/erp/fiscal/nfe?pedidoId=${pedido.id}`, [pedido.id, pedido.statusOperacional]);
  const a = useAcoesNfe(() => l.reload()); const { busy, run } = useAction(); const { can } = useAuth();
  if (pedido.statusOperacional !== 'SEPARADO' && !(l.data ?? []).length) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3>Nota fiscal</h3>
      <Async state={l}>{(d) => {
        const viva = d.find((n) => n.status !== 'CANCELADA');
        return <>
          {d.map((n) => <div key={n.id} className="row between small" style={{ flexWrap: 'wrap' }}><span>NF-e {n.numero}/{n.serie} · {ST[n.status]}{n.motivo && n.status === 'REJEITADA' ? ` · ${n.cStat} ${n.motivo}` : ''}</span><BotoesNfe n={n} a={a} gestor={can('OWNER', 'ADMIN')} /></div>)}
          {pedido.statusOperacional === 'SEPARADO' && !viva && <button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => post('/erp/fiscal/nfe/pedido/' + pedido.id, {}), 'NF-e montada e assinada')) l.reload(); }}>Emitir NF-e</button>}
          {pedido.statusOperacional === 'SEPARADO' && viva?.status === 'AUTORIZADA' && <button className="btn primary" style={{ marginTop: 6 }} onClick={() => onFaturar(String(viva.numero))}>Faturar com a NF-e {viva.numero}</button>}
        </>;
      }}</Async>
    </div>
  );
}

function Config() {
  const st = useApi<any>('/erp/fiscal/config');
  const [f, setF] = useState<any>(null); const [senha, setSenha] = useState(''); const [arq, setArq] = useState<File | null>(null);
  const { busy, run } = useAction(); const toast = useToast(); const { can } = useAuth();
  return <Async state={st}>{(c) => {
    const v = f ?? { razaoSocial: c.razaoSocial, fantasia: c.fantasia ?? '', cnpj: c.cnpj, ie: c.ie, crt: c.crt, uf: c.uf, codMunicipio: c.codMunicipio, municipio: c.municipio, logradouro: c.logradouro, numero: c.numero, bairro: c.bairro, cep: c.cep, fone: c.fone ?? '', ambiente: c.ambiente, serie: c.serie, proximoNumero: c.proximoNumero };
    const set = (k: string) => (e: any) => setF({ ...v, [k]: e.target.value });
    return <>
      <div className="card">
        <div className="grid g2">
          <Field label="Razão social"><input value={v.razaoSocial} onChange={set('razaoSocial')} /></Field>
          <Field label="Nome fantasia"><input value={v.fantasia} onChange={set('fantasia')} /></Field>
          <Field label="CNPJ"><input value={v.cnpj} onChange={set('cnpj')} /></Field>
          <Field label="Inscrição estadual"><input value={v.ie} onChange={set('ie')} /></Field>
          <Field label="Regime"><select value={v.crt} onChange={(e) => setF({ ...v, crt: Number(e.target.value) })}><option value={1}>Simples Nacional</option><option value={2}>Simples (excesso de sublimite)</option><option value={3}>Regime normal (Presumido/Real)</option></select></Field>
          <Field label="UF"><input value={v.uf} onChange={set('uf')} maxLength={2} /></Field>
          <Field label="Município"><input value={v.municipio} onChange={set('municipio')} /></Field>
          <Field label="Código IBGE do município" hint="7 dígitos (São Paulo: 3550308)"><input value={v.codMunicipio} onChange={set('codMunicipio')} /></Field>
          <Field label="Logradouro"><input value={v.logradouro} onChange={set('logradouro')} /></Field>
          <Field label="Número"><input value={v.numero} onChange={set('numero')} /></Field>
          <Field label="Bairro"><input value={v.bairro} onChange={set('bairro')} /></Field>
          <Field label="CEP"><input value={v.cep} onChange={set('cep')} /></Field>
          <Field label="Ambiente"><select value={v.ambiente} onChange={(e) => setF({ ...v, ambiente: Number(e.target.value) })}><option value={2}>Homologação (testes, sem valor)</option><option value={1}>Produção</option></select></Field>
          <Field label="Série"><input value={v.serie} onChange={(e) => setF({ ...v, serie: Number(e.target.value) || 1 })} inputMode="numeric" /></Field>
          <Field label="Próximo número"><input value={v.proximoNumero} onChange={(e) => setF({ ...v, proximoNumero: Number(e.target.value) || 1 })} inputMode="numeric" /></Field>
        </div>
        {can('OWNER', 'ADMIN') && <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={async () => { if (v.ambiente === 1 && c.ambiente !== 1 && !confirm('Mudar para PRODUÇÃO? As notas passam a ter valor fiscal.')) return; if (await run(() => put('/erp/fiscal/config', { ...v, fantasia: v.fantasia || null, fone: v.fone || null }), 'Dados salvos')) { setF(null); st.reload(); } }}>Salvar</button></div>}
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <h3>Certificado digital A1</h3>
        {c.temCertificado ? <p className="small">{c.certTitular} · vence em {new Date(c.certValidade).toLocaleDateString('pt-BR')}</p> : <p className="small muted">Nenhum certificado. Ele fica cifrado e só é usado para assinar e transmitir as notas desta empresa.</p>}
        {can('OWNER', 'ADMIN') && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input type="file" accept=".pfx,.p12" aria-label="Arquivo do certificado" onChange={(e) => setArq(e.target.files?.[0] ?? null)} />
          <input type="password" placeholder="Senha do certificado" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="off" />
          <button className="btn primary" disabled={busy || !arq || !senha} onClick={async () => {
            const buf = new Uint8Array(await arq!.arrayBuffer()); let bin = ''; buf.forEach((b) => (bin += String.fromCharCode(b)));
            if (await run(() => post('/erp/fiscal/certificado', { pfxBase64: btoa(bin), senha }), 'Certificado instalado')) { setSenha(''); setArq(null); st.reload(); }
          }}>Enviar certificado</button>
          {c.temCertificado && <><button className="btn ghost" disabled={busy} onClick={async () => { const r = await run(() => get<any>('/erp/fiscal/status-sefaz')); if (r) toast(`SEFAZ: ${r.cStat} ${r.motivo ?? ''}`); }}>Testar SEFAZ</button>
            <button className="btn ghost" disabled={busy} onClick={async () => { if (confirm('Remover o certificado?') && await run(() => del('/erp/fiscal/certificado'), 'Certificado removido')) st.reload(); }}>Remover</button></>}
        </div>}
      </div>
    </>;
  }}</Async>;
}

function Regras() {
  const l = useApi<any[]>('/erp/fiscal/regras');
  const [ed, setEd] = useState<any>(null); const { busy, run } = useAction(); const { can } = useAuth();
  const nova = { nome: '', produto: null, ncmPrefixo: '', cfopDentro: '5102', cfopFora: '6102', csosn: '102', cstIcms: '00', icms: '18', cstIpi: '53', ipi: '0', cstPis: '49', pis: '0', cstCofins: '49', cofins: '0' };
  const bp = (s: string) => Math.round(Number(String(s).replace(',', '.')) * 100) || 0;
  return <>
    {can('OWNER', 'ADMIN') && <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setEd(nova)}>+ Regra</button>}
    <Async state={l}>{(d) => d.length === 0 ? <div className="card"><Empty title="Usando a regra padrão">Sem regras, vale CFOP 5102/6102, Simples CSOSN 102 e PIS/COFINS 49. Crie a regra padrão da empresa e as exceções por NCM ou produto.</Empty></div> : (
      <div className="card table-wrap"><table><thead><tr><th>Regra</th><th>Aplica a</th><th>CFOP</th><th>ICMS</th><th>PIS/COFINS</th><th></th></tr></thead>
        <tbody>{d.map((r) => <tr key={r.id}><td>{r.nome}</td><td className="small">{r.produtoId ? 'produto' : r.ncmPrefixo ? `NCM ${r.ncmPrefixo}…` : 'padrão'}</td><td>{r.cfopDentro}/{r.cfopFora}</td><td>CSOSN {r.csosn} · CST {r.cstIcms} {r.aliqIcmsBp / 100}%</td><td>{r.cstPis}/{r.cstCofins}</td><td>{can('OWNER', 'ADMIN') && <button className="btn sm ghost" onClick={async () => { if (confirm('Excluir regra?') && await run(() => del(`/erp/fiscal/regras/${r.id}`), 'Excluída')) l.reload(); }}>Excluir</button>}</td></tr>)}</tbody></table></div>
    )}</Async>
    {ed && <Modal title="Regra de tributação" onClose={() => setEd(null)}>
      <Field label="Nome"><input value={ed.nome} onChange={(e) => setEd({ ...ed, nome: e.target.value })} placeholder="Padrão da empresa" /></Field>
      <div className="grid g2">
        <Field label="Só para o produto (opcional)">{ed.produto ? <div className="row between"><span>{ed.produto.sku}</span><button className="btn ghost sm" onClick={() => setEd({ ...ed, produto: null })}>✕</button></div> : <BuscaProduto onPick={(p) => setEd({ ...ed, produto: p })} />}</Field>
        <Field label="Ou NCM que começa com"><input value={ed.ncmPrefixo} onChange={(e) => setEd({ ...ed, ncmPrefixo: e.target.value })} /></Field>
        {(['cfopDentro', 'cfopFora', 'csosn', 'cstIcms', 'icms', 'cstIpi', 'ipi', 'cstPis', 'pis', 'cstCofins', 'cofins'] as const).map((k) => <Field key={k} label={{ cfopDentro: 'CFOP no estado', cfopFora: 'CFOP fora do estado', csosn: 'CSOSN (Simples)', cstIcms: 'CST ICMS (normal)', icms: 'Alíquota ICMS %', cstIpi: 'CST IPI', ipi: 'Alíquota IPI %', cstPis: 'CST PIS', pis: 'Alíquota PIS %', cstCofins: 'CST COFINS', cofins: 'Alíquota COFINS %' }[k]}><input value={ed[k]} onChange={(e) => setEd({ ...ed, [k]: e.target.value })} /></Field>)}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || ed.nome.length < 2} onClick={async () => { if (await run(() => post('/erp/fiscal/regras', { nome: ed.nome, produtoId: ed.produto?.id ?? null, ncmPrefixo: ed.ncmPrefixo || null, cfopDentro: ed.cfopDentro, cfopFora: ed.cfopFora, csosn: ed.csosn, cstIcms: ed.cstIcms, aliqIcmsBp: bp(ed.icms), cstIpi: ed.cstIpi, aliqIpiBp: bp(ed.ipi), cstPis: ed.cstPis, aliqPisBp: bp(ed.pis), cstCofins: ed.cstCofins, aliqCofinsBp: bp(ed.cofins) }), 'Regra salva')) { setEd(null); l.reload(); } }}>Salvar</button></div>
    </Modal>}
  </>;
}
