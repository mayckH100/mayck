import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerClient, Client, prisma } from '../helpers.js';
import { trustProxySetting, DEFAULT_TRUSTED_PROXIES } from '../../server/lib/clientIp.js';

const DAY = 86400000;

describe('Auditoria de segurança 2026-11 · MCK ERP exige assinatura ativa para alterar dados', () => {
  let owner: Client; let orgId: string;
  beforeAll(async () => {
    owner = await registerClient();
    orgId = (await owner.get('/api/auth/me')).body.org.id;
  });

  it('com teste ativo grava; com MCKBOT e MCK Mensagens vencidos → 402 (v1.17.0: também na leitura)', async () => {
    expect((await owner.post('/api/erp/produtos', { sku: 'SEG-1', nome: 'Produto', precoBaseCents: 100 })).status).toBe(201);
    await owner.get('/api/billing/status'); // garante as assinaturas criadas
    await prisma.subscription.updateMany({ where: { orgId }, data: { status: 'ATIVA', validUntil: new Date(Date.now() - DAY) } });
    const w = await owner.post('/api/erp/produtos', { sku: 'SEG-2', nome: 'Produto 2', precoBaseCents: 100 });
    expect(w.status).toBe(402);
    expect((await owner.get('/api/erp/produtos')).status).toBe(402);
    // v1.17.0: um produto só não basta mais; o ERP exige o Plano Completo (os dois ativos) — ver erp-plano-completo.test.ts.
    await prisma.subscription.update({ where: { orgId_product: { orgId, product: 'MCKMENSAGEM' } }, data: { validUntil: new Date(Date.now() + DAY) } });
    expect((await owner.post('/api/erp/produtos', { sku: 'SEG-3', nome: 'Produto 3', precoBaseCents: 100 })).status).toBe(402);
    await prisma.subscription.updateMany({ where: { orgId }, data: { validUntil: new Date(Date.now() + DAY) } });
    expect((await owner.post('/api/erp/produtos', { sku: 'SEG-3', nome: 'Produto 3', precoBaseCents: 100 })).status).toBe(201);
  });
});

describe('Auditoria de segurança 2026-11 · IP real do visitante atrás do Cloudflare + Render', () => {
  const appWith = () => {
    const a = express();
    a.set('trust proxy', trustProxySetting(''));
    a.get('/ip', (req, res) => res.json({ ip: req.ip }));
    return a;
  };

  it('pula o balanceador interno e a borda do Cloudflare e chega no visitante', async () => {
    const r = await request(appWith()).get('/ip').set('X-Forwarded-For', '200.150.10.20, 172.70.1.2, 10.1.2.3');
    expect(r.body.ip).toBe('200.150.10.20');
  });

  it('o visitante não consegue forjar o IP escrevendo X-Forwarded-For', async () => {
    // O que o visitante manda fica à esquerda do IP que o Cloudflare viu.
    const r = await request(appWith()).get('/ip').set('X-Forwarded-For', '1.2.3.4, 200.150.10.20, 162.158.5.6, 10.1.2.3');
    expect(r.body.ip).toBe('200.150.10.20');
  });

  it('TRUST_PROXY substitui a regra em emergência', () => {
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('10.0.0.0/8, 1.1.1.1')).toEqual(['10.0.0.0/8', '1.1.1.1']);
    expect(trustProxySetting(undefined)).toEqual(DEFAULT_TRUSTED_PROXIES);
  });
});
