import express, { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { escHtml } from '../agenda/service.js';
import { allowedOrigins } from '../auth/session.js';
import { SEGMENTS } from './core.js';
import { sdrLiberadoCached } from './access.js';
import { getSdrSettings, optOutLead, upsertLead } from './service.js';

/**
 * Páginas públicas do SDR, fora de /api (formulário HTML puro, sem JavaScript, compatível com a CSP):
 *  - /f/<token>: formulário/link público da empresa → lead FORMULARIO (consentimento marcado pelo próprio lead);
 *  - /descadastro/<token>: descadastro do e-mail (botão; GET só mostra a página, para robôs de e-mail não descadastrarem sozinhos).
 * Proteções: token aleatório, limite por IP, campo-isca anti-robô, origem conferida no POST, tudo escapado.
 */
export const sdrPublicRouter = Router();

const formLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: 'Muitos envios. Tente de novo em alguns minutos.' });
const viewLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, message: 'Muitas requisições.' });
const urlenc = express.urlencoded({ extended: false, limit: '20kb' });
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function page(res: Response, status: number, title: string, body: string) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f4f5f7;margin:0;color:#111827}main{max-width:460px;margin:32px auto;background:#fff;border-radius:14px;padding:26px;box-shadow:0 4px 20px rgba(0,0,0,.06)}h1{font-size:22px;margin:0 0 6px}p{color:#4b5563}label{display:block;font-size:14px;margin:12px 0 4px;font-weight:600}input,select,textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit}textarea{min-height:80px}.chk{display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:13px;color:#374151}.chk input{width:auto;margin-top:3px}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#d90429;color:#fff;font-size:16px;font-weight:700;cursor:pointer}.hp{position:absolute;left:-5000px}.small{font-size:12px;color:#6b7280}</style></head><body><main>${body}</main></body></html>`);
}

function originOk(req: Request) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  if (o === 'null') return false;
  return allowedOrigins(req).has(o);
}

async function formOrg(token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const s = await prisma.sdrSettings.findUnique({ where: { formToken: token } });
  if (!s || !s.enabled || !s.formEnabled) return null;
  if (!(await sdrLiberadoCached(s.orgId))) return null;
  const org = await prisma.organization.findUnique({ where: { id: s.orgId }, select: { name: true } });
  return { s, orgName: org?.name ?? '' };
}

function formHtml(token: string, title: string, orgName: string, error?: string) {
  const segs = SEGMENTS.map((s) => `<option value="${s.id}">${escHtml(s.label)}</option>`).join('');
  return `<h1>${escHtml(title)}</h1><p>${escHtml(orgName)}: deixe seus dados e retornamos rapidinho.</p>${error ? `<p style="color:#b91c1c">${escHtml(error)}</p>` : ''}
<form method="post" action="/f/${escHtml(token)}">
<label for="nome">Nome</label><input id="nome" name="nome" maxlength="120" required autocomplete="name">
<label for="empresa">Empresa (opcional)</label><input id="empresa" name="empresa" maxlength="120" autocomplete="organization">
<label for="telefone">WhatsApp</label><input id="telefone" name="telefone" maxlength="30" inputmode="tel" autocomplete="tel" placeholder="(11) 90000-0000">
<label for="email">E-mail</label><input id="email" name="email" type="email" maxlength="200" autocomplete="email">
<label for="segmento">Ramo</label><select id="segmento" name="segmento">${segs}</select>
<label for="mensagem">Como podemos ajudar? (opcional)</label><textarea id="mensagem" name="mensagem" maxlength="500"></textarea>
<div class="hp" aria-hidden="true"><label for="site">Site</label><input id="site" name="site" tabindex="-1" autocomplete="off"></div>
<label class="chk"><input type="checkbox" name="consentimento" value="sim" required> Autorizo ${escHtml(orgName || 'a empresa')} a entrar em contato comigo por WhatsApp e e-mail. Posso pedir para sair a qualquer momento respondendo SAIR.</label>
<button type="submit">Enviar</button><p class="small">Seus dados são usados só para este contato (LGPD).</p></form>`;
}

sdrPublicRouter.get('/f/:token', viewLimiter, async (req, res, next) => {
  try {
    const f = await formOrg(req.params.token);
    if (!f) return page(res, 404, 'Formulário indisponível', '<h1>Formulário indisponível</h1><p>Este link não está ativo.</p>');
    page(res, 200, f.s.formTitle, formHtml(req.params.token, f.s.formTitle, f.orgName));
  } catch (e) { next(e); }
});

sdrPublicRouter.post('/f/:token', formLimiter, urlenc, async (req, res, next) => {
  try {
    if (!originOk(req)) return page(res, 403, 'Origem não permitida', '<h1>Envio recusado</h1>');
    const f = await formOrg(req.params.token);
    if (!f) return page(res, 404, 'Formulário indisponível', '<h1>Formulário indisponível</h1><p>Este link não está ativo.</p>');
    const b = (req.body ?? {}) as Record<string, string>;
    const thanks = () => page(res, 200, 'Recebido!', `<h1>Recebido! ✅</h1><p>Obrigado. ${escHtml(f.orgName || 'A equipe')} vai falar com você em breve.</p>`);
    if (b.site) return thanks(); // robô preencheu o campo-isca: finge sucesso e não grava
    if (b.consentimento !== 'sim') return page(res, 400, f.s.formTitle, formHtml(req.params.token, f.s.formTitle, f.orgName, 'Marque a autorização de contato para enviar.'));
    const seg = SEGMENTS.some((s) => s.id === b.segmento) ? b.segmento : null;
    try {
      await upsertLead(f.s.orgId, {
        name: String(b.nome ?? '').slice(0, 120), company: String(b.empresa ?? '').slice(0, 120) || null, segment: seg,
        phone: String(b.telefone ?? '').slice(0, 30), email: String(b.email ?? '').slice(0, 200), consent: true,
        note: b.mensagem ? `Mensagem do formulário: ${String(b.mensagem).slice(0, 400)}` : null,
      }, 'FORMULARIO');
    } catch {
      return page(res, 400, f.s.formTitle, formHtml(req.params.token, f.s.formTitle, f.orgName, 'Informe um WhatsApp ou e-mail válido.'));
    }
    thanks();
  } catch (e) { next(e); }
});

async function unsubLead(token: string) {
  if (!TOKEN_RE.test(token)) return null;
  return prisma.sdrLead.findUnique({ where: { unsubToken: token } });
}

sdrPublicRouter.get('/descadastro/:token', viewLimiter, async (req, res, next) => {
  try {
    const l = await unsubLead(req.params.token);
    if (!l) return page(res, 404, 'Link inválido', '<h1>Link inválido</h1><p>Este link de descadastro não existe.</p>');
    const org = await prisma.organization.findUnique({ where: { id: l.orgId }, select: { name: true } });
    if (l.optOutAt) return page(res, 200, 'Descadastrado', `<h1>Pronto</h1><p>Você não vai mais receber mensagens de ${escHtml(org?.name ?? 'esta empresa')}.</p>`);
    page(res, 200, 'Descadastrar', `<h1>Não quer mais receber?</h1><p>Confirme para não receber mais e-mails nem mensagens de ${escHtml(org?.name ?? 'esta empresa')}.</p><form method="post" action="/descadastro/${escHtml(req.params.token)}"><button type="submit">Descadastrar</button></form>`);
  } catch (e) { next(e); }
});

sdrPublicRouter.post('/descadastro/:token', formLimiter, urlenc, async (req, res, next) => {
  try {
    if (!originOk(req)) return page(res, 403, 'Origem não permitida', '<h1>Envio recusado</h1>');
    const l = await unsubLead(req.params.token);
    if (!l) return page(res, 404, 'Link inválido', '<h1>Link inválido</h1>');
    await optOutLead(l, 'EMAIL');
    await prisma.lead.updateMany({ where: { orgId: l.orgId, optOutAt: null, OR: [...(l.leadId ? [{ id: l.leadId }] : []), ...(l.phone ? [{ phone: l.phone }] : [])] }, data: { optOutAt: new Date() } }).catch(() => undefined);
    const org = await prisma.organization.findUnique({ where: { id: l.orgId }, select: { name: true } });
    page(res, 200, 'Descadastrado', `<h1>Pronto ✅</h1><p>Você não vai mais receber mensagens de ${escHtml(org?.name ?? 'esta empresa')}.</p>`);
  } catch (e) { next(e); }
});

export { getSdrSettings };
