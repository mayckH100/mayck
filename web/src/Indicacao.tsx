import { useApi, useToast, copy } from './ui';

interface Resumo {
  code: string; link: string; rewardDays: number; indicados: number; aguardando: number; mesesGanhos: number; diasGanhos: number;
  items: { empresa: string; status: 'PENDENTE' | 'CREDITADO' | 'RECUSADO' | 'ESTORNADO'; createdAt: string; creditedAt: string | null }[];
}

const STATUS: Record<string, string> = { PENDENTE: 'Aguardando o 1º pagamento', CREDITADO: '1 mês ganho', RECUSADO: 'Não vale (mesma pessoa/empresa)', ESTORNADO: 'Pagamento estornado' };

export const whatsappShareUrl = (link: string) =>
  `https://wa.me/?text=${encodeURIComponent(`Uso a MCK (MCKBOT e MCK Mensagens) para atender e vender pelo WhatsApp com IA. Crie sua conta e teste grátis: ${link}`)}`;

/** Cartão "Indique e ganhe" (Perfil do MCKBOT e Assinatura do MCK Mensagens). */
export function IndiqueGanheCard() {
  const st = useApi<Resumo>('/indicacao');
  const toast = useToast();
  const d = st.data;
  return (
    <div className="card stack" id="indique-e-ganhe" data-testid="indique-ganhe">
      <h2>🎁 Indique e ganhe</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Envie seu link para outras empresas. Quando uma delas fizer o <strong>primeiro pagamento</strong>, você ganha <strong>1 mês grátis</strong> (30 dias a mais no seu plano). Vale uma vez por empresa indicada.
      </p>
      {st.error && <div className="alert err small">Não foi possível carregar seu link agora.</div>}
      {d && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input readOnly value={d.link} aria-label="Seu link de indicação" onFocus={(e) => e.currentTarget.select()} style={{ flex: '1 1 260px' }} />
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" onClick={() => copy(d.link, toast)}>Copiar link</button>
            <a className="btn" href={whatsappShareUrl(d.link)} target="_blank" rel="noopener noreferrer">Compartilhar no WhatsApp</a>
          </div>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <div><div className="small muted">Empresas indicadas</div><strong style={{ fontSize: 22 }} data-testid="indicados">{d.indicados}</strong></div>
            <div><div className="small muted">Meses ganhos</div><strong style={{ fontSize: 22 }} data-testid="meses-ganhos">{d.mesesGanhos}</strong></div>
            {d.aguardando > 0 && <div><div className="small muted">Aguardando pagamento</div><strong style={{ fontSize: 22 }}>{d.aguardando}</strong></div>}
          </div>
          {d.items.length > 0 && (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {d.items.slice(0, 10).map((i, k) => (
                <li key={k}>{i.empresa} · {new Date(i.createdAt).toLocaleDateString('pt-BR')} · <span className="muted">{STATUS[i.status] ?? i.status}</span></li>
              ))}
            </ul>
          )}
          <p className="small muted" style={{ margin: 0 }}>Não vale indicar a si mesmo (mesmo e-mail, celular ou CPF/CNPJ). Se o pagamento da empresa indicada for estornado, o mês ganho é retirado.</p>
        </>
      )}
    </div>
  );
}
