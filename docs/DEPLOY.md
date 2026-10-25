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

## 4. Conectar o WhatsApp (Cloud API oficial da Meta)
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
| Render dorme após 15 min sem tráfego | A primeira mensagem depois de um período parado pode demorar ~1 min; se passar do tempo limite, a Meta reenvia o evento | O MCKBOT é idempotente (reenvio não duplica). Opcional: um monitor gratuito chamando `https://SEU-APP.onrender.com/api/health` a cada 10 min mantém o serviço acordado; 750 h/mês cobrem um serviço o mês inteiro |
| Bloco **Aguardar** com o serviço dormindo | A espera só é retomada quando o serviço acorda | Prefira esperas curtas ou mantenha o serviço acordado |
| Neon dorme após 5 min | Primeira consulta após pausa leva alguns centésimos de segundo a mais | O health check `/api/health` não consulta o banco e o agendador só consulta quando há espera pendente, para economizar as 100 CU-horas |
| Neon Free: 1 GB | Histórico muito grande enche o banco | Exporte/apague contatos antigos (LGPD) ou mude de plano |
| Sem SMTP | Convites não são enviados por e-mail | Copie o link do convite em **Equipe** |

## 7. Checklist do que falta conectar (só você pode fazer)
- [ ] Repositório no GitHub com o código.
- [ ] Projeto Neon e `DATABASE_URL` no Render.
- [ ] Serviço no Render (Blueprint) e cópia de segurança da `MASTER_KEY`.
- [ ] App na Meta com produto WhatsApp.
- [ ] **Phone Number ID**, **WABA ID**, **token permanente** (usuário do sistema) e **App Secret** cadastrados em Canais WhatsApp.
- [ ] Webhook configurado na Meta (URL + token de verificação, campo `messages`) e botão **Verificar conexão** mostrando **Conectado**.
- [ ] Número real registrado e nome de exibição aprovado (para sair do número de teste).
- [ ] **Chave de IA** (Gemini) cadastrada, base de conhecimento preenchida e IA ativada.
- [ ] (Opcional) Monitor gratuito para manter o serviço acordado.

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
