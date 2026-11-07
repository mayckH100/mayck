import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiSettings } from '@prisma/client';
import { getSettings, PLAN_PRODUCTS } from '../billing/service.js';
import { PUBLIC_PLAN_INFO } from '../routes/plans.js';

/**
 * Conhecimento do site da MCK DESENVOLVIMENTO para a IA (só organizações com useMckSite, que só o superadmin liga)
 * e posicionamento frente a concorrentes (qualquer organização, pelo campo "Diferenciais vs concorrentes").
 *
 * - Páginas: web/public/empresa (dev/testes) ou dist/web/empresa (produção): mckbot, mck-mensagens, planos, ajuda, contato.
 *   Texto limpo (sem scripts/menus), lido uma vez por processo.
 * - Preços: sempre os atuais, os mesmos de /api/public/plans (PlatformSettings editado no Master).
 */

export const SITE_PAGES = ['index', 'mckbot', 'mck-mensagens', 'planos', 'ajuda', 'contato'] as const;
const PAGE_MAX = 2500;

function empresaDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const c = [
    path.resolve(here, '../../web/empresa'), path.resolve(here, '../../../dist/web/empresa'), path.resolve(process.cwd(), 'dist/web/empresa'),
    path.resolve(here, '../../web/public/empresa'), path.resolve(process.cwd(), 'web/public/empresa'),
  ];
  return c.find((d) => existsSync(path.join(d, 'mckbot.html'))) ?? null;
}

/** HTML → texto: tira head/scripts/estilos, cabeçalho e rodapé do site, tags e espaços. */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|head|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(header|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|h[1-6]|li|div|section|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, '·');
  return s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 2).join('\n');
}

let cache: { text: string } | null = null;
export function siteText(): string {
  if (cache) return cache.text;
  const dir = empresaDir();
  const parts: string[] = [];
  if (dir) {
    const seen = new Set<string>(); // linhas repetidas em todas as páginas (faixa, menu, rodapé) entram uma vez só
    for (const p of SITE_PAGES) {
      const f = path.join(dir, `${p}.html`);
      if (!existsSync(f)) continue;
      const lines = htmlToText(readFileSync(f, 'utf8')).replace(/Carregando planos…/g, '').split('\n').filter((l) => { if (seen.has(l)) return false; seen.add(l); return true; });
      const t = lines.join('\n').slice(0, PAGE_MAX);
      if (t) parts.push(`[Página ${p === 'index' ? 'inicial' : p}]\n${t}`);
    }
  }
  cache = { text: parts.join('\n\n') };
  return cache.text;
}
export const resetSiteCache = () => { cache = null; };

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Preços atuais (mesmos da vitrine /api/public/plans). */
export async function livePricesText(): Promise<string> {
  const { prices, trialDays } = await getSettings();
  const lines = PLAN_PRODUCTS.map((id) => {
    const p = prices[id];
    const save = Math.max(0, p.MENSAL * 12 - p.ANUAL);
    return `- ${PUBLIC_PLAN_INFO[id].label}: ${brl(p.MENSAL)}/mês ou ${brl(p.ANUAL)}/ano${save ? ` (economia de ${brl(save)} no anual)` : ''}. ${PUBLIC_PLAN_INFO[id].desc}`;
  });
  return [`PREÇOS ATUAIS (valem mais que qualquer valor escrito nas páginas): teste grátis de ${trialDays} dias, sem cartão no cadastro; pagamento por Pix, boleto ou cartão (Mercado Pago), sem fidelidade.`, ...lines].join('\n');
}

/** Diferenciais da MCK DESENVOLVIMENTO (verdadeiros, tirados do produto e do site; sem números de concorrentes). */
export const MCK_DIFERENCIAIS = [
  'Tudo em um lugar: robô de fluxos, IA, Inbox da equipe, Kanban/CRM, agenda com Google Meet, campanhas e cobranças automáticas (MCK Mensagens) e SDR com IA, que qualifica os leads (inclusive quem responde às campanhas).',
  'Conecta o número de WhatsApp que a empresa já usa, por QR code, sem trocar de número e sem precisar da API paga para começar (a API oficial da Meta também é suportada).',
  'IA que fala como a empresa (instruções, base de conhecimento, catálogo de produtos) e só passa para uma pessoa quando o cliente pede.',
  'Teste grátis sem cartão, planos mensais sem fidelidade e preços acessíveis (veja PREÇOS ATUAIS).',
  'Empresa brasileira (MCK DESENVOLVIMENTO), suporte em português, pagamento por Pix, boleto ou cartão.',
  'Não confundir com a "MCK Desenvolvimento de Sistemas LTDA" nem com o Grupo MCK Automação: são outras empresas.',
].map((l) => `- ${l}`).join('\n');

/** Regras de comparação com concorrentes (sempre honestas). */
export const COMPETITOR_RULES = [
  'QUANDO O CLIENTE COMPARAR COM CONCORRENTES (outra empresa, outro sistema, "qual a diferença", "é melhor que…", "é mais barato que…"):',
  '- Responda com respeito e SEMPRE posicione a nossa empresa de forma favorável, destacando os diferenciais abaixo que resolvem a necessidade do cliente.',
  '- Seja honesto: nunca invente preço, recurso, defeito ou número de outra empresa e não fale mal de concorrente pelo nome. Se não souber como o concorrente funciona, diga que não pode afirmar pelo outro e foque no que nós oferecemos.',
  '- Termine convidando para o próximo passo (testar grátis, ver os planos ou tirar uma dúvida).',
].join('\n');

/** Seção do prompt: site da MCK + preços atuais + diferenciais/regras de concorrentes. Vazia quando nada está ligado. */
export async function knowledgePromptSection(s: Pick<AiSettings, 'useMckSite' | 'competitorNotes' | 'webSearch'>, _text = ''): Promise<string> {
  const out: string[] = [];
  if (s.useMckSite) {
    const site = siteText();
    const prices = await livePricesText().catch(() => '');
    out.push('### SITE OFICIAL DA EMPRESA (MCK DESENVOLVIMENTO) — use como base de conhecimento', site || '(páginas do site indisponíveis)', prices, '### FIM DO SITE');
  }
  const notes = s.competitorNotes?.trim();
  if (s.useMckSite || notes || s.webSearch) {
    out.push(COMPETITOR_RULES, 'NOSSOS DIFERENCIAIS:');
    if (s.useMckSite) out.push(MCK_DIFERENCIAIS);
    if (notes) out.push(notes.slice(0, 3000));
    if (s.webSearch) out.push('- Se você tiver resultados de pesquisa na web sobre o concorrente, use só fatos confirmados por eles e cite que são informações públicas.');
  }
  return out.join('\n');
}
