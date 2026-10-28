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
- **Ações em massa nos contatos:** marque contatos (ou "todos os N que atendem ao filtro") e vincule/remova campanha, adicione/remova etiquetas, mude status, marque/remova opt-out ou exclua — `POST /api/mckmensagem/leads/bulk` com `ids` ou `filter` (limite de 10.000 por operação, auditado). Na campanha, "Adicionar contatos" abre um seletor com busca, etiqueta, status e selecionar todos; se a campanha já começou, os elegíveis entram direto na fila.
- Pagamento iniciado no MCK Mensagens (`POST /api/billing/checkout` com `app: "mensagem"`) volta para `/mensagem/assinatura`.

### Automações e Cobranças (`/mensagem/automacoes`)

Menu "Automações e Cobranças" do MCK Mensagens. OWNER/ADMIN alteram; AGENT só consulta. Com a assinatura inativa, escrita responde 402 (leitura liberada). API em `/api/mckmensagem/automacoes`.

- **Fase 1:** Dashboard, Clientes (CSV, sem duplicidade, consentimento/opt-out), Agendamentos, Lembretes, Marketing, Calendário, Histórico, Configurações. Motor no servidor (`automacoes/engine.ts`) com fila persistente (`Ocorrencia`), chave idempotente, claim atômico, retentativas e retomada após restart.
- **Fase 2 — telas:** Boletos e faturas (`/automacoes/boletos`), Sequências de cobrança (`/automacoes/cobrancas`), Pagamentos e comprovantes (`/automacoes/pagamentos`), Arquivos (`/automacoes/arquivos`), Relatórios (`/automacoes/relatorios`).
- **Boletos:** valor, juros/multa/desconto, vencimento, linha digitável, código de barras, link e PDF; status financeiro (rascunho, a vencer, vencido — automático, comprovante em análise, parcial, pago confirmado, cancelado) separado do status de envio; histórico de alterações só de inserção (`BoletoEvento`).
- **Sequência de cobrança:** mensagem N leva o boleto N (`AutomacaoAnexo.envio`), na ordem; antes de cada envio o motor confere o boleto — pago, cancelado ou com comprovante em análise não é cobrado. Reenvio relativo ao vencimento (ex.: −1, 0, 1, 3, 7 dias) só de pendentes/vencidos, com máximo por boleto; pagamento confirmado cancela os envios futuros daquele boleto e encerra a sequência quando todas as parcelas estão pagas.
- **Anexos:** qualquer agendamento pode levar arquivos (todas as mensagens ou só a mensagem N). WhatsApp QR envia o arquivo como documento/imagem pelo Baileys; Cloud API faz upload em `/media` (fora da janela de 24 h falha com explicação); e-mail anexa via SMTP. Falha de um canal fica registrada no histórico daquele canal; nada é simulado.
- **Arquivos:** guardados no próprio PostgreSQL (`ArquivoConteudo.dados`, bytea) — sobrevivem aos deploys do Render Free e não exigem serviço pago. Tipo real pelo conteúdo, tamanho máximo configurável (até 25 MB), bloqueio de executáveis, PDF com JavaScript e documentos com macro; download só autenticado (OWNER/ADMIN), sem link público.
- **Comprovantes:** imagem/PDF recebido no WhatsApp de um cliente com cobrança em aberto (ou que fala de pagamento) vira comprovante "em análise", com extração gratuita de valor/data/ID Pix/banco (texto da legenda e do PDF; sem OCR de imagem), sugestão da parcela e nível de confiança, detecção de duplicado; nunca dá baixa sozinho. O administrador aprova (gera o pagamento) ou rejeita; aviso por e-mail aos administradores quando há SMTP.
- **Pagamentos:** baixa manual total ou parcial, estorno (só o dono) sem apagar o registro e com reabertura da cobrança; relatórios com exportação CSV (mensagens, boletos, pagamentos, comprovantes).
- **Configuração externa:** nenhuma obrigatória. Para e-mail: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (ex.: Brevo grátis). WhatsApp: canal QR conectado no MCKBOT (ou Cloud API). Confirmação bancária automática não está integrada (sem custo): a baixa é manual ou por aprovação de comprovante.
