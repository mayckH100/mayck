/** Máquina de estados da oportunidade (funil de vendas). */
import type { Maquina } from '../shared/statemachine.js';

export type StatusOportunidade = 'ABERTA' | 'GANHA' | 'PERDIDA' | 'CANCELADA';
export type EventoOportunidade = 'MOVER' | 'GANHAR' | 'PERDER' | 'CANCELAR' | 'REABRIR';
export interface CtxOportunidade { valorCents: number; motivoPerda?: string | null; parceiroStatus: string }

export const maquinaOportunidade: Maquina<StatusOportunidade, EventoOportunidade, CtxOportunidade> = {
  nome: 'Oportunidade',
  inicial: 'ABERTA',
  finais: ['CANCELADA'],
  transicoes: [
    { de: 'ABERTA', evento: 'MOVER', para: 'ABERTA', emite: ['crm.oportunidade.movida'] },
    {
      de: 'ABERTA', evento: 'GANHAR', para: 'GANHA', emite: ['crm.oportunidade.ganha'],
      guarda: (c) => (c.valorCents <= 0 ? 'Informe o valor antes de marcar como ganha' : c.parceiroStatus === 'BLOQUEADO' ? 'Cliente bloqueado: libere o cadastro antes de fechar' : null),
    },
    { de: 'ABERTA', evento: 'PERDER', para: 'PERDIDA', emite: ['crm.oportunidade.perdida'], guarda: (c) => (!c.motivoPerda?.trim() ? 'Informe o motivo da perda' : null) },
    { de: ['GANHA', 'PERDIDA'], evento: 'REABRIR', para: 'ABERTA', emite: ['crm.oportunidade.reaberta'] },
    { de: ['ABERTA', 'PERDIDA'], evento: 'CANCELAR', para: 'CANCELADA', emite: ['crm.oportunidade.cancelada'] },
  ],
};
