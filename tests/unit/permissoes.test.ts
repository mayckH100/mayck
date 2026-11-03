import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sanitizeGrant, accessOf, effectiveModules, DEFAULT_MODULES } from '../../server/lib/permissions.js';

const owner = { role: 'OWNER' as const, access: { modules: null, channelIds: null } };

describe('permissões da equipe', () => {
  it('padrões do formulário: atendente = Inbox, Kanban e Contatos; admin = tudo menos Plano', () => {
    expect(DEFAULT_MODULES.AGENT).toEqual(['inbox', 'kanban', 'contatos']);
    expect(DEFAULT_MODULES.ADMIN).not.toContain('plano');
    expect(DEFAULT_MODULES.ADMIN).toContain('equipe');
  });
  it('proprietário sempre tem tudo, mesmo com valores gravados', () => {
    expect(accessOf('OWNER', { modules: '["inbox"]', channelIds: '["c1"]' })).toEqual({ modules: null, channelIds: null });
    expect(effectiveModules('OWNER', { modules: null, channelIds: null })).toContain('plano');
  });
  it('nulo = acesso antigo do papel; módulos fora do papel são ignorados', () => {
    expect(accessOf('AGENT', { modules: null, channelIds: null }).modules).toBeNull();
    expect(accessOf('AGENT', { modules: '["inbox","mensagens"]', channelIds: null }).modules).toEqual(['inbox']);
  });
  it('não concede além do que quem concede tem (módulos e canais)', () => {
    const admin = { role: 'ADMIN' as const, access: { modules: ['inbox' as const, 'equipe' as const], channelIds: ['c1'] } };
    expect(sanitizeGrant(admin, { role: 'AGENT', modules: ['inbox', 'agenda'] }, ['c1', 'c2'])).toHaveProperty('error');
    expect(sanitizeGrant(admin, { role: 'AGENT', modules: ['inbox'], channelIds: ['c2'] }, ['c1', 'c2'])).toHaveProperty('error');
    expect(sanitizeGrant(admin, { role: 'AGENT', modules: null, channelIds: null }, ['c1', 'c2'])).toEqual({ modules: '["inbox","equipe"]', channelIds: '["c1"]' });
    expect(sanitizeGrant(owner, { role: 'AGENT', modules: ['x'] }, [])).toHaveProperty('error');
    expect(sanitizeGrant(owner, { role: 'AGENT', modules: ['inbox'], channelIds: ['outra-org'] }, ['c1'])).toHaveProperty('error');
    expect(sanitizeGrant(owner, { role: 'AGENT' }, ['c1'])).toEqual({ modules: null, channelIds: null });
  });
  it('migração 0033 é só aditiva', () => {
    const sql = readFileSync('prisma/migrations/0033_permissoes_equipe/migration.sql', 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i);
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(6);
  });
});
