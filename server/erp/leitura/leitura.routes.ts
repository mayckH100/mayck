/**
 * "Ler código" de qualquer tela do MCK ERP (v1.34.0): GET /api/erp/leitura?codigo=… diz o que é o código e para onde ir.
 *  - pedido (PV-123) → o pedido;  - chave de NF-e/NFC-e → o pedido da nota de saída, ou o rastreio da nota de entrada;
 *  - etiqueta do lote / lote → rastreio do lote;  - produto (código de barras, código) → rastreio do produto (lotes e saldos);
 *  - nada disso → Localizar pedido com o texto.
 * Só responde o destino: cada tela de destino continua conferindo a permissão do usuário.
 */
import { Router } from 'express';
import { prisma } from '../../db.js';
import { ah, badRequest } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { resolverCodigo } from '../estoque/leitura.js';
import { classificarLeitura, codigoPedido } from './codigo.js';

export const leituraRouter = Router();

type Destino = { tipo: 'pedido' | 'nfe_entrada' | 'lote' | 'produto' | 'localizar'; titulo: string; destino: string; detalhe?: string | null };

export async function destinoDaLeitura(orgId: string, codigo: string): Promise<Destino> {
  const c = classificarLeitura(codigo);
  const enc = encodeURIComponent;
  if (c.tipo === 'pedido') {
    const p = await prisma.erpPedidoVenda.findFirst({ where: { orgId, numero: c.numero }, select: { id: true, numero: true } });
    if (p) return { tipo: 'pedido', titulo: `Pedido nº ${p.numero}`, destino: `/erp/pedidos/${p.id}` };
    return { tipo: 'localizar', titulo: `Pedido ${codigoPedido(c.numero)} não encontrado`, destino: `/erp/pedidos/localizar?q=${enc(c.bruto)}` };
  }
  if (c.tipo === 'chave_nfe') {
    const s = await prisma.erpNfeSaida.findFirst({ where: { orgId, chave: c.chave }, select: { pedidoId: true, numero: true, serie: true } });
    if (s?.pedidoId) return { tipo: 'pedido', titulo: `NF-e nº ${s.numero}/${s.serie}`, destino: `/erp/pedidos/${s.pedidoId}` };
    const pv = await prisma.erpPedidoVenda.findFirst({ where: { orgId, nfNumero: c.chave }, select: { id: true, numero: true } });
    if (pv) return { tipo: 'pedido', titulo: `Pedido nº ${pv.numero}`, destino: `/erp/pedidos/${pv.id}` };
    const e = await prisma.erpNfeEntrada.findFirst({ where: { orgId, chave: c.chave }, select: { numero: true, serie: true, emitenteNome: true } });
    if (e) return { tipo: 'nfe_entrada', titulo: `NF-e de entrada nº ${e.numero}/${e.serie} · ${e.emitenteNome}`, destino: `/erp/rastreio?q=${c.chave}` };
    return { tipo: 'localizar', titulo: c.valida ? 'Nota fiscal não encontrada no sistema' : 'Chave de nota com dígito inválido: leia de novo', destino: `/erp/pedidos/localizar?q=${c.chave}`, detalhe: c.chave };
  }
  const r = await resolverCodigo(prisma, orgId, c.bruto);
  if (r?.lote) return { tipo: 'lote', titulo: `Lote ${r.lote.numero} · ${r.produto.nome}`, destino: `/erp/rastreio?lote=${r.lote.id}` };
  if (r) return { tipo: 'produto', titulo: `${r.produto.nome} (cód. ${r.produto.sku})`, destino: `/erp/rastreio?q=${enc(r.produto.sku)}` };
  return { tipo: 'localizar', titulo: 'Procurar pedidos', destino: `/erp/pedidos/localizar?q=${enc(c.bruto)}` };
}

leituraRouter.get('/', ah(async (req, res) => {
  const codigo = typeof req.query.codigo === 'string' ? req.query.codigo.slice(0, 600) : '';
  if (!codigo.trim()) throw badRequest('Leia ou digite um código');
  res.json(await destinoDaLeitura(orgOf(req), codigo));
}));
