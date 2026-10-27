import nodemailer, { type Transporter } from 'nodemailer';
import type { Request } from 'express';
import { isTest } from '../config.js';

/**
 * E-mails transacionais via SMTP genérico (qualquer provedor: Brevo, Gmail com senha de app, Zoho, Resend SMTP…).
 * Variáveis: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, APP_URL.
 * Sem SMTP configurado, nada quebra: o envio é apenas registrado no log.
 */

export interface MailMessage { to: string; subject: string; html: string; text: string; kind: string }

/** Caixa de saída em memória — usada só nos testes automatizados. */
export const outbox: MailMessage[] = [];

let transporter: Transporter | null = null;
let transporterKey = '';

export function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function getTransporter(): Transporter | null {
  if (!smtpConfigured()) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const key = [process.env.SMTP_HOST, port, process.env.SMTP_USER].join('|');
  if (!transporter || key !== transporterKey) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    transporterKey = key;
  }
  return transporter;
}

/** Envia sem lançar erro: falha de SMTP nunca derruba cadastro, recuperação ou troca de senha. */
export async function sendMail(msg: MailMessage): Promise<boolean> {
  if (isTest) { outbox.push(msg); return true; }
  const t = getTransporter();
  if (!t) {
    console.warn(`[mail] SMTP não configurado — e-mail "${msg.kind}" para ${maskEmail(msg.to)} não enviado.`);
    return false;
  }
  try {
    await t.sendMail({ from: process.env.MAIL_FROM, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
    console.info(`[mail] "${msg.kind}" enviado para ${maskEmail(msg.to)}`);
    return true;
  } catch (e) {
    console.error(`[mail] falha ao enviar "${msg.kind}" para ${maskEmail(msg.to)}:`, (e as Error).message);
    return false;
  }
}

/**
 * Envio com resultado detalhado (Automações do MCK Mensagens): devolve o id do provedor ou o erro real.
 * Usa o mesmo transporte SMTP configurado; sem SMTP, falha com motivo explícito (nunca simula envio).
 */
export async function sendMailResult(msg: { to: string; subject: string; text: string; html?: string }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (isTest) { outbox.push({ ...msg, html: msg.html ?? msg.text, kind: 'automacao' }); return { ok: true, messageId: `test-${outbox.length}` }; }
  const t = getTransporter();
  if (!t) return { ok: false, error: 'SMTP não configurado (defina SMTP_HOST e MAIL_FROM)' };
  try {
    const r = await t.sendMail({ from: process.env.MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return { ok: true, messageId: r.messageId };
  } catch (e) {
    return { ok: false, error: ((e as Error).message || 'Falha no SMTP').slice(0, 500) };
  }
}

/** Verifica a conexão/autenticação SMTP sem enviar e-mail. */
export async function verifySmtp(): Promise<{ ok: boolean; error?: string }> {
  const t = getTransporter();
  if (!t) return { ok: false, error: 'SMTP não configurado' };
  try { await t.verify(); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Dispara em segundo plano (não atrasa a resposta HTTP). */
export function sendMailLater(msg: MailMessage) {
  void sendMail(msg);
}

export function maskEmail(e: string) {
  const [u, d] = e.split('@');
  return `${(u ?? '').slice(0, 2)}***@${d ?? ''}`;
}

/**
 * URL pública do app para os links dos e-mails.
 * APP_URL (explícita) → RENDER_EXTERNAL_URL (definida pelo Render) → origem da requisição (apenas fora de produção,
 * para evitar envenenamento do link pelo cabeçalho Host).
 */
export function appUrl(req?: Request) {
  const explicit = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  if (req && process.env.NODE_ENV !== 'production') return `${req.protocol}://${req.get('host')}`;
  return 'http://localhost:3000';
}

// ---------- Templates ----------
export type AppBrand = 'mckbot' | 'mensagem';
const BRANDS: Record<AppBrand, { name: string; color: string; base: string; logo: string }> = {
  mckbot: { name: 'MCKBOT', color: '#d90429', base: '', logo: '/logo-512.png' },
  mensagem: { name: 'MCK Mensagens', color: '#e10a2c', base: '/mensagem', logo: '/mensagem-logo-512.png' },
};
export const brandOf = (app: unknown): AppBrand => (app === 'mensagem' ? 'mensagem' : 'mckbot');
export const appPath = (app: AppBrand, path: string, req?: Request) => `${appUrl(req)}${BRANDS[app].base}${path}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function layout(app: AppBrand, req: Request | undefined, title: string, paragraphs: string[], cta?: { label: string; url: string }, footnote?: string) {
  const b = BRANDS[app];
  const logo = `${appUrl(req)}${b.logo}`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0a0a0b;padding:20px 28px;border-bottom:4px solid ${b.color}">
<img src="${logo}" width="36" height="36" alt="" style="vertical-align:middle;border-radius:8px"> <span style="color:#fff;font-size:20px;font-weight:bold;vertical-align:middle;margin-left:8px">${b.name}</span></td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px">${p}</p>`).join('\n')}
${cta ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:${b.color};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${esc(cta.label)}</a></p>
<p style="font-size:12px;color:#71717a;word-break:break-all">Se o botão não funcionar, copie e cole este endereço no navegador:<br>${esc(cta.url)}</p>` : ''}
${footnote ? `<p style="font-size:12px;color:#71717a;margin-top:20px">${footnote}</p>` : ''}
</td></tr>
<tr><td style="background:#0a0a0b;color:#a1a1aa;font-size:12px;padding:14px 28px">${b.name} · mensagem automática, não responda este e-mail.</td></tr>
</table></td></tr></table></body></html>`;
  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  const text = [title, '', ...paragraphs.map(strip), cta ? `\n${cta.label}: ${cta.url}` : '', footnote ? `\n${strip(footnote)}` : ''].join('\n');
  return { html, text };
}

export function welcomeMail(o: { to: string; name: string; app: AppBrand; verifyUrl?: string; req?: Request }): MailMessage {
  const b = BRANDS[o.app];
  const { html, text } = layout(o.app, o.req, `Bem-vindo(a) ao ${b.name}, ${o.name}!`, [
    'Sua conta foi criada com sucesso. Você já pode entrar e começar a usar a plataforma — o período de teste grátis começa agora.',
    o.verifyUrl ? 'Para confirmar que este e-mail é seu, clique no botão abaixo. Isso não bloqueia o seu acesso.' : 'Guarde este e-mail: ele é o login da sua conta.',
  ], o.verifyUrl ? { label: 'Confirmar meu e-mail', url: o.verifyUrl } : { label: `Abrir o ${b.name}`, url: appPath(o.app, '/', o.req) },
  'Se você não criou esta conta, ignore esta mensagem.');
  return { to: o.to, subject: `Sua conta no ${b.name} foi criada`, html, text, kind: 'welcome' };
}

export function resetMail(o: { to: string; name: string; app: AppBrand; url: string; req?: Request }): MailMessage {
  const b = BRANDS[o.app];
  const { html, text } = layout(o.app, o.req, 'Redefinição de senha', [
    `Olá, ${esc(o.name)}. Recebemos um pedido para redefinir a senha da sua conta no ${b.name}.`,
    'O link abaixo vale por <strong>1 hora</strong> e só pode ser usado uma vez.',
  ], { label: 'Definir nova senha', url: o.url }, 'Se você não pediu a redefinição, ignore este e-mail: sua senha continua a mesma.');
  return { to: o.to, subject: `Redefina sua senha do ${b.name}`, html, text, kind: 'reset' };
}

export function passwordChangedMail(o: { to: string; name: string; app: AppBrand; req?: Request }): MailMessage {
  const b = BRANDS[o.app];
  const when = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const { html, text } = layout(o.app, o.req, 'Sua senha foi alterada', [
    `Olá, ${esc(o.name)}. A senha da sua conta no ${b.name} foi alterada em ${when} (horário de Brasília).`,
    'Por segurança, todas as sessões abertas foram encerradas. Entre de novo com a nova senha.',
  ], { label: 'Entrar', url: appPath(o.app, '/login', o.req) }, 'Se não foi você, redefina a senha imediatamente pelo link "Esqueci minha senha" e fale com o suporte.');
  return { to: o.to, subject: `Senha alterada no ${b.name}`, html, text, kind: 'password_changed' };
}
