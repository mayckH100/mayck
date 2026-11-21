/**
 * "Ler código" do MCK ERP (v1.34.0). v1.35.0 (pedido do dono): deixa de ser botão solto na barra e vira subitem de
 * Venda balcão (/erp/balcao/ler). A tecla F2 continua abrindo o leitor em qualquer tela do ERP. Lê com o leitor, a
 * câmera ou digitação e abre o lugar certo: pedido (PV-…), nota (chave do DANFE), lote (etiqueta) ou produto.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../../api';
import { Modal } from '../../ui';
import { CampoLeitura } from './Leitor';
import { Ajuda } from '../pagina';
import { Voltar } from '../Voltar';

const AJUDA = 'Leia o código do pedido, recibo ou romaneio, a etiqueta do lote, o código de barras do produto ou a chave da nota (DANFE). Também pode digitar.';

function useAbrirLeitura(depois?: () => void) {
  const nav = useNavigate();
  return async (c: string) => {
    const r = await get<any>(`/erp/leitura?codigo=${encodeURIComponent(c)}`);
    depois?.();
    nav(r.destino);
    return { ok: r.tipo !== 'localizar', msg: r.titulo };
  };
}

/** Tecla F2 em qualquer tela do ERP: abre o leitor numa janela (sem botão na barra). */
export function AtalhoLerCodigo() {
  const [aberto, setAberto] = useState(false);
  const abrir = useAbrirLeitura(() => setAberto(false));
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'F2') { e.preventDefault(); setAberto(true); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  if (!aberto) return null;
  return <Modal title="Ler código (F2)" onClose={() => setAberto(false)}>
    <p className="small muted" style={{ marginTop: 0 }}>{AJUDA}</p>
    <CampoLeitura continuo={false} onCodigo={abrir} />
  </Modal>;
}

/** Tela Venda balcão › Ler código (/erp/balcao/ler). */
export default function LerCodigoPagina() {
  const abrir = useAbrirLeitura();
  return <>
    <div className="page-head erp-cab"><div className="erp-titulo"><Voltar /><h1>📷 Ler código</h1><Ajuda>{AJUDA} Dica: a tecla <b>F2</b> abre o leitor em qualquer tela do ERP.</Ajuda></div></div>
    <div className="card" data-testid="ler-codigo"><CampoLeitura continuo={false} onCodigo={abrir} /></div>
  </>;
}
