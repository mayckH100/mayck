import { test, expect, type Page } from '@playwright/test';

const email = `e2e${Date.now()}@teste.dev`;
const password = 'senhaE2E12345';
const errors: string[] = [];

async function register(page: Page) {
  await page.goto('/cadastro');
  await page.getByLabel('Seu nome').fill('Mayck Teste');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByLabel('Nome da empresa').fill('Loja E2E');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
}

test.describe.serial('MCKBOT — fluxo completo no navegador', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  });

  test('cadastro leva ao painel com indicadores zerados e aviso de WhatsApp não conectado', async () => {
    await register(page);
    await expect(page.getByText('Conversas abertas')).toBeVisible();
    await expect(page.getByText(/WhatsApp\s+não conectado/).first()).toBeVisible();
    await expect(page.getByText('Nenhuma falha registrada')).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/01-painel.png', fullPage: true });
  });

  test('todas as páginas do menu abrem sem erro', async () => {
    const pages: [string, string][] = [
      ['Inbox', 'Inbox'], ['Kanban', 'Kanban'], ['Contatos', 'Contatos'], ['Fluxos', 'Fluxos'], ['Inteligência artificial', 'Inteligência artificial'],
      ['Canais WhatsApp', 'Canais WhatsApp'], ['Integrações', 'Integrações de parceiros'], ['Relatórios', 'Relatórios'], ['Equipe', 'Equipe'],
      ['Plano', 'Plano'], ['Auditoria', 'Auditoria'], ['Perfil', 'Perfil e conta'], ['Boas práticas', 'Boas práticas no WhatsApp'],
    ];
    for (const [link, heading] of pages) {
      await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.locator('.alert.err')).toHaveCount(0);
    }
  });

  test('canal WhatsApp novo aparece como "Não conectado" com URL de webhook', async () => {
    await page.goto('/canais');
    await page.getByRole('button', { name: '+ Adicionar número' }).click();
    await expect(page.locator('.card .badge', { hasText: 'Não conectado' })).toBeVisible();
    await page.getByRole('button', { name: 'Configurações' }).click();
    await expect(page.getByText('/api/webhooks/whatsapp/')).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/02-canal.png', fullPage: true });
    await page.getByRole('button', { name: 'Fechar' }).click();
    await page.getByRole('button', { name: 'Verificar conexão' }).click();
    await expect(page.getByText(/Preencha Phone Number ID/)).toBeVisible();
  });

  test('cria e edita contato; aparece no Kanban', async () => {
    await page.goto('/contatos');
    await expect(page.getByText('Nenhum contato ainda')).toBeVisible();
    await page.getByRole('button', { name: '+ Novo contato' }).click();
    await page.getByLabel('Nome').fill('Cliente Exemplo');
    await page.getByLabel('WhatsApp').fill('11999998888');
    await page.getByLabel('Etiquetas').fill('vip, teste');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('cell', { name: /Cliente Exemplo/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: '+5511999998888' })).toBeVisible();
    await page.getByRole('button', { name: 'Abrir', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exportar dados (LGPD)' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar' }).click();
    await page.goto('/kanban');
    await expect(page.locator('.kcard', { hasText: 'Cliente Exemplo' })).toBeVisible();
    await page.locator('.kcard', { hasText: 'Cliente Exemplo' }).getByLabel('Mover para').selectOption({ label: 'Qualificado' });
    await page.reload();
    await expect(page.locator('.col', { hasText: 'Qualificado' }).locator('.kcard', { hasText: 'Cliente Exemplo' })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/03-kanban.png', fullPage: true });
  });

  test('cria fluxo no editor visual, adiciona bloco, salva nova versão e ativa', async () => {
    await page.goto('/fluxos');
    await page.getByRole('button', { name: '+ Novo fluxo' }).click();
    await page.getByLabel('Nome do fluxo').fill('Boas-vindas E2E');
    await page.getByRole('button', { name: 'Criar e abrir editor' }).click();
    await expect(page.locator('.react-flow')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await page.locator('.palette').getByRole('button', { name: 'Menu de opções' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.getByText('Alterações não salvas')).toBeVisible();
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();
    await expect(page.locator('.badge', { hasText: 'v2' })).toBeVisible();
    await page.locator('.react-flow__node').filter({ hasText: 'Início' }).click();
    await expect(page.getByRole('button', { name: '+ Adicionar gatilho' })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/04-editor-fluxo.png' });
    // Gatilho de exemplo tem palavra "oi" — fluxo válido pode ser ativado
    await page.getByRole('button', { name: 'Ativar' }).click();
    await expect(page.locator('.badge', { hasText: 'Ativo' })).toBeVisible();
    await page.getByRole('button', { name: '← Voltar' }).click();
    await expect(page.getByRole('cell', { name: 'Boas-vindas E2E' })).toBeVisible();
  });

  test('configura IA e adiciona documento à base de conhecimento', async () => {
    await page.goto('/ia');
    await expect(page.getByText('Nenhuma chave configurada')).toBeVisible();
    await page.getByLabel('Instruções').fill('Somos a Loja E2E. Atenda com educação.');
    await page.getByRole('button', { name: 'Salvar configurações' }).click();
    await expect(page.getByText('Configurações da IA salvas')).toBeVisible();
    await page.getByRole('button', { name: 'Base de conhecimento' }).click();
    await page.getByRole('button', { name: '+ Documento' }).click();
    await page.getByLabel('Título').fill('Horário');
    await page.getByLabel('Conteúdo').fill('Atendemos de segunda a sexta, das 9h às 18h.');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('1 trecho(s)')).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/05-ia.png', fullPage: true });
  });

  test('equipe gera link de convite; relatórios e auditoria mostram dados reais', async () => {
    await page.goto('/equipe');
    await page.getByLabel('E-mail').fill('atendente@teste.dev');
    await page.getByRole('button', { name: 'Gerar convite' }).click();
    await expect(page.locator('.alert.ok .mono')).toContainText('/convite/');
    await page.goto('/relatorios');
    await expect(page.getByText('Desempenho dos fluxos')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Boas-vindas E2E' })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/06-relatorios.png', fullPage: true });
    await page.goto('/auditoria');
    await expect(page.getByRole('cell', { name: 'Fluxo ativado' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Convite criado' })).toBeVisible();
  });

  test('layout responsivo no celular (menu recolhível)', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeVisible();
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Inbox', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    await expect(page.getByText('Nenhuma conversa aqui')).toBeVisible();
    await page.waitForTimeout(400); // aguarda a animação de fechar o menu
    await page.screenshot({ path: 'docs/screenshots/07-mobile-inbox.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('logout e login novamente; senha errada mostra erro', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill('errada123');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toContainText('E-mail ou senha incorretos');
    await page.getByLabel('Senha').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  });

  test('nenhum erro de JavaScript no console durante a navegação', async () => {
    expect(errors).toEqual([]);
  });
});
