import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../lib/http.js';
import { orgOf } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { parseJson } from '../lib/json.js';
import { isProductActive } from '../billing/service.js';
import { contactIdForPhone } from './contactSync.js';
import {
  consultarCnpjEmpresa, ConsultaErro, usoHoje, extrairCnpjs, normalizarCnpj, fichaDoCache, donoDaFicha, nomeEmpresa, origemDoDado,
  LOTE_MAX, LOTE_TOTAL_MAX, CACHE_DIAS, type FichaCnpj,
} from './cnpjConsulta.js';

/**
 * v1.53.0 — Consulta CNPJ / Prospecção (MCK Mensagens): /api/mckmensagem/cnpj/*.
 * Montado dentro do router do MCK Mensagens (OWNER/ADMIN + módulo mensagens). Toda consulta exige o MCK Mensagens ativo.
 */
export const cnpjRouter = Router();

const exigirAtivo = ah(async (req, _res, next) => {
  if (!(await isProductActive(orgOf(req), 'MCKMENSAGEM'))) throw new HttpError(402, 'Assinatura MCK Mensagens inativa');
  next();
});
cnpjRouter.use(exigirAtivo);

const erro = (e: unknown) => {
  if (e instanceof ConsultaErro) return new HttpError(e.status, e.message);
  return e;
};

cnpjRouter.get('/uso', ah(async (req, res) => {
  const u = await usoHoje(orgOf(req));
  res.json({ ...u, cacheDias: CACHE_DIAS, loteMax: LOTE_TOTAL_MAX, buscaPorNome: false });
}));

cnpjRouter.post('/consultar', ah(async (req, res) => {
  const b = z.object({ cnpj: z.string().trim().min(1).max(40), atualizar: z.boolean().optional() }).parse(req.body);
  try {
    res.json(await consultarCnpjEmpresa(orgOf(req), b.cnpj, { atualizar: b.atualizar }));
  } catch (e) { throw erro(e); }
}));

/** Lote: até LOTE_MAX CNPJs por chamada (a tela divide listas maiores). Nunca falha o lote todo por um CNPJ. */
cnpjRouter.post('/lote', ah(async (req, res) => {
  const b = z.object({ cnpjs: z.array(z.string().trim().min(1).max(40)).min(1).max(LOTE_MAX) }).parse(req.body);
  const orgId = orgOf(req);
  const itens: { cnpj: string; ok: boolean; ficha?: FichaCnpj & { doCache: boolean }; erro?: string; status?: number }[] = [];
  let parar: string | null = null;
  for (const raw of b.cnpjs) {
    const c = normalizarCnpj(raw) ?? raw;
    if (parar) { itens.push({ cnpj: c, ok: false, erro: parar, status: 429 }); continue; }
    try {
      itens.push({ cnpj: c, ok: true, ficha: await consultarCnpjEmpresa(orgId, raw) });
    } catch (e) {
      const st = e instanceof ConsultaErro ? e.status : 502;
      const msg = e instanceof ConsultaErro ? e.message : 'Falha na consulta';
      if (st === 429) parar = msg;
      itens.push({ cnpj: c, ok: false, erro: msg, status: st });
    }
  }
  res.json({ itens, uso: await usoHoje(orgId) });
}));

/** Lê CNPJs de um texto colado ou do conteúdo de um CSV. */
cnpjRouter.post('/extrair', ah(async (req, res) => {
  const b = z.object({ texto: z.string().max(2_000_000) }).parse(req.body);
  res.json(extrairCnpjs(b.texto, LOTE_TOTAL_MAX));
}));

const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(30);
const importarSchema = z.object({
  itens: z.array(z.object({ cnpj: z.string().trim().min(1).max(40), telefone: z.string().trim().max(20).optional().nullable() })).min(1).max(LOTE_TOTAL_MAX),
  tags: tagsSchema.optional(),
  campaignId: z.string().max(40).optional().nullable(),
});

/**
 * Importa empresas consultadas como contatos. Os dados vêm SEMPRE do cache da consulta (nunca da tela): o telefone
 * escolhido tem de ser um telefone do cadastro da empresa. Quem está em opt-out (SAIR) no MCK Mensagens ou no MCKBOT
 * fica de fora. Cada contato guarda a origem ("Cadastro CNPJ – fonte – data").
 */
cnpjRouter.post('/importar', ah(async (req, res) => {
  const b = importarSchema.parse(req.body);
  const orgId = orgOf(req);
  let campaign: { id: string; status: string } | null = null;
  if (b.campaignId) {
    campaign = await prisma.campaign.findFirst({ where: { id: b.campaignId, orgId }, select: { id: true, status: true } });
    if (!campaign) throw new HttpError(400, 'Campanha inválida');
  }
  const tags = [...new Set(b.tags ?? [])];
  const now = new Date();
  let criados = 0, atualizados = 0, naFila = 0;
  const bloqueados: string[] = [], semTelefone: string[] = [], naoConsultados: string[] = [], inativas: string[] = [];
  const vistos = new Set<string>();
  for (const it of b.itens) {
    const cnpj = normalizarCnpj(it.cnpj);
    if (!cnpj) { naoConsultados.push(it.cnpj); continue; }
    const f = await fichaDoCache(cnpj);
    if (!f) { naoConsultados.push(cnpj); continue; }
    const tel = it.telefone ? f.telefones.find((t) => t.e164 === it.telefone) : (f.telefones.find((t) => t.celular) ?? f.telefones[0]);
    if (!tel) { semTelefone.push(cnpj); continue; }
    if (vistos.has(tel.e164)) continue;
    vistos.add(tel.e164);
    if (!f.ativa) inativas.push(cnpj);
    const phone = tel.e164;
    const contactId = await contactIdForPhone(orgId, phone);
    const contatoSaiu = contactId ? !!(await prisma.contact.findFirst({ where: { id: contactId, orgId }, select: { optOut: true } }))?.optOut : false;
    const existing = await prisma.lead.findUnique({ where: { orgId_phone: { orgId, phone } } });
    if (contatoSaiu || existing?.optOutAt) { bloqueados.push(cnpj); continue; }
    const dados = { cnpj, empresa: nomeEmpresa(f), dono: donoDaFicha(f), origemDado: origemDoDado(f) };
    let leadId: string;
    if (existing) {
      const merged = [...new Set([...parseJson<string[]>(existing.tags, []), ...tags])].slice(0, 30);
      const lead = await prisma.lead.update({
        where: { id: existing.id },
        data: {
          tags: JSON.stringify(merged), name: existing.name ?? dados.empresa,
          cnpj: existing.cnpj ?? dados.cnpj, empresa: existing.empresa ?? dados.empresa, dono: existing.dono ?? dados.dono, origemDado: existing.origemDado ?? dados.origemDado,
          ...(!existing.contactId && contactId ? { contactId } : {}),
          ...(campaign ? { campaignId: campaign.id } : {}),
        },
      });
      leadId = lead.id; atualizados++;
    } else {
      const lead = await prisma.lead.create({
        data: { orgId, phone, name: dados.empresa, tags: JSON.stringify(tags.slice(0, 30)), consentSource: 'IMPORTACAO', consentAt: now, campaignId: campaign?.id ?? null, contactId, ...dados },
      });
      leadId = lead.id; criados++;
    }
    if (campaign && (campaign.status === 'EM_ANDAMENTO' || campaign.status === 'PAUSADA')) {
      const ja = await prisma.campaignRecipient.findFirst({ where: { campaignId: campaign.id, leadId }, select: { id: true } });
      if (!ja) { await prisma.campaignRecipient.create({ data: { campaignId: campaign.id, leadId } }); naFila++; }
    }
  }
  await audit(req, 'mckmensagem.cnpj.importar', { meta: { pedidos: b.itens.length, criados, atualizados, naFila, bloqueados: bloqueados.length, semTelefone: semTelefone.length, naoConsultados: naoConsultados.length, campaignId: campaign?.id ?? null, tags } });
  res.json({ criados, atualizados, naFila, bloqueados: bloqueados.length, semTelefone: semTelefone.length, naoConsultados: naoConsultados.length, inativas: inativas.length });
}));
