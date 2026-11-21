/**
 * Telas-resumo das áreas do MCK ERP (v1.37.0): 3 a 5 indicadores, "Precisa de atenção" com atalhos e, no celular,
 * a lista das subcategorias. Lê só o que a API já entrega (nenhuma rota nova). Cada consulta respeita a permissão
 * de área do usuário (não pede o que daria 403).
 */
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { useApi } from '../../ui';
import { brl } from '../format';
import { AREAS, podeArea, podeItem, type AreaId, type ErpAreaPerm } from '../ErpNav';
import { Cabecalho, Kpi, Kpis, Pendencias, ListaSubcategorias, type Pendencia } from '../pagina';
import { contarVendas, contarCompras, solicitacoesEmAprovacao, contarReposicao, contarLotes, vencido, proximosDias, menorSaldo, contarProducao, contarFiscal, diasCertificado } from './contagens';
import { AvisoInventarios } from '../estoque/Estoque';

const area = (id: AreaId) => AREAS.find((a) => a.id === id)!;
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
  const { hasModule, can } = useAuth();
  const areas = AREAS.filter((a) => a.id !== 'inicio' && podeArea(a.area, hasModule) && (a.subs.some((s) => podeItem({ ...s, area: s.area ?? a.area }, hasModule, can))));
  return (
    <div className="erp-resumo" data-testid="erp-inicio">
      <Cabecalho titulo="Início" ajuda={area('inicio').ajuda} acao={p.mod('erp_vendas') && p.area('erp_vendas') ? <Link className="btn primary" to="/erp/balcao">Venda balcão</Link> : undefined} />
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
      <nav className="erp-areas so-celular" aria-label="Áreas do MCK ERP" data-testid="erp-areas">
        {areas.map((a) => <Link key={a.id} to={a.home} className="erp-area-tile"><span aria-hidden className="erp-area-ico">{a.icon}</span><span>{a.label}</span></Link>)}
      </nav>
    </div>
  );
}

export function VendasResumo() {
  const p = usePode();
  const rel = p.area('erp_relatorios') && p.mod('erp_relatorios');
  const pode = p.area('erp_vendas');
  const vendas = useVendas(pode);
  const dia = useDia(rel);
  const v = contarVendas(vendas.data ?? []);
  return (
    <div className="erp-resumo" data-testid="erp-resumo-vendas">
      <Cabecalho titulo="Vendas" ajuda={area('vendas').ajuda} acao={pode && p.mod('erp_vendas') ? <Link className="btn primary" to="/erp/balcao">Venda balcão</Link> : undefined} />
      <Kpis>
        {rel && <Kpi rotulo="Vendido hoje" valor={brl(dia.data?.vendas?.totalCents)} detalhe={dia.data?.vendas?.balcao ? `${dia.data.vendas.balcao} no balcão` : undefined} to="/erp/relatorios" carregando={dia.loading} />}
        {pode && <Kpi rotulo="Orçamentos abertos" valor={v.orcamentos} to="/erp/pedidos?grupo=orcamentos" carregando={vendas.loading} />}
        {pode && <Kpi rotulo="Aguardando aprovação" valor={v.aprovacao} to="/erp/pedidos?grupo=aprovacao" tom={v.aprovacao ? 'alerta' : 'neutro'} carregando={vendas.loading} />}
        {pode && <Kpi rotulo="Para separar ou faturar" valor={v.separacao + v.aFaturar} to="/erp/pedidos?grupo=separacao" carregando={vendas.loading} />}
      </Kpis>
      <Pendencias carregando={vendas.loading} itens={[
        { icone: '✍️', texto: 'Pedidos aguardando aprovação', n: v.aprovacao, to: '/erp/pedidos?grupo=aprovacao' },
        { icone: '⏳', texto: 'Pedidos aguardando estoque', n: v.aguardandoEstoque, to: '/erp/pedidos?grupo=estoque' },
        { icone: '📦', texto: 'Pedidos para separar', n: v.separacao, to: '/erp/pedidos?grupo=separacao', tom: 'neutro' },
        { icone: '🧾', texto: 'Pedidos separados para faturar', n: v.aFaturar, to: '/erp/pedidos?grupo=separacao', tom: 'neutro' },
      ]} />
      <ListaSubcategorias area={area('vendas')} />
    </div>
  );
}

export function ComprasResumo() {
  const ocs = useOcs(true); const solic = useSolic(true); const av = useAvisos(true); const rep = useReposicao(true);
  const c = contarCompras(ocs.data ?? []); const r = contarReposicao(rep.data); const sol = solicitacoesEmAprovacao(solic.data ?? []);
  return (
    <div className="erp-resumo" data-testid="erp-resumo-compras">
      <Cabecalho titulo="Compras" ajuda={area('compras').ajuda} acao={<Link className="btn primary" to="/erp/compras/o-que-comprar">O que comprar</Link>} />
      <Kpis>
        <Kpi rotulo="Atrasadas" valor={c.atrasadas} to="/erp/compras/ordens?filtro=atrasados" tom={c.atrasadas ? 'perigo' : 'ok'} carregando={ocs.loading} />
        <Kpi rotulo="Chegam em breve" valor={c.emBreve} to="/erp/compras/ordens?filtro=em_breve" tom={c.emBreve ? 'alerta' : 'neutro'} carregando={ocs.loading} />
        <Kpi rotulo="Em andamento" valor={c.emAndamento} detalhe={c.emAndamento ? brl(c.valorAbertoCents) : undefined} to="/erp/compras/ordens" carregando={ocs.loading} />
        <Kpi rotulo="Para comprar" valor={r.itens} detalhe={r.totalCents ? brl(r.totalCents) : r.itens ? undefined : 'estoque em dia'} to="/erp/compras/o-que-comprar" tom={r.zerados ? 'alerta' : 'neutro'} carregando={rep.loading} />
      </Kpis>
      <Pendencias carregando={ocs.loading} itens={[
        { icone: '⏰', texto: 'Ordens de compra atrasadas', n: c.atrasadas, to: '/erp/compras/ordens?filtro=atrasados', tom: 'perigo' },
        { icone: '✍️', texto: 'Ordens aguardando aprovação', n: c.aprovacaoOc, to: '/erp/compras/ordens?filtro=aprovacao' },
        { icone: '📝', texto: 'Solicitações aguardando aprovação', n: sol, to: '/erp/compras/solicitacoes' },
        { icone: '🚚', texto: 'Recebimento: NF, qualidade ou conferência', n: c.recebimento, to: '/erp/compras/ordens?filtro=recebimento', tom: 'neutro' },
        { icone: '🔴', texto: 'Produtos zerados', n: r.zerados, to: '/erp/compras/o-que-comprar', tom: 'perigo' },
        { icone: '🔔', texto: 'Avisos não lidos', n: av.data?.naoLidos ?? 0, to: '/erp/compras/avisos', tom: 'neutro' },
      ]} />
      <ListaSubcategorias area={area('compras')} />
    </div>
  );
}

export function EstoqueResumo() {
  const p = usePode();
  const rep = useReposicao(true);
  const lotes = useApi<any[]>('/erp/estoque/lotes-saldo');
  const inv = useInvPend(p.can('OWNER', 'ADMIN'));
  const r = contarReposicao(rep.data); const l = contarLotes(lotes.data ?? []);
  const nav = useNavigate();
  return (
    <div className="erp-resumo" data-testid="erp-resumo-estoque">
      {p.can('OWNER', 'ADMIN') && <AvisoInventarios onAbrir={() => nav('/erp/estoque/inventario')} />}
      <Cabecalho titulo="Estoque" ajuda={area('estoque').ajuda} acao={<Link className="btn primary" to="/erp/estoque/saldos?entrada=1">+ Entrada</Link>} />
      <Kpis>
        <Kpi rotulo="Zerados" valor={r.zerados} to="/erp/compras/o-que-comprar" tom={r.zerados ? 'perigo' : 'ok'} carregando={rep.loading} />
        <Kpi rotulo="Abaixo do mínimo" valor={r.abaixoMinimo} to="/erp/compras/o-que-comprar" tom={r.abaixoMinimo ? 'alerta' : 'ok'} carregando={rep.loading} />
        <Kpi rotulo="Lotes vencendo (30 dias)" valor={l.vencendo} detalhe={l.vencidos ? `${l.vencidos} vencido(s)` : undefined} to="/erp/estoque/lotes" tom={l.vencidos ? 'perigo' : l.vencendo ? 'alerta' : 'neutro'} carregando={lotes.loading} />
        <Kpi rotulo="Lotes com saldo" valor={l.total} to="/erp/estoque/lotes" carregando={lotes.loading} />
      </Kpis>
      <Pendencias carregando={rep.loading || lotes.loading} itens={[
        { icone: '🔴', texto: 'Produtos zerados', n: r.zerados, to: '/erp/compras/o-que-comprar', tom: 'perigo' },
        { icone: '📉', texto: 'Produtos abaixo do mínimo', n: r.abaixoMinimo, to: '/erp/compras/o-que-comprar' },
        { icone: '⛔', texto: 'Lotes vencidos com saldo', n: l.vencidos, to: '/erp/estoque/lotes', tom: 'perigo' },
        { icone: '⏳', texto: 'Lotes vencendo em 30 dias', n: l.vencendo, to: '/erp/estoque/lotes' },
        { icone: '🔒', texto: 'Lotes em quarentena ou bloqueados', n: l.bloqueados, to: '/erp/estoque/lotes', tom: 'neutro' },
        { icone: '📋', texto: 'Inventário aguardando aprovação', n: inv.data?.length ?? 0, to: '/erp/estoque/inventario' },
      ]} />
      <ListaSubcategorias area={area('estoque')} />
    </div>
  );
}

export function ProducaoResumo() {
  const ops = useApi<any[]>('/erp/producao/ops');
  const c = contarProducao(ops.data ?? []);
  return (
    <div className="erp-resumo" data-testid="erp-resumo-producao">
      <Cabecalho titulo="Produção" ajuda={area('producao').ajuda} acao={<Link className="btn primary" to="/erp/producao/ordens?nova=1">+ Ordem de produção</Link>} />
      <Kpis>
        <Kpi rotulo="Planejadas" valor={c.planejadas} to="/erp/producao/ordens" carregando={ops.loading} />
        <Kpi rotulo="Liberadas" valor={c.liberadas} to="/erp/producao/ordens" carregando={ops.loading} />
        <Kpi rotulo="Em produção" valor={c.emProducao} to="/erp/producao/ordens" carregando={ops.loading} />
        <Kpi rotulo="Atrasadas" valor={c.atrasadas} to="/erp/producao/ordens" tom={c.atrasadas ? 'perigo' : 'ok'} carregando={ops.loading} />
      </Kpis>
      <Pendencias carregando={ops.loading} itens={[
        { icone: '⏰', texto: 'Ordens de produção atrasadas', n: c.atrasadas, to: '/erp/producao/ordens', tom: 'perigo' },
        { icone: '▶️', texto: 'Ordens liberadas para começar', n: c.liberadas, to: '/erp/producao/ordens', tom: 'neutro' },
        { icone: '📝', texto: 'Ordens planejadas para liberar', n: c.planejadas, to: '/erp/producao/ordens', tom: 'neutro' },
      ]} />
      <ListaSubcategorias area={area('producao')} />
    </div>
  );
}

export function FinanceiroResumo() {
  const fin = useFin(true);
  const d = fin.data;
  const prox = proximosDias(d?.fluxo, 7);
  const venceP = vencido(d?.pagar); const venceR = vencido(d?.receber);
  const menor = menorSaldo(d?.fluxo);
  return (
    <div className="erp-resumo" data-testid="erp-resumo-financeiro">
      <Cabecalho titulo="Financeiro" ajuda={area('financeiro').ajuda} acao={<Link className="btn primary" to="/erp/financeiro/pagar?nova=1">+ Conta a pagar</Link>} />
      <Kpis>
        <Kpi rotulo="Saldo em contas" valor={brl(d?.saldoCents)} to="/erp/financeiro/contas" tom={(d?.saldoCents ?? 0) < 0 ? 'perigo' : 'neutro'} carregando={fin.loading} />
        <Kpi rotulo="A pagar vencido" valor={brl(venceP)} to="/erp/financeiro/pagar" tom={venceP ? 'perigo' : 'ok'} carregando={fin.loading} />
        <Kpi rotulo="A receber vencido" valor={brl(venceR)} to="/erp/financeiro/receber" tom={venceR ? 'alerta' : 'ok'} carregando={fin.loading} />
        <Kpi rotulo="Próximos 7 dias" valor={brl(prox.entradasCents - prox.saidasCents)} detalhe={`entra ${brl(prox.entradasCents)} · sai ${brl(prox.saidasCents)}`} to="/erp/financeiro/fluxo" carregando={fin.loading} />
        <Kpi rotulo="Menor saldo (30 dias)" valor={brl(menor)} to="/erp/financeiro/fluxo" tom={menor < 0 ? 'perigo' : 'neutro'} carregando={fin.loading} />
      </Kpis>
      <Pendencias carregando={fin.loading} itens={[
        { icone: '💸', texto: 'Contas a pagar vencidas', n: venceP ? 1 : 0, valor: brl(venceP), to: '/erp/financeiro/pagar', tom: 'perigo' },
        { icone: '💰', texto: 'Contas a receber vencidas', n: venceR ? 1 : 0, valor: brl(venceR), to: '/erp/financeiro/receber' },
        { icone: '📉', texto: 'Saldo fica negativo nos próximos 30 dias', n: menor < 0 ? 1 : 0, valor: brl(menor), to: '/erp/financeiro/fluxo', tom: 'perigo' },
      ]} />
      <ListaSubcategorias area={area('financeiro')} />
    </div>
  );
}

export function FiscalResumo() {
  const nfe = useNfe(true);
  const cfg = useApi<any>('/erp/fiscal/config');
  const f = contarFiscal(nfe.data ?? []);
  const dc = diasCertificado(cfg.data?.certValidade);
  const semCert = cfg.data && !cfg.data.temCertificado;
  return (
    <div className="erp-resumo" data-testid="erp-resumo-fiscal">
      <Cabecalho titulo="Fiscal" ajuda={area('fiscal').ajuda} acao={<Link className="btn primary" to="/erp/fiscal/notas">NF-e emitidas</Link>} />
      <Kpis>
        <Kpi rotulo="Autorizadas no mês" valor={f.autorizadasMes} detalhe={f.autorizadasMes ? brl(f.valorMesCents) : undefined} to="/erp/fiscal/notas" carregando={nfe.loading} />
        <Kpi rotulo="Rejeitadas" valor={f.rejeitadas} to="/erp/fiscal/notas" tom={f.rejeitadas ? 'perigo' : 'ok'} carregando={nfe.loading} />
        <Kpi rotulo="Sem transmitir" valor={f.semTransmitir} to="/erp/fiscal/notas" tom={f.semTransmitir ? 'alerta' : 'ok'} carregando={nfe.loading} />
        <Kpi rotulo="Certificado A1" valor={semCert ? 'Não enviado' : dc === null ? '—' : dc < 0 ? 'Vencido' : `${dc} dias`} detalhe={cfg.data ? (cfg.data.ambiente === 1 ? 'produção' : 'homologação') : undefined} to="/erp/fiscal/emitente" tom={semCert || (dc !== null && dc < 30) ? 'alerta' : 'neutro'} carregando={cfg.loading} />
      </Kpis>
      <Pendencias carregando={nfe.loading} itens={[
        { icone: '⚠️', texto: 'NF-e rejeitadas', n: f.rejeitadas, to: '/erp/fiscal/notas', tom: 'perigo' },
        { icone: '📤', texto: 'NF-e assinadas sem transmitir', n: f.semTransmitir, to: '/erp/fiscal/notas' },
        { icone: '🔐', texto: semCert ? 'Enviar o certificado A1' : 'Certificado A1 vence em menos de 30 dias', n: semCert || (dc !== null && dc < 30) ? 1 : 0, to: '/erp/fiscal/emitente' },
      ]} />
      <ListaSubcategorias area={area('fiscal')} />
    </div>
  );
}

export function ConfigResumo() {
  const p = usePode();
  const outras = [
    { to: '/erp/compras/configuracoes', label: 'Compras › Prazos e avisos', ok: p.area('erp_compras') },
    { to: '/erp/estoque/depositos', label: 'Estoque › Depósitos e endereços', ok: p.area('erp_estoque') },
    { to: '/erp/fiscal/emitente', label: 'Fiscal › Emitente e certificado', ok: p.area('erp_financeiro') },
  ].filter((o) => o.ok);
  return (
    <div className="erp-resumo" data-testid="erp-resumo-config">
      <Cabecalho titulo="Configurações" ajuda={area('config').ajuda} />
      <ListaSubcategorias area={area('config')} sempre />
      {outras.length > 0 && <nav className="card erp-sublista" aria-label="Configurações de outras áreas">
        {outras.map((o) => <Link key={o.to} to={o.to}><span>{o.label}</span><span aria-hidden>›</span></Link>)}
      </nav>}
    </div>
  );
}
