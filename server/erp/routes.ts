/**
 * MCK ERP — roteador raiz (/api/erp). Cada módulo tem a própria pasta e o próprio sub-roteador.
 * Etapa 1: core + CRM. Etapa 2: produtos/, estoque/, vendas/. Etapa 3: compras/, producao/. Etapa 4: financeiro/, fiscal/. Etapa 5: bi/.
 */
import { Router } from 'express';
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
import { registrarConsumidoresFinanceiro } from './financeiro/consumidores.js';
import { registrarConsumidoresVendas } from './vendas/consumidores.js';

registrarConsumidoresCrm();
registrarConsumidoresVendas();
registrarConsumidoresFinanceiro();

export const erpRouter = Router();
erpRouter.use('/core', coreRouter);
erpRouter.use('/crm/parceiros', parceirosRouter);
erpRouter.use('/crm/funil', funilRouter);
erpRouter.use('/crm/interacoes', interacoesRouter);
erpRouter.use('/crm/kpis', kpisRouter);
erpRouter.use('/produtos', produtosRouter);
erpRouter.use('/estoque/nfe', nfeRouter);
erpRouter.use('/estoque/inventarios', inventarioRouter);
erpRouter.use('/estoque', estoqueRouter);
erpRouter.use('/vendas/pedidos', pedidosRouter);
erpRouter.use('/compras', comprasRouter);
erpRouter.use('/producao', producaoRouter);
erpRouter.use('/financeiro', financeiroRouter);
erpRouter.use('/fiscal', fiscalRouter);
erpRouter.use('/bi', biRouter);

/** Chamado na subida do servidor (fora dos testes). */
export function iniciarErp() { iniciarDespachante(); }
