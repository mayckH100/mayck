/** Regras puras do Financeiro: parcelamento, encargos, Pix copia-e-cola (BR Code), OFX, conciliação, aging, DRE e fluxo. */

const DIA = 86_400_000;
const inicioDia = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Divide o total em parcelas pelos prazos (dias); a diferença de arredondamento vai na última. */
export function parcelar(totalCents: number, prazos: number[], base: Date) {
  const p = prazos.length ? prazos : [0];
  const valor = Math.floor(totalCents / p.length);
  return p.map((dias, i) => ({ parcela: i + 1, parcelas: p.length, valorCents: i === p.length - 1 ? totalCents - valor * (p.length - 1) : valor, vencimento: new Date(inicioDia(base).getTime() + dias * DIA) }));
}

/** Multa (uma vez) + juros de mora pro rata dia sobre o saldo, a partir do dia seguinte ao vencimento. */
export function encargos(saldoCents: number, vencimento: Date, data: Date, multaBp: number, jurosMesBp: number) {
  const dias = Math.floor((inicioDia(data).getTime() - inicioDia(vencimento).getTime()) / DIA);
  if (dias <= 0 || saldoCents <= 0) return { dias: Math.max(0, dias), multaCents: 0, jurosCents: 0 };
  return { dias, multaCents: Math.round((saldoCents * multaBp) / 10_000), jurosCents: Math.round((saldoCents * jurosMesBp * dias) / (10_000 * 30)) };
}

/** Situação do título a partir do que já foi pago. */
export const statusTitulo = (valorCents: number, pagoCents: number) => (pagoCents <= 0 ? 'EM_ABERTO' : pagoCents >= valorCents ? 'PAGO' : 'PARCIAL');

// ---------- Pix copia-e-cola (BR Code estático, padrão EMV do Banco Central) ----------
const campo = (id: string, v: string) => `${id}${String(v.length).padStart(2, '0')}${v}`;
export function crc16(s: string) {
  let crc = 0xffff;
  for (const ch of Buffer.from(s, 'utf8')) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 .\-]/g, '').toUpperCase();
export function pixCopiaECola(p: { chave: string; nome: string; cidade: string; valorCents?: number; txid?: string; mensagem?: string }) {
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', p.chave.trim()) + (p.mensagem ? campo('02', p.mensagem.slice(0, 40)) : '');
  const txid = (p.txid ?? '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const corpo = campo('00', '01') + campo('26', conta) + campo('52', '0000') + campo('53', '986') +
    (p.valorCents ? campo('54', (p.valorCents / 100).toFixed(2)) : '') + campo('58', 'BR') +
    campo('59', semAcento(p.nome).slice(0, 25) || 'RECEBEDOR') + campo('60', semAcento(p.cidade).slice(0, 15) || 'BRASIL') +
    campo('62', campo('05', txid)) + '6304';
  return corpo + crc16(corpo);
}

// ---------- OFX (extrato bancário) ----------
export interface LinhaOfx { fitId: string; data: Date; valorCents: number; descricao: string }
export function lerOfx(texto: string): LinhaOfx[] {
  const out: LinhaOfx[] = [];
  const blocos = texto.split(/<STMTTRN>/i).slice(1);
  const v = (b: string, t: string) => new RegExp(`<${t}>([^<\\r\\n]*)`, 'i').exec(b)?.[1]?.trim() ?? '';
  for (const b0 of blocos) {
    const b = b0.split(/<\/STMTTRN>/i)[0];
    const dt = v(b, 'DTPOSTED');
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(dt);
    const valor = Number(v(b, 'TRNAMT').replace(',', '.'));
    if (!m || !Number.isFinite(valor)) continue;
    out.push({ fitId: v(b, 'FITID') || `${dt}-${valor}-${out.length}`, data: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), valorCents: Math.round(valor * 100), descricao: v(b, 'MEMO') || v(b, 'NAME') || 'Sem descrição' });
  }
  return out;
}

/** Sugere o par extrato ↔ lançamento: mesmo valor, data em até `tolDias`; o mais próximo ganha e cada um casa uma vez. */
export function sugerirConciliacao(extrato: { id: string; data: Date; valorCents: number }[], lancs: { id: string; data: Date; valorCents: number }[], tolDias = 3) {
  const usados = new Set<string>(); const pares: { extratoId: string; lancamentoId: string }[] = [];
  for (const e of [...extrato].sort((a, b) => a.data.getTime() - b.data.getTime())) {
    const c = lancs.filter((l) => !usados.has(l.id) && l.valorCents === e.valorCents && Math.abs(l.data.getTime() - e.data.getTime()) <= tolDias * DIA)
      .sort((a, b) => Math.abs(a.data.getTime() - e.data.getTime()) - Math.abs(b.data.getTime() - e.data.getTime()))[0];
    if (c) { usados.add(c.id); pares.push({ extratoId: e.id, lancamentoId: c.id }); }
  }
  return pares;
}

/** Aging: saldo em aberto por faixa de atraso. */
export function aging(titulos: { valorCents: number; pagoCents: number; vencimento: Date }[], hoje = new Date()) {
  const f = { aVencer: 0, ate30: 0, ate60: 0, ate90: 0, mais90: 0 };
  for (const t of titulos) {
    const s = t.valorCents - t.pagoCents; if (s <= 0) continue;
    const d = Math.floor((inicioDia(hoje).getTime() - inicioDia(t.vencimento).getTime()) / DIA);
    if (d <= 0) f.aVencer += s; else if (d <= 30) f.ate30 += s; else if (d <= 60) f.ate60 += s; else if (d <= 90) f.ate90 += s; else f.mais90 += s;
  }
  return f;
}

/** Fluxo de caixa projetado por dia: saldo atual + a receber − a pagar (vencidos entram hoje). */
export function fluxoProjetado(saldoAtualCents: number, titulos: { tipo: string; valorCents: number; pagoCents: number; vencimento: Date }[], dias: number, hoje = new Date()) {
  const h = inicioDia(hoje).getTime();
  const linhas = Array.from({ length: dias }, (_, i) => ({ data: new Date(h + i * DIA).toISOString().slice(0, 10), entradasCents: 0, saidasCents: 0, saldoCents: 0 }));
  for (const t of titulos) {
    const s = t.valorCents - t.pagoCents; if (s <= 0) continue;
    const i = Math.max(0, Math.floor((inicioDia(t.vencimento).getTime() - h) / DIA));
    if (i >= dias) continue;
    if (t.tipo === 'RECEBER') linhas[i].entradasCents += s; else linhas[i].saidasCents += s;
  }
  let saldo = saldoAtualCents;
  for (const l of linhas) { saldo += l.entradasCents - l.saidasCents; l.saldoCents = saldo; }
  return linhas;
}

/** DRE gerencial por competência a partir dos títulos e do grupo da categoria. */
export const GRUPOS_DRE = ['RECEITA_BRUTA', 'DEDUCAO', 'CUSTO', 'OPERACIONAL', 'FINANCEIRA', 'IMPOSTO'] as const;
export function dre(titulos: { tipo: string; valorCents: number; grupo: string | null }[]) {
  const g: Record<string, number> = Object.fromEntries(GRUPOS_DRE.map((x) => [x, 0]));
  for (const t of titulos) {
    const grupo = t.grupo ?? (t.tipo === 'RECEBER' ? 'RECEITA_BRUTA' : 'OPERACIONAL');
    g[grupo] = (g[grupo] ?? 0) + (t.tipo === 'RECEBER' ? t.valorCents : -t.valorCents);
  }
  const receitaLiquida = g.RECEITA_BRUTA + g.DEDUCAO;
  const lucroBruto = receitaLiquida + g.CUSTO;
  const operacional = lucroBruto + g.OPERACIONAL;
  const antesImposto = operacional + g.FINANCEIRA;
  return { ...g, receitaLiquida, lucroBruto, resultadoOperacional: operacional, resultadoAntesImpostos: antesImposto, resultadoLiquido: antesImposto + g.IMPOSTO };
}

/** Plano de contas inicial (empresa pode editar). */
export const PLANO_PADRAO: { codigo: string; nome: string; tipo: 'RECEITA' | 'DESPESA'; grupo: string }[] = [
  { codigo: '1.01', nome: 'Venda de produtos', tipo: 'RECEITA', grupo: 'RECEITA_BRUTA' },
  { codigo: '1.02', nome: 'Prestação de serviços', tipo: 'RECEITA', grupo: 'RECEITA_BRUTA' },
  { codigo: '1.03', nome: 'Receitas financeiras', tipo: 'RECEITA', grupo: 'FINANCEIRA' },
  { codigo: '2.01', nome: 'Impostos sobre vendas', tipo: 'DESPESA', grupo: 'DEDUCAO' },
  { codigo: '2.02', nome: 'Devoluções e abatimentos', tipo: 'DESPESA', grupo: 'DEDUCAO' },
  { codigo: '3.01', nome: 'Compra de mercadorias e insumos', tipo: 'DESPESA', grupo: 'CUSTO' },
  { codigo: '3.02', nome: 'Fretes sobre compras', tipo: 'DESPESA', grupo: 'CUSTO' },
  { codigo: '4.01', nome: 'Salários e encargos', tipo: 'DESPESA', grupo: 'OPERACIONAL' },
  { codigo: '4.02', nome: 'Aluguel e condomínio', tipo: 'DESPESA', grupo: 'OPERACIONAL' },
  { codigo: '4.03', nome: 'Energia, água e internet', tipo: 'DESPESA', grupo: 'OPERACIONAL' },
  { codigo: '4.04', nome: 'Marketing', tipo: 'DESPESA', grupo: 'OPERACIONAL' },
  { codigo: '4.05', nome: 'Serviços de terceiros', tipo: 'DESPESA', grupo: 'OPERACIONAL' },
  { codigo: '5.01', nome: 'Tarifas bancárias e juros pagos', tipo: 'DESPESA', grupo: 'FINANCEIRA' },
  { codigo: '6.01', nome: 'IRPJ e CSLL', tipo: 'DESPESA', grupo: 'IMPOSTO' },
];
