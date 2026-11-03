/** Reações automáticas do CRM a eventos (idempotentes; rodam no despachante). */
import { consumir } from '../shared/events.js';
import { vincular } from '../shared/trace.js';

const ROTULO: Record<string, string> = {
  'crm.oportunidade.ganha': 'Oportunidade ganha',
  'crm.oportunidade.perdida': 'Oportunidade perdida',
  'crm.oportunidade.reaberta': 'Oportunidade reaberta',
  'crm.oportunidade.cancelada': 'Oportunidade cancelada',
  'crm.oportunidade.criada': 'Oportunidade criada',
};

export function registrarConsumidoresCrm() {
  // Linha do tempo: todo marco da oportunidade aparece no histórico do cliente.
  for (const tipo of Object.keys(ROTULO)) {
    consumir(tipo, 'crm.timeline', async (ev, tx) => {
      const p = ev.payload as { parceiroId?: string; titulo?: string; motivoPerda?: string; valorCents?: number };
      if (!p.parceiroId) return;
      const valor = typeof p.valorCents === 'number' ? ` (R$ ${(p.valorCents / 100).toFixed(2).replace('.', ',')})` : '';
      await tx.erpInteracao.create({
        data: { orgId: ev.orgId, parceiroId: p.parceiroId, oportunidadeId: ev.agregadoId, tipo: 'SISTEMA', assunto: ROTULO[tipo], conteudo: `${p.titulo ?? ''}${valor}${p.motivoPerda ? ` — motivo: ${p.motivoPerda}` : ''}` },
      });
    });
  }
  // Rastreio: cliente → oportunidade.
  consumir('crm.oportunidade.criada', 'crm.trace', async (ev, tx) => {
    const p = ev.payload as { parceiroId?: string };
    if (p.parceiroId) await vincular(tx, ev.orgId, { tipo: 'parceiro', id: p.parceiroId }, { tipo: 'oportunidade', id: ev.agregadoId }, 'gerou');
  });
  // Cliente que fecha negócio fica ATIVO (reativa inativos).
  consumir('crm.oportunidade.ganha', 'crm.reativar-cliente', async (ev, tx) => {
    const p = ev.payload as { parceiroId?: string };
    if (p.parceiroId) await tx.erpParceiro.updateMany({ where: { id: p.parceiroId, orgId: ev.orgId, status: 'INATIVO' }, data: { status: 'ATIVO' } });
  });
}
