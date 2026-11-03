/** Rastreabilidade ponta a ponta: vínculos entre documentos e consulta do grafo (para trás e para frente). */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';

type Tx = Prisma.TransactionClient | PrismaClient;
export interface Ref { tipo: string; id: string }

export async function vincular(tx: Tx, orgId: string, origem: Ref, destino: Ref, vinculo: string) {
  await tx.erpTraceLink.upsert({
    where: { origemTipo_origemId_destinoTipo_destinoId_vinculo: { origemTipo: origem.tipo, origemId: origem.id, destinoTipo: destino.tipo, destinoId: destino.id, vinculo } },
    create: { orgId, origemTipo: origem.tipo, origemId: origem.id, destinoTipo: destino.tipo, destinoId: destino.id, vinculo },
    update: {},
  });
}

/** Percorre o grafo a partir de um documento (BFS, limitado) nas duas direções. */
export async function grafo(orgId: string, inicio: Ref, maxNos = 200) {
  const vistos = new Set<string>([`${inicio.tipo}:${inicio.id}`]);
  const arestas: { de: Ref; para: Ref; vinculo: string }[] = [];
  let fronteira: Ref[] = [inicio];
  while (fronteira.length && vistos.size < maxNos) {
    const prox: Ref[] = [];
    for (const r of fronteira) {
      const links = await prisma.erpTraceLink.findMany({ where: { orgId, OR: [{ origemTipo: r.tipo, origemId: r.id }, { destinoTipo: r.tipo, destinoId: r.id }] }, take: 100 });
      for (const l of links) {
        const de = { tipo: l.origemTipo, id: l.origemId }; const para = { tipo: l.destinoTipo, id: l.destinoId };
        if (!arestas.some((a) => a.de.id === de.id && a.para.id === para.id && a.vinculo === l.vinculo)) arestas.push({ de, para, vinculo: l.vinculo });
        for (const n of [de, para]) { const k = `${n.tipo}:${n.id}`; if (!vistos.has(k)) { vistos.add(k); prox.push(n); } }
      }
    }
    fronteira = prox;
  }
  return { nos: [...vistos].map((k) => { const [tipo, ...id] = k.split(':'); return { tipo, id: id.join(':') }; }), arestas };
}
