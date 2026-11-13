/**
 * Registro dos provedores de maquininha. Hoje só o Mercado Pago Point está integrado; Stone, PagBank e Cielo ficam
 * registrados como "em breve": aparecem na configuração, mas qualquer chamada responde que precisa de credenciamento.
 */
import { mercadoPagoPoint } from './mercadopagoPoint.js';
import { MaquininhaError, type ProvedorMaquininha } from './tipos.js';

function emBreve(id: string, nome: string, ajuda: string): ProvedorMaquininha {
  const falha = async (): Promise<never> => { throw new MaquininhaError(501, `${nome}: integração em breve. Ela precisa de credenciamento junto à ${nome.split(' ')[0]} antes de ser liberada.`, 'em_breve'); };
  return { id, nome, disponivel: false, ajuda, criarCobranca: falha, consultarStatus: falha, cancelar: falha, listarTerminais: falha };
}

export const PROVEDORES: Record<string, ProvedorMaquininha> = {
  mercadopago_point: mercadoPagoPoint,
  stone_connect: emBreve('stone_connect', 'Stone Connect', 'Em breve. Exige credenciamento como parceiro Stone.'),
  pagbank_smart: emBreve('pagbank_smart', 'PagBank Smart', 'Em breve. Exige credenciamento no programa de integração PagBank.'),
  cielo: emBreve('cielo', 'Cielo LIO', 'Em breve. Exige credenciamento na Cielo.'),
};
export const IDS_PROVEDORES = Object.keys(PROVEDORES) as [string, ...string[]];

export function provedor(id: string): ProvedorMaquininha {
  const p = PROVEDORES[id];
  if (!p) throw new MaquininhaError(400, 'Provedor de maquininha desconhecido');
  return p;
}

export const listaProvedores = () => Object.values(PROVEDORES).map((p) => ({ id: p.id, nome: p.nome, disponivel: p.disponivel, ajuda: p.ajuda }));
