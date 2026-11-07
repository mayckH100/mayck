import type { SdrLead } from '@prisma/client';
import { prisma } from '../db.js';
import { parseJson } from '../lib/json.js';
import { isValidCnpj, onlyDigits } from '../lib/documento.js';
import { consultarCnpj, CnpjErro } from '../erp/crm/cnpj.js';
import { logEvent } from './service.js';

/**
 * SDR fase 2 (v1.21.0) — enriquecimento por CNPJ na BrasilAPI (gratuita, dados públicos da Receita), reaproveitando a
 * consulta do MCK ERP. Cache em memória (24 h; falha 1 h), timeout da consulta e falha silenciosa: nunca lança e nunca
 * bloqueia o atendimento. Guarda no histórico do lead (evento CNPJ) só dados da empresa: razão social, fantasia,
 * atividade (CNAE), situação, porte/regime, cidade/UF. Telefone e e-mail da Receita não são guardados (podem ser de pessoa física/MEI).
 */
export interface EmpresaReceita { cnpj: string; razaoSocial: string; fantasia: string | null; atividade: string | null; situacao: string | null; regime: string | null; cidade: string | null; uf: string | null }

const CNPJ_RE = /(?<![\d])(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})(?![\d])/g;
/** Primeiro CNPJ válido (numérico) que aparece no texto. */
export function findCnpjIn(text: string | null | undefined): string | null {
  for (const m of String(text ?? '').matchAll(CNPJ_RE)) {
    const d = onlyDigits(m[1]);
    if (d.length === 14 && isValidCnpj(d)) return d;
  }
  return null;
}

const OK_TTL = 24 * 3600e3, FAIL_TTL = 3600e3, MAX = 500;
const cache = new Map<string, { at: number; data: EmpresaReceita | null }>();
export const clearCnpjCache = () => cache.clear();

/** Consulta com cache; null quando não achou, inválido ou API fora (nunca lança). */
export async function lookupCnpj(raw: string, now = Date.now()): Promise<EmpresaReceita | null> {
  const cnpj = onlyDigits(raw);
  if (cnpj.length !== 14 || !isValidCnpj(cnpj)) return null;
  const hit = cache.get(cnpj);
  if (hit && now - hit.at < (hit.data ? OK_TTL : FAIL_TTL)) return hit.data;
  let data: EmpresaReceita | null = null;
  try {
    const d = await consultarCnpj(cnpj);
    data = { cnpj, razaoSocial: d.nome, fantasia: d.fantasia, atividade: d.cnaeDescricao, situacao: d.situacaoCadastral, regime: d.regimeTributario, cidade: d.municipio, uf: d.uf };
  } catch (e) {
    if (!(e instanceof CnpjErro)) console.warn('[sdr] consulta de CNPJ falhou', { error: (e as Error).message });
  }
  if (cache.size >= MAX) cache.delete(cache.keys().next().value as string);
  cache.set(cnpj, { at: now, data });
  return data;
}

/** Último enriquecimento gravado no lead. */
export async function leadEmpresa(orgId: string, leadId: string): Promise<EmpresaReceita | null> {
  const e = await prisma.sdrEvent.findFirst({ where: { orgId, leadId, type: 'CNPJ' }, orderBy: { createdAt: 'desc' }, select: { detail: true } });
  return e ? parseJson<EmpresaReceita | null>(e.detail, null) : null;
}

/** Enriquece o lead (preenche a empresa se estiver vazia). Nunca lança. */
export async function enrichLead(lead: SdrLead, raw: string): Promise<EmpresaReceita | null> {
  try {
    const cnpj = onlyDigits(raw);
    const prev = await leadEmpresa(lead.orgId, lead.id);
    if (prev?.cnpj === cnpj) return prev;
    const data = await lookupCnpj(cnpj);
    if (!data) return null;
    await logEvent(lead.orgId, lead.id, 'CNPJ', null, JSON.stringify(data));
    if (!lead.company?.trim()) await prisma.sdrLead.update({ where: { id: lead.id }, data: { company: (data.fantasia || data.razaoSocial).slice(0, 120) } });
    return data;
  } catch (e) {
    console.warn('[sdr] enriquecimento por CNPJ ignorado', { leadId: lead.id, error: (e as Error).message });
    return null;
  }
}

const pending = new Set<Promise<unknown>>();
/** Segundo plano (não atrasa nada). */
export function enrichLeadInBackground(lead: SdrLead, raw: string) {
  const p = enrichLead(lead, raw);
  pending.add(p);
  p.finally(() => pending.delete(p));
}
export async function flushCnpj() { while (pending.size) await Promise.all([...pending]); }
