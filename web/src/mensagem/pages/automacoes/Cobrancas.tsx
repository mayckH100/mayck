import { useState } from 'react';
import { useApi, Async, Modal, Field, useAction, Empty, fmtNum } from '../../../ui';
import { post, patch, del, upload } from '../../../api';
import { useAuth } from '../../../auth';
import { Kpi } from '../Dashboard';
import {
  API, useReadOnly, BolBadge, EnvioBadge, OcBadge, BOL_STATUS, BOL_LABEL, brl, fmtYmd, fmtBytes, fmtDT, downloadUrl, CANAL_LABEL, ymdLocal,
  type Boleto, type Arquivo, type Cliente,
} from './shared';

// ---------------- Peças compartilhadas ----------------

/** Botão de envio de arquivo (valida no servidor: tipo real, tamanho, segurança). */
export function UploadButton({ label = 'Enviar arquivo', query = '', onDone, accept = '.pdf,.png,.jpg,.jpeg,.webp', small = true }: { label?: string; query?: string; onDone: (a: Arquivo) => void; accept?: string; small?: boolean }) {
  const { busy, run } = useAction();
  return (
    <label className={`btn ${small ? 'sm' : ''}`} style={{ cursor: busy ? 'wait' : 'pointer' }}>
      {busy ? 'Enviando…' : label}
      <input type="file" accept={accept} style={{ display: 'none' }} disabled={busy} onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) run(async () => onDone(await upload<Arquivo>(`${API}/arquivos${query}`, f)), 'Arquivo enviado');
      }} />
    </label>
  );
}

export function ArquivoLink({ id, nome }: { id: string; nome: string }) {
  const { can } = useAuth();
  return can('OWNER', 'ADMIN') ? <a href={downloadUrl(id)} title="Baixar (acesso autenticado)">{nome}</a> : <span>{nome}</span>;
}

function ClienteSelect({ value, onChange, allowEmpty = false, label = 'Cliente' }: { value: string; onChange: (id: string) => void; allowEmpty?: boolean; label?: string }) {
  const [q, setQ] = useState('');
  const list = useApi<{ items: Cliente[] }>(`${API}/clientes?pageSize=200${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  return (
    <Field label={label}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 140 }} />
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{allowEmpty ? 'Todos os clientes' : 'Escolha…'}</option>
          {list.data?.items.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.whatsapp ? ` — ${c.whatsapp}` : ''}</option>)}
        </select>
      </div>
    </Field>
  );
}

const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(/\./g, '').replace(',', '.')));

// ---------------- Boletos e faturas ----------------

export function Boletos() {
  const ro = useReadOnly();
  const [f, setF] = useState({ status: 'ABERTOS', clienteId: '', q: '', de: '', ate: '' });
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page) });
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
  const list = useApi<{ items: Boleto[]; total: number; pageSize: number }>(`${API}/boletos?${qs}`);
  const [edit, setEdit] = useState<Boleto | 'novo' | null>(null);
  const [lote, setLote] = useState(false);
  const [seq, setSeq] = useState(false);
  const [ver, setVer] = useState<string | null>(null);
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); setPage(1); };
  return (
    <div className="stack">
      <div className="row between">
        <p className="muted" style={{ margin: 0 }}>Cada boleto tem status financeiro próprio. Mensagem enviada não significa boleto pago: a baixa é feita por pagamento registrado ou comprovante aprovado.</p>
        {!ro && <div className="row">
          <button className="btn" onClick={() => setSeq(true)}>Nova sequência de cobrança</button>
          <button className="btn" onClick={() => setLote(true)}>Gerar parcelas</button>
          <button className="btn primary" onClick={() => setEdit('novo')}>+ Novo boleto</button>
        </div>}
      </div>
      <div className="row">
        <select value={f.status} onChange={set('status')} style={{ width: 'auto' }}>
          <option value="">Todos os status</option><option value="ABERTOS">Em aberto</option>{BOL_STATUS.map((s) => <option key={s} value={s}>{BOL_LABEL[s]}</option>)}
        </select>
        <input placeholder="Descrição, documento ou linha digitável" value={f.q} onChange={set('q')} style={{ maxWidth: 260 }} />
        <span className="small muted">Vencimento</span><input type="date" value={f.de} onChange={set('de')} style={{ width: 'auto' }} /> até <input type="date" value={f.ate} onChange={set('ate')} style={{ width: 'auto' }} />
      </div>
      <div className="card table-wrap">
        <Async state={list}>{(d) => d.items.length === 0 ? <Empty title="Nenhum boleto">Cadastre um boleto ou gere as parcelas de um cliente.</Empty> : (
          <>
            <table>
              <thead><tr><th>Vencimento</th><th>Cliente</th><th>Descrição</th><th>Valor</th><th>Saldo</th><th>Financeiro</th><th>Envio</th><th /></tr></thead>
              <tbody>{d.items.map((b) => (
                <tr key={b.id}>
                  <td className="small">{fmtYmd(b.vencimentoData)}{b.atrasado && <div style={{ color: 'var(--danger)' }}>em atraso</div>}</td>
                  <td>{b.cliente}</td>
                  <td><button className="btn ghost sm" style={{ padding: 0, textAlign: 'left' }} onClick={() => setVer(b.id)}><strong>{b.descricao}</strong></button>
                    <div className="small muted">{b.parcela ? `Parcela ${b.parcela}${b.totalParcelas ? `/${b.totalParcelas}` : ''}` : ''}{b.numeroDocumento ? ` · doc. ${b.numeroDocumento}` : ''}{b.arquivoId ? ' · PDF' : ''}</div></td>
                  <td className="small">{brl(b.devido)}</td><td className="small">{brl(b.saldo)}</td>
                  <td><BolBadge s={b.status} /></td><td><EnvioBadge s={b.statusEnvio} /></td>
                  <td><button className="btn sm" onClick={() => setVer(b.id)}>Abrir</button></td>
                </tr>
              ))}</tbody>
            </table>
            <div className="row between small muted" style={{ marginTop: 8 }}>
              <span>{fmtNum(d.total)} boleto(s)</span>
              <span className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button> Página {page}<button className="btn sm" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>›</button></span>
            </div>
          </>
        )}</Async>
      </div>
      {edit && <BoletoForm boleto={edit === 'novo' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {lote && <ParcelasForm onClose={() => setLote(false)} onSaved={() => { setLote(false); list.reload(); }} />}
      {seq && <SequenciaForm onClose={() => setSeq(false)} onSaved={() => { setSeq(false); list.reload(); }} />}
      {ver && <BoletoDetalhe id={ver} onClose={() => { setVer(null); list.reload(); }} onEdit={(b) => { setVer(null); setEdit(b); }} />}
    </div>
  );
}

function BoletoForm({ boleto, onClose, onSaved, clienteFixo }: { boleto: Boleto | null; onClose: () => void; onSaved: (b: any) => void; clienteFixo?: string }) {
  const { busy, run } = useAction();
  const travado = boleto && (boleto.status === 'PAGO' || boleto.status === 'CANCELADO');
  const c2 = (v: number | null | undefined) => (v == null ? '' : String(v / 100).replace('.', ','));
  const [f, setF] = useState(() => ({
    clienteId: boleto?.clienteId ?? clienteFixo ?? '', descricao: boleto?.descricao ?? '', numeroDocumento: boleto?.numeroDocumento ?? '',
    parcela: boleto?.parcela ? String(boleto.parcela) : '', totalParcelas: boleto?.totalParcelas ? String(boleto.totalParcelas) : '',
    valor: boleto ? String(boleto.valor).replace('.', ',') : '', valorAtualizado: c2(boleto?.valorAtualizadoCentavos), juros: c2(boleto?.jurosCentavos || null),
    multa: c2(boleto?.multaCentavos || null), desconto: c2(boleto?.descontoCentavos || null), emissao: boleto?.emissao?.slice(0, 10) ?? '', vencimento: boleto?.vencimentoData ?? '',
    codigoBarras: boleto?.codigoBarras ?? '', linhaDigitavel: boleto?.linhaDigitavel ?? '', linkPagamento: boleto?.linkPagamento ?? '', observacoes: boleto?.observacoes ?? '',
    arquivoId: boleto?.arquivoId ?? '', arquivoNome: boleto?.arquivoId ? 'PDF anexado' : '', rascunho: false,
  }));
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const salvar = () => run(async () => {
    const body: any = {
      descricao: f.descricao, numeroDocumento: f.numeroDocumento, parcela: f.parcela ? Number(f.parcela) : null, totalParcelas: f.totalParcelas ? Number(f.totalParcelas) : null,
      emissao: f.emissao || '', codigoBarras: f.codigoBarras, linhaDigitavel: f.linhaDigitavel, linkPagamento: f.linkPagamento, observacoes: f.observacoes, arquivoId: f.arquivoId || null,
    };
    if (!travado) Object.assign(body, { valor: num(f.valor), valorAtualizado: num(f.valorAtualizado), juros: num(f.juros), multa: num(f.multa), desconto: num(f.desconto), vencimento: f.vencimento });
    const r = boleto ? await patch(`${API}/boletos/${boleto.id}`, body) : await post(`${API}/boletos`, { ...body, clienteId: f.clienteId, rascunho: f.rascunho });
    onSaved(r);
  }, 'Boleto salvo');
  return (
    <Modal title={boleto ? 'Editar boleto' : 'Novo boleto'} onClose={onClose}>
      <div className="stack">
        {travado && <div className="alert warn small">Boleto {boleto!.statusLabel.toLowerCase()}: valores e vencimento não podem ser alterados.</div>}
        {!boleto && !clienteFixo && <ClienteSelect value={f.clienteId} onChange={(id) => setF({ ...f, clienteId: id })} />}
        <div className="grid g2">
          <Field label="Descrição da cobrança *"><input value={f.descricao} onChange={set('descricao')} placeholder="Mensalidade de novembro" /></Field>
          <Field label="Número do documento"><input value={f.numeroDocumento} onChange={set('numeroDocumento')} /></Field>
          <Field label="Parcela"><input type="number" min={1} value={f.parcela} onChange={set('parcela')} /></Field>
          <Field label="Total de parcelas"><input type="number" min={1} value={f.totalParcelas} onChange={set('totalParcelas')} /></Field>
          <Field label="Valor original (R$) *"><input inputMode="decimal" value={f.valor} onChange={set('valor')} disabled={!!travado} /></Field>
          <Field label="Valor atualizado (R$)" hint="opcional; substitui o original"><input inputMode="decimal" value={f.valorAtualizado} onChange={set('valorAtualizado')} disabled={!!travado} /></Field>
          <Field label="Juros (R$)"><input inputMode="decimal" value={f.juros} onChange={set('juros')} disabled={!!travado} /></Field>
          <Field label="Multa (R$)"><input inputMode="decimal" value={f.multa} onChange={set('multa')} disabled={!!travado} /></Field>
          <Field label="Desconto (R$)"><input inputMode="decimal" value={f.desconto} onChange={set('desconto')} disabled={!!travado} /></Field>
          <Field label="Emissão"><input type="date" value={f.emissao} onChange={set('emissao')} /></Field>
          <Field label="Vencimento *"><input type="date" value={f.vencimento} onChange={set('vencimento')} disabled={!!travado} /></Field>
          <Field label="Link de pagamento"><input value={f.linkPagamento} onChange={set('linkPagamento')} placeholder="https://…" /></Field>
        </div>
        <Field label="Linha digitável"><input value={f.linhaDigitavel} onChange={set('linhaDigitavel')} /></Field>
        <Field label="Código de barras"><input value={f.codigoBarras} onChange={set('codigoBarras')} /></Field>
        <div className="row small">
          <strong>Arquivo do boleto/fatura:</strong> {f.arquivoId ? <>{f.arquivoNome} <button className="btn sm" onClick={() => setF({ ...f, arquivoId: '', arquivoNome: '' })}>Remover</button></> : <span className="muted">nenhum</span>}
          {(f.clienteId || boleto) && <UploadButton label={f.arquivoId ? 'Substituir PDF' : 'Enviar PDF'} query={`?clienteId=${boleto?.clienteId ?? f.clienteId}&descricao=${encodeURIComponent('Boleto/fatura')}`} onDone={(a) => setF({ ...f, arquivoId: a.id, arquivoNome: a.nome })} />}
        </div>
        <Field label="Observações"><textarea rows={2} value={f.observacoes} onChange={set('observacoes')} /></Field>
        {!boleto && <label className="mm-check"><input type="checkbox" checked={f.rascunho} onChange={set('rascunho')} /> Salvar como rascunho (não entra em cobrança até ser emitido)</label>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !f.descricao.trim() || (!boleto && (!f.clienteId || !f.valor || !f.vencimento))} onClick={salvar}>Salvar</button>
        </div>
      </div>
    </Modal>
  );
}

function ParcelasForm({ onClose, onSaved, clienteFixo }: { onClose: () => void; onSaved: () => void; clienteFixo?: string }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ clienteId: clienteFixo ?? '', descricao: '', valorParcela: '', parcelas: '3', primeiroVencimento: '', intervaloMeses: '1', numeroDocumentoBase: '' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Gerar parcelas" onClose={onClose}>
      <div className="stack">
        {!clienteFixo && <ClienteSelect value={f.clienteId} onChange={(id) => setF({ ...f, clienteId: id })} />}
        <div className="grid g2">
          <Field label="Descrição *"><input value={f.descricao} onChange={set('descricao')} placeholder="Plano anual" /></Field>
          <Field label="Valor de cada parcela (R$) *"><input inputMode="decimal" value={f.valorParcela} onChange={set('valorParcela')} /></Field>
          <Field label="Quantidade de parcelas"><input type="number" min={1} max={120} value={f.parcelas} onChange={set('parcelas')} /></Field>
          <Field label="1º vencimento *"><input type="date" value={f.primeiroVencimento} onChange={set('primeiroVencimento')} /></Field>
          <Field label="A cada (meses)"><input type="number" min={1} max={12} value={f.intervaloMeses} onChange={set('intervaloMeses')} /></Field>
          <Field label="Nº do documento (base)" hint="vira BASE-1, BASE-2…"><input value={f.numeroDocumentoBase} onChange={set('numeroDocumentoBase')} /></Field>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Depois, abra cada parcela para anexar o PDF do boleto, a linha digitável ou o link de pagamento.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !f.clienteId || !f.descricao.trim() || !f.valorParcela || !f.primeiroVencimento} onClick={() => run(async () => {
            await post(`${API}/boletos/parcelas`, { clienteId: f.clienteId, descricao: f.descricao, valorParcela: num(f.valorParcela), parcelas: Number(f.parcelas), primeiroVencimento: f.primeiroVencimento, intervaloMeses: Number(f.intervaloMeses), numeroDocumentoBase: f.numeroDocumentoBase });
            onSaved();
          }, 'Parcelas geradas')}>Gerar</button>
        </div>
      </div>
    </Modal>
  );
}

/** Sequência de cobrança: mensagem 1 + boleto 1, mensagem 2 + boleto 2… (ordem editável). */
export function SequenciaForm({ onClose, onSaved, clienteFixo }: { onClose: () => void; onSaved: () => void; clienteFixo?: string }) {
  const { busy, run } = useAction();
  const [clienteId, setClienteId] = useState(clienteFixo ?? '');
  const bols = useApi<{ items: Boleto[] }>(clienteId ? `${API}/boletos?clienteId=${clienteId}&status=ABERTOS` : null, [clienteId]);
  const [ordem, setOrdem] = useState<string[]>([]);
  const [f, setF] = useState({
    nome: 'Cobrança', canais: ['WHATSAPP'] as string[], assunto: 'Boleto da parcela {{numero_parcela}}', diasAntes: '3', horario: '09:00',
    mensagem: 'Olá, {{primeiro_nome}}! Segue o boleto da parcela {{numero_parcela}}/{{total_parcelas}} no valor de {{valor_parcela}}, com vencimento em {{data_vencimento}}.',
    reenvio: true, offsets: '0, 1, 3, 7', reHorario: '10:00', maxPorBoleto: '3', reMensagem: 'Olá, {{primeiro_nome}}. A parcela {{numero_parcela}} ({{valor_pendente}}) venceu em {{data_vencimento}}. Se já pagou, envie o comprovante por aqui.',
    ativar: true,
  });
  const boletos = (bols.data?.items ?? []).filter((b) => ['PENDENTE', 'VENCIDO', 'PARCIAL'].includes(b.status));
  const mover = (i: number, d: number) => { const n = [...ordem]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setOrdem(n); };
  const toggle = (id: string) => setOrdem(ordem.includes(id) ? ordem.filter((x) => x !== id) : [...ordem, id]);
  return (
    <Modal title="Nova sequência de cobrança" onClose={onClose}>
      <div className="stack">
        {!clienteFixo && <ClienteSelect value={clienteId} onChange={(id) => { setClienteId(id); setOrdem([]); }} />}
        {clienteId && (
          <div className="stack">
            <strong className="small">Boletos em aberto — marque e ordene (mensagem 1 leva o 1º, mensagem 2 o 2º…)</strong>
            {boletos.length === 0 && <div className="small muted">Este cliente não tem boletos pendentes ou vencidos.</div>}
            {boletos.filter((b) => !ordem.includes(b.id)).map((b) => (
              <label key={b.id} className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={false} onChange={() => toggle(b.id)} /> {b.descricao} {b.parcela ? `· parcela ${b.parcela}` : ''} · vence {fmtYmd(b.vencimentoData)} · {brl(b.saldo)} {!b.arquivoId && <span className="badge amber">sem PDF</span>}</label>
            ))}
            {ordem.length > 0 && <div className="card stack" style={{ padding: 8 }}>
              {ordem.map((id, i) => { const b = boletos.find((x) => x.id === id); return b && (
                <div key={id} className="row between small">
                  <span><strong>Mensagem {i + 1}</strong> → {b.descricao} {b.parcela ? `· parcela ${b.parcela}` : ''} · vence {fmtYmd(b.vencimentoData)}</span>
                  <span className="row" style={{ flexWrap: 'nowrap' }}><button className="btn sm" onClick={() => mover(i, -1)} disabled={i === 0} aria-label="Subir">↑</button><button className="btn sm" onClick={() => mover(i, 1)} disabled={i === ordem.length - 1} aria-label="Descer">↓</button><button className="btn sm" onClick={() => toggle(id)}>Remover</button></span>
                </div>
              ); })}
            </div>}
          </div>
        )}
        <div className="grid g2">
          <Field label="Nome"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></Field>
          <div className="row">{['WHATSAPP', 'EMAIL'].map((c) => <label key={c} className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.canais.includes(c)} onChange={() => setF({ ...f, canais: f.canais.includes(c) ? f.canais.filter((x) => x !== c) : [...f.canais, c] })} /> {CANAL_LABEL[c as 'EMAIL']}</label>)}</div>
          <Field label="Enviar quantos dias antes do vencimento"><input type="number" min={0} max={60} value={f.diasAntes} onChange={(e) => setF({ ...f, diasAntes: e.target.value })} /></Field>
          <Field label="Horário do envio"><input type="time" value={f.horario} onChange={(e) => setF({ ...f, horario: e.target.value })} /></Field>
        </div>
        {f.canais.includes('EMAIL') && <Field label="Assunto do e-mail"><input value={f.assunto} onChange={(e) => setF({ ...f, assunto: e.target.value })} /></Field>}
        <Field label="Mensagem (vale para cada boleto, com os dados da parcela)"><textarea rows={3} value={f.mensagem} onChange={(e) => setF({ ...f, mensagem: e.target.value })} /></Field>
        <label className="mm-check"><input type="checkbox" checked={f.reenvio} onChange={(e) => setF({ ...f, reenvio: e.target.checked })} /> Reenviar boletos que continuarem pendentes ou vencidos</label>
        {f.reenvio && <div className="grid g3">
          <Field label="Dias em relação ao vencimento" hint="-1 = um dia antes, 0 = no dia, 3 = três dias depois"><input value={f.offsets} onChange={(e) => setF({ ...f, offsets: e.target.value })} /></Field>
          <Field label="Horário"><input type="time" value={f.reHorario} onChange={(e) => setF({ ...f, reHorario: e.target.value })} /></Field>
          <Field label="Máximo de reenvios por boleto"><input type="number" min={1} max={50} value={f.maxPorBoleto} onChange={(e) => setF({ ...f, maxPorBoleto: e.target.value })} /></Field>
        </div>}
        {f.reenvio && <Field label="Mensagem do reenvio"><textarea rows={2} value={f.reMensagem} onChange={(e) => setF({ ...f, reMensagem: e.target.value })} /></Field>}
        <p className="small muted" style={{ margin: 0 }}>Antes de cada envio o sistema confere o status do boleto: boleto pago, cancelado ou com comprovante em análise não é cobrado. Ao confirmar o pagamento de todas as parcelas, a sequência é encerrada.</p>
        <label className="mm-check"><input type="checkbox" checked={f.ativar} onChange={(e) => setF({ ...f, ativar: e.target.checked })} /> Ativar agora</label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !clienteId || !ordem.length || !f.canais.length || !f.mensagem.trim()} onClick={() => run(async () => {
            const r = await post(`${API}/cobrancas/sequencia`, {
              nome: f.nome, clienteId, boletoIds: ordem, canais: f.canais, assunto: f.assunto || null, mensagem: f.mensagem, diasAntes: Number(f.diasAntes), horario: f.horario, ativar: f.ativar,
              reenvio: f.reenvio ? { offsets: f.offsets.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n)), horario: f.reHorario, maxPorBoleto: Number(f.maxPorBoleto), mensagem: f.reMensagem || null } : null,
            });
            if (r.avisos?.length) alert(`Sequência criada. Avisos:\n• ${r.avisos.join('\n• ')}`);
            onSaved();
          }, 'Sequência de cobrança criada')}>Criar sequência</button>
        </div>
      </div>
    </Modal>
  );
}

function BoletoDetalhe({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (b: Boleto) => void }) {
  const ro = useReadOnly();
  const { can } = useAuth();
  const d = useApi<any>(`${API}/boletos/${id}`);
  const { busy, run } = useAction();
  const [pg, setPg] = useState<{ valor: string; pagoEm: string; forma: string; observacoes: string } | null>(null);
  const acao = (path: string, msg: string, body: any = {}) => run(async () => { await post(`${API}/boletos/${id}/${path}`, body); d.reload(); }, msg);
  const comMotivo = (path: string, pergunta: string, msg: string) => { const m = prompt(pergunta); if (m && m.trim().length >= 3) acao(path, msg, { motivo: m.trim() }); };
  return (
    <Modal title="Boleto" onClose={onClose}>
      <Async state={d}>{(b) => (
        <div className="stack">
          <div className="row between">
            <div><h3 style={{ margin: 0 }}>{b.descricao}{b.parcela ? ` — parcela ${b.parcela}${b.totalParcelas ? `/${b.totalParcelas}` : ''}` : ''}</h3><div className="small muted">{b.cliente} · vence {fmtYmd(b.vencimentoData)}{b.numeroDocumento ? ` · doc. ${b.numeroDocumento}` : ''}</div></div>
            <div className="row"><BolBadge s={b.status} /><EnvioBadge s={b.statusEnvio} /></div>
          </div>
          <div className="grid g4">
            <Kpi label="Valor devido" value={brl(b.devido)} /><Kpi label="Pago" value={brl(b.pago)} /><Kpi label="Saldo" value={brl(b.saldo)} /><Kpi label="Envios" value={fmtNum(b.envios)} sub={b.enviadoEm ? `último ${fmtDT(b.enviadoEm)}` : undefined} />
          </div>
          <div className="small">
            {b.linhaDigitavel && <div><strong>Linha digitável:</strong> <code>{b.linhaDigitavel}</code></div>}
            {b.codigoBarras && <div><strong>Código de barras:</strong> <code>{b.codigoBarras}</code></div>}
            {b.linkPagamento && <div><strong>Link:</strong> <a href={b.linkPagamento} target="_blank" rel="noreferrer">{b.linkPagamento}</a></div>}
            <div><strong>Arquivo:</strong> {b.arquivo ? <ArquivoLink id={b.arquivo.id} nome={b.arquivo.nome} /> : <span className="muted">nenhum</span>}</div>
            {b.automacoes.length > 0 && <div><strong>Sequências:</strong> {b.automacoes.map((a: any) => `${a.nome} (mensagem ${a.envio ?? '—'}, ${a.status.toLowerCase()})`).join(' · ')}</div>}
          </div>
          {!ro && (
            <div className="row">
              {['PENDENTE', 'VENCIDO', 'PARCIAL', 'EM_ANALISE'].includes(b.status) && <button className="btn sm primary" onClick={() => setPg({ valor: String(b.saldo).replace('.', ','), pagoEm: ymdLocal(new Date()), forma: '', observacoes: '' })}>Registrar pagamento</button>}
              {b.status === 'RASCUNHO' && <button className="btn sm primary" disabled={busy} onClick={() => acao('emitir', 'Boleto emitido')}>Emitir</button>}
              {['PENDENTE', 'VENCIDO', 'PARCIAL'].includes(b.status) && <button className="btn sm" disabled={busy} onClick={() => confirm('Reenviar agora este boleto pela sequência de cobrança ativa?') && acao('reenviar', 'Reenvio colocado na fila')}>Reenviar agora</button>}
              <button className="btn sm" onClick={() => onEdit(b)}>Editar</button>
              {b.status !== 'CANCELADO' && b.status !== 'PAGO' && b.pago === 0 && <button className="btn sm danger" disabled={busy} onClick={() => comMotivo('cancelar', 'Motivo do cancelamento:', 'Boleto cancelado')}>Cancelar</button>}
              {b.status === 'CANCELADO' && <button className="btn sm" disabled={busy} onClick={() => comMotivo('reabrir', 'Motivo da reabertura:', 'Boleto reaberto')}>Reabrir</button>}
            </div>
          )}
          {!ro && <ComprovanteUpload clienteId={b.clienteId} boletoId={b.id} onDone={() => d.reload()} />}
          {pg && (
            <div className="card stack" style={{ background: 'var(--brand-soft)' }}>
              <strong className="small">Baixa manual (pagamento parcial mantém o saldo em cobrança)</strong>
              <div className="grid g4">
                <Field label="Valor (R$)"><input inputMode="decimal" value={pg.valor} onChange={(e) => setPg({ ...pg, valor: e.target.value })} /></Field>
                <Field label="Data do pagamento"><input type="date" value={pg.pagoEm} onChange={(e) => setPg({ ...pg, pagoEm: e.target.value })} /></Field>
                <Field label="Forma"><input value={pg.forma} onChange={(e) => setPg({ ...pg, forma: e.target.value })} placeholder="Pix, boleto…" /></Field>
                <Field label="Observações"><input value={pg.observacoes} onChange={(e) => setPg({ ...pg, observacoes: e.target.value })} /></Field>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn sm" onClick={() => setPg(null)}>Cancelar</button>
                <button className="btn sm primary" disabled={busy} onClick={() => run(async () => { await post(`${API}/boletos/${id}/pagamentos`, { valor: num(pg.valor), pagoEm: pg.pagoEm, forma: pg.forma, observacoes: pg.observacoes }); setPg(null); d.reload(); }, 'Pagamento registrado')}>Confirmar baixa</button>
              </div>
            </div>
          )}
          <h4 style={{ margin: 0 }}>Pagamentos</h4>
          {b.pagamentos.length === 0 ? <div className="small muted">Nenhum pagamento registrado.</div> : (
            <div className="table-wrap"><table><tbody>{b.pagamentos.map((p: any) => (
              <tr key={p.id} style={p.estornadoEm ? { opacity: 0.6 } : undefined}>
                <td className="small">{fmtYmd(p.pagoEm)}</td><td className="small">{brl(p.valor)}</td><td className="small">{p.forma ?? ''} · {p.origem === 'COMPROVANTE' ? 'comprovante aprovado' : 'baixa manual'}</td>
                <td className="small">{p.estornadoEm ? <span className="badge red">Estornado: {p.estornoMotivo}</span> : !ro && can('OWNER') && <button className="btn sm danger" onClick={() => { const m = prompt('Motivo do estorno (o registro é mantido e a cobrança reaberta):'); if (m && m.trim().length >= 3) run(async () => { await post(`${API}/pagamentos/${p.id}/estornar`, { motivo: m.trim() }); d.reload(); }, 'Pagamento estornado'); }}>Estornar</button>}</td>
              </tr>
            ))}</tbody></table></div>
          )}
          {b.comprovantes.length > 0 && <>
            <h4 style={{ margin: 0 }}>Comprovantes</h4>
            {b.comprovantes.map((c: any) => <div key={c.id} className="small">{fmtDT(c.createdAt)} · {c.origem.toLowerCase()} · confiança {c.confianca}% · <strong>{c.status === 'EM_ANALISE' ? 'em análise' : c.status.toLowerCase()}</strong>{c.motivoRevisao ? ` — ${c.motivoRevisao}` : ''}</div>)}
          </>}
          {b.envios.length > 0 && <>
            <h4 style={{ margin: 0 }}>Envios programados e realizados</h4>
            <div className="table-wrap"><table><tbody>{b.envios.map((o: any) => <tr key={o.id}><td className="small">{fmtDT(o.agendadoPara)}</td><td className="small">{o.tipo === 'ENVIO' ? 'Envio' : o.tipo === 'MANUAL' ? 'Reenvio manual' : 'Reenvio'}</td><td className="small">{CANAL_LABEL[o.canal as 'EMAIL']}</td><td><OcBadge s={o.status} />{o.erro && <div className="small muted">{o.erro}</div>}</td></tr>)}</tbody></table></div>
          </>}
          <h4 style={{ margin: 0 }}>Histórico de alterações</h4>
          <div className="table-wrap"><table><tbody>{b.eventos.map((e: any) => <tr key={e.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDT(e.createdAt)}</td><td className="small">{e.descricao}</td></tr>)}</tbody></table></div>
        </div>
      )}</Async>
    </Modal>
  );
}

function ComprovanteUpload({ clienteId, boletoId, onDone }: { clienteId: string; boletoId?: string; onDone: () => void }) {
  const { busy, run } = useAction();
  return (
    <label className="small row" style={{ cursor: 'pointer' }}>
      <span className="btn sm">{busy ? 'Enviando…' : 'Enviar comprovante para análise'}</span>
      <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" style={{ display: 'none' }} disabled={busy} onChange={(e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (f) run(async () => { await upload(`${API}/comprovantes?clienteId=${clienteId}${boletoId ? `&boletoId=${boletoId}` : ''}`, f); onDone(); }, 'Comprovante registrado: aguardando conferência');
      }} />
      <span className="muted">o pagamento só é baixado depois da aprovação</span>
    </label>
  );
}

// ---------------- Controle de pagamentos (comprovantes + pagamentos) ----------------

export function Pagamentos() {
  const [aba, setAba] = useState<'comprovantes' | 'pagamentos'>('comprovantes');
  return (
    <div className="stack">
      <div className="row">
        <button className={`btn sm ${aba === 'comprovantes' ? 'primary' : ''}`} onClick={() => setAba('comprovantes')}>Comprovantes</button>
        <button className={`btn sm ${aba === 'pagamentos' ? 'primary' : ''}`} onClick={() => setAba('pagamentos')}>Pagamentos registrados</button>
      </div>
      {aba === 'comprovantes' ? <Comprovantes /> : <ListaPagamentos />}
    </div>
  );
}

function Comprovantes() {
  const ro = useReadOnly();
  const [status, setStatus] = useState('EM_ANALISE');
  const list = useApi<{ items: any[]; total: number }>(`${API}/comprovantes?${status ? `status=${status}` : ''}`);
  const [rev, setRev] = useState<any>(null);
  const [novo, setNovo] = useState(false);
  return (
    <div className="stack">
      <div className="row between">
        <p className="small muted" style={{ margin: 0 }}>Comprovantes recebidos pelo WhatsApp entram aqui automaticamente quando o remetente é um cliente com cobrança em aberto (ou a mensagem fala de pagamento). Receber comprovante <strong>não</strong> é pagamento confirmado: aprove ou rejeite após conferir.</p>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="EM_ANALISE">Em análise</option><option value="APROVADO">Aprovados</option><option value="REJEITADO">Rejeitados</option><option value="">Todos</option></select>
          {!ro && <button className="btn" onClick={() => setNovo(true)}>Enviar comprovante</button>}
        </div>
      </div>
      <div className="card table-wrap">
        <Async state={list}>{(d) => d.items.length === 0 ? <Empty title="Nenhum comprovante">Quando um cliente mandar um comprovante pelo WhatsApp, ele aparece aqui para conferência.</Empty> : (
          <table>
            <thead><tr><th>Recebido</th><th>Cliente</th><th>Arquivo</th><th>Boleto identificado</th><th>Confiança</th><th>Status</th><th /></tr></thead>
            <tbody>{d.items.map((c) => (
              <tr key={c.id}>
                <td className="small">{fmtDT(c.createdAt)}<div className="muted">{c.origem === 'WHATSAPP' ? 'WhatsApp' : c.origem === 'EMAIL' ? 'e-mail' : 'operador'}</div></td>
                <td>{c.cliente ?? <span className="badge amber">não identificado</span>}</td>
                <td className="small">{c.arquivo ? <ArquivoLink id={c.arquivo.id} nome={c.arquivo.nome} /> : '—'}{c.texto && <div className="muted" style={{ maxWidth: 220 }}>“{c.texto}”</div>}</td>
                <td className="small">{c.boleto ? <>{c.boleto.descricao}{c.boleto.parcela ? ` · parcela ${c.boleto.parcela}` : ''}<div className="muted">saldo {brl(c.boleto.saldo)} · vence {fmtYmd(c.boleto.vencimentoData)}</div></> : '—'}{c.valorDetectado != null && <div>valor lido: {brl(c.valorDetectado)}</div>}</td>
                <td><span className={`badge ${c.confianca >= 70 ? 'green' : c.confianca >= 40 ? 'amber' : 'red'}`}>{c.confianca}%</span>{c.duplicado && <div><span className="badge red">possível duplicado</span></div>}</td>
                <td className="small">{c.status === 'EM_ANALISE' ? <span className="badge amber">Em análise</span> : c.status === 'APROVADO' ? <span className="badge green">Aprovado</span> : <span className="badge red">Rejeitado</span>}{c.motivoRevisao && <div className="muted">{c.motivoRevisao}</div>}</td>
                <td>{!ro && c.status === 'EM_ANALISE' && <button className="btn sm primary" onClick={() => setRev(c)}>Conferir</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}</Async>
      </div>
      {rev && <RevisarComprovante c={rev} onClose={() => setRev(null)} onDone={() => { setRev(null); list.reload(); }} />}
      {novo && <NovoComprovante onClose={() => setNovo(false)} onDone={() => { setNovo(false); list.reload(); }} />}
    </div>
  );
}

function NovoComprovante({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [clienteId, setClienteId] = useState('');
  return (
    <Modal title="Enviar comprovante" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Use para comprovantes recebidos por e-mail ou outro meio. O sistema tenta identificar a parcela e deixa em análise.</p>
        <ClienteSelect value={clienteId} onChange={setClienteId} />
        {clienteId && <ComprovanteUpload clienteId={clienteId} onDone={onDone} />}
      </div>
    </Modal>
  );
}

function RevisarComprovante({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [clienteId, setClienteId] = useState<string>(c.clienteId ?? '');
  const bols = useApi<{ items: Boleto[] }>(clienteId ? `${API}/boletos?clienteId=${clienteId}&status=ABERTOS` : null, [clienteId]);
  const [boletoId, setBoletoId] = useState<string>(c.boletoId ?? '');
  const b = bols.data?.items.find((x) => x.id === boletoId);
  const [valor, setValor] = useState(c.valorDetectado != null ? String(c.valorDetectado).replace('.', ',') : '');
  const [pagoEm, setPagoEm] = useState(c.dataDetectada ?? ymdLocal(new Date()));
  const [obs, setObs] = useState('');
  return (
    <Modal title="Conferir comprovante" onClose={onClose}>
      <div className="stack">
        {c.arquivo && (c.arquivo.mime.startsWith('image/')
          ? <img src={downloadUrl(c.arquivo.id, true)} alt="Comprovante" style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain', border: '1px solid var(--line)', borderRadius: 8 }} />
          : <a className="btn sm" href={downloadUrl(c.arquivo.id, true)} target="_blank" rel="noreferrer">Abrir {c.arquivo.nome}</a>)}
        <div className="small"><strong>Análise automática</strong> (confiança {c.confianca}%):<ul style={{ margin: '4px 0' }}>{c.motivos.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul>
          {c.transacaoId && <div>ID da transação: <code>{c.transacaoId}</code></div>}{c.instituicao && <div>Instituição: {c.instituicao}</div>}</div>
        {c.duplicado && <div className="alert err small">Possível comprovante duplicado. Só aprove se tiver certeza de que é outro pagamento.</div>}
        <ClienteSelect value={clienteId} onChange={(id) => { setClienteId(id); setBoletoId(''); }} />
        <Field label="Boleto/parcela">
          <select value={boletoId} onChange={(e) => setBoletoId(e.target.value)}>
            <option value="">Escolha…</option>{bols.data?.items.map((x) => <option key={x.id} value={x.id}>{x.descricao}{x.parcela ? ` · parcela ${x.parcela}` : ''} · vence {fmtYmd(x.vencimentoData)} · saldo {brl(x.saldo)}</option>)}
          </select>
        </Field>
        <div className="grid g2">
          <Field label="Valor pago (R$)" hint={b ? `saldo da parcela: ${brl(b.saldo)}; menor = pagamento parcial` : undefined}><input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder={b ? String(b.saldo).replace('.', ',') : ''} /></Field>
          <Field label="Data do pagamento"><input type="date" value={pagoEm} onChange={(e) => setPagoEm(e.target.value)} /></Field>
        </div>
        <Field label="Observações / motivo"><input value={obs} onChange={(e) => setObs(e.target.value)} /></Field>
        <div className="row between">
          <button className="btn danger" disabled={busy} onClick={() => { if (obs.trim().length < 3) { alert('Informe o motivo da rejeição em "Observações / motivo".'); return; } run(async () => { await post(`${API}/comprovantes/${c.id}/rejeitar`, { motivo: obs.trim() }); onDone(); }, 'Comprovante rejeitado'); }}>Rejeitar</button>
          <div className="row">
            {(clienteId !== (c.clienteId ?? '') || boletoId !== (c.boletoId ?? '')) && <button className="btn" disabled={busy} onClick={() => run(async () => { await patch(`${API}/comprovantes/${c.id}`, { clienteId: clienteId || null, boletoId: boletoId || null }); onDone(); }, 'Vínculo salvo (continua em análise)')}>Só vincular</button>}
            <button className="btn primary" disabled={busy || !boletoId} onClick={() => confirm('Confirmar o pagamento? Isso dá baixa na parcela e interrompe as cobranças dela.') && run(async () => {
              await post(`${API}/comprovantes/${c.id}/aprovar`, { boletoId, valor: valor ? num(valor) : undefined, pagoEm, observacoes: obs, confirmarDuplicado: c.duplicado || undefined });
              onDone();
            }, 'Pagamento confirmado')}>Aprovar e dar baixa</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ListaPagamentos() {
  const [f, setF] = useState({ de: '', ate: '' });
  const qs = new URLSearchParams(); if (f.de) qs.set('de', f.de); if (f.ate) qs.set('ate', f.ate);
  const list = useApi<{ items: any[]; total: number }>(`${API}/pagamentos?${qs}`);
  return (
    <div className="stack">
      <div className="row"><span className="small muted">Pagos entre</span><input type="date" value={f.de} onChange={(e) => setF({ ...f, de: e.target.value })} style={{ width: 'auto' }} /> e <input type="date" value={f.ate} onChange={(e) => setF({ ...f, ate: e.target.value })} style={{ width: 'auto' }} /></div>
      <div className="card table-wrap">
        <Async state={list}>{(d) => d.items.length === 0 ? <Empty title="Nenhum pagamento">As baixas manuais e os comprovantes aprovados aparecem aqui.</Empty> : (
          <table>
            <thead><tr><th>Data</th><th>Cliente</th><th>Boleto</th><th>Valor</th><th>Origem</th><th>Situação</th></tr></thead>
            <tbody>{d.items.map((p) => (
              <tr key={p.id} style={p.estornadoEm ? { opacity: 0.6 } : undefined}>
                <td className="small">{fmtYmd(p.pagoEm)}</td><td>{p.cliente}</td>
                <td className="small">{p.boleto ? `${p.boleto.descricao}${p.boleto.parcela ? ` · parcela ${p.boleto.parcela}` : ''}` : '—'}</td>
                <td className="small">{brl(p.valor)}</td><td className="small">{p.origem === 'COMPROVANTE' ? 'Comprovante aprovado' : 'Baixa manual'}{p.forma ? ` · ${p.forma}` : ''}</td>
                <td className="small">{p.estornadoEm ? <span className="badge red">Estornado — {p.estornoMotivo}</span> : <span className="badge green">Confirmado</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}</Async>
      </div>
    </div>
  );
}

// ---------------- Arquivos e documentos ----------------

export function Arquivos() {
  const ro = useReadOnly();
  const { can } = useAuth();
  const [clienteId, setClienteId] = useState('');
  const [q, setQ] = useState('');
  const list = useApi<{ items: Arquivo[]; total: number }>(`${API}/arquivos?${clienteId ? `clienteId=${clienteId}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`);
  const tipos = useApi<{ permitidos: string[]; tamanhoMaxMb: number }>(`${API}/arquivos/tipos`);
  const { run } = useAction();
  return (
    <div className="stack">
      <div className="row between">
        <div className="row" style={{ flex: 1 }}>
          <input placeholder="Buscar pelo nome" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 220 }} />
          <div style={{ minWidth: 320 }}><ClienteSelect value={clienteId} onChange={setClienteId} allowEmpty label="" /></div>
        </div>
        {!ro && <UploadButton small={false} label={clienteId ? 'Enviar arquivo do cliente' : 'Enviar documento geral'} query={clienteId ? `?clienteId=${clienteId}` : ''} onDone={() => list.reload()} accept={tipos.data ? tipos.data.permitidos.map((t) => `.${t}${t === 'jpg' ? ',.jpeg' : ''}`).join(',') : undefined} />}
      </div>
      {tipos.data && <p className="small muted" style={{ margin: 0 }}>Tipos permitidos: {tipos.data.permitidos.join(', ').toUpperCase()} · até {tipos.data.tamanhoMaxMb} MB. Os arquivos ficam no banco de dados (não há link público); o download exige login de administrador.</p>}
      <div className="card table-wrap">
        <Async state={list}>{(d) => d.items.length === 0 ? <Empty title="Nenhum arquivo">Envie boletos, faturas e documentos para anexar às mensagens.</Empty> : (
          <table>
            <thead><tr><th>Arquivo</th><th>Cliente</th><th>Tamanho</th><th>Origem</th><th>Enviado em</th><th /></tr></thead>
            <tbody>{d.items.map((a) => (
              <tr key={a.id}>
                <td><ArquivoLink id={a.id} nome={a.nome} />{a.descricao && <div className="small muted">{a.descricao}</div>}</td>
                <td className="small">{a.cliente ?? <span className="muted">geral</span>}</td><td className="small">{fmtBytes(a.tamanho)}</td>
                <td className="small">{a.origem === 'WHATSAPP' ? 'WhatsApp' : a.origem === 'EMAIL' ? 'E-mail' : 'Upload'}</td><td className="small">{fmtDT(a.createdAt)}</td>
                <td>{!ro && can('OWNER') && <button className="btn sm danger" onClick={() => confirm(`Excluir ${a.nome}?`) && run(async () => { await del(`${API}/arquivos/${a.id}`); list.reload(); }, 'Arquivo excluído')}>Excluir</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}</Async>
      </div>
    </div>
  );
}

// ---------------- Relatórios ----------------

export function Relatorios() {
  const { can } = useAuth();
  const hoje = ymdLocal(new Date());
  const [f, setF] = useState({ de: ymdLocal(new Date(Date.now() - 29 * 86400e3)), ate: hoje, clienteId: '', categoria: '' });
  const qs = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
  const r = useApi<any>(`${API}/relatorios?${qs}`);
  return (
    <div className="stack">
      <div className="row">
        <input type="date" value={f.de} onChange={(e) => setF({ ...f, de: e.target.value })} style={{ width: 'auto' }} /> até <input type="date" value={f.ate} onChange={(e) => setF({ ...f, ate: e.target.value })} style={{ width: 'auto' }} />
        <select value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })} style={{ width: 'auto' }}><option value="">Todas as categorias</option><option value="LEMBRETE">Lembretes</option><option value="MARKETING">Marketing</option><option value="COBRANCA">Cobranças</option></select>
        <div style={{ minWidth: 320 }}><ClienteSelect value={f.clienteId} onChange={(id) => setF({ ...f, clienteId: id })} allowEmpty label="" /></div>
      </div>
      <Async state={r}>{(d) => (
        <div className="stack">
          <h3 style={{ margin: 0 }}>Mensagens</h3>
          <div className="grid g4">
            <Kpi label="Enviadas" value={fmtNum(d.mensagens.enviadas)} /><Kpi label="Com falha" value={fmtNum(d.mensagens.falhas)} />
            <Kpi label="Sucesso WhatsApp" value={d.mensagens.porCanal.WHATSAPP.taxaSucesso == null ? '—' : `${d.mensagens.porCanal.WHATSAPP.taxaSucesso}%`} sub={`${d.mensagens.porCanal.WHATSAPP.enviadas} ok / ${d.mensagens.porCanal.WHATSAPP.falhas} falhas`} />
            <Kpi label="Sucesso e-mail" value={d.mensagens.porCanal.EMAIL.taxaSucesso == null ? '—' : `${d.mensagens.porCanal.EMAIL.taxaSucesso}%`} sub={`${d.mensagens.porCanal.EMAIL.enviadas} ok / ${d.mensagens.porCanal.EMAIL.falhas} falhas`} />
          </div>
          <div className="grid g4">
            <Kpi label="Lembretes enviados" value={fmtNum(d.mensagens.lembretesEnviados)} /><Kpi label="Campanhas executadas" value={fmtNum(d.mensagens.campanhasExecutadas)} sub={`${d.mensagens.marketingEnviados} mensagem(ns)`} />
            <Kpi label="Cobranças enviadas" value={fmtNum(d.mensagens.cobrancasEnviadas)} /><Kpi label="Reenvios efetuados" value={fmtNum(d.mensagens.reenvios)} />
          </div>
          <h3 style={{ margin: 0 }}>Financeiro</h3>
          <div className="grid g4">
            <Kpi label="Boletos emitidos" value={fmtNum(d.financeiro.boletosEmitidos)} /><Kpi label="Boletos enviados" value={fmtNum(d.financeiro.boletosEnviados)} />
            <Kpi label="Boletos vencidos" value={fmtNum(d.financeiro.boletosVencidos)} /><Kpi label="Parcelas em atraso" value={fmtNum(d.financeiro.parcelasEmAtraso)} sub={brl(d.financeiro.valorEmAtraso)} />
          </div>
          <div className="grid g4">
            <Kpi label="Pagamentos confirmados" value={fmtNum(d.financeiro.pagamentosConfirmados)} sub={`${d.financeiro.boletosComPagamento} boleto(s)`} /><Kpi label="Valores recebidos" value={brl(d.financeiro.valoresRecebidos)} />
            <Kpi label="Valores pendentes" value={brl(d.financeiro.valoresPendentes)} sub={`${d.financeiro.pagamentosParciais} com pagamento parcial`} /><Kpi label="Comprovantes em análise" value={fmtNum(d.financeiro.comprovantesPendentes)} sub={`${d.financeiro.comprovantesRecebidos} recebido(s) no período`} />
          </div>
          <div className="card table-wrap">
            <h3 style={{ marginTop: 0 }}>Mensagens por dia</h3>
            {d.mensagens.porDia.length === 0 ? <p className="small muted">Nenhum envio no período.</p> : (
              <table><thead><tr><th>Dia</th><th>Enviadas</th><th>Falhas</th></tr></thead><tbody>{d.mensagens.porDia.map((x: any) => <tr key={x.dia}><td className="small">{fmtYmd(x.dia)}</td><td>{x.enviadas}</td><td>{x.falhas}</td></tr>)}</tbody></table>
            )}
          </div>
          {can('OWNER', 'ADMIN') && <div className="row">
            <span className="small muted">Exportar CSV do período:</span>
            {['mensagens', 'boletos', 'pagamentos', 'comprovantes'].map((t) => <a key={t} className="btn sm" href={`/api${API}/relatorios/export?tipo=${t}&${qs}`}>{t[0].toUpperCase() + t.slice(1)}</a>)}
          </div>}
          <p className="small muted" style={{ margin: 0 }}>Calculado dos registros reais: cada envio conta uma vez (pelo resultado final) e pagamentos estornados não entram em "recebidos".</p>
        </div>
      )}</Async>
    </div>
  );
}

export { BoletoForm, ParcelasForm, ComprovanteUpload };
