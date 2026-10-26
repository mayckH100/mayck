# MCKBOT

Plataforma SaaS de automação de atendimento no WhatsApp com IA, conectando o número por **QR code** (como o WhatsApp Web, via Baileys) — com a **API oficial (WhatsApp Cloud API da Meta)** disponível como opção avançada.

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
  whatsapp/        Cloud API (opcional) e qr/ (Baileys: sessões, QR, parser); inbound/outbound com roteamento por provider
  flows/           motor de fluxos (logic.ts puro + engine.ts com banco)
  ai/              provedores, RAG, regras anti-invenção, serviço
  routes/          rotas REST por módulo
web/src/           interface React (páginas em web/src/pages)
prisma/            schema.prisma (PostgreSQL) + migrations/
tests/             unit/, integration/, e2e/
docs/              requisitos, deploy, relatório de testes, capturas de tela
```

## MCK Mensagens (app separado em `/mensagem`)

- Mesmo serviço, banco e contas do MCKBOT; frontend próprio (entrada Vite `web/mensagem.html` → `web/src/mensagem/`), marca "MCK Mensagens", cor roxa e menu no topo.
- Rotas: `/mensagem/login`, `/mensagem/` (painel), `/mensagem/contatos`, `/mensagem/campanhas`, `/mensagem/campanhas/:id`, `/mensagem/assinatura`. O Express serve `mensagem.html` para `/mensagem` e `/mensagem/*`; o restante continua no SPA do MCKBOT.
- API `/api/mckmensagem` (OWNER/ADMIN): com a assinatura MCKMENSAGEM inativa, leitura e exportação seguem liberadas; escrita, importação, iniciar e pausar respondem `402 {"error":"Assinatura MCK Mensagens inativa"}`.
- Pagamento iniciado no MCK Mensagens (`POST /api/billing/checkout` com `app: "mensagem"`) volta para `/mensagem/assinatura`.
