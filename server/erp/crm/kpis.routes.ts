/** Painel do CRM: KPIs e funil com filtros de período, filial e centro de custo. */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { calcularKpis, funil } from './kpis.js';
import { etapasDa } from './funil.routes.js';
import { temAreaErp } from '../../lib/permissions.js';
import { calcularInadimplencia, resumoScores } from './score.js';
import { scoresDosClientes } from './scoreDados.js';

export const kpisRouter = Router();

kpisRouter.get('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const f = z.object({ de: z.coerce.date().optional(), ate: z.coerce.date().optional(), filialId: z.string().optional(), centroCustoId: z.string().optional() }).parse(req.query);
  const ate = f.ate ?? new Date();
  const de = f.de ?? new Date(ate.getTime() - 90 * 86_400_000);
  const filtroOp = { orgId, createdAt: { gte: de, lte: ate }, ...(f.filialId ? { filialId: f.filialId } : {}), ...(f.centroCustoId ? { centroCustoId: f.centroCustoId } : {}) };
  const [parceiros, ops, abertas, etapas] = await Promise.all([
    prisma.erpParceiro.findMany({ where: { orgId, ...(f.filialId ? { filialId: f.filialId } : {}) }, select: { id: true, status: true, ehCliente: true, nome: true, fantasia: true } }),
    prisma.erpOportunidade.findMany({ where: filtroOp, select: { status: true, valorCents: true, custoAquisicaoCents: true, parceiroId: true, createdAt: true, fechadaEm: true, etapaId: true } }),
    prisma.erpOportunidade.findMany({ where: { orgId, status: 'ABERTA', ...(f.filialId ? { filialId: f.filialId } : {}) }, select: { etapaId: true, status: true, valorCents: true } }),
    etapasDa(orgId),
  ]);
  // v1.56.0: inadimplência pelas contas a receber do Financeiro (vencimento no período). Só para quem pode ver o Financeiro
  // (ou os Relatórios, que já mostram a inadimplência no BI); os outros recebem null e a tela explica.
  const podeFin = temAreaErp(req.auth as any, 'erp_financeiro', ['erp_relatorios']);
  const inad = podeFin ? calcularInadimplencia(await prisma.erpTitulo.findMany({
    where: { orgId, tipo: 'RECEBER', status: { not: 'CANCELADO' }, vencimento: { gte: de, lte: ate }, ...(f.centroCustoId ? { centroCustoId: f.centroCustoId } : {}) },
    select: { valorCents: true, pagoCents: true, status: true, vencimento: true },
  })) : null;
  // Score: todos os clientes da empresa (da filial, se filtrada) com conta ou compra.
  const clientes = parceiros.filter((p) => p.ehCliente);
  const sc = await scoresDosClientes(orgId, clientes.map((c) => c.id));
  const scores = resumoScores(clientes.map((c) => ({ id: c.id, nome: c.fantasia || c.nome, score: sc.get(c.id)! })));
  res.json({ periodo: { de, ate }, kpis: calcularKpis(parceiros, ops, inad), funil: funil(etapas, abertas), scores, podeVerFinanceiro: podeFin });
}));
