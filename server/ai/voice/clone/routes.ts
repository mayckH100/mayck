/** v1.47.0 — Rotas da biblioteca de áudios gravados e da voz clonada (montadas em /api/ai/voz). */
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '../../../db.js';
import { ah, HttpError, badRequest, notFound } from '../../../lib/http.js';
import { orgOf, requireRole } from '../../../auth/session.js';
import { audit } from '../../../lib/audit.js';
import { MAX_CLIPS, MAX_CLIP_BYTES, MAX_CLIP_SECONDS, toVoiceNote } from '../clips.js';
import { transcribeAudio } from '../service.js';
import { activateProfile, consentText, createProfile, deleteProfile, listProfiles, previewOf, processProfile, readingScript, saveSample, CONSENT_VERSION, MAX_PROFILES, MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS } from './service.js';
import { workerStatus } from './worker.js';

export const vozRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');
const MAX_SAMPLE_BYTES = 12 * 1024 * 1024;

const janelas = new Map<string, number[]>();
const porOrg = (tipo: string, max: number, janelaMs = 10 * 60_000): RequestHandler => (req, _res, next) => {
  const k = `${tipo}:${orgOf(req)}`;
  const agora = Date.now();
  const lista = (janelas.get(k) ?? []).filter((t) => agora - t < janelaMs);
  if (lista.length >= max) return next(new HttpError(429, 'Muitos envios seguidos. Espere alguns minutos e tente de novo.'));
  lista.push(agora);
  janelas.set(k, lista);
  next();
};
export function resetLimitesVoz() { janelas.clear(); }

const corpo = (limit: number): RequestHandler => (req, res, next) => {
  express.raw({ type: () => true, limit: limit + 1024 })(req, res, (err?: any) => {
    if (err) return next(err.type === 'entity.too.large' ? new HttpError(413, `Arquivo maior que ${Math.round(limit / 1024 / 1024)} MB.`) : new HttpError(400, 'Falha ao ler o arquivo enviado.'));
    next();
  });
};
const hdr = (req: any, name: string, max: number) => { const raw = String(req.header(name) ?? ''); try { return decodeURIComponent(raw).trim().slice(0, max); } catch { return raw.trim().slice(0, max); } };
const mimeOf = (req: any) => String(req.header('x-file-type') ?? req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
const sendOgg = (res: any, buf: Buffer) => { res.setHeader('Content-Type', 'audio/ogg'); res.setHeader('Cache-Control', 'no-store'); res.send(buf); };

/** Visão geral da tela "Voz do vendedor". */
vozRouter.get('/', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const [clips, profiles, s, w, org] = await Promise.all([
    prisma.voiceClip.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, whenToUse: true, transcript: true, seconds: true, active: true, useCount: true, lastUsedAt: true, createdAt: true } }),
    listProfiles(orgId),
    prisma.aiSettings.findUnique({ where: { orgId }, select: { enabled: true, voiceEnabled: true, voiceLibraryEnabled: true, voiceProvider: true, voiceReplyMode: true } }),
    workerStatus(),
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
  ]);
  res.json({
    clips, profiles, settings: s ?? { enabled: false, voiceEnabled: false, voiceLibraryEnabled: false, voiceProvider: 'gemini', voiceReplyMode: 'espelhar' },
    worker: { configured: w.configured, online: w.ok, pronto: w.ready, fila: w.queue },
    limites: { maxClips: MAX_CLIPS, maxClipSeconds: MAX_CLIP_SECONDS, maxProfiles: MAX_PROFILES, minSample: MIN_SAMPLE_SECONDS, maxSample: MAX_SAMPLE_SECONDS },
    termo: { versao: CONSENT_VERSION, modelo: consentText({ ownerName: '[nome do dono da voz]', company: org?.name ?? 'a empresa' }) },
  });
}));

vozRouter.put('/biblioteca', admins, ah(async (req, res) => {
  const b = z.object({ enabled: z.boolean() }).parse(req.body);
  const orgId = orgOf(req);
  await prisma.aiSettings.upsert({ where: { orgId }, create: { orgId, voiceLibraryEnabled: b.enabled }, update: { voiceLibraryEnabled: b.enabled } });
  await audit(req, 'voz.biblioteca.config', { meta: { ligada: b.enabled } });
  res.json({ ok: true });
}));

// ---------- Biblioteca de áudios gravados ----------
vozRouter.post('/clips', admins, porOrg('clip', 40), corpo(MAX_CLIP_BYTES), ah(async (req, res) => {
  const orgId = orgOf(req);
  const title = hdr(req, 'x-clip-title', 80);
  const whenToUse = hdr(req, 'x-clip-when', 300);
  let transcript = hdr(req, 'x-clip-transcript', 1000);
  if (title.length < 2) throw badRequest('Dê um nome ao áudio (ex.: Boas-vindas).');
  if (await prisma.voiceClip.count({ where: { orgId } }) >= MAX_CLIPS) throw badRequest(`Limite de ${MAX_CLIPS} áudios. Exclua algum para gravar outro.`);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let note;
  try { note = toVoiceNote(buf, mimeOf(req)); } catch (e) { throw badRequest((e as Error).message); }
  if (note.seconds < 1) throw badRequest('Áudio curto demais.');
  if (note.seconds > MAX_CLIP_SECONDS + 1) throw badRequest(`Cada áudio pode ter até ${MAX_CLIP_SECONDS / 60} minutos.`);
  // Sem o texto do que foi dito, tenta transcrever (motor de transcrição da IA, se ligado); a IA usa isso para escolher.
  if (!transcript) {
    const t = await transcribeAudio({ orgId, conversationId: null, audio: note.ogg, mime: 'audio/ogg', seconds: note.seconds }).catch(() => null);
    if (t?.ok) transcript = t.text.slice(0, 1000);
  }
  const c = await prisma.voiceClip.create({ data: { orgId, title, whenToUse, transcript, audio: new Uint8Array(note.ogg), seconds: note.seconds, waveform: note.waveform ? new Uint8Array(note.waveform) : null, createdById: req.auth?.userId ?? null } });
  await audit(req, 'voz.biblioteca.criar', { entity: 'VoiceClip', entityId: c.id, meta: { title, segundos: Math.round(note.seconds) } });
  res.status(201).json({ id: c.id, title, whenToUse, transcript, seconds: note.seconds, active: true, useCount: 0 });
}));

vozRouter.put('/clips/:id', admins, ah(async (req, res) => {
  const b = z.object({ title: z.string().trim().min(2).max(80).optional(), whenToUse: z.string().trim().max(300).optional(), transcript: z.string().trim().max(1000).optional(), active: z.boolean().optional() }).parse(req.body);
  const r = await prisma.voiceClip.updateMany({ where: { id: req.params.id, orgId: orgOf(req) }, data: b });
  if (!r.count) throw notFound('Áudio não encontrado');
  await audit(req, 'voz.biblioteca.editar', { entity: 'VoiceClip', entityId: req.params.id, meta: { campos: Object.keys(b) } });
  res.json({ ok: true });
}));

vozRouter.delete('/clips/:id', admins, ah(async (req, res) => {
  const r = await prisma.voiceClip.deleteMany({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!r.count) throw notFound('Áudio não encontrado');
  await audit(req, 'voz.biblioteca.excluir', { entity: 'VoiceClip', entityId: req.params.id });
  res.json({ ok: true });
}));

vozRouter.get('/clips/:id/audio', admins, ah(async (req, res) => {
  const c = await prisma.voiceClip.findFirst({ where: { id: req.params.id, orgId: orgOf(req) }, select: { audio: true } });
  if (!c) throw notFound('Áudio não encontrado');
  sendOgg(res, Buffer.from(c.audio));
}));

// ---------- Voz clonada ----------
vozRouter.post('/perfis', admins, porOrg('perfil', 10), ah(async (req, res) => {
  const b = z.object({
    ownerName: z.string().trim().min(5, 'Escreva o nome completo do dono da voz').max(100),
    ownerRole: z.string().trim().max(60).default(''),
    ownerEmail: z.string().trim().email('E-mail inválido').max(120).optional().or(z.literal('')),
    genero: z.enum(['masculina', 'feminina']).default('masculina'),
    assinatura: z.string().trim().max(100),
    aceite: z.literal(true, { errorMap: () => ({ message: 'O dono da voz precisa aceitar o termo' }) } as any),
    souDonoOuTenhoTermo: z.literal(true, { errorMap: () => ({ message: 'Confirme que é o dono da voz ou que ele assinou o termo' }) } as any),
  }).parse(req.body);
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (norm(b.assinatura) !== norm(b.ownerName)) throw badRequest('A assinatura (nome digitado) precisa ser igual ao nome do dono da voz.');
  try {
    const r = await createProfile(req, orgOf(req), req.auth?.userId ?? null, { ownerName: b.ownerName, ownerRole: b.ownerRole, ownerEmail: b.ownerEmail || '', accept: true, ip: req.ip ?? null, baseVoice: b.genero === 'feminina' ? 'Kore' : 'Puck' });
    res.status(201).json(r);
  } catch (e) { throw badRequest((e as Error).message); }
}));

vozRouter.get('/perfis/:id/termo', admins, ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.voiceProfile.findFirst({ where: { id: req.params.id, orgId }, select: { ownerName: true, consentText: true, consentAt: true, consentVersion: true, status: true, deletedAt: true } });
  if (!p) throw notFound('Voz não encontrada');
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  res.json({ ...p, script: readingScript(p.ownerName, org?.name ?? 'a empresa') });
}));

vozRouter.post('/perfis/:id/amostra', admins, porOrg('amostra', 15), corpo(MAX_SAMPLE_BYTES), ah(async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let note;
  try { note = toVoiceNote(buf, mimeOf(req)); } catch (e) { throw badRequest((e as Error).message); }
  try { await saveSample(req, orgOf(req), req.params.id, note.ogg, note.seconds); } catch (e) { throw badRequest((e as Error).message); }
  res.json({ ok: true, seconds: note.seconds });
}));

vozRouter.post('/perfis/:id/reprocessar', admins, porOrg('reprocessar', 10), ah(async (req, res) => {
  const r = await prisma.voiceProfile.updateMany({ where: { id: req.params.id, orgId: orgOf(req), status: { in: ['ERRO', 'NA_FILA'] }, sampleEnc: { not: null } }, data: { status: 'NA_FILA', error: null, attempts: 0 } });
  if (!r.count) throw badRequest('Nada para refazer: grave a amostra de novo.');
  void processProfile(req.params.id).catch(() => undefined);
  res.json({ ok: true });
}));

vozRouter.get('/perfis/:id/previa', admins, ah(async (req, res) => {
  const b = await previewOf(orgOf(req), req.params.id);
  if (!b) throw notFound('A prévia ainda não está pronta');
  sendOgg(res, b);
}));

vozRouter.post('/perfis/:id/ativar', admins, ah(async (req, res) => {
  try { await activateProfile(req, orgOf(req), req.params.id); } catch (e) { throw badRequest((e as Error).message); }
  res.json({ ok: true });
}));

vozRouter.post('/perfis/:id/excluir', admins, ah(async (req, res) => {
  const b = z.object({ motivo: z.string().trim().max(300).default('Pedido de exclusão') }).parse(req.body ?? {});
  try { await deleteProfile(req, orgOf(req), req.params.id, b.motivo || 'Pedido de exclusão'); } catch (e) { throw badRequest((e as Error).message); }
  res.json({ ok: true });
}));
