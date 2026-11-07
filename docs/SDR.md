# SDR com IA (v1.18.0)

Pré-vendas automática dentro do MCKBOT (menu **SDR com IA**, rota `/sdr`). Evolui o funil de leads automático
existente: o lead do SDR (`SdrLead`) liga-se ao contato do MCKBOT (`Contact`) e ao lead do MCK Mensagens (`Lead`)
da mesma pessoa; opt-out e consentimento valem nos dois lados. Lead só com e-mail (prospecção fria) também cabe.

## Quem tem
- Plano Completo ativo ou em teste (`planoCompletoAtivo`, mesma regra do ERP na 1.17.0), quando o Master deixa o
  plano ligado (padrão ligado). Só MCKBOT / só MCK Mensagens: desligado por padrão (Painel Master › SDR com IA).
- Sempre: empresa com um superadmin na equipe (empresa da MCK) ou listada em `SDR_ORG_IDS`, e o superadmin.
- Sem acesso: `/api/sdr` responde 402 com `code: SDR_PLANO` (exceto `/api/sdr/acesso`). Módulo de equipe: `sdr`.

## Como funciona (modo automático, padrão)
1. **Entrada:** quem chama pela 1ª vez no WhatsApp (contato novo, não salvo na agenda do celular quando o canal
   não responde salvos, sem opt-out); formulário público `/f/<token>` (com autorização de contato obrigatória);
   cadastro manual; planilha CSV (`nome;empresa;segmento;telefone;email;consentimento`, origem IMPORTACAO).
   Opt-out existente (contato, lead do MCK Mensagens ou SDR) nunca é sobrescrito.
2. **Qualificação:** a IA do MCKBOT continua respondendo normalmente; o SDR acrescenta ao prompt as perguntas que
   faltam (uma por resposta). Depois de cada mensagem do lead, uma extração em segundo plano grava as respostas,
   dá notas 0–100 por pergunta e calcula a pontuação ponderada (pesos configuráveis). Frio < 40 ≤ morno < 70 ≤ quente.
   Morno/quente com 2+ respostas → etapa Qualificado.
3. **Lead quente:** aviso pelos Números de aviso (WhatsApp, cai para e-mail) + painel. Nunca transfere a conversa
   (regra do dono: só transfere quando o cliente pede).
4. **Cadências:** prontas por segmento (8), passos com dia + canal + texto com variáveis
   `{nome} {primeiro_nome} {empresa} {segmento} {minha_empresa}`. Lead do WhatsApp entra em "espera": o
   acompanhamento começa após `silenceHours` (padrão 3 h) sem resposta. Demais leads começam no dia 0.
   - WhatsApp só para quem chamou ou tem consentimento; e-mail nunca para lead do WhatsApp (canal de entrada);
     passo de canal não permitido é pulado (registrado no histórico).
   - Horário comercial (padrão 9h–18h, seg–sex, fuso da empresa) e limite diário por empresa (padrão 40).
   - Para sozinha quando o lead responde, marca reunião, vira ganho/perdido ou pede para sair (SAIR/PARAR,
     descadastro do e-mail). E-mail pela Brevo/SMTP do sistema, sempre com link `/descadastro/<token>`.
   - API oficial (Cloud) fora da janela de 24 h: o passo de WhatsApp é pulado (a Meta exige modelo aprovado).
5. **Reunião:** no modo automático com "IA marca a reunião sozinha", a agenda pela IA vale para o lead mesmo com a
   opção da Agenda desligada (marcador `[AGENDAR]`, com confirmação do lead). Confirmação e lembrete pela Agenda.
   Reunião criada para o contato → etapa Reunião marcada e cadência parada.
6. **Modo manual:** cada passo vencido fica "aguardando aprovação" (painel › Revisar › Aprovar e enviar / Pular).

## Agendador
`tickSdr` a cada 60 s quando `ENABLE_SCHEDULER=true` (lote de 100). Logs sem dados pessoais (só ids).

## Rotas
- `/api/sdr/*` (sessão): acesso, config, cadencias, leads, leads/:id (+ aprovar, pular, parar, cadencia, reuniao),
  importar, painel. `/api/master/sdr` (superadmin): planos.
- Públicas (fora de /api, HTML sem JS): `GET/POST /f/:token`, `GET/POST /descadastro/:token` (limite por IP,
  campo-isca, origem conferida, tudo escapado).

## Para a v2
Resposta por e-mail (IMAP/webhook de entrada) para parar a cadência sozinha; modelos aprovados da Meta para
WhatsApp fora da janela de 24 h; formulário incorporável em outros sites; teste A/B de textos; distribuição
automática de leads por dono (rodízio); sincronizar a etapa com o Kanban do MCKBOT; relatórios por cadência/passo.
