# MCKBOT

Plataforma SaaS de automação de atendimento no WhatsApp com IA, usando a **API oficial (WhatsApp Cloud API da Meta)**.

- **Atendimento:** Inbox compartilhada, Kanban de funil, Contatos/CRM (etiquetas, notas, campos coletados, importação, LGPD).
- **Automação:** fluxos visuais (React Flow) com gatilhos (mensagem recebida, palavra-chave, primeira mensagem, horário) e blocos (texto, mídia, menu, perguntar e salvar, condição, IA, aguardar, webhook HTTP, etiqueta/etapa, transferir para humano, encerrar), versionamento e registro de cada execução.
- **IA:** Google Gemini ou OpenAI/compatível, chave cifrada, RAG sobre a base de conhecimento, regra anti-invenção de preços/políticas, limites de uso, fallback e transferência para humano.
- **Gestão:** painel com indicadores reais, relatórios, equipe com papéis (Proprietário/Administrador/Atendente), auditoria, integrações de parceiros (API HTTP com credencial cifrada).

## Stack
Node.js 22 + TypeScript · Express · React 18 + Vite · React Flow · Prisma (PostgreSQL em produção, SQLite em dev/testes) · Zod · bcrypt · Vitest + Supertest · Playwright.

## Rodar localmente (SQLite)
```bash
npm install
npm run dev:setup      # gera o cliente SQLite e cria dev.db
npm run dev            # API em :3000 e interface em http://localhost:5173
```
> Os scripts usam variáveis inline (`VAR=valor comando`). No Windows, use WSL ou Git Bash.

## Testes
```bash
npm test               # unitários + integração (SQLite)
npm run test:pg        # integração contra PostgreSQL (defina DATABASE_URL)
npm run test:e2e       # Playwright (requer Chromium: npx playwright install chromium)
npm run typecheck
```
Resultados reais em `docs/RELATORIO_TESTES.md` (logs em `docs/evidencias/`).

## Deploy gratuito
Veja `docs/DEPLOY.md` (Render free + Neon/Supabase Postgres grátis). Requisitos e diferenças em relação à referência: `docs/REQUISITOS.md`.

## Estrutura
```
server/            API Express
  auth/            sessão httpOnly, CSRF, RBAC, convites
  whatsapp/        Cloud API: cliente com retries, webhook, assinatura, inbound/outbound
  flows/           motor de fluxos (logic.ts puro + engine.ts com banco)
  ai/              provedores, RAG, regras anti-invenção, serviço
  routes/          rotas REST por módulo
web/src/           interface React (páginas em web/src/pages)
prisma/            schema.prisma (PostgreSQL) + migrations/
tests/             unit/, integration/, e2e/
docs/              requisitos, deploy, relatório de testes, capturas de tela
```
