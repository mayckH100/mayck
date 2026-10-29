import { prisma } from '../db.js';
import { getSettings } from '../billing/service.js';

/**
 * Configurações do site oficial (/empresa), editadas no Painel Master > Configurações > Site oficial.
 * Guardadas em PlatformSettings.siteJson. As páginas do site leem a versão pública em /api/public/site
 * e mantêm o conteúdo estático se a API falhar.
 */
export interface SiteSettings {
  contactEmail: string;
  whatsapp: string; // só dígitos, com DDI (ex.: 5511999999999); vazio = não mostrar
  facebookUrl: string;
  tutorialsPublic: boolean; // tutoriais completos abertos no site (padrão: só assinantes)
  promoCoupon: string; // cupom em destaque (vazio = sem promoção)
  promoText: string;
}

export const DEFAULT_SITE: SiteSettings = {
  contactEmail: 'mckdevbr@gmail.com',
  whatsapp: '',
  facebookUrl: 'https://www.facebook.com/profile.php?id=61596189174050',
  tutorialsPublic: false,
  promoCoupon: '',
  promoText: '',
};

export function parseSite(json: string | null | undefined): SiteSettings {
  let o: any = {};
  try { o = JSON.parse(json || '{}') ?? {}; } catch { o = {}; }
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  return {
    contactEmail: str(o.contactEmail, DEFAULT_SITE.contactEmail) || DEFAULT_SITE.contactEmail,
    whatsapp: str(o.whatsapp, ''),
    facebookUrl: str(o.facebookUrl, DEFAULT_SITE.facebookUrl) || DEFAULT_SITE.facebookUrl,
    tutorialsPublic: o.tutorialsPublic === true,
    promoCoupon: str(o.promoCoupon, ''),
    promoText: str(o.promoText, ''),
  };
}

export async function getSiteSettings(): Promise<SiteSettings> {
  const { raw } = await getSettings();
  return parseSite(raw.siteJson);
}

export async function updateSiteSettings(input: Partial<SiteSettings>): Promise<SiteSettings> {
  const cur = await getSiteSettings();
  const next: SiteSettings = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as SiteSettings;
  await prisma.platformSettings.update({ where: { id: 'default' }, data: { siteJson: JSON.stringify(next) } });
  return next;
}
