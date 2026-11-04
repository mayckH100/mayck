/** Configuração dos alertas diários por WhatsApp (só Proprietário/Admin). */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, forbidden } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import { configDa } from '../produtos/produtos.routes.js';
import { agoraLocal, enviarAlerta, montarAlerta, telefonesDe } from './alertas.js';

export const alertasRouter = Router();
alertasRouter.use((req, _res, next) => next(req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN' ? undefined : forbidden()));

const visao = (c: Awaited<ReturnType<typeof configDa>>) => ({
  alertaAtivo: c.alertaAtivo, telefones: telefonesDe(c.alertaTelefones), alertaHora: c.alertaHora, alertaDiasAntes: c.alertaDiasAntes,
  alertaPagar: c.alertaPagar, alertaEstoqueMinimo: c.alertaEstoqueMinimo, alertaSemSaidaDias: c.alertaSemSaidaDias,
  ultimoDia: c.alertaUltimoDia, status: c.alertaStatus ? JSON.parse(c.alertaStatus) : null,
});

alertasRouter.get('/', ah(async (req, res) => res.json(visao(await configDa(orgOf(req))))));

const fone = z.string().trim().transform((s) => s.replace(/[^\d+]/g, '')).refine((s) => /^\+?\d{10,15}$/.test(s), 'Telefone inválido (use DDD, ex.: 11 99999-9999)')
  .transform((s) => { const d = s.replace(/\D/g, ''); return `+${d.length <= 11 ? `55${d}` : d}`; });

alertasRouter.put('/', ah(async (req, res) => {
  const b = z.object({ alertaAtivo: z.boolean(), telefones: z.array(fone).max(5), alertaHora: z.number().int().min(0).max(23), alertaDiasAntes: z.number().int().min(0).max(30),
    alertaPagar: z.boolean(), alertaEstoqueMinimo: z.boolean(), alertaSemSaidaDias: z.number().int().min(0).max(365) }).parse(req.body);
  if (b.alertaAtivo && !b.telefones.length) throw badRequest('Informe ao menos um número de WhatsApp');
  const orgId = orgOf(req);
  await configDa(orgId);
  const { telefones, ...rest } = b;
  const c = await prisma.erpConfig.update({ where: { orgId }, data: { ...rest, alertaTelefones: JSON.stringify(telefones) } });
  await auditar(req, 'config.alertas', 'erp_config', orgId, null, { alertaAtivo: b.alertaAtivo, telefones: telefones.length });
  res.json(visao(c));
}));

async function hojeDa(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  return agoraLocal(org?.timezone || 'America/Sao_Paulo').dia;
}

/** Prévia do texto de hoje, sem enviar. */
alertasRouter.get('/previa', ah(async (req, res) => {
  const orgId = orgOf(req);
  const a = await montarAlerta(orgId, await configDa(orgId), await hojeDa(orgId));
  res.json({ texto: a?.texto ?? null, itens: a?.itens ?? 0 });
}));

/** Envia agora para os números salvos (teste). */
alertasRouter.post('/enviar-agora', ah(async (req, res) => {
  const orgId = orgOf(req);
  const c = await configDa(orgId);
  const tels = telefonesDe(c.alertaTelefones);
  if (!tels.length) throw badRequest('Salve ao menos um número de WhatsApp');
  const a = await montarAlerta(orgId, c, await hojeDa(orgId));
  const texto = a?.texto ?? '*MCK ERP · teste de alerta*\nTudo em dia: nenhuma conta vencendo e nenhum produto em alerta.';
  res.json(await enviarAlerta(orgId, tels, texto));
}));
