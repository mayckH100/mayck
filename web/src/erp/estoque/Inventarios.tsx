/**
 * Inventário (v1.33.0): contagem por lote e local lendo o CÓDIGO DE BARRAS do produto (câmera do celular ou leitor;
 * cada leitura soma 1) ou a etiqueta do lote (código de barras GS1 ou QR), e digitando a quantidade. Ao encerrar:
 * relatório Físico x Sistema (quantidade e R$) e aviso ao proprietário se houver diferença. O estoque só muda
 * depois da aprovação com a senha do proprietário + motivo.
 */
import { useState } from 'react';
import { post } from '../../api';
import { ApiError } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Empty, Modal, Field, useAction, useToast, fmtDate } from '../../ui';
import { qtd, toMil, brl } from '../format';
import { qtdUn } from '../../../../server/erp/shared/unidade';
import { CampoLeitura } from './lotes';
import { imprimir } from '../impressao/cabecalho';
import { esc } from '../impressao/modelo';

const STATUS: Record<string, string> = { CONTANDO: 'Contando', EM_APROVACAO: 'Aguardando aprovação', CONCLUIDO: 'Concluído', CANCELADO: 'Cancelado' };

export default function Inventarios({ depositos, onAjustado }: { depositos: any[]; onAjustado: () => void }) {
  const lista = useApi<any[]>('/erp/estoque/inventarios');
  const [novo, setNovo] = useState(false); const [aberto, setAberto] = useState<string | null>(null);
  const [f, setF] = useState({ descricao: '', depositoId: '', cego: true });
  const { busy, run } = useAction();
  return (
    <>
      <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setNovo(true)}>+ Inventário</button>
      <Async state={lista}>{(d) => d.length === 0 ? <div className="card"><Empty title="Nenhum inventário">Abra um inventário para conferir o estoque físico.</Empty></div> : (
        <>{d.map((i) => (
          <div key={i.id} className="card row between" style={{ padding: 10, marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
            <div><b>{i.descricao}</b> {i.cego && <span className="badge">cego</span>}<div className="small muted">{STATUS[i.status] ?? i.status} · aberto {fmtDate(i.createdAt)}</div></div>
            <button className="btn sm primary" onClick={() => setAberto(i.id)}>Abrir</button>
          </div>
        ))}</>
      )}</Async>
      {novo && <Modal title="Novo inventário" onClose={() => setNovo(false)}>
        <Field label="Descrição"><input autoFocus value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} placeholder="Inventário geral novembro" /></Field>
        <Field label="Depósito"><select value={f.depositoId} onChange={(e) => setF({ ...f, depositoId: e.target.value })}><option value="">Todos</option>{depositos.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}</select></Field>
        <label className="row small"><input type="checkbox" checked={f.cego} onChange={(e) => setF({ ...f, cego: e.target.checked })} /> Contagem cega (quem conta não vê o saldo do sistema)</label>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || f.descricao.length < 2} onClick={async () => { const r = await run(() => post<any>('/erp/estoque/inventarios', { ...f, depositoId: f.depositoId || null }), 'Inventário aberto'); if (r) { setNovo(false); setAberto(r.id); lista.reload(); } }}>Abrir</button></div>
      </Modal>}
      {aberto && <Inventario id={aberto} depositos={depositos} onClose={() => { setAberto(null); lista.reload(); }} onAjustado={onAjustado} />}
    </>
  );
}

function Inventario({ id, depositos, onClose, onAjustado }: { id: string; depositos: any[]; onClose: () => void; onAjustado: () => void }) {
  const st = useApi<any>(`/erp/estoque/inventarios/${id}`, [id]);
  const [endereco, setEndereco] = useState('');
  const [manual, setManual] = useState({ codigo: '', qtd: '' });
  const [escolha, setEscolha] = useState<{ codigo: string; produto: any; lotes: any[]; modo: string; qtdMil?: number } | null>(null);
  const [loteFixo, setLoteFixo] = useState<Record<string, string>>({}); // produto → lote escolhido (as próximas leituras somam nele)
  const [ultimo, setUltimo] = useState<any>(null);
  const [relatorio, setRelatorio] = useState(false);
  const { busy, run } = useAction(); const toast = useToast(); const { can } = useAuth();
  const enderecos = depositos.flatMap((d) => d.enderecos.map((e: any) => ({ codigo: e.codigo, label: `${d.nome} · ${e.codigo}` })));

  async function contar(corpo: { codigo?: string; loteId?: string; qtdMil?: number; modo: 'LEITURA' | 'MANUAL' }): Promise<boolean> {
    if (!endereco) { toast('Escolha ou leia primeiro o endereço (local)', 'err'); return false; }
    try {
      const r = await post<any>(`/erp/estoque/inventarios/${id}/contar`, { endereco, ...corpo });
      setUltimo(r); st.reload();
      return true;
    } catch (e) {
      const det = e instanceof ApiError ? (e.details as any) : null;
      if (det?.escolherLote && corpo.codigo) {
        const fixo = det.produto && loteFixo[det.produto.id];
        if (fixo && det.escolherLote.some((l: any) => l.id === fixo)) return contar({ ...corpo, codigo: undefined, loteId: fixo });
        setEscolha({ codigo: corpo.codigo, produto: det.produto, lotes: det.escolherLote, modo: corpo.modo, qtdMil: corpo.qtdMil });
        return true;
      }
      toast((e as Error).message, 'err');
      return false;
    }
  }
  // Leitura: se o código for de um endereço, troca o local; senão conta 1 (código de barras do produto ou etiqueta do lote).
  async function lido(c: string) {
    const cod = c.trim().toUpperCase();
    if (enderecos.some((e) => e.codigo === cod)) { setEndereco(cod); toast(`Local: ${cod}`); return true; }
    return contar({ codigo: c, modo: 'LEITURA' });
  }

  return (
    <Modal title="Inventário" onClose={onClose}>
      <Async state={st}>{(inv) => (
        <>
          <p className="small" style={{ marginTop: 0 }}><b>{inv.descricao}</b> · {STATUS[inv.status] ?? inv.status}{inv.cego ? ' · cego' : ''}</p>
          {inv.status === 'CONTANDO' && <>
            <Field label="1. Local (endereço)"><select value={endereco} onChange={(e) => setEndereco(e.target.value)}><option value="">Escolha ou leia a etiqueta do local…</option>{enderecos.map((e) => <option key={e.codigo} value={e.codigo}>{e.label}</option>)}</select></Field>
            <div className="card" style={{ padding: 10, marginBottom: 8 }}>
              <div className="small" style={{ marginBottom: 4 }}><b>2. Ler código de barras</b> — câmera 📷 ou leitor. Cada leitura conta <b>1</b>. Aceita também a etiqueta do lote.</div>
              <CampoLeitura onCodigo={lido} placeholder="Código de barras do produto ou etiqueta do lote" />
              {ultimo && <div className="small" style={{ marginTop: 6, color: '#16a34a' }}>✔ {ultimo.produto?.nome} · lote {ultimo.lote} · {ultimo.endereco}: <b>{qtdUn(ultimo.contadoMil, ultimo.produto?.unidade)}</b>{ultimo.leituras ? ` (${ultimo.leituras} leitura${ultimo.leituras === 1 ? '' : 's'})` : ''}</div>}
            </div>
            <div className="card" style={{ padding: 10, marginBottom: 8 }}>
              <div className="small" style={{ marginBottom: 4 }}><b>Ou digite a quantidade contada</b> (substitui o que já foi contado neste lote e local)</div>
              <form className="row" style={{ gap: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (manual.codigo && manual.qtd !== '') contar({ codigo: manual.codigo, qtdMil: toMil(manual.qtd), modo: 'MANUAL' }).then(() => setManual({ codigo: '', qtd: '' })); }}>
                <input placeholder="Código, código de barras ou lote" value={manual.codigo} onChange={(e) => setManual({ ...manual, codigo: e.target.value })} style={{ flex: 2, minWidth: 140 }} aria-label="Código do produto ou lote" />
                <input placeholder="Qtd" value={manual.qtd} onChange={(e) => setManual({ ...manual, qtd: e.target.value })} style={{ width: 80 }} inputMode="decimal" aria-label="Quantidade" />
                <button className="btn primary">Gravar</button>
              </form>
            </div>
          </>}

          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {inv.status !== 'CONTANDO' && <button className="btn sm primary" onClick={() => setRelatorio(true)}>📊 Relatório Físico x Sistema</button>}
            <button className="btn sm" onClick={() => imprimirFolha(inv)}>🖨️ Folha de contagem</button>
          </div>
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            {inv.contagens.map((x: any) => (
              <div key={x.id} className="row between" style={{ borderTop: '1px solid #e5e7eb', padding: '6px 0', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}><b>{x.produto?.nome}</b><div className="small muted">cód. {x.produto?.sku} · lote {x.lote} · {x.endereco}{x.contadoPor ? ` · ${x.contadoPor}` : ''}</div></div>
                <div style={{ textAlign: 'right' }} className="small">
                  <div>Contado: <b>{x.contadoMil == null ? '—' : qtd(x.contadoMil)}</b>{x.leituras ? <span className="muted"> ({x.leituras} leit.)</span> : null}</div>
                  <div className="muted">Sistema: {x.sistemaMil == null ? '•••' : qtd(x.sistemaMil)}{x.diferencaMil ? <b style={{ color: x.diferencaMil < 0 ? '#dc2626' : '#16a34a' }}> · {x.diferencaMil > 0 ? '+' : ''}{qtd(x.diferencaMil)}</b> : null}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
            {inv.status === 'CONTANDO' && <button className="btn primary" disabled={busy} onClick={async () => { if (!confirm('Encerrar a contagem? O que não foi contado vale zero. O relatório sai na hora e, se houver diferença, o proprietário é avisado.')) return; if (await run(() => post(`/erp/estoque/inventarios/${id}/acao`, { acao: 'ENVIAR' }), 'Contagem encerrada')) { st.reload(); setRelatorio(true); } }}>Encerrar contagem</button>}
            {inv.status === 'EM_APROVACAO' && can('OWNER', 'ADMIN') && <button className="btn" onClick={async () => { if (await run(() => post(`/erp/estoque/inventarios/${id}/acao`, { acao: 'RECONTAR' }), 'Voltou para contagem')) st.reload(); }}>Recontar</button>}
            {['CONTANDO', 'EM_APROVACAO'].includes(inv.status) && can('OWNER', 'ADMIN') && <button className="btn ghost" onClick={async () => { if (confirm('Cancelar este inventário?') && await run(() => post(`/erp/estoque/inventarios/${id}/acao`, { acao: 'CANCELAR' }), 'Cancelado')) st.reload(); }}>Cancelar</button>}
          </div>
          {escolha && <Modal title="Qual lote você está contando?" onClose={() => setEscolha(null)}>
            <p className="small" style={{ marginTop: 0 }}>{escolha.produto?.nome} tem mais de um lote neste local. As próximas leituras deste produto vão para o lote escolhido.</p>
            {escolha.lotes.map((l) => <button key={l.id} className="btn" style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left' }} onClick={() => { if (escolha.produto) setLoteFixo({ ...loteFixo, [escolha.produto.id]: l.id }); const e = escolha; setEscolha(null); contar({ loteId: l.id, qtdMil: e.qtdMil, modo: e.modo as 'LEITURA' | 'MANUAL' }); }}><b>Lote {l.numero}</b>{l.loteFornecedor ? ` · fornecedor ${l.loteFornecedor}` : ''}{l.validade ? ` · vence ${String(l.validade).slice(0, 10).split('-').reverse().join('/')}` : ''}</button>)}
          </Modal>}
          {relatorio && <Relatorio id={id} status={inv.status} onClose={() => setRelatorio(false)} onAprovado={() => { setRelatorio(false); st.reload(); onAjustado(); }} />}
        </>
      )}</Async>
    </Modal>
  );
}

/** Relatório Físico x Sistema + aprovação com a senha do proprietário. */
function Relatorio({ id, status, onClose, onAprovado }: { id: string; status: string; onClose: () => void; onAprovado: () => void }) {
  const st = useApi<any>(`/erp/estoque/inventarios/${id}/relatorio`, [id, status]);
  const [so, setSo] = useState(true);
  const [motivo, setMotivo] = useState(''); const [senha, setSenha] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title="Físico x Sistema" onClose={onClose}>
      <Async state={st}>{(r) => {
        const t = r.totais; const linhas = so ? r.linhas.filter((l: any) => l.diferencaMil) : r.linhas;
        return (
          <>
            <div className="grid g2" style={{ gap: 6, marginBottom: 8 }}>
              <div className="card stat"><div className="l">Itens com diferença</div><div className="v">{t.divergentes} de {t.linhas}</div></div>
              <div className="card stat"><div className="l">Valor líquido</div><div className="v" style={{ color: t.liquidoCents < 0 ? '#dc2626' : '#16a34a' }}>{brl(t.liquidoCents)}</div></div>
              <div className="card stat"><div className="l">Sobras</div><div className="v" style={{ color: '#16a34a' }}>{brl(t.sobrasCents)}</div><div className="small muted">{t.sobras} item(ns)</div></div>
              <div className="card stat"><div className="l">Faltas</div><div className="v" style={{ color: '#dc2626' }}>{brl(t.faltasCents)}</div><div className="small muted">{t.faltas} item(ns)</div></div>
            </div>
            <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
              <label className="row small"><input type="checkbox" checked={so} onChange={(e) => setSo(e.target.checked)} /> Só o que tem diferença</label>
              <a className="btn sm" href={`/api/erp/estoque/inventarios/${id}/relatorio?formato=csv`}>⬇️ Planilha (CSV)</a>
            </div>
            <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 6 }}>
              {linhas.length === 0 ? <div className="small muted">Nenhuma diferença: o físico bate com o sistema.</div> : linhas.map((l: any) => (
                <div key={l.id} style={{ borderTop: '1px solid #e5e7eb', padding: '6px 0' }}>
                  <div><b>{l.nome}</b> <span className="small muted">cód. {l.sku}</span></div>
                  <div className="small muted">Lote {l.lote}{l.loteFornecedor ? ` (fornecedor ${l.loteFornecedor})` : ''} · {l.local}</div>
                  <div className="small">Contado <b>{qtdUn(l.contadoFinalMil, l.unidade)}</b> · Sistema {qtdUn(l.sistemaMil, l.unidade)} · Diferença <b style={{ color: l.diferencaMil < 0 ? '#dc2626' : l.diferencaMil > 0 ? '#16a34a' : undefined }}>{l.diferencaMil > 0 ? '+' : ''}{qtdUn(l.diferencaMil, l.unidade)} ({brl(l.diferencaCents)})</b></div>
                </div>
              ))}
            </div>
            {r.inventario.status === 'EM_APROVACAO' && t.divergentes > 0 && <div className="card" style={{ marginTop: 10, padding: 10, borderLeft: '4px solid #f59e0b' }}>
              <b>Aprovar e ajustar o estoque</b>
              <div className="small muted">Cada diferença vira um movimento de inventário no lote e local. Precisa da senha do proprietário.</div>
              <Field label="Motivo *"><input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: inventário geral de novembro conferido" /></Field>
              <Field label="Senha do proprietário *"><input type="password" autoComplete="off" value={senha} onChange={(e) => setSenha(e.target.value)} /></Field>
              <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy || motivo.trim().length < 3 || !senha} onClick={async () => { if (await run(() => post(`/erp/estoque/inventarios/${id}/acao`, { acao: 'APROVAR', motivo, senhaProprietario: senha }), 'Estoque ajustado')) onAprovado(); else setSenha(''); }}>Aprovar ajuste ({brl(t.liquidoCents)})</button></div>
            </div>}
            {r.inventario.status === 'EM_APROVACAO' && t.divergentes === 0 && <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn primary" disabled={busy} onClick={async () => { if (await run(() => post(`/erp/estoque/inventarios/${id}/acao`, { acao: 'APROVAR', motivo: 'Sem diferença', senhaProprietario: senha }), 'Inventário concluído')) onAprovado(); }}>Concluir</button></div>}
            {r.inventario.motivoAjuste && <p className="small muted">Aprovado com o motivo: {r.inventario.motivoAjuste}</p>}
          </>
        );
      }}</Async>
    </Modal>
  );
}

/**
 * v1.54.0: folha de contagem (papel/PDF) por local, com o cabeçalho da empresa e o rodapé da MCK. Em inventário cego o
 * saldo do sistema não sai (o servidor já não manda). Linhas em branco no fim para itens achados fora da lista.
 */
function imprimirFolha(inv: any) {
  const linhas = [...inv.contagens].sort((a: any, b: any) => String(a.endereco ?? '').localeCompare(String(b.endereco ?? '')) || String(a.produto?.nome ?? '').localeCompare(String(b.produto?.nome ?? '')));
  const mostraSistema = !inv.cego && linhas.some((x: any) => x.sistemaMil != null);
  imprimir(() => ({
    titulo: `Folha de contagem · ${inv.descricao}`,
    corpo: `<h2>Folha de contagem · ${esc(inv.descricao)}</h2><div class="small">${esc(STATUS[inv.status] ?? inv.status)}${inv.cego ? ' · contagem cega' : ''} · aberto em ${esc(fmtDate(inv.createdAt))} · ${linhas.length} linha(s)</div>
      <table><thead><tr><th>Local</th><th>Código</th><th>Produto</th><th>Lote</th>${mostraSistema ? '<th class="dir">Sistema</th>' : ''}<th style="width:22%">Contado</th></tr></thead><tbody>${linhas.map((x: any) => `<tr><td><b>${esc(x.endereco ?? '—')}</b></td><td>${esc(x.produto?.sku ?? '')}</td><td>${esc(x.produto?.nome ?? '')}</td><td>${esc(x.lote ?? '—')}</td>${mostraSistema ? `<td class="dir">${x.sistemaMil == null ? '' : esc(qtd(x.sistemaMil))}</td>` : ''}<td style="border-bottom:1px solid #000">&nbsp;</td></tr>`).join('')}${`<tr><td>&nbsp;</td><td></td><td></td><td></td>${mostraSistema ? '<td></td>' : ''}<td style="border-bottom:1px solid #000"></td></tr>`.repeat(6)}</tbody></table>
      <p style="margin-top:28px">Contado por: ____________________ &nbsp; Data: ___/___/______ &nbsp; Conferido por: ____________________</p>`,
  })).catch((e) => alert((e as Error).message));
}
