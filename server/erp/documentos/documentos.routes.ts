/**
 * v1.54.0 — Documentos impressos: cabeçalho (logo + dados da empresa) usado em todos os documentos do ERP.
 *  GET  /api/erp/documentos/config  → qualquer usuário do ERP da empresa (precisa para imprimir); logo só da própria org.
 *  PUT  /api/erp/documentos/config  → só Proprietário/Administrador.
 * Sem configuração salva, sugere os dados do emitente fiscal (Fiscal › Emitente) e o nome da empresa.
 * O rodapé da MCK (RODAPE_DOCUMENTO) volta sempre do código: campos desconhecidos (ex.: "rodape") são descartados.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { ah, badRequest } from '../../lib/http.js';
import { orgOf, requireRole } from '../../auth/session.js';
import { detectImageMime } from '../../lib/announcements.js';
import { auditar } from '../shared/auditoria.js';
import { CAMPOS_CABECALHO, LOGO_DATA_URL, LOGO_MAX_BYTES, RODAPE_DOCUMENTO, type ConfigDocumento } from '../shared/documento.js';

export const documentosRouter = Router();
const admins = requireRole('OWNER', 'ADMIN');
const limiteEscrita = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas alterações seguidas. Aguarde um instante.' } });

const VAZIA: ConfigDocumento = { nomeExibicao: '', cnpj: '', ie: '', logradouro: '', numero: '', bairro: '', cidade: '', uf: '', cep: '', telefone: '', whatsapp: '', email: '', site: '', textoLivre: '', logo: null };
const soDigitos = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

export async function configDocumento(orgId: string): Promise<{ config: ConfigDocumento; salvo: boolean }> {
  const c = await prisma.erpDocumentoConfig.findUnique({ where: { orgId } });
  if (c) {
    const config = { ...VAZIA };
    for (const k of CAMPOS_CABECALHO) config[k] = c[k] ?? '';
    config.logo = c.logo && LOGO_DATA_URL.test(c.logo) ? c.logo : null;
    return { config, salvo: true };
  }
  const [f, org] = await Promise.all([
    prisma.erpConfigFiscal.findUnique({ where: { orgId }, select: { razaoSocial: true, fantasia: true, cnpj: true, ie: true, logradouro: true, numero: true, bairro: true, municipio: true, uf: true, cep: true, fone: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
  ]);
  return {
    salvo: false,
    config: {
      ...VAZIA,
      nomeExibicao: f?.fantasia || f?.razaoSocial || org?.name || '',
      cnpj: f?.cnpj ?? '', ie: f?.ie ?? '', logradouro: f?.logradouro ?? '', numero: f?.numero ?? '', bairro: f?.bairro ?? '',
      cidade: f?.municipio ?? '', uf: f?.municipio ? f?.uf ?? '' : '', cep: f?.cep ?? '', telefone: f?.fone ?? '',
    },
  };
}

documentosRouter.get('/config', ah(async (req, res) => {
  const r = await configDocumento(orgOf(req));
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ ...r, rodape: RODAPE_DOCUMENTO });
}));

const txt = (max: number) => z.string().trim().max(max).default('');
const schema = z.object({
  nomeExibicao: txt(120), cnpj: txt(20), ie: txt(20), logradouro: txt(120), numero: txt(20), bairro: txt(80), cidade: txt(80),
  uf: z.string().trim().max(2).toUpperCase().default(''), cep: txt(10), telefone: txt(20), whatsapp: txt(20),
  email: z.union([z.literal(''), z.string().trim().email('E-mail inválido').max(120)]).default(''),
  site: txt(120), textoLivre: txt(300),
  /** undefined = mantém o logo; null = remove; string = data URL nova. */
  logo: z.string().max(1_000_000, 'Logo muito grande: o máximo é 500 KB').nullish(),
}); // sem .passthrough(): qualquer outro campo (ex.: "rodape") é descartado.

/** Confere o logo pelos BYTES (não pelo nome/tipo declarado). Devolve a data URL normalizada com o tipo real. */
export function validarLogo(dataUrl: string): string {
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl.trim());
  if (!m) throw badRequest('Envie o logo como imagem PNG, JPG ou WEBP');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > LOGO_MAX_BYTES) throw badRequest('Logo muito grande: o máximo é 500 KB');
  const real = detectImageMime(bytes);
  if (!real) throw badRequest('O arquivo não é uma imagem PNG, JPG ou WEBP');
  return `data:${real};base64,${bytes.toString('base64')}`;
}

documentosRouter.put('/config', admins, limiteEscrita, ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = schema.parse(req.body ?? {});
  const { logo, ...campos } = b;
  if (campos.cnpj && ![11, 14].includes(soDigitos(campos.cnpj).length) && !/^[A-Z0-9./-]{14,18}$/i.test(campos.cnpj)) throw badRequest('CNPJ inválido');
  const data: Record<string, unknown> = { ...campos };
  if (logo === null) data.logo = null;
  else if (typeof logo === 'string' && logo) data.logo = validarLogo(logo);
  const antes = await prisma.erpDocumentoConfig.findUnique({ where: { orgId }, select: { nomeExibicao: true, logo: true } });
  await prisma.erpDocumentoConfig.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
  await auditar(req, 'documentos.config', 'erp_documento_config', orgId, antes ? { nomeExibicao: antes.nomeExibicao, logo: !!antes.logo } : null, { nomeExibicao: campos.nomeExibicao, logo: data.logo === undefined ? !!antes?.logo : !!data.logo });
  const r = await configDocumento(orgId);
  res.json({ ...r, rodape: RODAPE_DOCUMENTO });
}));
