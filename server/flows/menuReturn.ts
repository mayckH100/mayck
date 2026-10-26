import { prisma } from '../db.js';
import { normalize } from './logic.js';
import { numberedOptions } from '../whatsapp/qr/parse.js';
import type { OutboundPayload } from '../whatsapp/cloudClient.js';

/**
 * "Voltar ao menu" — comando global do cliente final do WhatsApp.
 *
 * - Em qualquer etapa (menu, pergunta, espera, IA em conversa, fluxo já encerrado), se o cliente
 *   mandar uma das palavras configuradas (padrão "0", "menu", "voltar"; sem diferenciar maiúsculas
 *   e acentos) ou tocar no botão "Voltar ao menu", a etapa atual é cancelada e o fluxo do menu
 *   recomeça do bloco inicial, reenviando todas as mensagens.
 * - Atendimento humano: quando a conversa está em modo HUMANO, a automação inteira fica desligada
 *   (o inbound nem chega ao motor). O comando, portanto, NÃO tira a conversa do atendente: a mensagem
 *   "0"/"menu" fica no Inbox como qualquer outra e o atendente decide. Para voltar ao robô, o atendente
 *   usa "Devolver ao robô" no Inbox. Escolha feita para não atrapalhar quem está atendendo.
 */
export const MENU_BUTTON_ID = '__menu__';
export const MENU_BUTTON_TITLE = 'Voltar ao menu';
export const DEFAULT_MENU_SETTINGS = {
  menuCommandEnabled: true,
  menuCommandWords: '0,menu,voltar',
  menuFooterEnabled: true,
  menuFooterText: '↩️ Digite 0 para voltar ao menu',
  menuButtonEnabled: true,
  menuFlowId: null as string | null,
};
export type MenuSettings = typeof DEFAULT_MENU_SETTINGS;

export async function getMenuSettings(orgId: string): Promise<MenuSettings> {
  const row = await prisma.flowSettings.findUnique({ where: { orgId } });
  if (!row) return { ...DEFAULT_MENU_SETTINGS };
  return {
    menuCommandEnabled: row.menuCommandEnabled, menuCommandWords: row.menuCommandWords, menuFooterEnabled: row.menuFooterEnabled,
    menuFooterText: row.menuFooterText, menuButtonEnabled: row.menuButtonEnabled, menuFlowId: row.menuFlowId,
  };
}

/** "0, Menu ,VOLTAR" → ["0","menu","voltar"] (normalizadas, sem repetição, até 10 palavras). */
export function parseWords(raw: string): string[] {
  return [...new Set(String(raw ?? '').split(/[,;\n]/).map((w) => normalize(w)).filter(Boolean))].slice(0, 10);
}

export function isMenuCommand(s: Pick<MenuSettings, 'menuCommandEnabled' | 'menuCommandWords'>, text: string, replyId?: string): boolean {
  if (!s.menuCommandEnabled) return false;
  if (replyId === MENU_BUTTON_ID) return true;
  const t = normalize(text);
  return !!t && parseWords(s.menuCommandWords).includes(t);
}

/**
 * Acrescenta a saída "Voltar ao menu" a uma mensagem que espera resposta.
 *  - Cloud API (botões confiáveis): botão "Voltar ao menu" (se couber: até 3 botões e texto ≤ 1024).
 *  - QR/Baileys (botões não confiáveis) ou sem espaço para botão: linha de rodapé em texto.
 */
export function withMenuReturn(p: OutboundPayload, s: MenuSettings, qr: boolean): OutboundPayload {
  if (!s.menuCommandEnabled || (p.type !== 'text' && p.type !== 'buttons')) return p;
  if (!qr && s.menuButtonEnabled && p.text.length <= 1024) {
    if (p.type === 'text') return { type: 'buttons', text: p.text, buttons: [{ id: MENU_BUTTON_ID, title: MENU_BUTTON_TITLE }] };
    if (p.buttons.length < 3) return { ...p, buttons: [...p.buttons, { id: MENU_BUTTON_ID, title: MENU_BUTTON_TITLE }] };
  }
  const footer = s.menuFooterEnabled ? String(s.menuFooterText ?? '').trim() : '';
  if (!footer) return p;
  if (p.type === 'text') return { ...p, text: `${p.text}\n\n${footer}` };
  // Botões no QR viram texto numerado; o rodapé vai no fim.
  if (qr) return { type: 'text', text: `${numberedOptions(p.text, p.buttons)}\n${footer}` };
  return { ...p, text: `${p.text}\n\n${footer}` };
}
