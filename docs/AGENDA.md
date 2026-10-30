# Agenda (reuniões e tarefas na agenda do celular)

Funciona sem configurar nada:
- **Link "Adicionar à agenda"** enviado ao contato pelo WhatsApp (página com botões Google Agenda / iPhone (.ics) / Outlook).
- **Feed assinável** (URL secreta `webcal://…/api/public/agenda/feed/<token>.ics`) por usuário ou da empresa inteira: atualiza sozinho no celular (novos, remarcados, cancelados).
- **IA agenda no WhatsApp** (Agenda › Configurações › "A IA pode agendar"): oferece só horários livres e cria o compromisso quando o cliente confirma, checando conflitos.
- Lembrete por WhatsApp para o contato (e alarme no próprio celular via .ics/feed). E-mail com convite .ics para o responsável quando o SMTP estiver configurado.

## Google Agenda direto (opcional, grátis)
1. https://console.cloud.google.com → criar projeto "MCKBOT".
2. "APIs e serviços" › Biblioteca › ativar **Google Calendar API**.
3. "Tela de consentimento OAuth": tipo Externo, nome MCKBOT, e-mail de suporte; escopos `calendar.events` e `calendar.freebusy`; em "Usuários de teste" adicione os e-mails que vão conectar (até 100, sem verificação do Google).
4. "Credenciais" › Criar credenciais › ID do cliente OAuth › Aplicativo da Web. URI de redirecionamento autorizado:
   `https://mckbot.onrender.com/api/agenda/google/callback`
5. No Render (serviço mckbot › Environment): `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` (opcional `GOOGLE_REDIRECT_URI`). Salvar e fazer deploy.
6. No painel: Agenda › "Conectar Google Agenda".
Para liberar a qualquer cliente sem lista de testadores, publique o app no consentimento (o Google pede verificação para escopos de agenda).
