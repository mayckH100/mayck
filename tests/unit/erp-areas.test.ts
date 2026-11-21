import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AREAS, ERP_ITENS, ROTAS_ANTIGAS, abaAtiva, areaDaRota, ehResumoDaArea, grupoAtivo, podeArea, rotuloDaRota } from '../../web/src/erp/ErpNav';
import { MODULOS, itensDoMenu, modulosVisiveis, type Acesso } from '../../web/src/modulos';
import { contarVendas, contarCompras, contarReposicao, contarLotes, vencido, proximosDias, menorSaldo, contarProducao, contarFiscal, diasCertificado, solicitacoesEmAprovacao } from '../../web/src/erp/inicio/contagens';

// v1.37.0 — pedido do dono: o ERP estava "muito poluído de informação"; quer "tela principal e subcategorias".
const app = readFileSync('web/src/App.tsx', 'utf8');
const rotaExiste = (r: string) => app.includes(`path="${r}"`);

describe('ERP · áreas → subcategorias', () => {
  it('poucas áreas principais, na ordem do pedido', () => {
    expect(AREAS.map((a) => a.label)).toEqual(['Início', 'Vendas', 'Compras', 'Estoque', 'Produção', 'Financeiro', 'Fiscal', 'Configurações']);
    expect(ERP_ITENS.filter((i) => !i.pai)).toHaveLength(8);
    for (const a of AREAS) {
      expect(a.subs.length, a.label).toBeGreaterThan(0);
      expect(rotaExiste(a.home), a.home).toBe(true);
      for (const s of a.subs) expect(rotaExiste(s.to), s.to).toBe(true);
    }
  });

  it('agrupa o que é relacionado (Rastreio dentro de Estoque; Prazos e avisos dentro de Compras)', () => {
    expect(grupoAtivo('/erp/rastreio')).toBe('/erp/estoque');
    expect(grupoAtivo('/erp/compras/configuracoes')).toBe('/erp/compras');
    expect(grupoAtivo('/erp/fornecedores/abc')).toBe('/erp/compras');
    expect(grupoAtivo('/erp/clientes/abc')).toBe('/erp/vendas');
    expect(grupoAtivo('/erp/produtos')).toBe('/erp/estoque');
    expect(grupoAtivo('/erp/caixa/x1')).toBe('/erp/vendas');
    expect(grupoAtivo('/erp/bi')).toBe('/erp');
    expect(grupoAtivo('/erp/funcionarios')).toBe('/erp/configuracoes');
    expect(grupoAtivo('/inbox')).toBeNull();
    expect(areaDaRota('/erp/financeiro/pagar')?.id).toBe('financeiro');
  });

  it('rotas antigas continuam funcionando (mesma rota ou redirecionamento)', () => {
    const antigas = ['/erp', '/erp/funil', '/erp/clientes', '/erp/fornecedores', '/erp/alertas', '/erp/produtos', '/erp/estoque', '/erp/rastreio', '/erp/pedidos',
      '/erp/balcao', '/erp/pedidos/localizar', '/erp/localizar', '/erp/balcao/ler', '/erp/compras', '/erp/producao', '/erp/financeiro', '/erp/fiscal', '/erp/maquininhas',
      '/erp/bi', '/erp/funcionarios', '/erp/relatorios', '/erp/caixa/:id', '/erp/pedidos/:id', '/erp/clientes/:id', '/erp/fornecedores/:id'];
    for (const r of antigas) expect(rotaExiste(r) || r in ROTAS_ANTIGAS, r).toBe(true);
    expect(ROTAS_ANTIGAS['/erp/localizar']).toBe('/erp/pedidos/localizar');
    // destino de cada redirecionamento é uma tela que existe
    for (const destino of Object.values(ROTAS_ANTIGAS)) expect(rotaExiste(destino), destino).toBe(true);
    expect(app).toContain('{Object.keys(ROTAS_ANTIGAS).map(');
    // links que o servidor manda no WhatsApp (alerta/OC) e o leitor de código continuam válidos
    for (const r of ['/erp/compras', '/erp/pedidos/localizar', '/erp/rastreio']) expect(rotaExiste(r)).toBe(true);
  });

  it('tela-resumo e rótulo do topo', () => {
    expect(ehResumoDaArea('/erp')).toBe(true);
    expect(ehResumoDaArea('/erp/compras')).toBe(true);
    expect(ehResumoDaArea('/erp/compras/ordens')).toBe(false);
    expect(rotuloDaRota('/erp/compras/ordens')).toBe('Compras › Ordens de compra');
    expect(rotuloDaRota('/erp/estoque')).toBe('Estoque');
    expect(abaAtiva('/erp/estoque/saldos')).toBe('/erp/estoque/saldos');
  });

  it('menu lateral: áreas sempre, subcategorias só da área aberta', () => {
    const erp = MODULOS.find((m) => m.id === 'erp')!;
    const naCompras = itensDoMenu(erp, '/erp/compras/ordens');
    expect(naCompras.filter((i) => !i.pai)).toHaveLength(8);
    // v1.37.1: subcategorias do Início (Indicadores (BI), Relatório do dia) sempre à vista
    expect(naCompras.filter((i) => i.pai).every((i) => i.pai === '/erp/compras' || i.pai === '/erp')).toBe(true);
    expect(naCompras.some((i) => i.to === '/erp/bi' && i.label === 'Indicadores (BI)')).toBe(true);
    expect(naCompras.some((i) => i.to === '/erp/compras/o-que-comprar')).toBe(true);
    expect(itensDoMenu(erp, '/erp/fornecedores/1').some((i) => i.to === '/erp/compras/ordens')).toBe(true);
    const bot = MODULOS.find((m) => m.id === 'bot')!;
    expect(itensDoMenu(bot, '/inbox')).toBe(bot.items);
  });

  it('permissão por área igual à do servidor: sem área marcada vê tudo; com áreas, só as suas', () => {
    expect(podeArea('erp_financeiro', () => false)).toBe(true);
    expect(podeArea('erp_financeiro', (m) => m === 'erp_vendas')).toBe(false);
    expect(podeArea('erp_vendas', (m) => m === 'erp_vendas')).toBe(true);
    expect(podeArea(undefined, (m) => m === 'erp_vendas')).toBe(true);
    const so = (mods: string[]): Acesso => ({ can: () => true, hasModule: (m) => mods.includes(m), superAdmin: false });
    const vend = modulosVisiveis(so(['erp_crm', 'erp_vendas'])).find((m) => m.id === 'erp')!.items.map((i) => i.to);
    expect(vend).toContain('/erp/vendas');
    expect(vend).not.toContain('/erp/financeiro');
    expect(vend).not.toContain('/erp/compras/ordens');
    const antigo = modulosVisiveis(so(['erp_crm'])).find((m) => m.id === 'erp')!.items.map((i) => i.to);
    expect(antigo).toContain('/erp/financeiro');
  });
});

describe('ERP · contas das telas-resumo (só contagem do que a API já devolve)', () => {
  it('vendas por etapa', () => {
    const v = contarVendas(['RASCUNHO', 'EM_APROVACAO', 'BLOQUEADO', 'AGUARDANDO_SUPRIMENTO', 'RESERVADO', 'SEPARADO', 'FATURADO', 'ENTREGUE'].map((s) => ({ statusOperacional: s })));
    expect(v).toEqual({ orcamentos: 1, aprovacao: 2, aguardandoEstoque: 1, separacao: 1, aFaturar: 1, emTransporte: 1 });
  });
  it('compras: atrasadas, em breve, aprovação e valor em aberto', () => {
    const c = contarCompras([
      { status: 'ENVIADO', totalCents: 1000, prazo: { codigo: 'ATRASADO' } },
      { status: 'APROVADO', totalCents: 500, prazo: { codigo: 'EM_BREVE' } },
      { status: 'EM_APROVACAO', totalCents: 200, prazo: { codigo: 'NA' } },
      { status: 'AGUARDANDO_NF', totalCents: 100 },
      { status: 'RECEBIDO', totalCents: 9999 },
      { status: 'CANCELADO', totalCents: 9999 },
    ]);
    expect(c).toMatchObject({ atrasadas: 1, emBreve: 1, aprovacaoOc: 1, aguardandoEntrega: 2, recebimento: 1, emAndamento: 4, valorAbertoCents: 1800 });
    expect(solicitacoesEmAprovacao([{ status: 'EM_APROVACAO' }, { status: 'APROVADA' }])).toBe(1);
  });
  it('reposição, lotes e financeiro', () => {
    expect(contarReposicao({ itens: [{ saldoMil: 0, minimoMil: 5000 }, { saldoMil: 2000, minimoMil: 5000 }], totalCents: 900 })).toEqual({ zerados: 1, abaixoMinimo: 1, itens: 2, totalCents: 900 });
    expect(contarReposicao(null).itens).toBe(0);
    const agora = Date.UTC(2026, 10, 21);
    const l = contarLotes([{ validade: '2026-11-01', vencido: true }, { validade: '2026-12-01' }, { validade: '2027-06-01' }, { status: 'QUARENTENA' }], 30, agora);
    expect(l).toEqual({ vencidos: 1, vencendo: 1, bloqueados: 1, total: 4 });
    expect(vencido({ ate30: 1, ate60: 2, ate90: 3, mais90: 4 })).toBe(10);
    expect(vencido(null)).toBe(0);
    const fluxo = [{ data: 'd0', entradasCents: 999, saidasCents: 999, saldoCents: 100 }, { data: 'd1', entradasCents: 10, saidasCents: 5, saldoCents: 105 }, { data: 'd2', entradasCents: 0, saidasCents: 200, saldoCents: -95 }];
    expect(proximosDias(fluxo, 7)).toEqual({ entradasCents: 10, saidasCents: 205 });
    expect(menorSaldo(fluxo)).toBe(-95);
    expect(menorSaldo([])).toBe(0);
  });
  it('produção e fiscal', () => {
    const agora = Date.UTC(2026, 10, 21);
    expect(contarProducao([{ status: 'PLANEJADA' }, { status: 'LIBERADA', fimPrevisto: '2026-11-01' }, { status: 'EM_PRODUCAO' }, { status: 'ENCERRADA', fimPrevisto: '2026-01-01' }], agora))
      .toEqual({ planejadas: 1, liberadas: 1, emProducao: 1, atrasadas: 1 });
    const f = contarFiscal([
      { status: 'AUTORIZADA', totalCents: 1000, createdAt: '2026-11-05T12:00:00Z', autorizadaEm: '2026-11-05T12:00:00Z' },
      { status: 'AUTORIZADA', totalCents: 5000, createdAt: '2026-10-05T12:00:00Z', autorizadaEm: '2026-10-05T12:00:00Z' },
      { status: 'REJEITADA', totalCents: 1, createdAt: '2026-11-05T12:00:00Z' },
      { status: 'ASSINADA', totalCents: 1, createdAt: '2026-11-05T12:00:00Z' },
    ], new Date('2026-11-21T12:00:00Z'));
    expect(f).toEqual({ autorizadasMes: 1, valorMesCents: 1000, rejeitadas: 1, semTransmitir: 1 });
    expect(diasCertificado(null)).toBeNull();
    expect(diasCertificado('2026-12-21T00:00:00Z', Date.UTC(2026, 10, 21))).toBe(30);
  });
});
