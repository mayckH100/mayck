/**
 * Alertas diários do ERP por WhatsApp para a administração (v1.30.0): contas a pagar, estoque baixo com sugestão de
 * compra (e aprovação respondendo "APROVADO"), validade dos lotes, produtos parados, caixa e alterações de ontem.
 */
import { useState } from 'react';
import { get, post, put } from '../../api';
import { useApi, Async, Field, useAction } from '../../ui';
import { brl } from '../format';

const SITUACAO: Record<string, string> = {
  PENDENTE: 'Aguardando resposta', PROCESSANDO: 'Gerando pedido', AGUARDANDO_FORNECEDOR: 'Perguntando o fornecedor', CONCLUIDA: 'Aprovada',
  RECUSADA: 'Recusada', SUBSTITUIDA: 'Trocada pelo alerta seguinte', EXPIRADA: 'Venceu (48 h)',
};

export default function Alertas() {
  const st = useApi<any>('/erp/alertas');
  return (
    <>
      <div className="page-head"><div><h1>Alertas por WhatsApp</h1><p className="muted">Um resumo por dia no seu WhatsApp, com seções numeradas e ações sugeridas: contas vencendo, estoque baixo (com sugestão de compra), validade, produtos parados, caixa e alterações de ontem.</p></div></div>
      <Async state={st}>{(c) => <Form inicial={c} onSaved={st.reload} />}</Async>
      <Aprovacoes />
    </>
  );
}

function Form({ inicial, onSaved }: { inicial: any; onSaved: () => void }) {
  const [f, setF] = useState<any>({ ...inicial, telefones: inicial.telefones.length ? inicial.telefones : [''] });
  const [op, setOp] = useState<any>(inicial.opcoes ?? {});
  const [previa, setPrevia] = useState<string[] | null>(null);
  const { busy, run } = useAction();
  const num = (k: string) => (e: any) => setF({ ...f, [k]: Number(e.target.value) || 0 });
  const chk = (k: string) => (e: any) => setF({ ...f, [k]: e.target.checked });
  const opChk = (k: string) => (e: any) => setOp({ ...op, [k]: e.target.checked });
  const opNum = (k: string) => (e: any) => setOp({ ...op, [k]: Number(e.target.value) || 0 });
  const salvar = () => run(() => put('/erp/alertas', {
    alertaAtivo: f.alertaAtivo, telefones: f.telefones.filter((t: string) => t.trim()), alertaHora: f.alertaHora, alertaDiasAntes: f.alertaDiasAntes,
    alertaPagar: f.alertaPagar, alertaEstoqueMinimo: f.alertaEstoqueMinimo, alertaSemSaidaDias: f.alertaSemSaidaDias,
    opcoes: { validade: !!op.validade, validadeDias: op.validadeDias || 30, caixa: !!op.caixa, alteracoes: !!op.alteracoes, compraWhatsapp: !!op.compraWhatsapp, consumoDias: op.consumoDias || 30, coberturaDias: op.coberturaDias || 30 },
  }), 'Alertas salvos');
  const mini = { width: 64 };
  return (
    <div className="card">
      <label className="row"><input type="checkbox" checked={f.alertaAtivo} onChange={chk('alertaAtivo')} /> <strong>Receber alertas por WhatsApp</strong></label>
      <Field label="Números que recebem" hint="Seu celular pessoal, com DDD. Não use o número do WhatsApp conectado no MCKBOT: ele envia o alerta. Estes números (e o celular do proprietário) podem aprovar compras respondendo ao alerta.">
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
      <label className="row"><input type="checkbox" checked={f.alertaPagar} onChange={chk('alertaPagar')} /> 💰 Contas a pagar vencidas e que vencem em até <input type="number" min={0} max={30} value={f.alertaDiasAntes} onChange={num('alertaDiasAntes')} style={mini} aria-label="Dias antes" /> dias</label>
      <label className="row"><input type="checkbox" checked={f.alertaEstoqueMinimo} onChange={chk('alertaEstoqueMinimo')} /> 📦 Estoque baixo (abaixo do mínimo), com sugestão de compra</label>
      {f.alertaEstoqueMinimo && (
        <div style={{ marginLeft: 26 }}>
          <p className="small muted" style={{ margin: '4px 0' }}>Sugestão = o suficiente para cobrir os dias abaixo pelo consumo médio, mais o estoque mínimo (respeita prazo e lote mínimo do produto). Mostra o último fornecedor e o último custo.</p>
          <label className="row small">Consumo médio dos últimos <input type="number" min={7} max={180} value={op.consumoDias ?? 30} onChange={opNum('consumoDias')} style={mini} aria-label="Dias de consumo" /> dias · comprar para <input type="number" min={1} max={180} value={op.coberturaDias ?? 30} onChange={opNum('coberturaDias')} style={mini} aria-label="Dias de cobertura" /> dias</label>
          <label className="row small"><input type="checkbox" checked={!!op.compraWhatsapp} onChange={opChk('compraWhatsapp')} /> Aprovar a compra pelo WhatsApp: responder <strong>APROVADO</strong> (ou <strong>APROVADO 1,3</strong>) gera o pedido de compra em rascunho, um por fornecedor. Nada é enviado ao fornecedor.</label>
        </div>
      )}
      <label className="row"><input type="checkbox" checked={!!op.validade} onChange={opChk('validade')} /> ⏳ Lotes vencidos e que vencem em até <input type="number" min={1} max={365} value={op.validadeDias ?? 30} onChange={opNum('validadeDias')} style={mini} aria-label="Dias de validade" /> dias (quantidade e valor a custo)</label>
      <label className="row"><input type="checkbox" checked={f.alertaSemSaidaDias > 0} onChange={(e) => setF({ ...f, alertaSemSaidaDias: e.target.checked ? 15 : 0 })} /> 💤 Produtos parados: sem saída há {f.alertaSemSaidaDias > 0 ? <input type="number" min={1} max={365} value={f.alertaSemSaidaDias} onChange={num('alertaSemSaidaDias')} style={mini} aria-label="Dias sem saída" /> : '15'} dias ou mais (valor parado a custo)</label>
      <label className="row"><input type="checkbox" checked={!!op.caixa} onChange={opChk('caixa')} /> 🧾 Caixa de ontem: abertura, vendas por forma de pagamento, retiradas/reforços, diferença no fechamento e quem fez</label>
      <label className="row"><input type="checkbox" checked={!!op.alteracoes} onChange={opChk('alteracoes')} /> ✏️ Alterações de ontem: preço, custo e ajustes manuais de estoque, com quem e quando</label>

      {inicial.status && <p className="small" style={{ color: inicial.status.ok ? undefined : '#b45309' }}>Último envio: {new Date(inicial.status.at).toLocaleString('pt-BR')} — {inicial.status.detail}</p>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} onClick={async () => { if (await salvar()) { const r = await run(() => get<any>('/erp/alertas/previa')); if (r) setPrevia(r.partes?.length ? r.partes : ['Nada para avisar hoje.']); } }}>Salvar e ver prévia</button>
        <button className="btn" disabled={busy} onClick={async () => { if (await salvar()) { const r = await run(() => post<any>('/erp/alertas/enviar-agora')); if (r) { alert(r.ok ? `Alerta enviado${r.partes > 1 ? ` em ${r.partes} mensagens` : ''}.${r.codigo ? ` Código de compra: ${r.codigo}.` : ''}` : `Não foi enviado: ${r.detail}`); onSaved(); } } }}>Salvar e enviar agora</button>
        <button className="btn primary" disabled={busy} onClick={async () => { if (await salvar()) onSaved(); }}>Salvar</button>
      </div>
      {previa && previa.map((p, i) => (
        <pre key={i} className="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-soft, #f6f6f6)', padding: 10, borderRadius: 8, marginTop: 10 }}>{previa.length > 1 ? `Mensagem ${i + 1} de ${previa.length}\n\n` : ''}{p}</pre>
      ))}
    </div>
  );
}

function Aprovacoes() {
  const st = useApi<any[]>('/erp/alertas/aprovacoes');
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Compras aprovadas pelo WhatsApp</h3>
      <Async state={st}>{(l) => !l.length ? <p className="muted small">Nenhuma ainda. Quando o alerta trouxer itens com estoque baixo, responda APROVADO no WhatsApp.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Código</th><th>Alerta</th><th>Itens</th><th>Situação</th><th>Quem respondeu</th><th>Gerado</th></tr></thead>
          <tbody>{l.map((a) => (
            <tr key={a.codigo}>
              <td><strong>{a.codigo}</strong></td>
              <td>{a.dia.split('-').reverse().join('/')}</td>
              <td>{a.itens}</td>
              <td>{SITUACAO[a.status] ?? a.status}</td>
              <td>{a.aprovadoPor ?? '—'}{a.aprovadoEm ? ` · ${new Date(a.aprovadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</td>
              <td>{a.documentos.length ? a.documentos.map((d: any) => `${d.tipo === 'pedido' ? `Pedido nº ${d.numero} (${d.fornecedor})` : `Solicitação nº ${d.numero}`}${d.totalCents ? ` ${brl(d.totalCents)}` : ''}`).join(' · ') : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}</Async>
    </div>
  );
}
