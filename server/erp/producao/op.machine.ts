/** Máquina de estados da ordem de produção. */
import type { Maquina } from '../shared/statemachine.js';

export type StatusOp = 'PLANEJADA' | 'LIBERADA' | 'EM_PRODUCAO' | 'ENCERRADA' | 'CANCELADA';
export type EventoOp = 'LIBERAR' | 'INICIAR' | 'APONTAR' | 'ENCERRAR' | 'CANCELAR' | 'ESTORNAR_LIBERACAO';
export interface CtxOp { componentes: number; faltas: number; produzidoMil: number; motivo?: string | null }

export const maquinaOp: Maquina<StatusOp, EventoOp, CtxOp> = {
  nome: 'Ordem de produção', inicial: 'PLANEJADA', finais: ['ENCERRADA', 'CANCELADA'],
  transicoes: [
    { de: 'PLANEJADA', evento: 'LIBERAR', para: 'LIBERADA', guarda: (c) => (!c.componentes ? 'Produto sem estrutura (cadastre os componentes)' : c.faltas ? 'Há componentes em falta: compre ou produza antes de liberar' : null), emite: ['producao.op.liberada'] },
    { de: 'LIBERADA', evento: 'ESTORNAR_LIBERACAO', para: 'PLANEJADA' },
    { de: 'LIBERADA', evento: 'INICIAR', para: 'EM_PRODUCAO' },
    { de: ['LIBERADA', 'EM_PRODUCAO'], evento: 'APONTAR', para: 'EM_PRODUCAO' },
    { de: 'EM_PRODUCAO', evento: 'ENCERRAR', para: 'ENCERRADA', guarda: (c) => (c.produzidoMil > 0 ? null : 'Nada apontado: cancele a OP em vez de encerrar'), emite: ['producao.op.encerrada'] },
    { de: ['PLANEJADA', 'LIBERADA'], evento: 'CANCELAR', para: 'CANCELADA', guarda: (c) => (c.motivo ? null : 'Informe o motivo do cancelamento') },
  ],
};
