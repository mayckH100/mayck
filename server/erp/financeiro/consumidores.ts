/** Financeiro reage aos eventos: faturamento gera contas a receber; NF-e de entrada gera contas a pagar. */
import { consumir } from '../shared/events.js';
import { titulosDoPedido, titulosDaNfe, cancelarTitulosDoDoc } from './servico.js';

export function registrarConsumidoresFinanceiro() {
  consumir('vendas.pedido.faturado', 'financeiro.titulos-receber', async (ev, tx) => { await titulosDoPedido(tx, ev.orgId, ev.agregadoId); });
  consumir('estoque.nfe_entrada.lancada', 'financeiro.titulos-pagar', async (ev, tx) => { await titulosDaNfe(tx, ev.orgId, ev.agregadoId); });
  for (const t of ['vendas.pedido.cancelado', 'vendas.pedido.devolvido']) consumir(t, 'financeiro.cancelar-titulos', async (ev, tx) => { await cancelarTitulosDoDoc(tx, ev.orgId, 'pedido_venda', ev.agregadoId); });
}
