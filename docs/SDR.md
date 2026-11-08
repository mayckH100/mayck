# SDR com IA (v1.18.0; v2 na v1.19.0; unificado com a qualificação do MCK Mensagens na v1.20.0; fase 2 "inteligência" na v1.21.0; respostas automáticas na v1.22.0)

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

## Respostas automáticas (v1.22.0, sem migração)
Resposta automática do lead não é resposta: não qualifica, não pontua, não muda etapa (SDR, Kanban, lead do MCK Mensagens),
não para a cadência, não vira opt-out nem objeção, e a IA/fluxos não respondem (evita robô conversando com robô).
Vale para **todas** as empresas, ligado por padrão (inclusive quem já usa).
- **Detector local, sem IA** (`server/sdr/autoReply.ts`, `detectAutoReply(texto, ctx)` → `{ automatica, confianca, motivo, pontos, humano }`):
  padrões PT-BR/EN/ES com peso e categoria — *sistema* (declara "mensagem automática", menu "digite 1"/linhas numeradas,
  "notificações silenciadas", app de auto-resposta), *empresa* (agradece o contato, retornaremos, horário de atendimento,
  "não atendemos chamadas", "pedimos que envie", "agradecemos a compreensão", out of office...), *pessoal* (estou dirigindo,
  no trânsito, em reunião/atendimento/cirurgia/plantão, de férias/viajando até, não posso falar agora, Não Perturbe/Modo Foco)
  — mais sinais: tempo desde o nosso envio (≤ 15 s +2, ≤ 60 s +1), repetição do mesmo texto do mesmo contato (+3/+4),
  formatação de saudação (*negrito* várias vezes, ⚠️), frases extras da empresa (+6), cabeçalhos `Auto-Submitted`,
  (o sinal de tempo não vale em conversa em andamento — o contato escreveu nos 30 min antes do nosso envio —, porque aí
  responder rápido é normal),
  `X-Autoreply`, `Precedence: auto_reply` e assunto de ausência no e-mail. Automática com ≥ 4 pontos; confiança
  alta ≥ 6, média 3–5, baixa < 3. **Trava de pessoa:** com sinal claro de pessoa ("tenho interesse", "me manda o valor",
  "pode me ligar", "quanto custa", pergunta sobre a empresa como "qual o horário de atendimento?") só é automática com sinal de sistema, texto repetido longo ou saudação de empresa
  muito forte (≥ 7 pontos de empresa). Ex.: "Estou em reunião, mas tenho interesse, me manda o valor" = humano.
- **WhatsApp** (`server/whatsapp/inbound.ts` + `server/sdr/autoReplyService.ts`): só mensagens de texto que chegam quando a
  empresa enviou algo para a conversa nos últimos 7 dias (quem chama primeiro nunca é marcado). Verificada ANTES de gravar,
  dentro da trava do contato (sem corrida com a qualificação de campanha nem com a extração do SDR em segundo plano).
  A mensagem é gravada com `Message.error = "AUTORESPOSTA: <motivo>"` (campo sem uso em recebidas; sem migração), ganha nota
  de sistema no Inbox e evento `AUTORESPOSTA` nos leads do SDR da mesma pessoa. Não roda: opt-out, `onLeadInbound` (lead da
  campanha segue "Contatado"), `sdrOnInbound`, `qualifyLeadInbound`, fluxos/IA. `contact.lastMessageAt` não muda.
  Os históricos que a IA lê (resposta da IA, qualificação de campanha, extração do SDR, follow-up personalizado e melhor
  horário) filtram as marcadas (`notAutoReply`).
- **E-mail** (`server/sdr/inbound.ts`): falha de entrega/spam continua `ignorado`; cabeçalho, assunto ou texto de
  ausência com lead encontrado → `automatica` + evento `AUTORESPOSTA` (canal EMAIL); a cadência segue.
- **Configuração** (`server/sdr/autoReplyConfig.ts`): AuditLog `sdr.autoresposta.config` (o mais recente vale; sem registro =
  `{ enabled: true, frases: [], acao: 'SEGUIR', pausaHoras: 24, iaDuvida: false }`). Editada em SDR › Inteligência
  (`GET/PUT /api/sdr/inteligencia` → `autoResposta`). `acao: 'PAUSAR'` adia o próximo passo da cadência em `pausaHoras`
  (1–168; nunca adianta). `iaDuvida` (desligado): na faixa média, sem sinal de pessoa, pergunta à MCK IA "AUTO/HUMANO"
  respeitando a cota diária; sem cota/falha vale o detector.
- **Visível:** selo "🤖 Resposta automática" na mensagem do Inbox; evento no histórico do lead; contador na aba Relatórios
  (`respostasAutomaticas: { total, whatsapp, email }` em `GET /api/sdr/relatorio`).
- Testes: `tests/unit/sdr-autoresposta.test.ts` (exemplos reais típicos e falsos positivos), `tests/integration/sdr-autoresposta.test.ts`
  (caso real da clínica sem resposta da IA, cadência que segue, pausa, humano depois, desligado, e-mail).
- Fora: aba Inteligência só aparece para quem tem o SDR completo (quem tem só o MCK Mensagens fica com o padrão ligado, sem tela
  para frases/pausa); o CSV dos relatórios não traz o contador; mensagens de áudio/imagem não são analisadas.

## IA conversacional avançada (v1.26.0, sem migração)
Interruptor em SDR › Inteligência › "IA conversacional avançada" (AuditLog `sdr.intel.config`, campo `conversa: { enabled, autoverificacao, handoff }`). Registro antigo sem o campo = desligado (quem já usava não muda nada); configuração nova (`NEW_SETUP_INTEL`) liga. Vale só em conversas com lead do SDR ou de campanha (e no "Testar"); atendimento comum do MCKBOT não muda. Código: `server/sdr/conversa.ts` (puro) e `server/sdr/conversaService.ts`; ligado em `generateAiReply` (`server/ai/service.ts`) e em `qualifyLeadInbound` (`server/mckmensagem/qualificacao.ts`).
1. **Contexto rico:** nome, empresa, Receita (evento CNPJ), etapa/pontuação/temperatura, respostas já dadas ("nunca pergunte de novo"), o que falta, objeções (eventos OBJECAO), campanha de origem, resumo; histórico de 30 mensagens (antes 10; campanhas 9), sem respostas automáticas.
2. **Estilo WhatsApp:** regras no prompt + `polirResposta` (sem IA): tira frases de robô, emoji quando a empresa não usa (Instruções/tom), nome repetido quando já usado nas últimas 3 respostas.
3. **Planejamento:** a IA escreve `[PLANO: intencao=…; objetivo=RESPONDER|QUALIFICAR|TRATAR_OBJECAO|AGENDAR|PASSAR_VENDEDOR]` na 1ª linha (objetivo sugerido pelo código + guia do método Padrão/BANT/SPIN); `extrairPlano` retira antes de qualquer outro marcador. Campanhas: sem plano (saída JSON).
4. **Guardrails:** regras de segurança no prompt + `verificarResposta` local: > 500 caracteres, > 1 pergunta, frase de robô, valor/%/prazo que não aparece como valor nas fontes (prompt + conversa), CPF/cartão/chave/e-mail/telefone fora das fontes, nome de provedor de IA. Problema → no máximo 1 nova tentativa com a crítica (`cotaPermiteExtra`: MCK IA ≥ 10% e > 5 restantes; limite diário da empresa com folga; nunca se a resposta já agendou/registrou pedido). Grave persistente → `TEXTO_ESPECIALISTA` + nota "Tarefa para a equipe" + evento TAREFA; leve → `ajusteMecanico`. Erro na nova tentativa para a empresa (MCK IA): "MCK IA indisponível no momento".
5. **Handoff inteligente** (`conversa.handoff`): irritação, dúvida fora das Instruções, plano PASSAR_VENDEDOR, lead quente (compra/QUENTE, salvo se agendou) e pedido de atendente → `handoff: true` com motivo + resumo do lead (`resumoHandoff`) → `handoffToHuman` (nota + Números de aviso); evento HANDOFF. Campanhas: pedido de pessoa/irritação sem chamar a IA; dúvida fora das Instruções passa ao vendedor.
6. **Avaliação:** `tests/fixtures/conversas-avaliacao.ts` (10 conversas fictícias, 8 critérios automáticos), `tests/unit/sdr-conversa-avaliacao.test.ts`, relatório `npx tsx scripts/avaliar-conversa.ts` → docs/AVALIACAO_IA_CONVERSA.md (antes 1/10, depois 10/10 conversas em todos os critérios; respostas do modelo fixas, mede as regras do código, não um modelo real).
Testes: tests/unit/sdr-conversa.test.ts, tests/integration/sdr-conversa.test.ts.

## Para a v3
Modelos aprovados da Meta para WhatsApp fora da janela de 24 h; teste A/B de textos (dependem de aprovação externa /
ficaram fora da v2). Se o rodízio ou os relatórios ficarem pesados, levar a configuração do AuditLog para colunas próprias
numa migração aditiva.
