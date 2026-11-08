/** Alertas diários do ERP por WhatsApp para a administração: contas a pagar, estoque mínimo e produto parado. */
import { useState } from 'react';
import { get, post, put } from '../../api';
import { useApi, Async, Field, useAction } from '../../ui';

export default function Alertas() {
  const st = useApi<any>('/erp/alertas');
  return (
    <>
      <div className="page-head"><div><h1>Alertas por WhatsApp</h1><p className="muted">Um resumo por dia no seu WhatsApp: contas vencendo, estoque abaixo do mínimo e produtos parados.</p></div></div>
      <Async state={st}>{(c) => <Form inicial={c} onSaved={st.reload} />}</Async>
    </>
  );
}

function Form({ inicial, onSaved }: { inicial: any; onSaved: () => void }) {
  const [f, setF] = useState<any>({ ...inicial, telefones: inicial.telefones.length ? inicial.telefones : [''] });
  const [previa, setPrevia] = useState<string | null>(null);
  const { busy, run } = useAction();
  const num = (k: string) => (e: any) => setF({ ...f, [k]: Number(e.target.value) || 0 });
  const chk = (k: string) => (e: any) => setF({ ...f, [k]: e.target.checked });
  const salvar = () => run(() => put('/erp/alertas', { alertaAtivo: f.alertaAtivo, telefones: f.telefones.filter((t: string) => t.trim()), alertaHora: f.alertaHora, alertaDiasAntes: f.alertaDiasAntes, alertaPagar: f.alertaPagar, alertaEstoqueMinimo: f.alertaEstoqueMinimo, alertaSemSaidaDias: f.alertaSemSaidaDias }), 'Alertas salvos');
  return (
    <div className="card">
      <label className="row"><input type="checkbox" checked={f.alertaAtivo} onChange={chk('alertaAtivo')} /> <strong>Receber alertas por WhatsApp</strong></label>
      <Field label="Números que recebem" hint="Seu celular pessoal, com DDD. Não use o número do WhatsApp conectado no MCKBOT: ele envia o alerta.">
        <>
          {f.telefones.map((t: string, i: number) => (
            <div className="row" key={i} style={{ marginBottom: 4 }}>
              <input value={t} placeholder="11 99999-9999" inputMode="tel" onChange={(e) => setF({ ...f, telefones: f.telefones.map((x: string, j: number) => (j === i ? e.target.value : x)) })} aria-label={`Número ${i + 1}`} />
              {f.telefones.length > 1 && <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, telefones: f.telefones.filter((_: string, j: number) => j !== i) })} aria-label="Remover número">✕</button>}
            </div>
          ))}
          {f.telefones.length < 5 && <button type="button" className="btn sm" onClick={() => setF({ ...f, telefones: [...f.telefones, ''] })}>+ Adicionar número</button>}
        </>
      </Field>
      <div className="grid g2">
        <Field label="Horário do envio"><select value={f.alertaHora} onChange={num('alertaHora')}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</select></Field>
      </div>
      <h3 style={{ marginTop: 14 }}>O que avisar</h3>
      <label className="row"><input type="checkbox" checked={f.alertaPagar} onChange={chk('alertaPagar')} /> Contas a pagar vencidas e que vencem em até <input type="number" min={0} max={30} value={f.alertaDiasAntes} onChange={num('alertaDiasAntes')} style={{ width: 60 }} aria-label="Dias antes" /> dias (fornecedores e contas da empresa separados)</label>
      <label className="row"><input type="checkbox" checked={f.alertaEstoqueMinimo} onChange={chk('alertaEstoqueMinimo')} /> Produtos abaixo do estoque mínimo</label>
      <label className="row"><input type="checkbox" checked={f.alertaSemSaidaDias > 0} onChange={(e) => setF({ ...f, alertaSemSaidaDias: e.target.checked ? 15 : 0 })} /> Produtos sem saída há {f.alertaSemSaidaDias > 0 ? <input type="number" min={1} max={365} value={f.alertaSemSaidaDias} onChange={num('alertaSemSaidaDias')} style={{ width: 60 }} aria-label="Dias sem saída" /> : 'N'} dias</label>
      {inicial.status && <p className="small" style={{ color: inicial.status.ok ? undefined : '#b45309' }}>Último envio: {new Date(inicial.status.at).toLocaleString('pt-BR')} — {inicial.status.detail}</p>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
        <button className="btn" disabled={busy} onClick={async () => { const r = await run(() => get<any>('/erp/alertas/previa')); if (r) setPrevia(r.texto ?? 'Nada para avisar hoje.'); }}>Ver prévia</button>
        <button className="btn" disabled={busy} onClick={async () => { if (await salvar()) { const r = await run(() => post<any>('/erp/alertas/enviar-agora')); if (r) { alert(r.ok ? 'Alerta enviado.' : `Não foi enviado: ${r.detail}`); onSaved(); } } }}>Salvar e enviar teste</button>
        <button className="btn primary" disabled={busy} onClick={async () => { if (await salvar()) onSaved(); }}>Salvar</button>
      </div>
      {previa && <pre className="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-soft, #f6f6f6)', padding: 10, borderRadius: 8, marginTop: 10 }}>{previa}</pre>}
    </div>
  );
}
