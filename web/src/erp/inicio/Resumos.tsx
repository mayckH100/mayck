/**
 * Aba "Resumo" do MCK ERP (v1.50.0): o Início da v1.37 (BI dos últimos 30 dias, números do dia, atalhos e
 * "Precisa de atenção"), agora como uma aba do layout antigo. Lê só o que a API já entrega (nenhuma rota nova).
 * Cada consulta respeita a permissão de área do usuário (não pede o que daria 403).
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { useApi } from '../../ui';
import { brl } from '../format';
import { podeArea, type ErpAreaPerm } from '../ErpNav';
import { Kpi, Kpis, Pendencias, type Pendencia } from '../pagina';
import { contarVendas, contarCompras, solicitacoesEmAprovacao, contarReposicao, vencido, contarFiscal } from './contagens';

function usePode() {
  const { hasModule, can } = useAuth();
  return { area: (a?: ErpAreaPerm) => podeArea(a, hasModule), mod: hasModule, can };
}
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** Consultas compartilhadas (cada tela pede só as suas). */
function useVendas(on: boolean) { return useApi<any[]>(on ? '/erp/vendas/pedidos' : null, [on]); }
function useDia(on: boolean) { return useApi<any>(on ? '/erp/relatorios/dia' : null, [on]); }
function useOcs(on: boolean) { return useApi<any[]>(on ? '/erp/compras/pedidos' : null, [on]); }
function useSolic(on: boolean) { return useApi<any[]>(on ? '/erp/compras/solicitacoes' : null, [on]); }
function useAvisos(on: boolean) { return useApi<any>(on ? '/erp/compras/avisos?naoLidos=1' : null, [on]); }
function useReposicao(on: boolean) { return useApi<any>(on ? '/erp/compras/o-que-comprar' : null, [on]); }
function useFin(on: boolean) { return useApi<any>(on ? '/erp/financeiro/painel' : null, [on]); }
function useNfe(on: boolean) { return useApi<any[]>(on ? '/erp/fiscal/nfe' : null, [on]); }
function useInvPend(on: boolean) { return useApi<any[]>(on ? '/erp/estoque/inventarios/pendentes' : null, [on]); }
const isoBr = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
/** Mesmo período padrão da tela do BI (últimos 30 dias). */
function useBi(on: boolean) {
  const de = isoBr(new Date(Date.now() - 29 * 86_400_000)); const ate = isoBr(new Date());
  return useApi<any>(on ? `/erp/bi/resumo?de=${de}&ate=${ate}` : null, [on, de, ate]);
}
const pctBp = (bp: number | undefined) => (bp === undefined || bp === null ? '–' : `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

/**
 * v1.37.1 (dono: "o BI saiu, não estou achando"): os Indicadores (BI) aparecem logo no topo do Início, com um botão
 * grande para a tela completa.
 */
function BiNoInicio() {
  const bi = useBi(true);
  const d = bi.data;
  return (
    <section className="card bi-inicio" aria-label="Indicadores (BI)" data-testid="erp-inicio-bi">
      <div className="bi-inicio-topo"><h2>📊 Indicadores (BI)</h2><span className="small muted">últimos 30 dias</span></div>
      {bi.error ? <div className="small muted">Não foi possível carregar os indicadores agora.</div> : (
        <Kpis>
          <Kpi rotulo="Receita" valor={brl(d?.vendas?.receitaCents)} detalhe={d ? plural(d.vendas.pedidos, 'pedido', 'pedidos') : undefined} to="/erp/bi" carregando={bi.loading} />
          <Kpi rotulo="Margem bruta" valor={pctBp(d?.vendas?.margemBrutaBp)} detalhe={d ? brl(d.vendas.margemBrutaCents) : undefined} to="/erp/bi" carregando={bi.loading} />
          <Kpi rotulo="Estoque (custo)" valor={brl(d?.estoque?.valorCents)} detalhe={d ? (d.estoque.coberturaDias !== null ? `cobre ${d.estoque.coberturaDias} dias` : 'sem venda no período') : undefined} to="/erp/bi" carregando={bi.loading} />
          <Kpi rotulo="Inadimplência" valor={pctBp(d?.financeiro?.inadimplenciaBp)} detalhe={d ? `vencido ${brl(d.financeiro.receberVencidoCents)}` : undefined} to="/erp/bi" tom={(d?.financeiro?.inadimplenciaBp ?? 0) > 0 ? 'alerta' : 'neutro'} carregando={bi.loading} />
        </Kpis>
      )}
      <Link className="bi-inicio-mais" to="/erp/bi" data-testid="erp-inicio-bi-abrir">Ver todos os indicadores (BI) <span aria-hidden>›</span></Link>
    </section>
  );
}

/** Início do ERP (tela principal): o dia em números e tudo o que precisa de atenção, de todas as áreas liberadas. */
export function InicioErp() {
  const p = usePode();
  const rel = p.area('erp_relatorios') && p.mod('erp_relatorios');
  const dia = useDia(rel);
  const vendas = useVendas(p.area('erp_vendas'));
  const ocs = useOcs(p.area('erp_compras'));
  const solic = useSolic(p.area('erp_compras'));
  const rep = useReposicao(p.area('erp_compras') || p.area('erp_estoque'));
  const fin = useFin(p.area('erp_financeiro'));
  const nfe = useNfe(p.area('erp_financeiro'));
  const inv = useInvPend(p.area('erp_estoque') && p.can('OWNER', 'ADMIN'));
  const biOk = p.area('erp_relatorios');
  const av = useAvisos(p.area('erp_compras'));
  const v = contarVendas(vendas.data ?? []);
  const c = contarCompras(ocs.data ?? []);
  const r = contarReposicao(rep.data);
  const f = contarFiscal(nfe.data ?? []);
  const pend: Pendencia[] = [
    { icone: '⏰', texto: 'Ordens de compra atrasadas', n: c.atrasadas, to: '/erp/compras/ordens?filtro=atrasados', tom: 'perigo' },
    { icone: '💸', texto: 'Contas a pagar vencidas', n: fin.data && vencido(fin.data.pagar) > 0 ? 1 : 0, valor: fin.data ? brl(vencido(fin.data.pagar)) : undefined, to: '/erp/financeiro/pagar', tom: 'perigo' },
    { icone: '📉', texto: 'Produtos zerados ou abaixo do mínimo', n: r.itens, to: '/erp/compras/o-que-comprar' },
    { icone: '✍️', texto: 'Compras aguardando aprovação', n: c.aprovacaoOc + solicitacoesEmAprovacao(solic.data ?? []), to: '/erp/compras/ordens?filtro=aprovacao' },
    { icone: '🧾', texto: 'Pedidos de venda aguardando aprovação', n: v.aprovacao, to: '/erp/pedidos?grupo=aprovacao' },
    { icone: '📦', texto: 'Pedidos para separar ou faturar', n: v.separacao + v.aFaturar, to: '/erp/pedidos?grupo=separacao', tom: 'neutro' },
    { icone: '📋', texto: 'Inventário aguardando sua aprovação', n: inv.data?.length ?? 0, to: '/erp/estoque/inventario' },
    { icone: '⚠️', texto: 'NF-e rejeitadas ou sem transmitir', n: f.rejeitadas + f.semTransmitir, to: '/erp/fiscal/notas', tom: 'perigo' },
    { icone: '🔔', texto: 'Avisos de compras não lidos', n: av.data?.naoLidos ?? 0, to: '/erp/compras/avisos', tom: 'neutro' },
    { icone: '💰', texto: 'Contas a receber vencidas', n: fin.data && vencido(fin.data.receber) > 0 ? 1 : 0, valor: fin.data ? brl(vencido(fin.data.receber)) : undefined, to: '/erp/financeiro/receber' },
  ];
  const carregando = [dia, vendas, ocs, rep, fin].some((s) => s.loading);
  return (
    <div className="page erp-resumo" data-testid="erp-inicio">
      <div className="page-head"><div><h1>Resumo</h1><p className="muted">O dia da empresa em um lugar: números principais e o que precisa de atenção.</p></div>
        {p.mod('erp_vendas') && p.area('erp_vendas') && <Link className="btn primary" to="/erp/balcao">Venda balcão</Link>}</div>
      {biOk && <BiNoInicio />}
      <Kpis>
        {rel && <Kpi rotulo="Vendido hoje" valor={brl(dia.data?.vendas?.totalCents)} detalhe={dia.data ? plural(dia.data.vendas.pedidos, 'venda', 'vendas') : undefined} to="/erp/relatorios" carregando={dia.loading} />}
        {p.area('erp_financeiro') && <Kpi rotulo="Saldo em contas" valor={brl(fin.data?.saldoCents)} to="/erp/financeiro" carregando={fin.loading} tom={(fin.data?.saldoCents ?? 0) < 0 ? 'perigo' : 'neutro'} />}
        {p.area('erp_compras') && <Kpi rotulo="Compras atrasadas" valor={c.atrasadas} to="/erp/compras/ordens?filtro=atrasados" tom={c.atrasadas ? 'perigo' : 'ok'} carregando={ocs.loading} />}
        {(p.area('erp_compras') || p.area('erp_estoque')) && <Kpi rotulo="Para comprar" valor={r.itens} detalhe={r.totalCents ? brl(r.totalCents) : r.itens ? undefined : 'estoque em dia'} to="/erp/compras/o-que-comprar" tom={r.zerados ? 'alerta' : 'neutro'} carregando={rep.loading} />}
        {p.area('erp_vendas') && !rel && <Kpi rotulo="Pedidos em andamento" valor={v.aprovacao + v.separacao + v.aFaturar + v.aguardandoEstoque} to="/erp/pedidos" carregando={vendas.loading} />}
      </Kpis>
      <nav className="atalhos-inicio" aria-label="Atalhos" data-testid="erp-inicio-atalhos">
        {biOk && <Link to="/erp/bi">📊 Indicadores (BI)</Link>}
        {rel && <Link to="/erp/relatorios">📄 Relatório do dia</Link>}
        {p.area('erp_compras') && <Link to="/erp/compras/avisos">🔔 Avisos de compras{av.data?.naoLidos ? <span className="n">{av.data.naoLidos}</span> : null}</Link>}
        {(p.area('erp_compras') || p.area('erp_estoque')) && <Link to="/erp/compras/o-que-comprar">🛒 O que comprar</Link>}
      </nav>
      <Pendencias itens={pend} carregando={carregando} />
    </div>
  );
}
