/**
 * MCK ERP — roteador raiz (/api/erp). Cada módulo tem a própria pasta e o próprio sub-roteador.
 * Etapa 1: core + CRM. Próximas: vendas/, estoque/, producao/, compras/, fiscal/, financeiro/, bi/.
 */
import { Router } from 'express';
import { coreRouter } from './core/core.routes.js';
import { parceirosRouter } from './crm/parceiros.routes.js';
import { funilRouter } from './crm/funil.routes.js';
import { interacoesRouter } from './crm/interacoes.routes.js';
import { kpisRouter } from './crm/kpis.routes.js';
import { registrarConsumidoresCrm } from './crm/consumidores.js';
import { iniciarDespachante } from './shared/events.js';

registrarConsumidoresCrm();

export const erpRouter = Router();
erpRouter.use('/core', coreRouter);
erpRouter.use('/crm/parceiros', parceirosRouter);
erpRouter.use('/crm/funil', funilRouter);
erpRouter.use('/crm/interacoes', interacoesRouter);
erpRouter.use('/crm/kpis', kpisRouter);

/** Chamado na subida do servidor (fora dos testes). */
export function iniciarErp() { iniciarDespachante(); }
