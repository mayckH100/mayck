/**
 * Módulos do app (MCK ERP, MCKBOT, MCK Mensagens, Painel Master) e o que o topo e o menu mostram em cada rota.
 * Pedido do dono (08/11): "a interface superior deve ser o módulo que está sendo usado, vamos deixar mais limpo o layout".
 * Lógica pura (sem React) para poder ser testada em tests/unit/modulos.test.ts.
 */
import type { Role } from './auth';
import { ERP_ITENS } from './erp/ErpNav';

export type NavItem = { to: string; label: string; icon?: string; roles?: Role[]; superAdmin?: boolean; module?: string; sub?: string; href?: string; end?: boolean };
export type ModuloId = 'erp' | 'bot' | 'msg' | 'master';
export interface Modulo { id: ModuloId; label: string; icon: string; home: string; href?: string; items: NavItem[] }
export interface Grupo { id: string; label: string; icon: string; items: NavItem[] }

/** Os produtos, na ordem do menu. MCK Mensagens é outro app (/mensagem/): aqui é só o atalho. */
export const MODULOS: Modulo[] = [
  { id: 'erp', label: 'MCK ERP', icon: '◆', home: '/erp', items: [
    ...ERP_ITENS.map((i) => ({ module: 'erp_crm', ...i })),
    { to: '/erp/relatorios', label: 'Relatórios', module: 'erp_relatorios' },
    { to: '/erp/funcionarios', label: 'Funcionários', module: 'equipe', roles: ['OWNER', 'ADMIN'] },
  ] },
  { id: 'bot', label: 'MCKBOT', icon: '✉', home: '/', items: [
    { to: '/', label: 'Visão geral', icon: '◧', end: true },
    { to: '/inbox', module: 'inbox', label: 'Inbox', icon: '✉', sub: 'Atendimento' },
    { to: '/kanban', module: 'kanban', label: 'Kanban', icon: '▦' },
    { to: '/sdr', module: 'sdr', label: 'SDR com IA', icon: '🎯' },
    { to: '/agenda', module: 'agenda', label: 'Agenda', icon: '📅' },
    { to: '/contatos', module: 'contatos', label: 'Contatos', icon: '☺' },
    { to: '/fluxos', module: 'fluxos', label: 'Fluxos', icon: '⇄', sub: 'Automação' },
    { to: '/ia', module: 'ia', label: 'Inteligência artificial', icon: '✦' },
    { to: '/produtos', module: 'ia', label: 'Produtos', icon: '▣' },
    { to: '/canais', module: 'canais', label: 'Canais WhatsApp', icon: '☏' },
    { to: '/integracoes', module: 'integracoes', label: 'Integrações', icon: '⚙', roles: ['OWNER', 'ADMIN'] },
  ] },
  { id: 'msg', label: 'MCK Mensagens', icon: '✆', home: '/mensagem/', href: '/mensagem/', items: [
    { to: '/mensagem/', href: '/mensagem/', label: 'Abrir MCK Mensagens ↗', icon: '↗', roles: ['OWNER', 'ADMIN'], module: 'mensagens|automacoes' },
  ] },
  { id: 'master', label: 'Painel Master', icon: '♛', home: '/master', items: [
    { to: '/master', label: 'Painel Master', icon: '♛', superAdmin: true },
  ] },
];

/** Páginas de todos os módulos (gestão e conta): ficam no menu de qualquer módulo e mantêm o último módulo no topo. */
export const GRUPOS_COMUNS: Grupo[] = [
  { id: 'gestao', label: 'Gestão', icon: '▤', items: [
    { to: '/relatorios', module: 'relatorios', label: 'Relatórios', icon: '▤' },
    { to: '/equipe', module: 'equipe', label: 'Equipe', icon: '♟' },
    { to: '/plano', module: 'plano', label: 'Plano', icon: '◈' },
    { to: '/auditoria', module: 'auditoria', label: 'Auditoria', icon: '☰', roles: ['OWNER', 'ADMIN'] },
  ] },
  { id: 'conta', label: 'Conta', icon: '☻', items: [
    { to: '/perfil', label: 'Perfil', icon: '☻' },
    { to: '/tutoriais', label: 'Tutoriais', icon: '▶' },
    { to: '/boas-praticas', label: 'Boas práticas', icon: '?' },
  ] },
];

const EXTRAS: Record<string, string> = { '/versoes': 'Versões', '/assinatura': 'Plano' };

export interface Acesso { can: (...r: Role[]) => boolean; hasModule: (m: string) => boolean; superAdmin: boolean }

export const itemVisivel = (n: NavItem, a: Acesso) =>
  (!n.roles || a.can(...n.roles)) && (!n.module || n.module.split('|').some((m) => a.hasModule(m))) && (!n.superAdmin || a.superAdmin);

/** Módulos que a pessoa enxerga (com pelo menos um item liberado), já com os itens filtrados. */
export function modulosVisiveis(a: Acesso): Modulo[] {
  return MODULOS.map((m) => ({ ...m, items: m.items.filter((i) => itemVisivel(i, a)) })).filter((m) => m.items.length);
}
export function gruposComunsVisiveis(a: Acesso): Grupo[] {
  return GRUPOS_COMUNS.map((g) => ({ ...g, items: g.items.filter((i) => itemVisivel(i, a)) })).filter((g) => g.items.length);
}

export const rotaAtiva = (to: string, end: boolean | undefined, path: string) =>
  (end || to === '/' ? path === to : path === to || path.startsWith(`${to}/`));

/** A rota pertence a um módulo (erp, bot, master) ou é comum (gestão/conta), quando vale o último módulo usado. */
export function moduloDaRota(path: string, ultimo: ModuloId | null = null): { id: ModuloId; comum: boolean } {
  if (path === '/erp' || path.startsWith('/erp/')) return { id: 'erp', comum: false };
  if (path === '/master' || path.startsWith('/master/')) return { id: 'master', comum: false };
  const comum = GRUPOS_COMUNS.some((g) => g.items.some((i) => rotaAtiva(i.to, i.end, path))) || path in EXTRAS;
  if (comum) return { id: ultimo && ultimo !== 'msg' ? ultimo : 'bot', comum: true };
  return { id: 'bot', comum: false };
}

/** Nome da seção atual para o subtítulo do topo (ex.: "Venda balcão (PDV)"). O item mais específico ganha. */
export function secaoDaRota(path: string): string | null {
  let melhor: NavItem | null = null;
  for (const n of [...MODULOS.flatMap((m) => m.items), ...GRUPOS_COMUNS.flatMap((g) => g.items)]) {
    if (n.href || !rotaAtiva(n.to, n.end, path)) continue;
    if (!melhor || n.to.length > melhor.to.length) melhor = n;
  }
  if (!melhor && path.startsWith('/erp/caixa/')) return 'Caixa';
  return melhor?.label ?? EXTRAS[path] ?? null;
}

/** Ação principal do topo, por rota. No ERP e no Inbox não há (as telas já têm as suas). */
export interface AcaoTopo { to: string; label: string; roles?: Role[]; module?: string }
const ACOES: { rota: (p: string) => boolean; acao: AcaoTopo }[] = [
  { rota: (p) => p === '/fluxos' || p.startsWith('/fluxos/'), acao: { to: '/fluxos?novo=1', label: 'Criar fluxo', roles: ['OWNER', 'ADMIN'], module: 'fluxos' } },
];
export function acaoDaRota(path: string, a: Acesso): AcaoTopo | null {
  const achou = ACOES.find((x) => x.rota(path))?.acao;
  return achou && itemVisivel(achou, a) ? achou : null;
}

/** Iniciais para o avatar: "MAYCK A S HILARIO" → "MH". */
export function iniciais(nome: string | null | undefined): string {
  const p = (nome ?? '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return ((p[0][0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
