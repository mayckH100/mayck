/** Aba Relatórios: relatório do dia (tela e CSV) e envio manual ao proprietário. */
import { Router } from 'express';
import { prisma } from '../../db.js';
import { ah, badRequest, forbidden } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { agoraLocal, notificarProprietario } from '../alertas/alertas.js';
import { montarRelatorio, relatorioCsv, relatorioTexto } from './relatorio.js';

export const relatoriosRouter = Router();

async function diaDe(req: any) {
  const q = String(req.query.data ?? '');
  if (q && !/^\d{4}-\d{2}-\d{2}$/.test(q)) throw badRequest('Data inválida');
  if (q) return q;
  const org = await prisma.organization.findUnique({ where: { id: orgOf(req) }, select: { timezone: true } });
  return agoraLocal(org?.timezone || 'America/Sao_Paulo').dia;
}

relatoriosRouter.get('/dia', ah(async (req, res) => { res.json(await montarRelatorio(orgOf(req), await diaDe(req))); }));
relatoriosRouter.get('/dia.csv', ah(async (req, res) => {
  const dia = await diaDe(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-${dia}.csv"`);
  res.send(relatorioCsv(await montarRelatorio(orgOf(req), dia)));
}));
relatoriosRouter.post('/dia/enviar', ah(async (req, res) => {
  if (req.auth?.role !== 'OWNER' && req.auth?.role !== 'ADMIN') throw forbidden('Só proprietário ou administrador');
  const dia = await diaDe(req);
  const x = await montarRelatorio(orgOf(req), dia);
  await notificarProprietario(orgOf(req), `Relatório do dia ${dia.split('-').reverse().join('/')}`, relatorioTexto(x), [{ filename: `relatorio-${dia}.csv`, content: Buffer.from(relatorioCsv(x), 'utf8'), contentType: 'text/csv' }]);
  res.json({ ok: true });
}));
