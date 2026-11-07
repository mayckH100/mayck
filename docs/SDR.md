# SDR com IA (v1.18.0; v2 na v1.19.0; unificado com a qualificação do MCK Mensagens na v1.20.0; fase 2 "inteligência" na v1.21.0)

Pré-vendas automática dentro do MCKBOT (menu **SDR com IA**, rota `/sdr`). Evolui o funil de leads automático
existente: o lead do SDR (`SdrLead`) liga-se ao contato do MCKBOT (`Contact`) e ao lead do MCK Mensagens (`Lead`)
da mesma pessoa; opt-out e consentimento valem nos dois lados. Lead só com e-mail (prospecção fria) também cabe.

## Quem tem
- Plano Completo ativo ou em teste (`planoCompletoAtivo`, mesma regra do ERP na 1.17.0), quando o Master deixa o
  plano ligado (padrão ligado). Só MCKBOT / só MCK Mensagens: desligado por padrão (Painel Master › SDR com IA).
- Sempre: empresa com um superadmin na equipe (empresa da MCK) ou listada em `SDR_ORG_IDS`, e o superadmin.
- Sem acesso: `/api/sdr` responde 402 com `code: SDR_PLANO` (exceto `/api/sdr/acesso`). Módulo de equipe: `sdr`.
- **Etapa de qualificação (v1.20.0, `qualificacaoAccess`):** quem tem o SDR (regra acima) **ou** o MCK Mensagens ativo/em
  teste configura e usa a qualificação das respostas de campanha, mesmo sem o Plano Completo (ninguém perde o que tinha).
  MCK Mensagens vencido/bloqueado: só consulta (salvar = 402, como antes). Sem nenhum dos dois: 402 `SDR_PLANO`.
  Proprietário/Admin com o módulo `sdr` **ou** `mensagens`. Os extras do SDR (captura, cadências, e-mail, reunião,
  rodízio, relatórios) seguem a regra do SDR. `/api/sdr/acesso` aceita também o módulo `mensagens` e devolve
  `qualificacao: { liberado, leitura, motivo }` e `modulo` (tem o módulo `sdr`).

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

## v2 (v1.19.0, sem migração)
Configurações novas guardadas no AuditLog da empresa (ação `sdr.v2.config`, a mais recente vale; `server/sdr/v2config.ts`),
editáveis em SDR › Configuração (`PUT /api/sdr/config` com `kanbanSync`, `rodizio`, `embedDomains`).
1. **Kanban do MCKBOT ↔ SDR** (`kanbanSync`, padrão ligado; `server/sdr/kanbanSync.ts`, `onKanbanStageChanged`):
   etapas casam pelo nome (Novo, Contatado/Em contato, Respondeu/Interessado, Qualificado, Reunião…/Demonstração,
   Ganho/Venda fechada, Perdido/Cancelado). SDR → Kanban em toda mudança de etapa do lead com contato ligado; automação
   só anda para a frente e nunca tira de Ganho/Perdido nem de "Aguardando atendente"; mudança manual no SDR pode voltar.
   Reunião sem etapa correspondente usa "Reunião agendada" (a da Agenda). Kanban → SDR quando a equipe arrasta no Kanban
   ou edita o contato (manual) e quando um fluxo muda a etapa (só para a frente). Nunca cria etapa. Histórico: evento KANBAN.
2. **Rodízio de leads** (`rodizio: { enabled, members }`): lead novo sem responsável (qualquer origem) recebe o próximo
   membro da lista, na ordem; o último dono do rodízio vem do evento `DONO`/`RODIZIO` (marca interna `[u:<id>]`, escondida
   na tela). Membro que saiu da equipe é pulado. `POST /api/sdr/rodizio/distribuir` reparte os leads abertos sem dono (500).
3. **Relatórios** (aba Relatórios; `GET /api/sdr/relatorio?dias=N` e `/relatorio.csv`, CSV com `;`, BOM e proteção contra
   fórmula): por cadência e por passo — leads, enviados, respondidos, agendados, descadastros, taxa de resposta. Resposta,
   reunião e descadastro contam uma vez por lead e cadência, para o último passo enviado antes. Envios gravam a marca
   `[c:<cadência>#<passo>]` no histórico; envios antigos (v1.18) usam a cadência atual do lead e o "dia N".
4. **Resposta por e-mail** (`server/sdr/inbound.ts`): `POST /api/public/sdr/email` no formato do Inbound parsing do Brevo
   (`{ items: [{ From, To, Recipients, Cc, Subject, ExtractedMarkdownMessage, RawTextBody, Headers, SpamScore }] }`).
   Desligado (404) sem `SDR_INBOUND_SECRET` (≥ 16 caracteres). Segredo por `Authorization: Bearer`, Basic (senha), cabeçalho
   `x-sdr-secret` ou `?token=`. Com `SDR_INBOUND_DOMAIN`, o e-mail do SDR sai com "Responder para"
   `sdr-<unsubToken>@<domínio>` e a resposta acha o lead pelo token; sem token, pelo remetente que já recebeu e-mail do SDR.
   Ignora resposta automática, falha de entrega e spam ≥ 5. "Descadastrar/remover/não quero mais receber" = opt-out.
   Para ligar (Mayck): domínio próprio com subdomínio de resposta (MX `inbound1/2.sendinblue.com`), webhook `inbound` no
   Brevo apontando para `https://<app>/api/public/sdr/email` com o segredo, e as duas variáveis no Render.
5. **Formulário incorporável**: `/f/<token>?embed=1` (código `<iframe>` copiável na Configuração). Só essa resposta troca
   `frame-ancestors 'none'` pelos sites permitidos (`embedDomains`; vazio = `https:`, qualquer site com HTTPS) e tira o
   X-Frame-Options; CSP sem script continua; mesma origem conferida no POST, campo-isca e limite por IP (10 envios/10 min).

## Unificação com a "IA de qualificação" do MCK Mensagens (v1.20.0, sem migração)
Um só produto para o cliente: **SDR com IA** (MCKBOT `/sdr` e MCK Mensagens `/mensagem/sdr`, mesmo componente
`web/src/pages/Sdr.tsx` com `app`). O menu antigo `/mensagem/ia-leads` redireciona para `/mensagem/sdr?aba=qualificacao`.
- **Aba Qualificação:** resumo das perguntas/pontuação 0–100 (editadas em Configuração) + "Respostas das campanhas"
  (`web/src/pages/sdr/Qualificacao.tsx`, ex-LeadAi.tsx). Quem tem só o MCK Mensagens vê só essa aba + convite ao Plano Completo.
- **Fonte única da configuração** (`server/sdr/qualificacao.ts`): AuditLog da empresa, ação `sdr.qualificacao.config`
  (a mais recente vale; formato do SDR: `campanhas, abordagem, proximoPasso, persona, positivo, negativo, duvida,
  tentativas, etiquetas`). Sem ela, a linha antiga `LeadAiSettings` é convertida em código (`fromLegacy`, lazy, nada é
  gravado); sem linha, os padrões de antes. Salvar (`PUT /api/sdr/qualificacao` ou a rota antiga
  `PUT /api/mckmensagem/ia-leads`) grava no AuditLog e **espelha** na `LeadAiSettings` daquela empresa, para uma volta
  de versão continuar igual. Nenhum campo/tabela antigo foi apagado. Mexer direto na `LeadAiSettings` pelo banco não
  vale mais depois que a empresa salvou pelo SDR.
- **Motor:** o das campanhas (`server/mckmensagem/qualificacao.ts`: POSITIVO/NEGATIVO/DÚVIDA/SAIR, ações, novas
  tentativas, etiquetas, prompt editável) foi mantido por baixo, lendo da fonte única (`getLeadAiSettings` →
  `getLegacyView`). Motivo: é um trabalho diferente do motor do SDR (responde campanha com intenção e ação vs. extração
  de respostas/pontuação e cadência) e há empresa em produção dependendo das mesmas mensagens; trocar o motor mudaria o
  que os leads recebem. Ligações novas: o resultado da campanha vai para o lead do SDR da mesma pessoa
  (`onCampaignQualified`: histórico QUALIFICACAO + etapa Qualificado/Respondeu, não cria lead nem envia nada), e a
  abordagem/próximo passo entram no prompt do SDR (`qualiPromptLines`). `setStage` automático compara com a etapa
  atual do banco (evita a corrida entre a qualificação da campanha e a resposta no WhatsApp).
- Rotas: `GET/PUT /api/sdr/qualificacao`, `POST /api/sdr/qualificacao/testar` (`server/sdr/qualificacaoRoutes.ts`);
  `/api/mckmensagem/ia-leads*` continuam (mesmas funções) para apps abertos antes do deploy.
- Testes: `tests/unit/sdr-qualificacao.test.ts` (mapeamento), `tests/integration/sdr-qualificacao.test.ts` (config antiga,
  fonte única, fluxo antigo, ponte para o SDR, acesso), `tests/integration/lead-ia.test.ts` (fluxo antigo).

## Fase 2 — Inteligência (v1.21.0, sem migração)
Aba **SDR › Inteligência** (`web/src/pages/sdr/Inteligencia.tsx`; bloco do lead `LeadInteligencia`). Rotas `GET/PUT /api/sdr/inteligencia`,
`GET /api/sdr/inteligencia/leads/:id` (explicação, resumo, CNPJ, intenção, melhor horário, horários livres),
`POST /api/sdr/inteligencia/leads/:id/cnpj`, `POST /api/sdr/inteligencia/leads/:id/noshow` (`server/sdr/intelRoutes.ts`, montado no sdrRouter: mesmo acesso do SDR).
- **Configuração** (`server/sdr/intelConfig.ts`): AuditLog `sdr.intel.config` (a mais recente vale). **Sem registro = tudo desligado**
  (empresas que já usam não mudam nada). Ao ligar o SDR pela 1ª vez (`PUT /api/sdr/config` com enabled false→true), `seedIntelForNewSetup`
  grava os padrões de configuração nova: liga só o que não envia nada sozinho (`cnpj`, `resumo`, `sentimento`, `optOutAuto`).
  Desligados sempre até a empresa ligar: `objecoes`, `followupIa`, `melhorHorario`, `reuniao.ofertaHorarios`, `reuniao.noShow`; `metodo` = PADRAO.
- **1) Método** (`server/sdr/intel.ts`): PADRAO (perguntas da empresa) | BANT (necessidade, orçamento, decisor, prazo) | SPIN (situação,
  problema, implicação, necessidade). `questionsFor` substitui `questionsOf` no prompt, na extração e na tela do lead. A extração pede também
  `motivo` por resposta (guardado no answersJson). `explainScore`: pontos por resposta (peso × nota / soma dos pesos), fortes (≥ 70),
  fracos (< 40), faltas e próxima ação.
- **2) Objeções**: biblioteca padrão (preço, fornecedor, agora não, manda por e-mail, vou pensar, não conheço), editável (até 20; gatilhos por
  vírgula). Ligada: orientações no prompt do SDR + a objeção da última mensagem do lead; evento `OBJECAO` no histórico.
- **3) CNPJ** (`server/sdr/cnpj.ts`): reaproveita `consultarCnpj` do ERP (BrasilAPI). Fontes: mensagem do lead, campo empresa do formulário e do
  cadastro manual, botão no lead. Cache em memória 24 h (falha 1 h, máx. 500), segundo plano, falha silenciosa. Evento `CNPJ` com JSON só da
  empresa (sem e-mail/telefone da Receita); preenche `company` se vazia.
- **4) Resumo do handoff** (`server/sdr/handoff.ts`): dor (necessidade/problema/implicação), orçamento, prazo, decisor, próximo passo. No lead,
  no aviso de lead quente (linhas extras no WhatsApp/e-mail da equipe) e no Kanban (`GET /api/kanban` → `contacts[].sdr`).
- **5) Follow-up pela IA** (`server/sdr/followup.ts`): `sendStep(..., { personalize })` reescreve o texto do passo com as últimas 12 mensagens e o
  resumo; respeita a cota diária da MCK IA; qualquer falha/texto ruim (placeholder, longo) = texto padrão; histórico "(personalizado pela IA)".
  **Melhor horário**: `bestSendHour` = hora em que o lead mais respondeu (mín. 2 respostas; senão 10h) dentro do horário comercial, no fuso da
  empresa (padrão America/Sao_Paulo); `runStep` adia para a próxima ocorrência em dia útil, no máximo ~1 dia depois da data do passo.
- **6) Reunião** (`server/sdr/meeting.ts`): `nextFreeSlots` (Agenda `freeSlots`, 7 dias, 3 horários); ligado, a IA propõe esses horários a leads
  mornos/quentes. "Não compareceu" (a Agenda não tem esse status): limpa `appointmentId`, evento `NOSHOW`, volta para Qualificado e, com a
  recuperação ligada, envia UMA mensagem (`{horarios}` + variáveis da cadência) pelo canal permitido (WhatsApp ou e-mail).
- **7) Intenção/sentimento e opt-out**: `detectIntent` (OPTOUT, SEM_INTERESSE, REUNIAO, COMPRA, PRECO, DUVIDA, OUTRO; POSITIVO/NEUTRO/NEGATIVO)
  por palavras, sem IA; evento `INTENCAO` só quando muda. `isOptOutPhrase` no inbound do WhatsApp quando `optOutAuto`: mesmo caminho do SAIR
  (contato optOut, lead do MCK Mensagens, automações do ERP e SDR).
- Testes: `tests/unit/sdr-intel.test.ts`, `tests/integration/sdr-intel.test.ts`.
- Fora desta fase: status "não compareceu" na própria Agenda (precisaria de tela da Agenda) e recuperação automática sem o vendedor marcar;
  classificação de intenção por IA (hoje por palavras, para não gastar cota).

## Para a v3
Modelos aprovados da Meta para WhatsApp fora da janela de 24 h; teste A/B de textos (dependem de aprovação externa /
ficaram fora da v2). Se o rodízio ou os relatórios ficarem pesados, levar a configuração do AuditLog para colunas próprias
numa migração aditiva.
