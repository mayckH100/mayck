/**
 * "Ler código" de qualquer tela do MCK ERP (v1.34.0): botão na barra do ERP (e tecla F2). Lê com o leitor, a câmera
 * ou digitação e abre o lugar certo: pedido (PV-…), nota (chave do DANFE), lote (etiqueta) ou produto.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../../api';
import { Modal } from '../../ui';
import { CampoLeitura } from './Leitor';

export function BotaoLerCodigo() {
  const [aberto, setAberto] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'F2') { e.preventDefault(); setAberto(true); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  return <>
    <button type="button" className="erp-ler" onClick={() => setAberto(true)} title="Ler código de barras / QR (F2)" data-testid="ler-codigo">📷 Ler código</button>
    {aberto && <Modal title="Ler código" onClose={() => setAberto(false)}>
      <p className="small muted" style={{ marginTop: 0 }}>Leia o código do pedido, recibo ou romaneio, a etiqueta do lote, o código de barras do produto ou a chave da nota (DANFE). Também pode digitar.</p>
      <CampoLeitura continuo={false} onCodigo={async (c) => { const r = await get<any>(`/erp/leitura?codigo=${encodeURIComponent(c)}`); setAberto(false); nav(r.destino); return { ok: r.tipo !== 'localizar', msg: r.titulo }; }} />
    </Modal>}
  </>;
}
