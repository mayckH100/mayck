/**
 * Checagem de valores do atendimento (v1.35.0): preço, percentual ou prazo na resposta da IA que não aparece nas
 * Instruções, na base de conhecimento, nos produtos ou na conversa. Puro, sem custo (reaproveita a checagem da IA
 * conversacional avançada).
 */
import { verificarResposta } from '../sdr/conversa.js';

export const TEXTO_CONFIRMAR_VALOR = 'Esse valor eu prefiro confirmar com a equipe para não te passar nada errado. Já te retorno por aqui.';

/** Trechos com valor/prazo fora das fontes (ex.: ["R$ 9,99"]). Vazio = tudo certo. */
export function valoresForaDaBase(texto: string, fontes: string): string[] {
  const v = verificarResposta(texto, { fontes });
  if (!v.problemas.includes('valor_fora')) return [];
  return v.detalhes.filter((d) => d.includes('não está nas Instruções')).map((d) => d.replace(/^"|" não está.*$/g, ''));
}

/** Crítica para a nova tentativa (vai no fim do prompt do sistema). */
export function criticaValores(fora: string[]): string {
  return [
    '### CORREÇÃO OBRIGATÓRIA DA SUA ÚLTIMA RESPOSTA',
    `- Você citou ${fora.slice(0, 4).join(', ')}, que NÃO está nas Instruções da empresa nem no CONTEXTO.`,
    '- Escreva a resposta de novo sem nenhum valor, percentual ou prazo que não esteja lá. Se o cliente pediu esse valor, diga que confirma com a equipe.',
  ].join('\n');
}
