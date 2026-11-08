/**
 * MCK ERP — roteador raiz (/api/erp). Cada módulo tem a própria pasta e o próprio sub-roteador.
 * Etapa 1: core + CRM. Etapa 2: produtos/, estoque/, vendas/. Etapa 3: compras/, producao/. Etapa 4: financeiro/, fiscal/. Etapa 5: bi/.
 */
import { requireErpArea } from '../lib/permissions.js';
import { relatoriosRouter } from './relatorios/relatorios.routes.js';
import { balcaoRouter } from './vendas/balcao.routes.js';
import { caixaRouter } from './vendas/caixa.routes.js';
import { importacaoRouter } from './importacao/importacao.routes.js';
import { Router } from 'express';
import { ah } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { planoCompletoAtivo } from '../billing/service.js';
import { ERP_PLANO_COMPLETO_MSG } from '../billing/guard.js';
import { coreRouter } from './core/core.routes.js';
import { parceirosRouter } from './crm/parceiros.routes.js';
import { funilRouter } from './crm/funil.routes.js';
import { interacoesRouter } from './crm/interacoes.routes.js';
import { kpisRouter } from './crm/kpis.routes.js';
import { registrarConsumidoresCrm } from './crm/consumidores.js';
import { iniciarDespachante } from './shared/events.js';
import { produtosRouter } from './produtos/produtos.routes.js';
import { estoqueRouter } from './estoque/estoque.routes.js';
import { nfeRouter } from './estoque/nfe.routes.js';
import { inventarioRouter } from './estoque/inventario.routes.js';
import { pedidosRouter } from './vendas/pedidos.routes.js';
import { comprasRouter } from './compras/compras.routes.js';
import { producaoRouter } from './producao/producao.routes.js';
import { financeiroRouter } from './financeiro/financeiro.routes.js';
import { fiscalRouter } from './fiscal/fiscal.routes.js';
import { biRouter } from './bi/bi.routes.js';
import { alertasRouter } from './alertas/alertas.routes.js';
import { registrarConsumidoresFinanceiro } from './financeiro/consumidores.js';
import { registrarConsumidoresVendas } from './vendas/consumidores.js';

registrarConsumidoresCrm();
registrarConsumidoresVendas();
registrarConsumidoresFinanceiro();

export const erpRouter = Router();
/** O ERP está liberado para esta empresa? (Plano Completo ativo ou em teste; superadmin sempre.) Sempre responde, mesmo sem plano. */
erpRouter.get('/acesso', ah(async (req, res) => {
  const superAdmin = !!req.auth?.isSuperAdmin;
  const plano = await planoCompletoAtivo(orgOf(req));
  res.json({ liberado: superAdmin || plano, planoCompleto: plano, superAdmin, motivo: superAdmin || plano ? null : ERP_PLANO_COMPLETO_MSG });
}));
erpRouter.use('/core', coreRouter);
erpRouter.use('/crm/parceiros', parceirosRouter);
erpRouter.use('/crm/funil', funilRouter);
erpRouter.use('/crm/interacoes', interacoesRouter);
erpRouter.use('/crm/kpis', kpisRouter);
erpRouter.use('/produtos', requireErpArea('erp_estoque', ['erp_vendas', 'erp_compras']), produtosRouter);
erpRouter.use('/estoque/nfe', requireErpArea('erp_estoque', ['erp_compras']), nfeRouter);
erpRouter.use('/estoque/inventarios', requireErpArea('erp_estoque'), inventarioRouter);
erpRouter.use('/estoque', requireErpArea('erp_estoque', ['erp_vendas', 'erp_compras']), estoqueRouter);
erpRouter.use('/vendas/balcao', requireErpArea('erp_vendas'), balcaoRouter);
erpRouter.use('/vendas/caixa', requireErpArea('erp_vendas', ['erp_financeiro', 'erp_relatorios']), caixaRouter);
erpRouter.use('/vendas/pedidos', requireErpArea('erp_vendas', ['erp_estoque', 'erp_financeiro']), pedidosRouter);
erpRouter.use('/compras', requireErpArea('erp_compras', ['erp_estoque', 'erp_financeiro']), comprasRouter);
erpRouter.use('/producao', requireErpArea('erp_compras', ['erp_estoque']), producaoRouter);
erpRouter.use('/financeiro', requireErpArea('erp_financeiro'), financeiroRouter);
erpRouter.use('/fiscal', requireErpArea('erp_financeiro'), fiscalRouter);
erpRouter.use('/bi', requireErpArea('erp_relatorios'), biRouter);
erpRouter.use('/alertas', requireErpArea('erp_relatorios'), alertasRouter);
erpRouter.use('/relatorios', requireErpArea('erp_relatorios'), relatoriosRouter);
erpRouter.use('/io', importacaoRouter);

/** Chamado na subida do servidor (fora dos testes). */
export function iniciarErp() { iniciarDespachante(); }
