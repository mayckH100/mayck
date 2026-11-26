import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, prisma, uniq } from '../helpers.js';
import { RODAPE_DOCUMENTO } from '../../server/erp/shared/documento.js';

/**
 * v1.55.0 — "Posição do logo" dos documentos impressos (Esquerda padrão / Centro): salva e lê por empresa,
 * recusa valor fora do enum, só Proprietário/Administrador altera, e o rodapé da MCK continua fixo.
 */
describe('ERP · documentos impressos · posição do logo (v1.55.0)', () => {
  let c: Client; let outra: Client;
  beforeAll(async () => { c = await registerClient(); outra = await registerClient(); });

  it('sem configuração salva vem "ESQUERDA" (padrão)', async () => {
    const r = await c.get('/api/erp/documentos/config');
    expect(r.status).toBe(200);
    expect(r.body.config.posicaoLogo).toBe('ESQUERDA');
    expect(r.body.rodape).toBe(RODAPE_DOCUMENTO);
  });

  it('salva e lê "CENTRO"; PUT sem o campo mantém; volta para "ESQUERDA"', async () => {
    const s = await c.put('/api/erp/documentos/config', { nomeExibicao: 'Loja Centro', posicaoLogo: 'CENTRO' });
    expect(s.status).toBe(200);
    expect(s.body.config.posicaoLogo).toBe('CENTRO');
    expect((await c.get('/api/erp/documentos/config')).body.config.posicaoLogo).toBe('CENTRO');
    await c.put('/api/erp/documentos/config', { nomeExibicao: 'Loja Centro 2' });
    expect((await c.get('/api/erp/documentos/config')).body.config.posicaoLogo).toBe('CENTRO');
    const row = await prisma.erpDocumentoConfig.findUnique({ where: { orgId: c.me.org.id } });
    expect(row?.posicaoLogo).toBe('CENTRO');
    await c.put('/api/erp/documentos/config', { nomeExibicao: 'Loja Centro 2', posicaoLogo: 'ESQUERDA' });
    expect((await c.get('/api/erp/documentos/config')).body.config.posicaoLogo).toBe('ESQUERDA');
  });

  it('recusa valor inválido (400) e não muda o que estava salvo', async () => {
    await c.put('/api/erp/documentos/config', { nomeExibicao: 'Loja', posicaoLogo: 'CENTRO' });
    for (const ruim of ['DIREITA', 'centro', '<script>', 1, '']) {
      const r = await c.put('/api/erp/documentos/config', { nomeExibicao: 'Loja', posicaoLogo: ruim });
      expect(r.status).toBe(400);
    }
    expect((await c.get('/api/erp/documentos/config')).body.config.posicaoLogo).toBe('CENTRO');
  });

  it('valor estranho gravado direto no banco volta como "ESQUERDA" (nunca vai cru para o HTML)', async () => {
    await prisma.erpDocumentoConfig.update({ where: { orgId: c.me.org.id }, data: { posicaoLogo: '"><script>' } });
    expect((await c.get('/api/erp/documentos/config')).body.config.posicaoLogo).toBe('ESQUERDA');
    await prisma.erpDocumentoConfig.update({ where: { orgId: c.me.org.id }, data: { posicaoLogo: 'CENTRO' } });
  });

  it('cada empresa tem a sua; atendente não altera', async () => {
    expect((await outra.get('/api/erp/documentos/config')).body.config.posicaoLogo).toBe('ESQUERDA');
    const inv = await c.post('/api/team/invites', { email: `${uniq()}@t.dev`, role: 'AGENT' });
    const token = inv.body.link.split('/convite/')[1];
    const ag = new Client();
    const a = await ag.agent.post('/api/auth/accept-invite').set('x-requested-with', 'mckbot').send({ token, name: 'Atendente', password: 'senhaMembro123' });
    ag.csrf = a.body.csrfToken;
    expect((await ag.put('/api/erp/documentos/config', { posicaoLogo: 'ESQUERDA' })).status).toBe(403);
    expect((await c.get('/api/erp/documentos/config')).body.config.posicaoLogo).toBe('CENTRO');
  });
});
