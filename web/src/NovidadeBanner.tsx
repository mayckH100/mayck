import { useEffect, useState } from 'react';
import { get } from './api';
import { gravarFechada, lerFechada, novidadeHref, novidadeParaBanner, type NovidadeResumo } from './novidadeBanner';

/** Faixa discreta no topo do app (MCKBOT e MCK Mensagens) com a novidade mais recente do site. O usuário pode fechar. */
export default function NovidadeBanner({ base = '' }: { base?: string }) {
  const [item, setItem] = useState<NovidadeResumo | null>(null);
  useEffect(() => {
    let stop = false;
    get<{ items: NovidadeResumo[] }>('/novidades?limit=1')
      .then((r) => { if (!stop) setItem(novidadeParaBanner(r?.items, Date.now(), lerFechada)); })
      .catch(() => undefined);
    return () => { stop = true; };
  }, []);
  if (!item) return null;
  const fechar = () => { gravarFechada(item.id); setItem(null); };
  return (
    <div className="novidade-banner" role="region" aria-label="Novidade" data-testid="novidade-banner">
      <span className="nb-txt"><strong>Novidade:</strong> {item.title}</span>
      <a href={novidadeHref(item.id, base)} target="_blank" rel="noopener" data-sub-exempt>Ver →</a>
      <button type="button" className="nb-close" aria-label="Fechar aviso de novidade" data-sub-exempt onClick={fechar}>×</button>
    </div>
  );
}
