/**
 * Inventário: abre com a foto do saldo, conta por lote e local (leitura de QR pela câmera/leitor, somando a cada
 * leitura, ou quantidade digitada), encerra a contagem com o relatório Físico x Sistema (quantidade e R$) e, havendo
 * diferença, avisa o proprietário (app + WhatsApp/e-mail). A diferença só vira movimento de estoque (INVENTARIO, por
 * lote) depois da aprovação com a SENHA do proprietário + motivo. Contagem cega esconde o saldo do sistema do contador.
 * v1.33.0: correção manual de saldo (um lote/local) segue a mesma regra de senha do proprietário.
 */
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../db.js';
import { ah, badRequest, forbidden, notFound, HttpError } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { auditar } from '../shared/auditoria.js';
import { entrada, saidaDoSaldo, proximoLoteInterno, LOTE_UNICO } from './servico.js';
import { resolverCodigo } from './leitura.js';
import { custoTotal } from '../produtos/produtos.routes.js';
import { relatorioInventario, resumoDivergencia, csvInventario, reais, type LinhaInventario } from './inventario-relatorio.js';
import { notificarProprietario } from '../alertas/alertas.js';
import { numeroLoteLegivel } from './rastreio-regras.js';

export const inventarioRouter = Router();
const gestorDe = (req: { auth?: { role?: string | null } | null }) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';

// ---------- Senha do proprietário (reautenticação na hora) ----------
const tentativas = new Map<string, { n: number; desde: number }>();
const JANELA = 15 * 60_000; const MAX_ERROS = 5;
/** Confere a senha contra os Proprietários ativos da empresa. Devolve quem aprovou. 5 erros em 15 min → bloqueia. */
export async function confirmarSenhaProprietario(orgId: string, senha: string | undefined | null) {
  const t = tentativas.get(orgId);
  if (t && Date.now() - t.desde < JANELA && t.n >= MAX_ERROS) throw new HttpError(429, 'Muitas tentativas de senha. Espere 15 minutos e tente de novo.');
  if (!senha) throw new HttpError(403, 'Peça ao proprietário para digitar a senha dele para confirmar o ajuste.');
  const donos = await prisma.membership.findMany({ where: { orgId, role: 'OWNER' }, select: { user: { select: { id: true, name: true, passwordHash: true, disabledAt: true } } } });
  for (const d of donos) if (!d.user.disabledAt && (await bcrypt.compare(senha, d.user.passwordHash))) { tentativas.delete(orgId); return { id: d.user.id, name: d.user.name }; }
  const x = t && Date.now() - t.desde < JANELA ? t : { n: 0, desde: Date.now() };
  x.n++; tentativas.set(orgId, x);
  throw new HttpError(403, 'Senha do proprietário incorreta. O estoque não foi alterado.');
}

/** Linhas do inventário prontas para o relatório (produto, lote, local, custo). */
async function linhasDo(orgId: string, invId: string): Promise<{ inv: Awaited<ReturnType<typeof prisma.erpInventario.findFirst>>; linhas: (LinhaInventario & { contadoPor: string | null; contadoEm: Date | null })[] }> {
  const inv = await prisma.erpInventario.findFirst({ where: { id: invId, orgId }, include: { contagens: true } });
  if (!inv) throw notFound('Inventário');
  const [prods, lotes, ends, users] = await Promise.all([
    prisma.erpProduto.findMany({ where: { id: { in: [...new Set(inv.contagens.map((c) => c.produtoId))] } }, select: { id: true, sku: true, nome: true, unidade: true, custoMedioCents: true, custosAdicionais: true } }),
    prisma.erpLote.findMany({ where: { id: { in: [...new Set(inv.contagens.map((c) => c.loteId))] } }, select: { id: true, numero: true, loteFornecedor: true } }),
    prisma.erpEnderecoEstoque.findMany({ where: { id: { in: [...new Set(inv.contagens.map((c) => c.enderecoId))] } }, include: { deposito: { select: { nome: true } } } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(inv.contagens.map((c) => c.contadoPorId).filter(Boolean) as string[])] } }, select: { id: true, name: true } }),
  ]);
  const P = new Map(prods.map((x) => [x.id, x])); const L = new Map(lotes.map((x) => [x.id, x])); const E = new Map(ends.map((x) => [x.id, x])); const U = new Map(users.map((u) => [u.id, u.name]));
  const fechado = !!inv.fechadoEm;
  return {
    inv,
    linhas: inv.contagens.map((c) => {
      const p = P.get(c.produtoId); const l = L.get(c.loteId); const e = E.get(c.enderecoId);
      return { id: c.id, produtoId: c.produtoId, sku: p?.sku ?? '', nome: p?.nome ?? '', unidade: p?.unidade ?? 'UN', loteId: c.loteId, lote: numeroLoteLegivel(l?.numero), loteFornecedor: l?.loteFornecedor ?? null, local: e ? `${e.deposito.nome} · ${e.codigo}` : '—', sistemaMil: c.sistemaMil, contadoMil: c.contadoMil, custoUnitCents: fechado ? c.custoUnitCents : p ? custoTotal(p) : 0, leituras: c.leituras, modo: c.modo, contadoPor: c.contadoPorId ? U.get(c.contadoPorId) ?? null : null, contadoEm: c.contadoEm };
    }),
  };
}

inventarioRouter.get('/', ah(async (req, res) => res.json(await prisma.erpInventario.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: 'desc' }, take: 100 }))));

/** Inventários encerrados com diferença aguardando a aprovação do proprietário (aviso no app). */
inventarioRouter.get('/pendentes', ah(async (req, res) => {
  const items = await prisma.erpInventario.findMany({ where: { orgId: orgOf(req), status: 'EM_APROVACAO', notificadoEm: { not: null } }, orderBy: { fechadoEm: 'desc' }, take: 20, select: { id: true, descricao: true, fechadoEm: true, resumoJson: true } });
  res.json(items.map((i) => ({ id: i.id, descricao: i.descricao, fechadoEm: i.fechadoEm, resumo: i.resumoJson ? JSON.parse(i.resumoJson) : null })));
}));

inventarioRouter.get('/:id', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { inv, linhas } = await linhasDo(orgId, req.params.id);
  const esconder = inv!.cego && inv!.status === 'CONTANDO' && !gestorDe(req);
  res.json({
    ...inv, resumo: inv!.resumoJson ? JSON.parse(inv!.resumoJson) : null,
    contagens: linhas.map((c) => ({ id: c.id, produtoId: c.produtoId, loteId: c.loteId, produto: { sku: c.sku, nome: c.nome, unidade: c.unidade }, lote: c.lote, loteFornecedor: c.loteFornecedor, endereco: c.local, sistemaMil: esconder ? null : c.sistemaMil, contadoMil: c.contadoMil, diferencaMil: esconder || c.contadoMil == null ? null : c.contadoMil - c.sistemaMil, leituras: c.leituras, modo: c.modo, contadoPor: c.contadoPor, contadoEm: c.contadoEm }))
      .sort((a, b) => a.endereco.localeCompare(b.endereco) || a.produto.nome.localeCompare(b.produto.nome)),
  });
}));

/** Relatório Físico x Sistema (JSON ou ?formato=csv). Só depois de encerrada a contagem (ou para gestor). */
inventarioRouter.get('/:id/relatorio', ah(async (req, res) => {
  const orgId = orgOf(req);
  const { inv, linhas } = await linhasDo(orgId, req.params.id);
  if (inv!.status === 'CONTANDO' && inv!.cego && !gestorDe(req)) throw forbidden('Contagem cega: o relatório aparece quando a contagem for encerrada');
  const r = relatorioInventario(linhas);
  if (req.query.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventario-${inv!.id.slice(-6)}.csv"`);
    return res.send(csvInventario(inv!.descricao, r));
  }
  res.json({ inventario: { id: inv!.id, descricao: inv!.descricao, status: inv!.status, fechadoEm: inv!.fechadoEm, concluidoEm: inv!.concluidoEm, motivoAjuste: inv!.motivoAjuste }, ...r });
}));

inventarioRouter.post('/', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ descricao: z.string().trim().min(2).max(120), depositoId: z.string().nullish(), produtoIds: z.array(z.string()).max(2000).optional(), cego: z.boolean().default(true) }).parse(req.body);
  const ends = await prisma.erpEnderecoEstoque.findMany({ where: { orgId, ...(b.depositoId ? { depositoId: b.depositoId } : {}) }, select: { id: true } });
  const saldos = await prisma.erpSaldo.findMany({ where: { orgId, enderecoId: { in: ends.map((e) => e.id) }, fisicoMil: { gt: 0 }, ...(b.produtoIds?.length ? { produtoId: { in: b.produtoIds } } : {}) } });
  const inv = await prisma.erpInventario.create({ data: { orgId, descricao: b.descricao, depositoId: b.depositoId ?? null, cego: b.cego, criadoPorId: req.auth?.userId ?? null, contagens: { create: saldos.map((s) => ({ produtoId: s.produtoId, loteId: s.loteId, enderecoId: s.enderecoId, sistemaMil: s.fisicoMil })) } } });
  await auditar(req, 'inventario.abrir', 'erp_inventario', inv.id, null, { linhas: saldos.length });
  res.status(201).json(inv);
}));

/**
 * Registra contagem por lote e local. Duas maneiras:
 *  - Leitura (modo "LEITURA"; caminho principal): cada leitura do CÓDIGO DE BARRAS do produto (EAN/GTIN ou código
 *    interno), pela câmera do celular ou leitor/teclado, soma `qtdMil` (padrão 1 unidade). Também aceita o QR da
 *    etiqueta do lote (MCK1;...) ou o número do lote. Endereço pode ser digitado ou lido do QR do endereço.
 *  - Digitada (modo "MANUAL"): grava a quantidade contada (ou soma, com `somar`).
 * Produto lido pelo código (sem lote): usa o lote dele neste local; com mais de um, pede para escolher (`loteId`).
 * Item achado fora da foto entra como linha nova (sistema 0). Produto que não controla lote e não tem lote no local
 * ganha um lote interno novo.
 */
inventarioRouter.post('/:id/contar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({
    endereco: z.string().trim().min(1).max(200), codigo: z.string().trim().min(1).max(200).optional(), loteId: z.string().optional(),
    qtdMil: z.number().int().min(0).max(2_000_000_000).optional(), somar: z.boolean().default(false),
    // LEITURA = código de barras do produto (EAN/GTIN ou código interno) pela câmera ou leitor; "QR" = etiqueta de lote (aceito igual).
    modo: z.enum(['LEITURA', 'QR', 'MANUAL']).default('MANUAL'),
  }).refine((x) => x.codigo || x.loteId, 'Leia o QR do lote/produto ou escolha o lote').parse(req.body);
  const inv = await prisma.erpInventario.findFirst({ where: { id: req.params.id, orgId } });
  if (!inv) throw notFound('Inventário');
  if (inv.status !== 'CONTANDO') throw badRequest('Contagem encerrada');
  const endCod = b.endereco.trim().toUpperCase();
  const end = await prisma.erpEnderecoEstoque.findFirst({ where: { orgId, codigo: endCod, ...(inv.depositoId ? { depositoId: inv.depositoId } : {}) } });
  if (!end) throw badRequest(`Endereço ${b.endereco} não existe${inv.depositoId ? ' neste depósito' : ''}`);
  const qr = b.modo !== 'MANUAL'; // cada leitura (código de barras ou QR) soma
  const qtdMil = b.qtdMil ?? (qr ? 1000 : undefined);
  if (qtdMil == null) throw badRequest('Informe a quantidade contada');
  const somar = qr || b.somar;
  const r = await prisma.$transaction(async (tx) => {
    let lote = b.loteId ? await tx.erpLote.findFirst({ where: { id: b.loteId, orgId } }) : null;
    if (!lote && b.codigo) {
      // v1.33.0: código de barras do lote (GS1-128) ou QR já dizem produto e lote; código de barras/código do produto diz só o produto.
      const r = await resolverCodigo(tx, orgId, b.codigo);
      if (!r) throw badRequest(`Código ${b.codigo.slice(0, 40)} não encontrado (código de barras, etiqueta do lote, lote ou código do produto)`);
      lote = r.lote;
      if (!lote) {
        const p = r.produto;
        // Lotes do produto neste local (na foto do inventário ou com saldo).
        const [cont, sal] = await Promise.all([
          tx.erpInventarioContagem.findMany({ where: { inventarioId: inv.id, produtoId: p.id, enderecoId: end.id }, select: { loteId: true } }),
          tx.erpSaldo.findMany({ where: { orgId, produtoId: p.id, enderecoId: end.id, fisicoMil: { gt: 0 } }, select: { loteId: true } }),
        ]);
        const ids = [...new Set([...cont, ...sal].map((x) => x.loteId))];
        if (ids.length === 1) lote = await tx.erpLote.findUniqueOrThrow({ where: { id: ids[0] } });
        else if (ids.length > 1) {
          const ls = await tx.erpLote.findMany({ where: { id: { in: ids } }, select: { id: true, numero: true, loteFornecedor: true, validade: true } });
          throw badRequest(`${p.nome} tem ${ls.length} lotes em ${end.codigo}: escolha qual está contando (ou leia a etiqueta do lote)`, { escolherLote: ls.map((l) => ({ ...l, numero: numeroLoteLegivel(l.numero) })), produto: { id: p.id, sku: p.sku, nome: p.nome } });
        } else {
          if (p.controlaLote) throw badRequest(`${p.sku} controla lote e não tem lote em ${end.codigo}: leia a etiqueta do lote`);
          const numero = await proximoLoteInterno(tx, orgId, p.id, p.sku);
          lote = await tx.erpLote.create({ data: { orgId, produtoId: p.id, numero, origemTipo: 'inventario', origemId: inv.id } });
        }
      }
    }
    if (!lote) throw badRequest('Lote não encontrado');
    const chave = { inventarioId_produtoId_loteId_enderecoId: { inventarioId: inv.id, produtoId: lote.produtoId, loteId: lote.id, enderecoId: end.id } };
    const atual = await tx.erpInventarioContagem.findUnique({ where: chave });
    const contado = somar && atual?.contadoMil != null ? atual.contadoMil + qtdMil : qtdMil;
    const dados = { contadoMil: contado, contadoPorId: req.auth?.userId ?? null, contadoEm: new Date(), modo: qr ? 'LEITURA' : 'MANUAL', ...(qr ? { leituras: { increment: 1 } } : {}) };
    const linha = await tx.erpInventarioContagem.upsert({ where: chave, create: { inventarioId: inv.id, produtoId: lote.produtoId, loteId: lote.id, enderecoId: end.id, sistemaMil: 0, ...dados, leituras: qr ? 1 : 0 }, update: dados });
    const p = await tx.erpProduto.findUniqueOrThrow({ where: { id: lote.produtoId }, select: { sku: true, nome: true, unidade: true } });
    return { linha, lote, p };
  });
  res.json({ id: r.linha.id, contadoMil: r.linha.contadoMil, leituras: r.linha.leituras, lote: numeroLoteLegivel(r.lote.numero), loteFornecedor: r.lote.loteFornecedor, produto: r.p, endereco: end.codigo });
}));

/** Aplica as diferenças (movimento INVENTARIO por lote). */
async function aplicarDiferencas(orgId: string, invId: string, descricao: string, userId: string | null | undefined, motivo: string) {
  const contagens = await prisma.erpInventarioContagem.findMany({ where: { inventarioId: invId } });
  await prisma.$transaction(async (tx) => {
    for (const c of contagens) {
      const dif = (c.contadoMil ?? 0) - c.sistemaMil;
      if (!dif) continue;
      const m = `Inventário: ${descricao} · ${motivo}`.slice(0, 300);
      if (dif > 0) {
        const lote = await tx.erpLote.findUniqueOrThrow({ where: { id: c.loteId } });
        await entrada(tx, { orgId, produtoId: c.produtoId, enderecoId: c.enderecoId, qtdMil: dif, tipo: 'INVENTARIO', docTipo: 'inventario', docId: invId, motivo: m, userId, lote: { numero: lote.numero, validade: lote.validade, status: lote.status } });
      } else {
        const s = await tx.erpSaldo.findUnique({ where: { produtoId_loteId_enderecoId: { produtoId: c.produtoId, loteId: c.loteId, enderecoId: c.enderecoId } } });
        if (!s) continue;
        await saidaDoSaldo(tx, { orgId, saldoId: s.id, qtdMil: Math.min(-dif, s.fisicoMil - s.reservadoMil), tipo: 'INVENTARIO', docTipo: 'inventario', docId: invId, motivo: m, userId }).catch(() => { throw badRequest('Há reservas de pedidos sobre um saldo com falta. Libere ou cancele as reservas e aprove de novo.'); });
      }
    }
  });
}

inventarioRouter.post('/:id/acao', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = z.object({ acao: z.enum(['ENVIAR', 'RECONTAR', 'APROVAR', 'CANCELAR']), senhaProprietario: z.string().max(200).optional(), motivo: z.string().trim().max(300).optional() }).parse(req.body);
  const inv = await prisma.erpInventario.findFirst({ where: { id: req.params.id, orgId } });
  if (!inv) throw notFound('Inventário');
  const gestor = gestorDe(req);
  let depois: unknown = null;
  if (b.acao === 'ENVIAR') {
    if (inv.status !== 'CONTANDO') throw badRequest('Inventário não está em contagem');
    // Linha não contada = contada como zero (padrão de inventário geral). Custo congelado para o relatório em R$.
    await prisma.erpInventarioContagem.updateMany({ where: { inventarioId: inv.id, contadoMil: null }, data: { contadoMil: 0, contadoEm: new Date() } });
    const cs = await prisma.erpInventarioContagem.findMany({ where: { inventarioId: inv.id }, select: { id: true, produtoId: true } });
    const ps = await prisma.erpProduto.findMany({ where: { id: { in: [...new Set(cs.map((c) => c.produtoId))] } }, select: { id: true, custoMedioCents: true, custosAdicionais: true } });
    const custo = new Map(ps.map((p) => [p.id, custoTotal(p)]));
    for (const c of cs) await prisma.erpInventarioContagem.update({ where: { id: c.id }, data: { custoUnitCents: custo.get(c.produtoId) ?? 0 } });
    await prisma.erpInventario.update({ where: { id: inv.id }, data: { status: 'EM_APROVACAO', fechadoEm: new Date(), fechadoPorId: req.auth?.userId ?? null } });
    const { linhas } = await linhasDo(orgId, inv.id);
    const { totais } = relatorioInventario(linhas);
    await prisma.erpInventario.update({ where: { id: inv.id }, data: { resumoJson: JSON.stringify(totais) } });
    if (totais.divergentes > 0) {
      await notificarProprietario(orgId, 'Inventário com diferença', resumoDivergencia(inv.descricao, totais));
      await prisma.erpInventario.update({ where: { id: inv.id }, data: { notificadoEm: new Date() } });
    }
    depois = { status: 'EM_APROVACAO', ...totais };
  } else if (b.acao === 'RECONTAR') {
    if (!gestor) throw forbidden();
    if (inv.status !== 'EM_APROVACAO') throw badRequest('Só volta para contagem quando está em aprovação');
    await prisma.erpInventario.update({ where: { id: inv.id }, data: { status: 'CONTANDO', fechadoEm: null, notificadoEm: null, resumoJson: null } });
  } else if (b.acao === 'CANCELAR') {
    if (!gestor) throw forbidden();
    if (inv.status === 'CONCLUIDO') throw badRequest('Inventário já concluído');
    await prisma.erpInventario.update({ where: { id: inv.id }, data: { status: 'CANCELADO' } });
  } else {
    if (inv.status !== 'EM_APROVACAO') throw badRequest('Encerre a contagem primeiro');
    if (!b.motivo || b.motivo.length < 3) throw badRequest('Informe o motivo do ajuste (mínimo 3 letras)');
    let dono;
    try { dono = await confirmarSenhaProprietario(orgId, b.senhaProprietario); }
    catch (e) { await auditar(req, 'inventario.senha_recusada', 'erp_inventario', inv.id, null, { motivo: (e as Error).message }); throw e; }
    const { linhas } = await linhasDo(orgId, inv.id);
    const rel = relatorioInventario(linhas);
    await aplicarDiferencas(orgId, inv.id, inv.descricao, req.auth?.userId, b.motivo);
    await prisma.erpInventario.update({ where: { id: inv.id }, data: { status: 'CONCLUIDO', aprovadoPorId: dono.id, concluidoEm: new Date(), motivoAjuste: b.motivo } });
    depois = { status: 'CONCLUIDO', aprovadoPor: dono.name, motivo: b.motivo, ...rel.totais, ajustes: rel.linhas.filter((l) => l.diferencaMil).map((l) => ({ sku: l.sku, lote: l.lote, local: l.local, antesMil: l.sistemaMil, depoisMil: l.contadoFinalMil, diferencaMil: l.diferencaMil, valorCents: l.diferencaCents })).slice(0, 200) };
  }
  await auditar(req, `inventario.${b.acao.toLowerCase()}`, 'erp_inventario', inv.id, { status: inv.status }, depois);
  res.json(await prisma.erpInventario.findUnique({ where: { id: inv.id } }));
}));

/**
 * Correção manual de saldo de um lote em um local (v1.33.0): mostra antes/depois/R$, exige motivo e a senha do
 * proprietário. Fica registrada como um inventário de uma linha (documento do movimento INVENTARIO no rastreio).
 */
const correcaoSchema = z.object({ saldoId: z.string(), novoMil: z.number().int().min(0).max(2_000_000_000), motivo: z.string().trim().max(300).optional(), senhaProprietario: z.string().max(200).optional(), previa: z.boolean().default(false) });
inventarioRouter.post('/corrigir-saldo', ah(async (req, res) => {
  const orgId = orgOf(req);
  const b = correcaoSchema.parse(req.body);
  const s = await prisma.erpSaldo.findFirst({ where: { id: b.saldoId, orgId } });
  if (!s) throw notFound('Saldo');
  const [p, lote, end] = await Promise.all([
    prisma.erpProduto.findUniqueOrThrow({ where: { id: s.produtoId } }),
    prisma.erpLote.findUniqueOrThrow({ where: { id: s.loteId } }),
    prisma.erpEnderecoEstoque.findUniqueOrThrow({ where: { id: s.enderecoId }, include: { deposito: { select: { nome: true } } } }),
  ]);
  const custo = custoTotal(p);
  const difMil = b.novoMil - s.fisicoMil;
  const previa = { produto: { sku: p.sku, nome: p.nome, unidade: p.unidade }, lote: numeroLoteLegivel(lote.numero), local: `${end.deposito.nome} · ${end.codigo}`, antesMil: s.fisicoMil, depoisMil: b.novoMil, diferencaMil: difMil, custoUnitCents: custo, valorCents: Math.round((difMil * custo) / 1000), reservadoMil: s.reservadoMil };
  if (b.previa) return res.json(previa);
  if (!difMil) throw badRequest('O saldo já é esse: nada para corrigir');
  if (b.novoMil < s.reservadoMil) throw badRequest(`Há ${s.reservadoMil / 1000} reservados para pedidos neste lote/local: libere as reservas antes de deixar o saldo abaixo disso`);
  if (!b.motivo || b.motivo.length < 3) throw badRequest('Informe o motivo da correção (mínimo 3 letras)');
  let dono;
  try { dono = await confirmarSenhaProprietario(orgId, b.senhaProprietario); }
  catch (e) { await auditar(req, 'estoque.correcao_senha_recusada', 'erp_saldo', s.id, null, { motivo: (e as Error).message }); throw e; }
  const inv = await prisma.erpInventario.create({ data: { orgId, descricao: `Correção manual: ${p.sku} lote ${numeroLoteLegivel(lote.numero)}`.slice(0, 120), depositoId: end.depositoId, cego: false, status: 'EM_APROVACAO', criadoPorId: req.auth?.userId ?? null, fechadoEm: new Date(), fechadoPorId: req.auth?.userId ?? null, contagens: { create: [{ produtoId: s.produtoId, loteId: s.loteId, enderecoId: s.enderecoId, sistemaMil: s.fisicoMil, contadoMil: b.novoMil, contadoPorId: req.auth?.userId ?? null, contadoEm: new Date(), modo: 'MANUAL', custoUnitCents: custo }] } } });
  await aplicarDiferencas(orgId, inv.id, inv.descricao, req.auth?.userId, b.motivo);
  await prisma.erpInventario.update({ where: { id: inv.id }, data: { status: 'CONCLUIDO', aprovadoPorId: dono.id, concluidoEm: new Date(), motivoAjuste: b.motivo, resumoJson: JSON.stringify(relatorioInventario([{ id: 'x', produtoId: p.id, sku: p.sku, nome: p.nome, unidade: p.unidade, loteId: lote.id, lote: numeroLoteLegivel(lote.numero), loteFornecedor: lote.loteFornecedor, local: previa.local, sistemaMil: s.fisicoMil, contadoMil: b.novoMil, custoUnitCents: custo }]).totais) } });
  await auditar(req, 'estoque.correcao_saldo', 'erp_saldo', s.id, { fisicoMil: s.fisicoMil }, { fisicoMil: b.novoMil, diferencaMil: difMil, valor: reais(previa.valorCents), motivo: b.motivo, aprovadoPor: dono.name, inventarioId: inv.id, lote: previa.lote, local: previa.local });
  res.json({ ...previa, inventarioId: inv.id, aprovadoPor: dono.name });
}));
