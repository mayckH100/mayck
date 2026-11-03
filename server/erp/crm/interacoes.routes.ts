/**
 * Linha do tempo do cliente: notas, ligações, chamados e envio real por WhatsApp (canal do MCKBOT) e e-mail (Brevo/SMTP).
 * Cada envio fica registrado com status ENVIADO/FALHOU; nada é simulado.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { sendMailResult } from '../../lib/mailer.js';
import { sendOutbound } from '../../whatsapp/messaging.js';
import { onlyDigits } from '../../lib/documento.js';

export const interacoesRouter = Router();

const registroSchema = z.object({
  parceiroId: z.string().min(1), oportunidadeId: z.string().nullish(),
  tipo: z.enum(['NOTA', 'LIGACAO', 'CHAMADO']), assunto: z.string().trim().max(200).nullish(), conteudo: z.string().trim().min(1).max(10_000),
  direcao: z.enum(['ENTRADA', 'SAIDA']).nullish(),
});

interacoesRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = registroSchema.parse(req.body);
  if (!(await prisma.erpParceiro.findFirst({ where: { id: b.parceiroId, orgId } }))) throw notFound('Cliente');
  const i = await prisma.erpInteracao.create({ data: { orgId, ...b, assunto: b.assunto ?? null, direcao: b.direcao ?? null, oportunidadeId: b.oportunidadeId ?? null, status: b.tipo === 'CHAMADO' ? 'ABERTO' : null, userId: req.auth?.userId ?? null } });
  res.status(201).json(i);
}));

interacoesRouter.patch('/:id/chamado', ah(async (req, res) => {
  const { status } = z.object({ status: z.enum(['ABERTO', 'RESOLVIDO']) }).parse(req.body);
  const r = await prisma.erpInteracao.updateMany({ where: { id: req.params.id, orgId: orgOf(req), tipo: 'CHAMADO' }, data: { status } });
  if (!r.count) throw notFound('Chamado');
  res.json({ ok: true });
}));

const envioSchema = z.object({
  parceiroId: z.string().min(1), oportunidadeId: z.string().nullish(),
  canal: z.enum(['WHATSAPP', 'EMAIL']), assunto: z.string().trim().max(200).optional(), texto: z.string().trim().min(1).max(4000),
});

interacoesRouter.post('/enviar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = envioSchema.parse(req.body);
  const p = await prisma.erpParceiro.findFirst({ where: { id: b.parceiroId, orgId } });
  if (!p) throw notFound('Cliente');
  let ok = false; let erro: string | null = null; let ref: string | null = null;
  if (b.canal === 'EMAIL') {
    if (!p.email) throw badRequest('Cliente sem e-mail cadastrado');
    const r = await sendMailResult({ to: p.email, subject: b.assunto || 'Mensagem', text: b.texto });
    ok = r.ok; erro = r.error ?? null; ref = r.messageId ?? null;
  } else {
    if (!p.telefone) throw badRequest('Cliente sem telefone cadastrado');
    const waId = onlyDigits(p.telefone);
    let contact = p.contactId ? await prisma.contact.findFirst({ where: { id: p.contactId, orgId } }) : null;
    contact ??= await prisma.contact.findUnique({ where: { orgId_waId: { orgId, waId } } });
    contact ??= await prisma.contact.create({ data: { orgId, waId, phone: p.telefone, name: p.fantasia || p.nome, email: p.email } });
    if (p.contactId !== contact.id) await prisma.erpParceiro.update({ where: { id: p.id }, data: { contactId: contact.id } });
    if (contact.optOut) throw badRequest('O cliente pediu para não receber mensagens (opt-out)');
    let conv = await prisma.conversation.findFirst({ where: { orgId, contactId: contact.id, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'desc' } });
    conv ??= await prisma.conversation.create({ data: { orgId, contactId: contact.id, channelId: null } });
    const msg = await sendOutbound({ conversation: conv, contact, payload: { type: 'text', text: b.texto }, sender: 'agent', authorUserId: req.auth?.userId, product: 'MCKBOT' });
    ok = msg.status !== 'FAILED'; erro = ok ? null : msg.error ?? 'Falha no envio pelo WhatsApp'; ref = msg.waMessageId ?? null;
  }
  const i = await prisma.erpInteracao.create({
    data: { orgId, parceiroId: p.id, oportunidadeId: b.oportunidadeId ?? null, tipo: b.canal, direcao: 'SAIDA', assunto: b.assunto ?? null, conteudo: b.texto, status: ok ? 'ENVIADO' : 'FALHOU', canalRef: ref, userId: req.auth?.userId ?? null },
  });
  res.status(ok ? 201 : 502).json({ ...i, erro });
}));
