/**
 * MCK ERP só no Plano Completo (ERP + MCKBOT + MCK Mensagens), ativo ou em teste (v1.17.0).
 * v1.25.0: vale qualquer plano com o módulo MCK ERP marcado no Painel Master; o servidor manda os planos à venda.
 * Sem ele, as telas do ERP dão lugar a um aviso com o botão de upgrade. Os dados já lançados continuam
 * disponíveis para baixar (planilhas, pedidos e NF-e emitidas): o cliente nunca fica preso.
 * Superadmin (Master) sempre entra. A regra de verdade está no servidor (402 em /api/erp).
 */
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useApi, Loading } from '../ui';

export interface ErpAcesso { liberado: boolean; planoCompleto: boolean; superAdmin: boolean; motivo: string | null; planos?: { id: string; name: string }[] }
interface NfeResumo { id: string; numero: number; serie: number; status: string; chave: string | null; destinatario?: string; createdAt: string }

/** Data (AAAA-MM-DD, Brasília) de `dias` atrás: o BI exporta no máximo 400 dias. */
function diaBr(diasAtras = 0) {
  return new Date(Date.now() - diasAtras * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

export function ErpBloqueado({ motivo, planos }: { motivo?: string | null; planos?: { id: string; name: string }[] }) {
  const nfes = useApi<NfeResumo[]>('/erp/fiscal/nfe');
  const periodo = `de=${diaBr(399)}&ate=${diaBr(0)}`;
  const baixar: { href: string; label: string }[] = [
    { href: '/api/erp/io/clientes/exportar', label: 'Clientes' },
    { href: '/api/erp/io/fornecedores/exportar', label: 'Fornecedores' },
    { href: '/api/erp/io/produtos/exportar', label: 'Produtos' },
    { href: `/api/erp/bi/exportar?tipo=pedidos&${periodo}`, label: 'Pedidos' },
    { href: `/api/erp/bi/exportar?tipo=produtos&${periodo}`, label: 'Produtos vendidos' },
  ];
  const lista = (nfes.data ?? []).filter((n) => n.chave);
  return (
    <div className="stack" data-testid="erp-bloqueado" style={{ maxWidth: 760 }}>
      <div className="card stack" style={{ borderColor: 'var(--brand-2)' }}>
        <h1 style={{ margin: 0 }}>{!planos ? 'O ERP faz parte do Plano Completo' : planos.length ? `O ERP faz parte do ${/^plano\b/i.test(planos[0].name) ? '' : 'plano '}${planos[0].name}` : 'O MCK ERP não está no seu plano'}</h1>
        <p style={{ margin: 0 }}>{motivo || 'O MCK ERP (vendas, estoque, compras, financeiro, fiscal e BI) está disponível no Plano Completo: MCK ERP + MCKBOT + MCK Mensagens, com uma só cobrança.'}</p>
        <p className="small muted" style={{ margin: 0 }}>Seus dados do ERP continuam guardados. Ao fazer o upgrade, tudo volta a aparecer como estava.</p>
        <div className="row" style={{ gap: 8 }}>
          {!planos ? <NavLink className="btn primary" to="/plano?plano=COMBO" data-sub-exempt>Fazer upgrade para o Plano Completo</NavLink>
            : planos.map((p) => <NavLink key={p.id} className="btn primary" to={`/plano?plano=${p.id}`} data-sub-exempt>Fazer upgrade: {p.name}</NavLink>)}
        </div>
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Baixar meus dados</h2>
        <p className="small muted" style={{ margin: 0 }}>Você pode baixar a qualquer momento o que já lançou no ERP (planilhas CSV).</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {baixar.map((b) => <a key={b.href} className="btn sm" href={b.href} download data-sub-exempt>{b.label}</a>)}
        </div>
        {lista.length > 0 && (
          <>
            <h3 style={{ margin: '8px 0 0' }}>Notas fiscais emitidas (XML)</h3>
            <div className="stack" style={{ gap: 4 }}>
              {lista.map((n) => (
                <div key={n.id} className="row between small">
                  <span>NF-e {n.numero} · série {n.serie}{n.destinatario ? ` · ${n.destinatario}` : ''} · {n.status.toLowerCase()}</span>
                  <a className="btn sm" href={`/api/erp/fiscal/nfe/${n.id}/xml`} download data-sub-exempt>Baixar XML</a>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function ErpGate({ children }: { children: ReactNode }) {
  const acesso = useApi<ErpAcesso>('/erp/acesso');
  if (!acesso.data && !acesso.error) return <Loading />;
  // Falha ao consultar (rede, 403 de permissão…): segue para a tela; o servidor continua barrando o que for preciso.
  if (!acesso.data || acesso.data.liberado) return <>{children}</>;
  return <ErpBloqueado motivo={acesso.data.motivo} planos={acesso.data.planos} />;
}
