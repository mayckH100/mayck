/**
 * Fiscal: dados do emitente, certificado A1 do cliente (cifrado), regras de tributação, emissão da NF-e a partir do
 * pedido separado (montagem + assinatura), transmissão à SEFAZ, XML autorizado, cancelamento e status do serviço.
 */
import { Router } from 'express';
import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { prisma } from '../../db.js';
import { ah, badRequest, notFound, forbidden } from '../../lib/http.js';
import { orgOf } from '../../auth/session.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { auditar } from '../shared/auditoria.js';
import { vincular } from '../shared/trace.js';
import { emitir } from '../shared/events.js';
import { montarNfe, assinarNfe, lerPfx, escolherRegra, ratear, eventoCancelamento, UF_IBGE, type DadosNfe } from './nfe.js';
import { autorizar, nfeProc, enviarEvento, statusServico } from './sefaz.js';

export const fiscalRouter = Router();
const gestor = (req: { auth?: { role?: string | null } }) => req.auth?.role === 'OWNER' || req.auth?.role === 'ADMIN';
const so = (s?: string | null) => (s ?? '').replace(/\D/g, '');
const configDe = (orgId: string) => prisma.erpConfigFiscal.upsert({ where: { orgId }, create: { orgId }, update: {} });
const publica = (c: Awaited<ReturnType<typeof configDe>>) => { const { certPfx, certSenha, ...r } = c; return { ...r, temCertificado: !!certPfx }; };
async function certDe(orgId: string) {
  const c = await configDe(orgId);
  if (!c.certPfx || !c.certSenha) throw badRequest('Envie o certificado A1 da empresa em Fiscal → Configuração');
  const cert = lerPfx(decrypt(c.certPfx), decrypt(c.certSenha));
  if (cert.validade < new Date()) throw badRequest('O certificado A1 está vencido');
  return { c, cert };
}

// ---------------- Configuração e certificado ----------------
fiscalRouter.get('/config', ah(async (req, res) => res.json(publica(await configDe(orgOf(req))))));
const cfgSchema = z.object({
  razaoSocial: z.string().trim().min(2).max(60), fantasia: z.string().trim().max(60).nullish(), cnpj: z.string().transform(so).refine((v) => v.length === 14, 'CNPJ com 14 dígitos'),
  ie: z.string().trim().min(2).max(14), crt: z.union([z.literal(1), z.literal(2), z.literal(3)]), uf: z.string().length(2).transform((v) => v.toUpperCase()).refine((v) => !!UF_IBGE[v], 'UF inválida'),
  codMunicipio: z.string().regex(/^\d{7}$/, 'Código IBGE do município com 7 dígitos'), municipio: z.string().trim().min(2).max(60), logradouro: z.string().trim().min(2).max(60), numero: z.string().trim().min(1).max(60),
  bairro: z.string().trim().min(2).max(60), cep: z.string().transform(so).refine((v) => v.length === 8, 'CEP com 8 dígitos'), fone: z.string().nullish(),
  ambiente: z.union([z.literal(1), z.literal(2)]), serie: z.number().int().min(1).max(889), proximoNumero: z.number().int().min(1).max(999_999_999),
});
fiscalRouter.put('/config', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req); const b = cfgSchema.parse(req.body);
  const antes = await configDe(orgId);
  const c = await prisma.erpConfigFiscal.update({ where: { orgId }, data: b });
  await auditar(req, 'fiscal.config', 'erp_config_fiscal', orgId, { ambiente: antes.ambiente, serie: antes.serie, proximoNumero: antes.proximoNumero }, { ambiente: c.ambiente, serie: c.serie, proximoNumero: c.proximoNumero });
  res.json(publica(c));
}));

fiscalRouter.post('/certificado', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req);
  const b = z.object({ pfxBase64: z.string().min(100).max(200_000), senha: z.string().min(1).max(200) }).parse(req.body);
  let cert;
  try { cert = lerPfx(b.pfxBase64, b.senha); } catch (e) { throw badRequest((e as Error).message); }
  if (cert.validade < new Date()) throw badRequest('Este certificado já venceu');
  const c = await configDe(orgId);
  if (c.cnpj && cert.cnpj && cert.cnpj !== c.cnpj) throw badRequest('O certificado é de outro CNPJ');
  const n = await prisma.erpConfigFiscal.update({ where: { orgId }, data: { certPfx: encrypt(b.pfxBase64), certSenha: encrypt(b.senha), certTitular: cert.titular, certValidade: cert.validade } });
  await auditar(req, 'fiscal.certificado', 'erp_config_fiscal', orgId, null, { titular: cert.titular, validade: cert.validade });
  res.json(publica(n));
}));
fiscalRouter.delete('/certificado', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req);
  const n = await prisma.erpConfigFiscal.update({ where: { orgId }, data: { certPfx: null, certSenha: null, certTitular: null, certValidade: null } });
  await auditar(req, 'fiscal.certificado.remover', 'erp_config_fiscal', orgId, null, null);
  res.json(publica(n));
}));

fiscalRouter.get('/status-sefaz', ah(async (req, res) => {
  const { c, cert } = await certDe(orgOf(req));
  res.json(await statusServico(c.uf, c.ambiente, UF_IBGE[c.uf], cert));
}));

// ---------------- Regras de tributação ----------------
const regraSchema = z.object({
  nome: z.string().trim().min(2).max(80), produtoId: z.string().nullish(), ncmPrefixo: z.string().regex(/^\d{2,8}$/).nullish(), prioridade: z.number().int().min(0).max(100).default(0),
  cfopDentro: z.string().regex(/^5\d{3}$/, 'CFOP dentro do estado começa com 5'), cfopFora: z.string().regex(/^6\d{3}$/, 'CFOP fora do estado começa com 6'),
  csosn: z.enum(['102', '103', '300', '400']).default('102'), cstIcms: z.enum(['00', '40', '41', '50']).default('00'), aliqIcmsBp: z.number().int().min(0).max(4000).default(0),
  cstIpi: z.string().regex(/^\d{2}$/).default('53'), aliqIpiBp: z.number().int().min(0).max(30000).default(0),
  cstPis: z.string().regex(/^\d{2}$/).default('49'), aliqPisBp: z.number().int().min(0).max(10000).default(0), cstCofins: z.string().regex(/^\d{2}$/).default('49'), aliqCofinsBp: z.number().int().min(0).max(10000).default(0),
});
fiscalRouter.get('/regras', ah(async (req, res) => res.json(await prisma.erpRegraFiscal.findMany({ where: { orgId: orgOf(req) }, orderBy: [{ produtoId: 'asc' }, { ncmPrefixo: 'asc' }] }))));
fiscalRouter.post('/regras', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req); const b = regraSchema.parse(req.body);
  if (b.produtoId && !(await prisma.erpProduto.findFirst({ where: { id: b.produtoId, orgId } }))) throw badRequest('Produto inválido');
  const r = await prisma.erpRegraFiscal.create({ data: { orgId, ...b, produtoId: b.produtoId ?? null, ncmPrefixo: b.ncmPrefixo ?? null } });
  await auditar(req, 'fiscal.regra.criar', 'erp_regra_fiscal', r.id, null, b);
  res.status(201).json(r);
}));
fiscalRouter.put('/regras/:id', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req); const b = regraSchema.parse(req.body);
  const antes = await prisma.erpRegraFiscal.findFirst({ where: { id: req.params.id, orgId } });
  if (!antes) throw notFound('Regra');
  const r = await prisma.erpRegraFiscal.update({ where: { id: antes.id }, data: { ...b, produtoId: b.produtoId ?? null, ncmPrefixo: b.ncmPrefixo ?? null } });
  await auditar(req, 'fiscal.regra.editar', 'erp_regra_fiscal', r.id, antes, b);
  res.json(r);
}));
fiscalRouter.delete('/regras/:id', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden();
  const orgId = orgOf(req);
  const r = await prisma.erpRegraFiscal.deleteMany({ where: { id: req.params.id, orgId } });
  if (!r.count) throw notFound('Regra');
  res.json({ ok: true });
}));

// ---------------- NF-e de saída ----------------
/** Monta os dados da NF-e a partir do pedido (itens, desconto e frete rateados, regras por produto/NCM). */
export async function dadosDoPedido(orgId: string, pedidoId: string, numero: number, cNF: number, emissao: Date): Promise<{ dados: DadosNfe; parceiroId: string }> {
  const c = await configDe(orgId);
  if (!c.cnpj || !c.razaoSocial) throw badRequest('Preencha os dados do emitente em Fiscal → Configuração');
  const p = await prisma.erpPedidoVenda.findFirst({ where: { id: pedidoId, orgId }, include: { itens: { orderBy: { posicao: 'asc' } } } });
  if (!p) throw notFound('Pedido');
  const dest = await prisma.erpParceiro.findUniqueOrThrow({ where: { id: p.parceiroId } });
  const prods = new Map((await prisma.erpProduto.findMany({ where: { id: { in: p.itens.map((i) => i.produtoId) } } })).map((x) => [x.id, x]));
  const regras = await prisma.erpRegraFiscal.findMany({ where: { orgId } });
  const bruto = p.itens.map((i) => Math.round((i.qtdMil * i.precoUnitCents) / 1000));
  const descPed = ratear(p.descontoCents, p.itens.map((i) => i.totalCents));
  const frete = ratear(p.freteCents, p.itens.map((i) => i.totalCents));
  const cond = p.condicaoPagamentoId ? await prisma.erpCondicaoPagamento.findFirst({ where: { id: p.condicaoPagamentoId } }) : null;
  const aPrazo = cond ? (JSON.parse(cond.prazos) as number[]).some((d) => d > 0) : false;
  const docDest = so(dest.documento);
  return {
    parceiroId: dest.id,
    dados: {
      emitente: { cnpj: c.cnpj, razaoSocial: c.razaoSocial, fantasia: c.fantasia, ie: c.ie, crt: c.crt, uf: c.uf, codMunicipio: c.codMunicipio, municipio: c.municipio, logradouro: c.logradouro, numero: c.numero, bairro: c.bairro, cep: c.cep, fone: c.fone },
      destinatario: { documento: docDest, nome: dest.nome, ie: dest.inscricaoEstadual, email: dest.email, uf: (dest.uf ?? '').toUpperCase(), codMunicipio: dest.codigoMunicipio ?? '', municipio: dest.municipio ?? '', logradouro: dest.logradouro ?? '', numero: dest.numero ?? '', bairro: dest.bairro ?? '', cep: dest.cep ?? '', complemento: dest.complemento },
      itens: p.itens.map((i, n) => {
        const pr = prods.get(i.produtoId)!;
        return { codigo: pr.sku, descricao: i.descricao || pr.nome, ncm: pr.ncm ?? '', ean: pr.codigoBarras, unidade: pr.unidade, qtdMil: i.qtdMil, valorUnitCents: i.precoUnitCents, descontoCents: bruto[n] - i.totalCents + descPed[n], freteCents: frete[n], origem: pr.origem, regra: escolherRegra(regras, pr.id, pr.ncm) };
      }),
      serie: c.serie, numero, cNF, emissao, ambiente: c.ambiente, natOp: 'VENDA DE MERCADORIA', tPag: aPrazo ? '15' : '17',
      infCpl: `Pedido ${p.numero}.${c.crt !== 3 ? ' Documento emitido por ME ou EPP optante pelo Simples Nacional. Não gera direito a crédito fiscal de IPI.' : ''}`,
      consumidorFinal: docDest.length === 11 || !dest.inscricaoEstadual,
    },
  };
}

fiscalRouter.get('/nfe', ah(async (req, res) => {
  const orgId = orgOf(req);
  const l = await prisma.erpNfeSaida.findMany({ where: { orgId, ...(typeof req.query.pedidoId === 'string' ? { pedidoId: req.query.pedidoId } : {}) }, orderBy: { createdAt: 'desc' }, take: 300, select: { id: true, pedidoId: true, parceiroId: true, numero: true, serie: true, chave: true, ambiente: true, status: true, totalCents: true, protocolo: true, cStat: true, motivo: true, autorizadaEm: true, canceladaEm: true, createdAt: true } });
  const ps = new Map((await prisma.erpParceiro.findMany({ where: { orgId, id: { in: l.map((n) => n.parceiroId) } }, select: { id: true, nome: true } })).map((p) => [p.id, p.nome]));
  res.json(l.map((n) => ({ ...n, destinatario: ps.get(n.parceiroId) })));
}));

fiscalRouter.get('/nfe/:id/xml', ah(async (req, res) => {
  const n = await prisma.erpNfeSaida.findFirst({ where: { id: req.params.id, orgId: orgOf(req) } });
  if (!n) throw notFound('NF-e');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${n.chave}-nfe.xml"`);
  res.send(n.xml);
}));

/** Dados para o DANFE (impressão no navegador). */
fiscalRouter.get('/nfe/:id/danfe', ah(async (req, res) => {
  const orgId = orgOf(req);
  const n = await prisma.erpNfeSaida.findFirst({ where: { id: req.params.id, orgId } });
  if (!n) throw notFound('NF-e');
  res.json({ ...n, emitente: publica(await configDe(orgId)), destinatario: await prisma.erpParceiro.findUnique({ where: { id: n.parceiroId } }) });
}));

fiscalRouter.post('/nfe/pedido/:pedidoId', ah(async (req, res) => {
  const orgId = orgOf(req);
  const p = await prisma.erpPedidoVenda.findFirst({ where: { id: req.params.pedidoId, orgId } });
  if (!p) throw notFound('Pedido');
  if (p.statusOperacional !== 'SEPARADO') throw badRequest('A NF-e é emitida com o pedido separado e conferido');
  const viva = await prisma.erpNfeSaida.findFirst({ where: { orgId, pedidoId: p.id, status: { in: ['ASSINADA', 'AUTORIZADA', 'REJEITADA'] } } });
  if (viva) throw badRequest(`Este pedido já tem a NF-e ${viva.numero} (${viva.status.toLowerCase()})`);
  const { c, cert } = await certDe(orgId);
  const emissao = new Date();
  // Monta e assina fora da transação; a numeração é reservada de forma otimista (só grava se o número não mudou).
  const numero = c.proximoNumero;
  const { dados, parceiroId } = await dadosDoPedido(orgId, p.id, numero, randomInt(10_000_000, 99_999_999), emissao);
  let m;
  try { m = montarNfe(dados); } catch (e) { throw badRequest((e as Error).message); }
  const xml = assinarNfe(m.infNFe, m.chave, cert);
  const n = await prisma.$transaction(async (tx) => {
    const r = await tx.erpConfigFiscal.updateMany({ where: { orgId, proximoNumero: numero }, data: { proximoNumero: numero + 1 } });
    if (!r.count) throw badRequest('Outra NF-e foi emitida ao mesmo tempo: tente de novo');
    const nf = await tx.erpNfeSaida.create({ data: { orgId, pedidoId: p.id, parceiroId, numero, serie: c.serie, chave: m.chave, ambiente: c.ambiente, status: 'ASSINADA', totalCents: m.totalCents, xml } });
    await vincular(tx, orgId, { tipo: 'pedido_venda', id: p.id }, { tipo: 'nfe_saida', id: nf.id }, 'emitiu');
    return nf;
  });
  await auditar(req, 'nfe_saida.emitir', 'erp_nfe_saida', n.id, null, { numero: n.numero, serie: n.serie, ambiente: n.ambiente });
  res.status(201).json({ id: n.id, numero: n.numero, chave: n.chave, status: n.status, totalCents: n.totalCents });
}));

/** Rejeitada: refaz o XML com o mesmo número (depois de corrigir o cadastro) e assina de novo. */
fiscalRouter.post('/nfe/:id/regerar', ah(async (req, res) => {
  const orgId = orgOf(req);
  const nf = await prisma.erpNfeSaida.findFirst({ where: { id: req.params.id, orgId } });
  if (!nf || !nf.pedidoId) throw notFound('NF-e');
  if (!['REJEITADA', 'ASSINADA'].includes(nf.status)) throw badRequest('Só NF-e rejeitada ou ainda não transmitida pode ser refeita');
  const { cert } = await certDe(orgId);
  const { dados } = await dadosDoPedido(orgId, nf.pedidoId, nf.numero, Number(nf.chave.slice(35, 43)), new Date());
  let m;
  try { m = montarNfe({ ...dados, serie: nf.serie, ambiente: nf.ambiente }); } catch (e) { throw badRequest((e as Error).message); }
  const n = await prisma.erpNfeSaida.update({ where: { id: nf.id }, data: { chave: m.chave, xml: assinarNfe(m.infNFe, m.chave, cert), totalCents: m.totalCents, status: 'ASSINADA', cStat: null, motivo: null } });
  res.json({ id: n.id, status: n.status, chave: n.chave });
}));

fiscalRouter.post('/nfe/:id/transmitir', ah(async (req, res) => {
  const orgId = orgOf(req);
  const nf = await prisma.erpNfeSaida.findFirst({ where: { id: req.params.id, orgId } });
  if (!nf) throw notFound('NF-e');
  if (nf.status !== 'ASSINADA') throw badRequest(nf.status === 'REJEITADA' ? 'Corrija e refaça a NF-e antes de transmitir de novo' : 'NF-e já transmitida');
  const { c, cert } = await certDe(orgId);
  const r = await autorizar(c.uf, nf.ambiente, nf.xml, cert);
  const ok = r.cStat === '100' || r.cStat === '150';
  const n = await prisma.$transaction(async (tx) => {
    const n = await tx.erpNfeSaida.update({ where: { id: nf.id }, data: ok
      ? { status: 'AUTORIZADA', protocolo: r.protocolo, cStat: r.cStat, motivo: r.motivo, autorizadaEm: new Date(), xml: nfeProc(nf.xml, r.protNFe!) }
      : { status: ['103', '104', '105'].includes(r.cStat ?? '') ? 'ASSINADA' : 'REJEITADA', cStat: r.cStat, motivo: r.motivo } });
    if (ok) await emitir(tx, { orgId, tipo: 'fiscal.nfe.autorizada', agregado: 'nfe_saida', agregadoId: nf.id, payload: { numero: nf.numero, pedidoId: nf.pedidoId, totalCents: nf.totalCents } });
    return n;
  });
  await auditar(req, 'nfe_saida.transmitir', 'erp_nfe_saida', nf.id, null, { cStat: r.cStat, motivo: r.motivo });
  res.json({ id: n.id, status: n.status, cStat: n.cStat, motivo: n.motivo, protocolo: n.protocolo, numero: n.numero });
}));

fiscalRouter.post('/nfe/:id/cancelar', ah(async (req, res) => {
  if (!gestor(req)) throw forbidden('Só proprietário ou administrador cancela NF-e');
  const orgId = orgOf(req);
  const { justificativa } = z.object({ justificativa: z.string().trim().min(15, 'Justificativa com pelo menos 15 caracteres').max(255) }).parse(req.body);
  const nf = await prisma.erpNfeSaida.findFirst({ where: { id: req.params.id, orgId } });
  if (!nf) throw notFound('NF-e');
  if (nf.status !== 'AUTORIZADA' || !nf.protocolo) throw badRequest('Só NF-e autorizada pode ser cancelada');
  if (Date.now() - (nf.autorizadaEm?.getTime() ?? 0) > 24 * 3_600_000) throw badRequest('Passou o prazo de 24 horas para cancelar: emita uma NF-e de devolução');
  const { c, cert } = await certDe(orgId);
  const ev = eventoCancelamento({ chave: nf.chave, cnpj: c.cnpj, protocolo: nf.protocolo, justificativa, ambiente: nf.ambiente, quando: new Date() }, cert);
  const r = await enviarEvento(c.uf, nf.ambiente, ev, cert);
  const ok = r.cStat === '135' || r.cStat === '155';
  if (ok) await prisma.erpNfeSaida.update({ where: { id: nf.id }, data: { status: 'CANCELADA', canceladaEm: new Date(), motivo: `Cancelada: ${justificativa}` } });
  await auditar(req, 'nfe_saida.cancelar', 'erp_nfe_saida', nf.id, null, { cStat: r.cStat, motivo: r.motivo });
  if (!ok) throw badRequest(`SEFAZ recusou o cancelamento: ${r.cStat} ${r.motivo ?? ''}`.trim());
  res.json({ ok: true, protocolo: r.protocolo });
}));
