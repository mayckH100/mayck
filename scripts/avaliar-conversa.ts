/**
 * v1.26.0 — Relatório antes × depois da IA conversacional avançada (conversas de teste, sem dados reais, sem provedor).
 * Uso: npx tsx scripts/avaliar-conversa.ts  → grava docs/AVALIACAO_IA_CONVERSA.md
 */
import { writeFileSync } from 'node:fs';
import { avaliar } from '../tests/fixtures/conversas-avaliacao.js';

const r = avaliar();
const pct = (n: number, d: number) => `${n}/${d} (${Math.round((n / d) * 100)}%)`;
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const md = [
  '# Avaliação da IA conversacional avançada (v1.26.0)',
  '',
  'Gerado por `npx tsx scripts/avaliar-conversa.ts` a partir de `tests/fixtures/conversas-avaliacao.ts` (conferido por `tests/unit/sdr-conversa-avaliacao.test.ts`).',
  '',
  '**Como ler:** são conversas de teste com nomes e números fictícios. "Antes" é a resposta típica do jeito antigo, enviada como veio. "Depois" é a saída do modelo com o prompt novo passando pelo caminho novo do código (plano interno, estilo, checagem final, 1 nova tentativa, especialista e handoff). As respostas do modelo são fixas: o relatório mede as regras e a rede de segurança do código, não a qualidade de um modelo real. Avaliar com conversas reais (MCK IA) fica para depois do deploy.',
  '',
  `**Conversas que passam em todos os critérios:** antes ${pct(r.casosOk.antes, r.casosOk.de)} · depois ${pct(r.casosOk.depois, r.casosOk.de)}`,
  '',
  '| Critério | Antes | Depois |',
  '|---|---|---|',
  ...r.resumo.map((c) => `| ${c.label} | ${pct(c.antes, c.de)} | ${pct(c.depois, c.de)} |`),
  '',
  '## Conversas',
  '',
  ...r.linhas.flatMap((l) => [
    `### ${l.caso.id} — ${l.caso.descricao}`,
    `- Lead: "${esc(l.caso.mensagemLead)}"`,
    `- Antes${l.antes.handoff ? ' (passou ao vendedor)' : ''}: "${esc(l.antes.texto)}" — falhou em: ${Object.entries(l.cAntes).filter(([, ok]) => !ok).map(([k]) => k).join(', ') || 'nada'}`,
    `- Depois${l.depois.handoff ? ' (passou ao vendedor)' : ''}${l.depois.tentativas > 1 ? ' (após 1 nova tentativa)' : ''}: "${esc(l.depois.texto)}" — falhou em: ${Object.entries(l.cDepois).filter(([, ok]) => !ok).map(([k]) => k).join(', ') || 'nada'}`,
    '',
  ]),
].join('\n');
writeFileSync(new URL('../docs/AVALIACAO_IA_CONVERSA.md', import.meta.url), md + '\n');
console.log(`Antes ${r.casosOk.antes}/${r.casosOk.de} · Depois ${r.casosOk.depois}/${r.casosOk.de}`);
