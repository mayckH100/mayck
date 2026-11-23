import type { Channel } from '@prisma/client';
import { qrManager } from './qr/manager.js';

/**
 * v1.46.1: o WhatsApp do canal está em condições de enviar agora?
 *  - QR (WhatsApp Web): sessão aberta neste servidor (ou reconectando, quando o envio sabe esperar);
 *  - API oficial: canal CONNECTED (credenciais verificadas);
 *  - chat do site: sempre (não há envio externo).
 */
export function canalConectado(channel: Pick<Channel, 'id' | 'provider' | 'status'> | null | undefined): boolean {
  if (!channel) return false;
  if (channel.provider === 'site') return true;
  if (channel.provider === 'whatsapp_qr') return qrManager.canSend(channel.id);
  return channel.status === 'CONNECTED';
}

/** Erros que dizem que o NÚMERO não pode receber (não adianta tentar de novo). Têm prioridade sobre os de conexão. */
const DEFINITIVO = /inv[aá]lid|n[aã]o (tem|possui|usa) whatsapp|sem whatsapp|not (on|a valid) whatsapp|not.{0,20}registered|n[aã]o existe|bloque|blocked|opt-?out|janela de 24|template|modelo|recusad|assinatura inativa|re-?engagement|\b(131026|131047|131051)\b/i;

/** Erros de conexão ou passageiros (o WhatsApp caiu, demorou ou o servidor da Meta falhou): dá para tentar de novo. */
const TRANSITORIO = /n[aã]o conectad|not connected|desconect|disconnect|connection (closed|lost|failure|reset|terminated)|conex[aã]o|socket|stream errored|timed? ?out|tempo esgotado|econnreset|econnrefused|etimedout|eai_again|enotfound|epipe|network|falha de rede|fetch failed|service unavailable|bad gateway|gateway timeout|internal server error|precondition required|\b(http )?5\d\d\b|erro http 5\d\d|rate limit|too many requests|\b429\b/i;

/** Classifica o erro de envio: 'conexao' (devolve à fila), 'definitivo' (FALHOU) ou 'outro' (FALHOU, como antes). Puro. */
export function tipoErroEnvio(erro: string | null | undefined): 'conexao' | 'definitivo' | 'outro' {
  const e = (erro ?? '').trim();
  if (!e) return 'outro';
  if (DEFINITIVO.test(e)) return 'definitivo';
  if (TRANSITORIO.test(e)) return 'conexao';
  return 'outro';
}

export const erroDeConexao = (erro: string | null | undefined) => tipoErroEnvio(erro) === 'conexao';
