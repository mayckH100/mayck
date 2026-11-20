/**
 * Peças de tela do controle de lote (v1.33.0): cartão do lote, lista de lotes do produto, etiquetas em PDF
 * (com quantidade sugerida e editável), leitor de código de barras/QR pela câmera do celular e campo de leitura
 * (leitor USB/Bluetooth digita + Enter).
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../../api';
import { useApi, Async, Empty, Modal, useToast } from '../../ui';
import { qtdUn } from '../../../../server/erp/shared/unidade';
import { imprimirZebra } from './impressao';

export const dataBr = (d?: string | null) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
export const dataValidade = (d?: string | null) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

/** Abre o PDF das etiquetas numa aba nova (imprimir ou salvar em PDF). */
export function abrirPdfEtiquetas(itens: { loteId: string; copias: number }[], formato: 'rolo' | 'a4') {
  const lotes = itens.filter((i) => i.copias > 0).map((i) => `${i.loteId}:${Math.min(999, Math.max(1, Math.round(i.copias)))}`).join(',');
  if (lotes) window.open(`/api/erp/estoque/etiquetas/pdf?lotes=${encodeURIComponent(lotes)}&formato=${formato}`, '_blank', 'noopener');
}

/** Depois de uma entrada: "Gerar etiqueta e imprimir", com a quantidade sugerida (uma por embalagem/peça) editável. */
export function ImprimirEtiquetas({ itens, onClose, titulo = 'Entrada registrada' }: { itens: { loteId: string; numero: string; produto?: string; sugeridas: number }[]; onClose: () => void; titulo?: string }) {
  const [copias, setCopias] = useState<Record<string, string>>(() => Object.fromEntries(itens.map((i) => [i.loteId, String(i.sugeridas)])));
  const [formato, setFormato] = useState<'rolo' | 'a4'>(() => (localStorage.getItem('mck:etiqueta:formato') as 'rolo' | 'a4') || 'rolo');
  const toast = useToast();
  const lista = itens.map((i) => ({ loteId: i.loteId, copias: Number(copias[i.loteId]) || 0 }));
  const total = lista.reduce((a, i) => a + i.copias, 0);
  const gerar = () => { localStorage.setItem('mck:etiqueta:formato', formato); abrirPdfEtiquetas(lista, formato); };
  return (
    <Modal title={titulo} onClose={onClose}>
      <p style={{ marginTop: 0 }}>🏷️ Gere as etiquetas do lote agora: cada uma tem o <b>código de barras</b> e o <b>QR</b> com produto, lote, fabricação e validade.</p>
      {itens.map((i) => (
        <div key={i.loteId} className="card" style={{ padding: 10, marginBottom: 8 }}>
          <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
            <div><b>Lote {i.numero}</b>{i.produto && <div className="small muted">{i.produto}</div>}</div>
            <label className="row small" style={{ gap: 6 }}>Etiquetas
              <input type="number" min={0} max={999} inputMode="numeric" value={copias[i.loteId] ?? ''} onChange={(e) => setCopias({ ...copias, [i.loteId]: e.target.value })} style={{ width: 80 }} aria-label={`Quantidade de etiquetas do lote ${i.numero}`} />
            </label>
          </div>
          <div className="small muted">Sugestão: {i.sugeridas} (uma por embalagem ou peça recebida). Pode mudar.</div>
        </div>
      ))}
      <label className="row small" style={{ gap: 6, margin: '6px 0' }}>Impressora
        <select value={formato} onChange={(e) => setFormato(e.target.value as 'rolo' | 'a4')} aria-label="Tipo de impressora"><option value="rolo">De etiqueta (rolo)</option><option value="a4">Comum (folha A4)</option></select>
      </label>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn" onClick={onClose}>Agora não</button>
        <button className="btn ghost" disabled={!total} onClick={async () => { try { const { zpl } = await post<any>('/erp/estoque/etiquetas/zpl', { itens: lista.filter((x) => x.copias > 0) }); toast((await imprimirZebra(zpl)) === 'impresso' ? 'Enviado para a Zebra' : 'Arquivo .zpl baixado'); } catch (e) { toast((e as Error).message, 'err'); } }}>Zebra (ZPL)</button>
        <button className="btn primary" disabled={!total} onClick={gerar}>🖨️ Gerar etiqueta e imprimir ({total})</button>
      </div>
    </Modal>
  );
}

/** Cartão de um lote: tudo o que o dono precisa ver de relance, legível no celular. */
export function LoteCard({ l, unidade, acoes = true }: { l: any; unidade?: string; acoes?: boolean }) {
  const [etq, setEtq] = useState(false);
  const un = unidade ?? l.produto?.unidade ?? 'UN';
  const venc = l.validade ? String(l.validade).slice(0, 10) : null;
  const vencido = venc && venc < new Date().toISOString().slice(0, 10);
  return (
    <div className="card" style={{ padding: 12, marginBottom: 8 }} data-testid="lote-card">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
        <div>
          <div style={{ fontSize: 17 }}><b>Lote {l.numero}</b> {l.status && l.status !== 'LIBERADO' && <span className="badge red">{l.status === 'QUARENTENA' ? 'em quarentena' : 'bloqueado'}</span>} {vencido && <span className="badge red">vencido</span>}</div>
          {l.produto && <div className="small muted">{l.produto.nome} · cód. {l.produto.sku}</div>}
        </div>
        <div style={{ textAlign: 'right' }}><div className="small muted">Saldo hoje</div><div style={{ fontSize: 18 }}><b>{qtdUn(l.saldoMil ?? 0, un)}</b></div></div>
      </div>
      <div className="lote-info" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '4px 12px', marginTop: 8 }}>
        <div><span className="small muted">Lote do fornecedor</span><div>{l.loteFornecedor || '—'}</div></div>
        <div><span className="small muted">Fornecedor</span><div>{l.fornecedor?.nome || '—'}</div></div>
        <div><span className="small muted">Entrou em</span><div>{dataBr(l.entradaEm)}</div></div>
        <div><span className="small muted">Documento de entrada</span><div>{l.documentoEntrada?.rotulo || '—'}</div></div>
        <div><span className="small muted">Validade</span><div style={{ color: vencido ? '#dc2626' : undefined }}>{venc ? dataValidade(venc) : 'não controla'}</div></div>
        {l.fabricacao && <div><span className="small muted">Fabricação</span><div>{dataValidade(l.fabricacao)}</div></div>}
        <div><span className="small muted">Recebido</span><div>{qtdUn(l.recebidoMil ?? 0, un)}</div></div>
        {l.reservadoMil > 0 && <div><span className="small muted">Reservado para pedidos</span><div>{qtdUn(l.reservadoMil, un)}</div></div>}
      </div>
      {l.locais?.length > 0 && <div style={{ marginTop: 6 }}><span className="small muted">Onde está</span>{l.locais.map((x: any) => <div key={x.enderecoId} className="small">📍 {x.deposito} · <b>{x.endereco}</b>: {qtdUn(x.fisicoMil, un)}{x.reservadoMil ? ` (${qtdUn(x.reservadoMil, un)} reservado)` : ''}</div>)}</div>}
      {acoes && <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Link className="btn sm primary" to={`/erp/rastreio?lote=${l.id}`}>🔎 Rastrear lote</Link>
        <button className="btn sm" onClick={() => setEtq(true)}>🏷️ Etiqueta</button>
      </div>}
      {etq && <ImprimirEtiquetas titulo={`Etiquetas do lote ${l.numero}`} itens={[{ loteId: l.id, numero: l.numero, produto: l.produto ? `${l.produto.sku} · ${l.produto.nome}` : undefined, sugeridas: 1 }]} onClose={() => setEtq(false)} />}
    </div>
  );
}

/** Lotes de um produto (abre da tela Produtos). */
export function LotesProduto({ produto, onClose }: { produto: any; onClose: () => void }) {
  const st = useApi<any>(`/erp/estoque/lotes/produto/${produto.id}`, [produto.id]);
  return (
    <Modal title={`Lotes de ${produto.nome}`} onClose={onClose}>
      <Async state={st}>{(d) => d.lotes.length === 0 ? <Empty title="Nenhum lote ainda">O lote nasce sozinho em cada entrada de estoque (manual, nota fiscal ou produção).</Empty> : (
        <>
          <p className="small muted" style={{ marginTop: 0 }}>{d.lotes.length} lote(s) · saída {d.produto.regraSaida === 'FEFO' ? 'pelo que vence primeiro (FEFO)' : 'pelo mais antigo (FIFO)'}</p>
          {d.lotes.map((l: any) => <LoteCard key={l.id} l={l} unidade={d.produto.unidade} />)}
        </>
      )}</Async>
    </Modal>
  );
}

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
/**
 * Câmera do celular lendo código de barras (EAN, Code 128/GS1-128, UPC...) e QR, sem instalar nada.
 * Usa o leitor nativo do navegador (Chrome no Android). Lê sem parar: o mesmo código só conta de novo depois de 1,5 s.
 */
export function LeitorCamera({ onLer, onClose, continuo = true }: { onLer: (codigo: string) => void; onClose: () => void; continuo?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ultimo, setUltimo] = useState('');
  const cb = useRef(onLer); cb.current = onLer;
  useEffect(() => {
    let parar = false; let stream: MediaStream | null = null; let ult = ''; let quando = 0;
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!BD) { setErro('Este navegador não lê código pela câmera. Use o Chrome no Android, um leitor de código de barras ou digite o código.'); return; }
    const det = new BD({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!video.current) return;
        video.current.srcObject = stream; await video.current.play();
        while (!parar) {
          const r = await det.detect(video.current).catch(() => []);
          const v = r[0]?.rawValue;
          if (v && (v !== ult || Date.now() - quando > 1500)) {
            ult = v; quando = Date.now(); setUltimo(v);
            try { navigator.vibrate?.(60); } catch { /* sem vibração */ }
            cb.current(v);
            if (!continuo) { parar = true; break; }
          }
          await new Promise((ok) => setTimeout(ok, 180));
        }
      } catch { setErro('Não foi possível abrir a câmera. Permita o uso da câmera para este site e tente de novo.'); }
    })();
    return () => { parar = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [continuo]);
  return (
    <Modal title="Ler com a câmera" onClose={onClose}>
      {erro ? <p>{erro}</p> : <>
        <video ref={video} muted playsInline style={{ width: '100%', maxHeight: '55vh', background: '#000', borderRadius: 8 }} />
        <p className="small muted">Aponte para o código de barras do produto ou para a etiqueta do lote.{continuo ? ' Cada leitura conta 1.' : ''}</p>
        {ultimo && <p className="small">Último lido: <code>{ultimo.replace(/[\x00-\x1f]/g, ' ').slice(0, 60)}</code></p>}
      </>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Pronto</button></div>
    </Modal>
  );
}

/** Campo de leitura: leitor de código de barras (digita + Enter), digitação ou câmera. */
export function CampoLeitura({ onCodigo, placeholder = 'Leia o código de barras ou digite', continuo = true, autoFocus = true }: { onCodigo: (c: string) => void; placeholder?: string; continuo?: boolean; autoFocus?: boolean }) {
  const [v, setV] = useState(''); const [cam, setCam] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onCodigo(v); setV(''); ref.current?.focus(); } }}>
        <input ref={ref} autoFocus={autoFocus} value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} style={{ flex: 1, minWidth: 0 }} aria-label="Código lido" inputMode="text" autoComplete="off" />
        <button type="button" className="btn" onClick={() => setCam(true)} aria-label="Ler com a câmera">📷</button>
        <button className="btn primary">OK</button>
      </form>
      {cam && <LeitorCamera continuo={continuo} onLer={(c) => { onCodigo(c); if (!continuo) setCam(false); }} onClose={() => setCam(false)} />}
    </>
  );
}
