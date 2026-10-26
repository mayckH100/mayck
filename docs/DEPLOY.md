# MCKBOT — Deploy gratuito passo a passo

Arquitetura gratuita sugerida: **Render (Free Web Service)** para o aplicativo + **Neon (Free)** para o PostgreSQL.
Nada aqui exige cartão de crédito no momento da escrita (verifique as condições de cada serviço antes de criar as contas).

> Condições verificadas em 25/10/2026 nas páginas oficiais:
> - Render Free: 750 horas grátis por mês por workspace; o serviço "dorme" após 15 min sem tráfego e leva cerca de 1 min para acordar; o Postgres grátis do Render expira em 30 dias — por isso usamos o Neon. Fonte: https://render.com/docs/free
> - Neon Free: 100 CU-horas por projeto/mês, 1 GB por projeto, o banco "dorme" após 5 min sem uso. Fonte: https://neon.com/docs/introduction/plans
> - Gemini API: `gemini-2.0-flash` foi desligado em 01/06/2026; para projetos novos o Google recomenda 3.5 Flash-Lite ou 3.8 Flash. Fonte: https://ai.google.dev/gemini-api/docs/models

---

## 1. Colocar o código no GitHub
1. Crie um repositório **privado** no GitHub.
2. Descompacte `mckbot.zip`, entre na pasta e envie:
   ```bash
   git init && git add . && git commit -m "MCKBOT"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/mckbot.git
   git push -u origin main
   ```
   O `.gitignore` já exclui `node_modules`, `dist`, bancos SQLite e `.env`.

## 2. Banco PostgreSQL grátis (Neon)
1. Crie a conta em https://neon.com e um projeto **MCKBOT**.
2. Região: **AWS US East (N. Virginia)** — a mesma região do Render configurada no `render.yaml` (o Render não tem região no Brasil; manter os dois juntos reduz a latência).
3. Em **Connect**, copie a *connection string* **direta** (sem `-pooler` no host) e mantenha `?sslmode=require` no final. Exemplo:
   `postgresql://usuario:senha@ep-xxxx.us-east-1.aws.neon.tech/neondb?sslmode=require`

**Alternativa — Supabase Free:** Project Settings → Database → Connection string (porta 5432). Atenção: no plano grátis o projeto é pausado após 1 semana sem atividade.

## 3. Aplicativo no Render (Blueprint)
1. Crie a conta em https://render.com (pode entrar com o GitHub).
2. **New → Blueprint** → escolha o repositório. O Render lê o `render.yaml`.
3. Preencha **DATABASE_URL** com a string do Neon. A **MASTER_KEY** é gerada automaticamente (256 bits em base64).
4. Clique em **Apply**. O build roda `npm ci --include=dev && npm run build` e o start roda `npm start`, que **aplica as migrações** (`prisma migrate deploy`) e sobe o servidor.
5. Quando ficar "Live", abra a URL `https://mckbot-xxxx.onrender.com` e **crie sua conta** — o primeiro cadastro cria a organização com você como Proprietário.

**Guarde a MASTER_KEY** (Render → Environment → MASTER_KEY → copiar) num cofre de senhas. Se ela mudar, tokens do WhatsApp, chaves de IA e credenciais de integrações salvas ficam ilegíveis e precisam ser cadastrados de novo.

### Configuração manual (sem Blueprint)
New → Web Service → repositório → Runtime **Node** → Plano **Free**
- Build Command: `npm ci --include=dev && npm run build`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- Variáveis: `NODE_ENV=production`, `NODE_VERSION=22`, `DATABASE_URL=…`, `MASTER_KEY=` (gere com `openssl rand -base64 32`).

### Docker (qualquer host)
```bash
docker build -t mckbot .
docker run -p 3000:3000 -e DATABASE_URL=... -e MASTER_KEY=... mckbot
```
(O Dockerfile foi escrito, mas **não foi testado** neste ambiente porque o Docker não estava disponível.)

## 4. Conectar o WhatsApp por QR code (modo principal)
Funciona como o WhatsApp Web: o MCKBOT vira um "aparelho conectado" do seu número. Não precisa de conta na Meta.

**Antes de tudo:** o número precisa estar com o **WhatsApp (ou WhatsApp Business) instalado e ativo no celular**. Recomendado: o app *WhatsApp Business* no celular da empresa.

1. Abra o MCKBOT → **Canais WhatsApp** → **+ Adicionar número** (se ainda não houver um canal).
2. No card do canal, clique em **Conectar por QR code**. Em poucos segundos aparece o QR.
3. No celular: WhatsApp → **⋮ Mais opções** (Android) ou **Configurações** (iPhone) → **Aparelhos conectados** → **Conectar aparelho** → aponte a câmera para o QR.
4. Aguarde aparecer **Conectado** com o número. Pronto: as mensagens recebidas entram no Inbox, nos fluxos e na IA.
5. O QR troca sozinho a cada ~20 s. Se ninguém ler a tempo, ele para e mostra **Gerar novo QR code**.
6. Para trocar de número ou desconectar: **Desconectar** no card (remove o aparelho no celular e apaga a sessão salva). Se você remover o aparelho pelo celular, o MCKBOT detecta e volta para "Não conectado".

Como funciona por trás: a sessão (credenciais do WhatsApp Web) fica **no banco**, cifrada com a `MASTER_KEY`. Quando o Render reinicia ou faz deploy, o servidor reconecta sozinho, sem ler o QR de novo. **Não troque a MASTER_KEY** — a sessão ficaria ilegível e seria preciso ler o QR outra vez.

Cuidados do modo QR (não oficial):
- Use para **atendimento**. Disparos em massa ou mensagens para quem não falou com você podem levar o WhatsApp a restringir o número.
- O WhatsApp desconecta aparelhos vinculados se o celular principal ficar **14 dias** sem ser usado.
- Botões interativos não são enviados no modo QR: o MCKBOT envia as opções numeradas ("1. Vendas / 2. Suporte") e entende a resposta pelo número.
- Modelos (templates) só existem na API oficial.

### 4.1 Manter o serviço acordado (obrigatório no Render Free para o modo QR)
O Render Free **hiberna após ~15 min sem tráfego HTTP** e isso **derruba a conexão do WhatsApp** — mensagens recebidas enquanto ele dorme só chegam quando ele acordar (e só se alguém acessar o site). Para evitar, use um **pinger gratuito** externo chamando o health check a cada 10 minutos:

1. Crie uma conta gratuita em https://cron-job.org (ou outro monitor grátis, como UptimeRobot).
2. **Create cronjob** → URL: `https://mckbot.onrender.com/api/health` → agendamento **a cada 10 minutos** → salvar.
3. O endpoint `/api/health` é leve (não consulta o banco), então não gasta as horas do Neon.

750 horas grátis/mês do Render cobrem um serviço ligado o mês inteiro (~730 h). Mesmo com o pinger, o Render pode reiniciar o serviço (deploy, manutenção): o MCKBOT reconecta sozinho com a sessão salva.

## 4B. (Opcional/Avançado) Conectar pela API oficial (Cloud API da Meta)
Na tela, fica em **Canais WhatsApp → Avançado / API oficial (opcional)**. Ao salvar as credenciais da API num canal, ele passa a usar a API oficial e a sessão por QR code daquele canal é encerrada.

Você precisa de: conta no Facebook, um **Portfólio empresarial (Business Manager)** e um número de telefone que **não esteja em uso** no app WhatsApp comum (ou que você remova de lá).

1. Acesse https://developers.facebook.com → **Meus apps → Criar app** → tipo **Empresa/Business** → vincule ao seu portfólio.
2. No app, adicione o produto **WhatsApp**. A Meta cria uma conta WhatsApp Business (WABA) e um **número de teste** (para testes, cadastre até 5 números destinatários).
3. Em **WhatsApp → Configuração da API**, anote o **ID do número de telefone (Phone Number ID)** e o **ID da conta do WhatsApp Business (WABA ID)**.
4. **Token permanente** (o token da tela de teste expira em 24 h):
   - business.facebook.com → Configurações do negócio → **Usuários do sistema** → Adicionar (função Administrador).
   - **Atribuir ativos**: o app (controle total) e a conta do WhatsApp.
   - **Gerar token** para o app com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`, validade "Nunca".
5. **App Secret**: no app → Configurações do app → Básico → **Chave secreta do app** → Mostrar.
6. No MCKBOT: **Canais WhatsApp → + Adicionar número → Configurações**: cole Phone Number ID, WABA ID, token e App Secret → **Salvar credenciais**.
7. Ainda nessa tela, copie a **URL de retorno** (`https://SEU-APP.onrender.com/api/webhooks/whatsapp/<id>`) e o **Token de verificação**.
8. No app da Meta → **WhatsApp → Configuração → Webhook → Editar**: cole a URL e o token → **Verificar e salvar** → em *Campos do webhook*, **assine `messages`**.
   - Se o Render estiver "dormindo", a verificação pode demorar; abra a URL do MCKBOT antes para acordar o serviço e tente de novo.
9. No MCKBOT clique em **Verificar conexão**. O status só muda para **Conectado** se a Graph API confirmar as credenciais.
10. Teste: do celular cadastrado como destinatário, mande "oi" para o número de teste. A conversa aparece no **Inbox**.

**Para produção (número real):** em WhatsApp → Configuração da API → *Adicionar número*, registre o número, defina o nome de exibição (passa por aprovação), conclua a **verificação da empresa** quando a Meta pedir, publique o app (modo *Live*, exige URL de política de privacidade) e cadastre uma forma de pagamento na conta do WhatsApp se for enviar **modelos**. Preços por mensagem: https://developers.facebook.com/docs/whatsapp/pricing — respostas dentro da janela de atendimento iniciada pelo cliente não usam modelo; mensagens fora dela exigem modelo aprovado.

## 5. Conectar a IA (grátis com Gemini)
1. Acesse https://aistudio.google.com/apikey → **Criar chave de API**.
2. No MCKBOT → **Inteligência artificial → Configuração**: provedor **Google Gemini**, modelo `gemini-3.5-flash-lite`, cole a chave, escreva as instruções e o tom → **Salvar**.
3. Em **Base de conhecimento**, cadastre horário, preços, políticas e perguntas frequentes. Sem isso a IA não responde sobre preços/políticas (transfere para humano).
4. Use **Testar** para conferir respostas e fontes; depois marque **IA ativada** e, se quiser, **Responder automaticamente quando nenhum fluxo for acionado**.
   (No plano gratuito do Gemini há limites de requisições por minuto/dia definidos pelo Google; os dados enviados no plano gratuito podem ser usados pelo Google para melhorar produtos — leia os termos antes de usar com dados sensíveis.)

Alternativa: provedor **OpenAI ou compatível** (OpenAI, Groq, OpenRouter etc.), informando URL base, modelo e chave.

## 6. Limitações do plano grátis e como lidar
| Situação | Efeito | O que fazer |
|---|---|---|
| Render dorme após 15 min sem tráfego (modo QR) | A conexão do WhatsApp cai; mensagens só chegam quando o serviço acordar | **Configure o pinger** da seção 4.1 (cron-job.org a cada 10 min em `/api/health`) |
| Render dorme após 15 min sem tráfego (API oficial) | A primeira mensagem depois de um período parado pode demorar ~1 min; se passar do tempo limite, a Meta reenvia o evento | O MCKBOT é idempotente (reenvio não duplica). Opcional: um monitor gratuito chamando `https://SEU-APP.onrender.com/api/health` a cada 10 min mantém o serviço acordado; 750 h/mês cobrem um serviço o mês inteiro |
| Bloco **Aguardar** com o serviço dormindo | A espera só é retomada quando o serviço acorda | Prefira esperas curtas ou mantenha o serviço acordado |
| Neon dorme após 5 min | Primeira consulta após pausa leva alguns centésimos de segundo a mais | O health check `/api/health` não consulta o banco e o agendador só consulta quando há espera pendente, para economizar as 100 CU-horas |
| Neon Free: 1 GB | Histórico muito grande enche o banco | Exporte/apague contatos antigos (LGPD) ou mude de plano |
| Sem SMTP | Convites não são enviados por e-mail | Copie o link do convite em **Equipe** |

## 7. Checklist do que falta conectar (só você pode fazer)
- [ ] Repositório no GitHub com o código.
- [ ] Projeto Neon e `DATABASE_URL` no Render.
- [ ] Serviço no Render (Blueprint) e cópia de segurança da `MASTER_KEY`.
- [ ] **Modo QR:** canal conectado lendo o QR com o celular do número (WhatsApp instalado).
- [ ] **Pinger gratuito** (cron-job.org a cada 10 min em `https://mckbot.onrender.com/api/health`) — necessário para o modo QR.
- [ ] (Opcional, API oficial) App na Meta com produto WhatsApp.
- [ ] **Phone Number ID**, **WABA ID**, **token permanente** (usuário do sistema) e **App Secret** cadastrados em Canais WhatsApp.
- [ ] Webhook configurado na Meta (URL + token de verificação, campo `messages`) e botão **Verificar conexão** mostrando **Conectado**.
- [ ] Número real registrado e nome de exibição aprovado (para sair do número de teste).
- [ ] **Chave de IA** (Gemini) cadastrada, base de conhecimento preenchida e IA ativada.

## 8. Variáveis de ambiente
| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | PostgreSQL (Neon/Supabase) com `sslmode=require` |
| `MASTER_KEY` | sim (produção) | 32 bytes em base64 para AES-256-GCM. Sem ela o servidor se recusa a iniciar em produção |
| `NODE_ENV` | sim | `production` |
| `PORT` | não | Definida pelo Render |
| `PUBLIC_URL` | não | URL pública; no Render usa `RENDER_EXTERNAL_URL` automaticamente |
| `GRAPH_API_VERSION` | não | Padrão `v26.0` (versão mais recente em 25/10/2026; a v21.0 expira em 21/01/2027 — https://developers.facebook.com/docs/graph-api/changelog). Atualize conforme o calendário da Meta |
| `FLOW_MAX_STEPS` | não | Limite de passos por execução (padrão 50) |
| `LOGIN_RATE_LIMIT` / `API_RATE_LIMIT` / `WEBHOOK_RATE_LIMIT` | não | Limites por janela (15 min / 1 min / 1 min) |
| `ENABLE_SCHEDULER` | não | `true` para retomar blocos Aguardar |
| `SUPERADMIN_EMAILS` | não | Lista de e-mails separados por vírgula (ex.: `voce@dominio.com,outro@dominio.com`). Quem estiver na lista vira superadmin no login e no startup do servidor. Nunca remove o acesso de ninguém |
| `ENABLE_WHATSAPP_QR` | não | Padrão `true`: reconecta as sessões do modo QR ao iniciar. `false` desliga a reconexão automática |

## Cobrança (Mercado Pago) — backend

Cada app tem assinatura própria por organização (`MCKBOT` e `MCKMENSAGEM`) e há o plano `COMBO`, que renova os dois. Novas organizações ganham teste grátis (`PlatformSettings.trialDays`, padrão 7 dias). Preços em centavos ficam em `PlatformSettings.pricesJson` (editáveis pelo painel Master, próxima fase).

- `MP_ACCESS_TOKEN` (env): access token do Mercado Pago. Sem ele, `billingConfigured=false` e o checkout responde 503.
- Erros do Mercado Pago são registrados no log (`[mercadopago] <método> <caminho> status=<http> message=<motivo>`, sem o token). Checkout/confirm com erro do MP respondem 502 com o motivo (ex.: "Mercado Pago recusou a credencial: Unauthorized use of live credentials"); pagamento inexistente no confirm → 404. No webhook, erro 4xx do MP (credencial/requisição) responde 200 e só loga, para não gerar reenvio infinito; 5xx/rede respondem 500 (o MP tenta de novo).
- `GET /api/master/settings` traz `mpCheck {ok, message}`: valida o token com `GET https://api.mercadopago.com/v1/payment_methods` (cache de 5 min). A aba Configurações do Master só mostra "Mercado Pago conectado" quando `ok`.
- Migração `0006_platform_settings_default` cria a linha `PlatformSettings 'default'` com os preços padrão (evita a corrida no primeiro cadastro).
- Segredo do webhook: `PlatformSettings.mpWebhookSecretEnc` (cifrado) ou, alternativamente, a env `MP_WEBHOOK_SECRET`. Com segredo configurado, o webhook exige `x-signature` válida.
- URL do webhook (configurar em *Suas integrações → Webhooks*, evento **Pagamentos**): `https://<host>/api/billing/mp/webhook`. A preferência já envia `notification_url` automaticamente.
- Endpoints: `GET /api/billing/status`, `POST /api/billing/checkout {product, cycle}`, `POST /api/billing/confirm {paymentId}`, `POST /api/billing/mp/webhook` (público).
- Bloqueio: com `MCKBOT` inativo (vencido/bloqueado) nenhuma mensagem sai e a automação não roda (as recebidas continuam gravadas); com `MCKMENSAGEM` inativo as campanhas ficam paradas sem consumir destinatários.

## Painel Master (superadmin) — backend

O painel Master (`/api/master/*`) é exclusivo do administrador da plataforma (`User.isSuperAdmin = true`).
Dono (OWNER) de organização **não** tem acesso: recebe 403.

### Tornar-se superadmin

**Sem acesso ao banco (recomendado):** defina no Render a env `SUPERADMIN_EMAILS=seu@email.com` (vários separados por vírgula; maiúsculas/minúsculas e espaços são ignorados). Ao subir, o servidor promove os usuários já existentes com esses e-mails; quem se cadastrar ou entrar depois com um deles também é promovido no ato. A env **só concede** acesso — tirar o e-mail da lista não remove o superadmin (para revogar use o painel Master → usuário ou o script abaixo).

**Pelo banco (alternativa):**

1. Crie sua conta normalmente pelo cadastro do app.
2. Rode, com a string de conexão do Neon (a mesma `DATABASE_URL` do Render):

```bash
DATABASE_URL='postgresql://...' node scripts/make-superadmin.mjs seu@email.com
# revogar: node scripts/make-superadmin.mjs seu@email.com --revoke
```

Alternativa pelo SQL Editor do Neon:

```sql
UPDATE "User" SET "isSuperAdmin" = true WHERE email = 'seu@email.com';
```

Saia e entre de novo no app (ou recarregue): `GET /api/auth/me` passa a trazer `isSuperAdmin: true`.

### Endpoints (todos exigem sessão de superadmin; POST/PUT exigem os cabeçalhos CSRF habituais)

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/master/dashboard` | clientes, assinaturas por status/produto, faturamento do mês/total, MRR, receita 12 meses, últimos 10 pagamentos |
| GET | `/api/master/clients?q=&status=&product=&page=` | lista de clientes (20 por página) |
| GET | `/api/master/clients/:orgId` | detalhes + eventos de cobrança + últimas 50 auditorias |
| POST | `/api/master/clients/:orgId/actions` | `renew` · `set-date` · `block` · `unblock` · `activate` · `deactivate` |
| POST | `/api/master/users/:userId` | `{ disabled?, isSuperAdmin? }` — desativar usuário derruba as sessões e bloqueia o login |
| GET | `/api/master/payments?page=` | todos os eventos de cobrança |
| GET | `/api/master/activity?page=` | auditoria global |
| GET/PUT | `/api/master/settings` | preços (centavos), dias de teste, segredo do webhook MP (salvo cifrado, exibido mascarado) |

Migração `0005_user_disabled` adiciona `User.disabledAt` (aplicada automaticamente no `npm start`).

## E-mails transacionais (SMTP grátis)

Cadastro (boas-vindas + confirmação de e-mail), "Esqueci minha senha" e aviso de senha alterada usam SMTP genérico via nodemailer. Sem SMTP, nada quebra: o servidor só registra no log que o e-mail não foi enviado.

| Variável | Exemplo (Brevo, grátis até 300 e-mails/dia) |
|---|---|
| `SMTP_HOST` | `smtp-relay.brevo.com` |
| `SMTP_PORT` | `587` (use `465` para SSL direto) |
| `SMTP_USER` | login SMTP do provedor |
| `SMTP_PASS` | chave/senha SMTP do provedor |
| `MAIL_FROM` | `MCKBOT <no-reply@seudominio.com>` (remetente verificado no provedor) |
| `APP_URL` | `https://mckbot.onrender.com` (opcional; sem ela usa `RENDER_EXTERNAL_URL`) |

Opcional: `FORGOT_RATE_LIMIT` (padrão 5 pedidos de redefinição por e-mail/IP a cada 15 min).

## PWA e futuro app na Play Store (TWA)

Os dois apps são instaláveis pelo navegador (`/manifest.webmanifest` para o MCKBOT e `/mensagem.webmanifest` para o MCK Mensagens, service worker em `/sw.js`, que nunca guarda `/api`). Para publicar na Play Store como TWA (Bubblewrap/PWABuilder), gere o app a partir do manifest e cole o JSON do Digital Asset Links na variável `TWA_ASSETLINKS`; ele passa a ser servido em `/.well-known/assetlinks.json`.
