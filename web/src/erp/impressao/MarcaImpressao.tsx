/**
 * v1.54.0 — para telas impressas direto (window.print da própria tela, ex.: Rastreio de lote): cabeçalho da empresa e
 * rodapé da MCK que só aparecem no papel/PDF (escondidos na tela).
 */
import { useEffect, useState } from 'react';
import type { ConfigDocumento } from '../../../../server/erp/shared/documento';
import { configDocumento } from './cabecalho';
import { cabecalhoHtml, rodapeHtml } from './modelo';

export function CabecalhoImpressao() {
  const [c, setC] = useState<ConfigDocumento | null>(null);
  useEffect(() => { let vivo = true; configDocumento().then((x) => { if (vivo) setC(x); }); return () => { vivo = false; }; }, []);
  // cabecalhoHtml escapa todo texto e só aceita logo em data URL de imagem.
  return <div className="so-impressao" dangerouslySetInnerHTML={{ __html: cabecalhoHtml(c, 'a4') }} />;
}
export function RodapeImpressao() {
  return <div className="so-impressao mck-rodape-tela" dangerouslySetInnerHTML={{ __html: rodapeHtml() }} />;
}
