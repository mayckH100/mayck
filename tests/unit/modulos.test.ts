import { describe, it, expect } from 'vitest';
import { acaoDaRota, iniciais, moduloDaRota, modulosVisiveis, secaoDaRota, type Acesso } from '../../web/src/modulos';
import { abaAtiva } from '../../web/src/erp/ErpNav';

// Pedido do dono (08/11): "a interface superior deve ser o módulo que está sendo usado, vamos deixar mais limpo o layout".
const dono: Acesso = { can: () => true, hasModule: () => true, superAdmin: false };
const atendente: Acesso = { can: (...r) => r.includes('AGENT'), hasModule: (m) => ['inbox', 'contatos'].includes(m), superAdmin: false };

describe('Topo mostra o módulo em uso', () => {
  it('rota decide o módulo; páginas comuns mantêm o último', () => {
    expect(moduloDaRota('/erp/balcao').id).toBe('erp');
    expect(moduloDaRota('/erp').id).toBe('erp');
    expect(moduloDaRota('/inbox/abc').id).toBe('bot');
    expect(moduloDaRota('/').id).toBe('bot');
    expect(moduloDaRota('/master/clientes/x').id).toBe('master');
    expect(moduloDaRota('/plano', 'erp')).toEqual({ id: 'erp', comum: true });
    expect(moduloDaRota('/perfil', null)).toEqual({ id: 'bot', comum: true });
    expect(moduloDaRota('/versoes', 'master').id).toBe('master');
    expect(moduloDaRota('/produtos', 'erp').id).toBe('bot'); // Produtos do MCKBOT não é página comum
  });

  it('seção atual pelo item mais específico', () => {
    expect(secaoDaRota('/erp/balcao')).toBe('Venda balcão (PDV)');
    expect(secaoDaRota('/erp')).toBe('Painel CRM');
    expect(secaoDaRota('/erp/pedidos/123')).toBe('Pedidos');
    expect(secaoDaRota('/erp/produtos')).toBe('Produtos');
    expect(secaoDaRota('/inbox/xyz')).toBe('Inbox');
    expect(secaoDaRota('/')).toBe('Visão geral');
    expect(secaoDaRota('/fluxos/1')).toBe('Fluxos');
    expect(secaoDaRota('/versoes')).toBe('Versões');
    expect(secaoDaRota('/erp/caixa/abc')).toBe('Caixa');
  });

  it('"+ Criar fluxo" só nas telas de fluxos e só para quem pode', () => {
    expect(acaoDaRota('/fluxos', dono)?.label).toBe('Criar fluxo');
    expect(acaoDaRota('/fluxos/abc', dono)?.to).toBe('/fluxos?novo=1');
    expect(acaoDaRota('/erp/balcao', dono)).toBeNull();
    expect(acaoDaRota('/inbox', dono)).toBeNull();
    expect(acaoDaRota('/', dono)).toBeNull();
    expect(acaoDaRota('/fluxos', atendente)).toBeNull();
  });

  it('módulos visíveis respeitam papel, módulo liberado e superadmin', () => {
    expect(modulosVisiveis(dono).map((m) => m.id)).toEqual(['erp', 'bot', 'msg']);
    expect(modulosVisiveis({ ...dono, superAdmin: true }).map((m) => m.id)).toEqual(['erp', 'bot', 'msg', 'master']);
    const a = modulosVisiveis(atendente);
    expect(a.map((m) => m.id)).toEqual(['bot']);
    expect(a[0].items.map((i) => i.to)).toEqual(['/', '/inbox', '/contatos']);
  });

  it('iniciais do avatar', () => {
    expect(iniciais('MAYCK A S HILARIO')).toBe('MH');
    expect(iniciais('ana')).toBe('A');
    expect(iniciais('')).toBe('?');
  });
});

describe('Abas do MCK ERP', () => {
  it('aba ativa pela rota mais específica', () => {
    expect(abaAtiva('/erp')).toBe('/erp');
    expect(abaAtiva('/erp/pedidos/9')).toBe('/erp/pedidos');
    expect(abaAtiva('/erp/fornecedores/1')).toBe('/erp/fornecedores');
    expect(abaAtiva('/erp/funcionarios')).toBeNull();
  });
});
