import { describe, it, expect, beforeAll } from 'vitest';
import { registerClient, Client, prisma } from '../helpers.js';

const SENHA = 'senhaSegura123';
const API = '/api/mckmensagem/automacoes';
const delCom = (c: Client, url: string, senha?: string) => c.agent.delete(url).set(c.h()).send(senha === undefined ? {} : { senha });

async function novaAutomacao(orgId: string, status: string) {
  return prisma.automacao.create({
    data: { orgId, nome: `Auto ${status}`, categoria: 'LEMBRETE', mensagem: 'Olá', regra: JSON.stringify({ tipo: 'UNICO', data: '2030-01-01', horario: '10:00' }), inicio: new Date(), status },
  });
}
async function novoCompromisso(orgId: string, status: string) {
  return prisma.appointment.create({ data: { orgId, title: `Reunião ${status}`, startAt: new Date(Date.now() + 86400e3), status, notifyContact: false } });
}

describe('Exclusão de itens cancelados com senha (Agenda e Agendamentos do MCK Mensagens)', () => {
  let owner: Client, other: Client;
  beforeAll(async () => {
    owner = await registerClient();
    other = await registerClient();
  });

  describe('Agendamentos (Automacao)', () => {
    it('cancelado + senha correta: exclui, remove envios/anexos e grava auditoria só com ids', async () => {
      const orgId = owner.me.org.id;
      const a = await novaAutomacao(orgId, 'CANCELADA');
      await prisma.ocorrencia.create({ data: { orgId, automacaoId: a.id, clienteId: 'x', canal: 'WHATSAPP', chave: `k-${a.id}`, agendadoPara: new Date(), executarEm: new Date(), status: 'CANCELADA' } });
      await prisma.automacaoAnexo.create({ data: { orgId, automacaoId: a.id } });
      const r = await delCom(owner, `${API}/automacoes/${a.id}`, SENHA);
      expect(r.status).toBe(200);
      expect(await prisma.automacao.findUnique({ where: { id: a.id } })).toBeNull();
      expect(await prisma.ocorrencia.count({ where: { automacaoId: a.id } })).toBe(0);
      expect(await prisma.automacaoAnexo.count({ where: { automacaoId: a.id } })).toBe(0);
      const log = await prisma.auditLog.findFirst({ where: { orgId, action: 'mckmensagem.automacao.delete', entityId: a.id } });
      expect(log).toBeTruthy();
      expect(log!.userId).toBe(owner.me.user.id);
      expect(JSON.parse(log!.meta)).toEqual({});
    });

    it('senha errada → 403 e nada é excluído; sem senha → 400', async () => {
      const a = await novaAutomacao(owner.me.org.id, 'CANCELADA');
      expect((await delCom(owner, `${API}/automacoes/${a.id}`, 'senhaErrada999')).status).toBe(403);
      expect((await delCom(owner, `${API}/automacoes/${a.id}`)).status).toBe(400);
      expect(await prisma.automacao.findUnique({ where: { id: a.id } })).not.toBeNull();
    });

    it('não cancelado → 409 com mensagem em português (mesmo com a senha certa)', async () => {
      for (const st of ['RASCUNHO', 'ATIVA', 'PAUSADA', 'CONCLUIDA']) {
        const a = await novaAutomacao(owner.me.org.id, st);
        const r = await delCom(owner, `${API}/automacoes/${a.id}`, SENHA);
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/cancelados/);
        expect(await prisma.automacao.findUnique({ where: { id: a.id } })).not.toBeNull();
      }
    });

    it('outra organização → 404', async () => {
      const a = await novaAutomacao(owner.me.org.id, 'CANCELADA');
      expect((await delCom(other, `${API}/automacoes/${a.id}`, SENHA)).status).toBe(404);
      expect(await prisma.automacao.findUnique({ where: { id: a.id } })).not.toBeNull();
    });
  });

  describe('Agenda (Appointment)', () => {
    it('cancelado + senha correta: exclui e grava agenda.delete só com ids', async () => {
      const orgId = owner.me.org.id;
      const ap = await novoCompromisso(orgId, 'CANCELLED');
      expect((await delCom(owner, `/api/agenda/${ap.id}`, SENHA)).status).toBe(200);
      expect(await prisma.appointment.findUnique({ where: { id: ap.id } })).toBeNull();
      const log = await prisma.auditLog.findFirst({ where: { orgId, action: 'agenda.delete', entityId: ap.id } });
      expect(log).toBeTruthy();
      expect(JSON.parse(log!.meta)).toEqual({});
    });

    it('senha errada → 403 e nada é excluído', async () => {
      const ap = await novoCompromisso(owner.me.org.id, 'CANCELLED');
      expect((await delCom(owner, `/api/agenda/${ap.id}`, 'senhaErrada999')).status).toBe(403);
      expect(await prisma.appointment.findUnique({ where: { id: ap.id } })).not.toBeNull();
    });

    it('não cancelado (agendado ou concluído) → 409', async () => {
      for (const st of ['SCHEDULED', 'DONE']) {
        const ap = await novoCompromisso(owner.me.org.id, st);
        const r = await delCom(owner, `/api/agenda/${ap.id}`, SENHA);
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/cancelados/);
      }
    });

    it('outra organização → 404', async () => {
      const ap = await novoCompromisso(owner.me.org.id, 'CANCELLED');
      expect((await delCom(other, `/api/agenda/${ap.id}`, SENHA)).status).toBe(404);
      expect(await prisma.appointment.findUnique({ where: { id: ap.id } })).not.toBeNull();
    });

    it('limita tentativas de senha errada (5 a cada 15 min por usuário) → 429', async () => {
      const c = await registerClient();
      const ap = await novoCompromisso(c.me.org.id, 'CANCELLED');
      for (let i = 0; i < 5; i++) expect((await delCom(c, `/api/agenda/${ap.id}`, 'senhaErrada999')).status).toBe(403);
      expect((await delCom(c, `/api/agenda/${ap.id}`, SENHA)).status).toBe(429);
    });
  });
});
