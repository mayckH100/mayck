# MCKBOT — Relatório de testes

Execução real em 25/10/2026, no sandbox de desenvolvimento (Linux ARM64, Node.js 22.23.3). Nenhum número abaixo foi estimado: todos saem dos logs em `docs/evidencias/`.

## 0. Atualização 28/10/2026 — Automações e Cobranças (fase 2)

Execução real no sandbox (Linux, Node.js 22.23.3, fuso do processo UTC), banco SQLite descartável: `npm test` → **24 arquivos, 229 testes aprovados / 0 reprovados**; `npm run typecheck` sem erros; `npm run build` concluído.

| Arquivo | Casos | O que prova |
|---|---|---|
| `tests/integration/cobrancas.test.ts` | 12 | upload com tipo real/tamanho/segurança (executável, PDF com JavaScript, extensão trocada, limite em MB), download só autenticado/admin e isolado por organização, exclusão só do dono e nunca de arquivo vinculado; boletos (lote de parcelas, vencido automático, status de envio ≠ financeiro, cliente com histórico financeiro não é excluído); **vários boletos em sequência** (mensagem N + boleto N, texto por mensagem, anexo geral + boleto, variáveis da parcela); boleto pago no meio não é cobrado e a sequência encerra quando tudo é pago; validação de anexos; **reenvio** só de vencido/pendente, nunca de pago, com máximo por boleto; **comprovante pelo WhatsApp** (vínculo com cliente/parcela, confiança, em análise sem baixa, duplicado, inconclusivo, idempotência, aprovação com responsável e auditoria); comprovante do operador e rejeição; **pagamento parcial**, quitação e **estorno** (só o dono); **envio real de anexos** pelo QR (Baileys recebe o PDF como documento; nova tentativa não repete o texto), e-mail com anexo e Cloud API com upload em `/media`; falha do WhatsApp e do e-mail registradas separadamente; relatórios, dashboard e calendário com números exatos e CSV; 402 com assinatura inativa |
| `tests/unit/cobrancas-rules.test.ts` | 9 | detecção de tipo pelo conteúdo, bloqueios de segurança, nome seguro; extração de valor/data/E2E Pix/instituição; leitura de texto de PDF (com e sem FlateDecode); identificação da parcela por valor e linha digitável; valor devido; variáveis do boleto; horários de reenvio no fuso |
| `tests/integration/automacoes.test.ts` | 14 | (fase 1) — o caso "recorrência mensal…" falhava conforme o dia em que rodava: o motor corretamente transforma "dia 31" no último dia de meses curtos, mas o teste exigia o mesmo número de dia em todos os meses. O teste agora calcula o dia esperado de cada mês (não era bug do motor). |

Limitações: não houve execução em PostgreSQL neste sandbox (sem servidor Postgres disponível) — a migração `0010_cobrancas_arquivos_comprovantes` foi gerada pelo `prisma migrate diff` a partir do schema da 0009 e contém só `CREATE TABLE`, `CREATE INDEX` e `ALTER TABLE … ADD COLUMN` (opcionais ou com padrão). E2E com Chromium não rodou (faltam bibliotecas do sistema no sandbox); as telas novas foram validadas por `tsc` e pelo build do Vite.

## 1. Resumo

| Suíte | Ferramenta | Banco | Resultado final | Evidência |
|---|---|---|---|---|
| Unitários (39) + integração (65) | Vitest 3 + Supertest | SQLite | **104 aprovados / 0 reprovados** | `evidencias/vitest-sqlite.txt` |
| Integração (65) | Vitest 3 + Supertest | **PostgreSQL 17** (migração real `prisma/migrations/0001_init`) | **65 aprovados / 0 reprovados** | `evidencias/vitest-postgres.txt` |
| Ponta a ponta (10) | Playwright 1.56 + Chromium headless | SQLite (servidor compilado `dist/`) | **10 aprovados / 0 reprovados** | `evidencias/playwright-e2e.txt` |
| Checagem de tipos | `tsc --noEmit` (servidor e web) | — | **sem erros** | `evidencias/typecheck.txt` |
| Smoke de produção | `npm run build` + `npm start` (NODE_ENV=production) | PostgreSQL 17 | migração aplicada, health ok, cadastro 201, cookie `HttpOnly`+`Secure`, CSRF 403, webhook com token errado 403 | `evidencias/smoke-producao-postgres.txt` |

**Total de casos distintos: 114** (39 unitários + 65 integração + 10 e2e) — todos aprovados na execução final; os 65 de integração foram aprovados **nos dois bancos**.

### Como reproduzir
```bash
npm install
npm test                                   # unitários + integração (SQLite)
DATABASE_URL=postgresql://... npm run test:pg   # integração em PostgreSQL (o banco é apagado e recriado!)
npx playwright install chromium && npm run test:e2e
npm run typecheck
```

## 2. O que os testes cobrem

- **Unitários:** criptografia AES-256-GCM (adulteração, chave errada, tamanho da chave), gatilhos (palavra-chave com acentos, igual/contém, primeira mensagem, horário com fuso e janela que cruza a meia-noite), condições (9 operadores, E/OU), menu, validação de respostas, grafo e validação, templates de variáveis, RAG (tokenização, fragmentação, ranking), regras anti-invenção de preço, provedor fake determinístico e recusa fora de teste, assinatura `X-Hub-Signature-256`, parsing de webhook, corpo das mensagens da Graph API, retries (5xx repete, 4xx não, rede esgota tentativas), proteção SSRF.
- **Integração (API + banco):** cadastro/login/logout, cookie httpOnly/SameSite, bcrypt, CSRF, rate limit de login e de webhook, troca de senha, **isolamento entre organizações** (listas e acesso por id → 404), **RBAC** (atendente/admin/dono), convites de uso único, auditoria, **webhook simulado** (verificação GET, assinatura inválida/ausente, recebimento, idempotência sequencial e concorrente, status sent→delivered→read sem regressão, retries, erro definitivo, janela de 24h e modelo, canal não conectado nunca envia, verificação real de credenciais, segredos não vazam, opt-out), **motor de fluxos** (primeira mensagem, prioridade de gatilho, perguntar/validar/salvar, condição sim/não, menu inválido/válido, transferência para humano, aguardar + agendador, limite de passos, duplicidade, versionamento, ativar/pausar/duplicar/excluir, estatísticas por bloco, HTTP com mapeamento/erro/SSRF, disparo manual, falha de envio), **IA** (chave cifrada, desativada, RAG, preço da base, pergunta sensível sem base, preço inventado bloqueado, palavra de transferência, falha do provedor + fallback, limite diário, bloco IA no fluxo, teste e uso), **CRM/LGPD** (CRUD, filtros, importação, Kanban, exportar e apagar), **painel e relatórios** com números exatos.
- **E2E:** cadastro → painel; todas as 13 páginas do menu; canal "Não conectado"; contato + Kanban; editor visual (adicionar bloco, salvar versão, ativar); IA + base de conhecimento; convite, relatórios e auditoria; layout de celular; logout/login; zero erros de JavaScript no console.

## 3. Resultado por teste (execução final)

#### `tests/unit/crypto.test.ts` (6 testes)

| Teste | Resultado |
|---|---|
| Criptografia AES-256-GCM > cifra e decifra mantendo o texto original | Aprovado |
| Criptografia AES-256-GCM > gera IV aleatório (mesmo texto → cifras diferentes) | Aprovado |
| Criptografia AES-256-GCM > rejeita dado adulterado (tag de autenticação) | Aprovado |
| Criptografia AES-256-GCM > rejeita chave mestra errada | Aprovado |
| Criptografia AES-256-GCM > exige chave mestra de 32 bytes | Aprovado |
| Criptografia AES-256-GCM > mascara segredos e compara em tempo constante | Aprovado |

#### `tests/unit/flow-logic.test.ts` (14 testes)

| Teste | Resultado |
|---|---|
| Gatilhos > palavra-chave "contém" ignora acentos e maiúsculas | Aprovado |
| Gatilhos > palavra-chave "igual" exige mensagem inteira | Aprovado |
| Gatilhos > aceita várias palavras separadas por vírgula | Aprovado |
| Gatilhos > primeira mensagem só casa quando é a primeira | Aprovado |
| Gatilhos > mensagem recebida casa qualquer texto e perde para palavra-chave | Aprovado |
| Gatilhos > horário respeita dias e janela no fuso da organização | Aprovado |
| Condições > operadores básicos | Aprovado |
| Condições > gt/lt com valor não numérico retorna falso | Aprovado |
| Condições > lógica "todas" e "qualquer" | Aprovado |
| Menu e validação de respostas > casa por número, rótulo e id do botão | Aprovado |
| Menu e validação de respostas > valida tipos de resposta | Aprovado |
| Grafo > segue a saída correta | Aprovado |
| Grafo > validação aponta problemas | Aprovado |
| Templates de variáveis > substitui variáveis e caminhos | Aprovado |

#### `tests/unit/ai.test.ts` (9 testes)

| Teste | Resultado |
|---|---|
| RAG > tokeniza sem acentos e sem stopwords | Aprovado |
| RAG > fragmenta textos longos | Aprovado |
| RAG > ranqueia o trecho mais relevante primeiro | Aprovado |
| Regras anti-invenção > detecta perguntas sobre preço/política | Aprovado |
| Regras anti-invenção > bloqueia preço que não está no contexto e aceita o que está | Aprovado |
| Regras anti-invenção > o prompt de sistema contém as regras e o contexto | Aprovado |
| Provedores de IA > provedor fake é determinístico | Aprovado |
| Provedores de IA > fábrica exige chave e escolhe o provedor | Aprovado |
| Provedores de IA > provedor fake é recusado fora do ambiente de teste | Aprovado |

#### `tests/unit/whatsapp.test.ts` (10 testes)

| Teste | Resultado |
|---|---|
| Assinatura X-Hub-Signature-256 > aceita assinatura correta | Aprovado |
| Assinatura X-Hub-Signature-256 > rejeita assinatura errada, ausente ou malformada | Aprovado |
| Parsing do webhook > extrai mensagens de texto, respostas interativas e status | Aprovado |
| Parsing do webhook > ignora objetos que não são do WhatsApp | Aprovado |
| Cliente da Cloud API > monta corpos de texto, mídia, botões e modelo | Aprovado |
| Cliente da Cloud API > repete em 5xx e devolve o id da Meta | Aprovado |
| Cliente da Cloud API > não repete em erro 4xx (exceto 429) | Aprovado |
| Cliente da Cloud API > desiste após o máximo de tentativas em falha de rede | Aprovado |
| Proteção SSRF > identifica endereços privados | Aprovado |
| Proteção SSRF > bloqueia localhost, IP interno e protocolos não HTTP | Aprovado |

#### `tests/integration/auth.test.ts` (7 testes)

| Teste | SQLite | PostgreSQL 17 |
|---|---|---|
| Autenticação e sessão > cadastro cria usuário, organização (dono), etapas do Kanban e cookie httpOnly | Aprovado | Aprovado |
| Autenticação e sessão > rejeita senha curta e e-mail duplicado | Aprovado | Aprovado |
| Autenticação e sessão > login correto, senha errada e logout | Aprovado | Aprovado |
| Autenticação e sessão > CSRF: bloqueia mutações sem X-Requested-With ou com token errado | Aprovado | Aprovado |
| Autenticação e sessão > rotas protegidas exigem login | Aprovado | Aprovado |
| Autenticação e sessão > rate limit no login devolve 429 após o limite | Aprovado | Aprovado |
| Autenticação e sessão > troca de senha exige a atual e encerra outras sessões | Aprovado | Aprovado |

#### `tests/integration/isolation-rbac.test.ts` (10 testes)

| Teste | SQLite | PostgreSQL 17 |
|---|---|---|
| Isolamento entre organizações > organização B não vê listas da A | Aprovado | Aprovado |
| Isolamento entre organizações > organização B recebe 404 ao acessar ou alterar recursos da A por id | Aprovado | Aprovado |
| Isolamento entre organizações > não permite trocar para organização da qual não é membro | Aprovado | Aprovado |
| Isolamento entre organizações > não permite mover contato para etapa de outra organização | Aprovado | Aprovado |
| Permissões (RBAC) > atendente usa Inbox/Contatos mas não edita fluxos, IA, canais ou equipe | Aprovado | Aprovado |
| Permissões (RBAC) > admin edita fluxos mas não altera papéis; dono altera e não pode ser removido | Aprovado | Aprovado |
| Permissões (RBAC) > membro removido perde o acesso à organização | Aprovado | Aprovado |
| Permissões (RBAC) > convite: link de uso único e conta existente precisa estar logada | Aprovado | Aprovado |
| Permissões (RBAC) > registra logs de auditoria das ações | Aprovado | Aprovado |
| Login inexistente > responde igual para e-mail inexistente | Aprovado | Aprovado |

#### `tests/integration/webhook.test.ts` (15 testes)

| Teste | SQLite | PostgreSQL 17 |
|---|---|---|
| Webhook WhatsApp Cloud API (payloads simulados) > GET de verificação devolve o challenge com token correto | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > GET de verificação recusa token errado ou canal inexistente | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > POST com assinatura inválida é rejeitado (401) e nada é gravado | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > POST sem cabeçalho de assinatura é rejeitado | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > mensagem válida cria contato, conversa e mensagem recebida | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > idempotência: o mesmo message id reenviado não duplica mensagem | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > idempotência sob concorrência: reenvios simultâneos geram uma só mensagem | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > atualizações de status avançam (sent→delivered→read) e não regridem | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > envio com falhas temporárias (500, 500) faz novas tentativas e conclui | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > erro definitivo da Meta (400) marca a mensagem como FAILED sem repetir | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > fora da janela de 24h só permite modelo (template) | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > canal sem credenciais fica "não conectado" e nunca simula envio | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > verificação de credenciais consulta a Graph API e só então marca CONNECTED; segredos não vazam | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > rate limit do webhook devolve 429 acima do limite | Aprovado | Aprovado |
| Webhook WhatsApp Cloud API (payloads simulados) > opt-out ("SAIR") bloqueia mensagens automáticas ao contato | Aprovado | Aprovado |

#### `tests/integration/flows.test.ts` (14 testes)

| Teste | SQLite | PostgreSQL 17 |
|---|---|---|
| Motor de fluxos (integração com banco e webhook) > primeira mensagem dispara o fluxo de boas-vindas; a segunda não | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > palavra-chave tem prioridade sobre primeira mensagem e coleta variáveis com validação | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > ramo "não" da condição | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > menu: opção inválida reenvia, opção válida segue o ramo; "Vendas" transfere para humano | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > bloco Aguardar pausa e o agendador retoma depois do tempo | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > proteção contra loop encerra a execução com FAILED no limite de passos | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > duplicidade: mesma mensagem reenviada não inicia o fluxo duas vezes | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > versionamento: salvar cria nova versão; execução em andamento usa a versão em que começou | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > ativar fluxo inválido é recusado; pausar cancela execuções; duplicar e excluir funcionam | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > estatísticas por bloco e histórico de execuções | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > bloco HTTP: mapeia JSON para variáveis, segue ramo de erro e bloqueia rede interna (SSRF) | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > disparo manual pelo Inbox ("Enviar fluxo") retoma o modo robô | Aprovado | Aprovado |
| Motor de fluxos (integração com banco e webhook) > falha no envio (canal desconectado) marca a execução como FAILED | Aprovado | Aprovado |
| Agendador econômico > scheduledTick não executa nada antes do vencimento e retoma depois | Aprovado | Aprovado |

#### `tests/integration/ai.test.ts` (13 testes)

| Teste | SQLite | PostgreSQL 17 |
|---|---|---|
| IA (provedor fake determinístico) > chave da IA é salva cifrada e nunca devolvida em texto puro | Aprovado | Aprovado |
| IA (provedor fake determinístico) > provedor "fake" é aceito na configuração apenas em NODE_ENV=test | Aprovado | Aprovado |
| IA (provedor fake determinístico) > IA desativada não responde | Aprovado | Aprovado |
| IA (provedor fake determinístico) > responde com base na base de conhecimento (RAG) e registra uso | Aprovado | Aprovado |
| IA (provedor fake determinístico) > preço presente na base pode ser citado | Aprovado | Aprovado |
| IA (provedor fake determinístico) > pergunta de preço/política sem base relevante → não inventa e transfere para humano | Aprovado | Aprovado |
| IA (provedor fake determinístico) > resposta do modelo com preço inventado é bloqueada | Aprovado | Aprovado |
| IA (provedor fake determinístico) > palavra de transferência ("atendente") faz handoff imediato | Aprovado | Aprovado |
| IA (provedor fake determinístico) > falha do provedor → nova tentativa, fallback e handoff, com erro registrado | Aprovado | Aprovado |
| IA (provedor fake determinístico) > limite diário de uso: ao atingir, não chama o provedor e transfere | Aprovado | Aprovado |
| IA (provedor fake determinístico) > bloco IA dentro de um fluxo com saída de transferência | Aprovado | Aprovado |
| IA (provedor fake determinístico) > endpoint de teste da IA mostra as fontes usadas | Aprovado | Aprovado |
| IA (provedor fake determinístico) > editar documento reindexa os trechos; uso agregado disponível | Aprovado | Aprovado |

#### `tests/integration/crm-dashboard.test.ts` (6 testes)

| Teste | SQLite | PostgreSQL 17 |
|---|---|---|
| Contatos/CRM, Kanban e LGPD > cria, busca, edita e filtra contatos por etiqueta; normaliza telefone brasileiro | Aprovado | Aprovado |
| Contatos/CRM, Kanban e LGPD > importa contatos em lote (CSV) informando erros por linha | Aprovado | Aprovado |
| Contatos/CRM, Kanban e LGPD > Kanban: mover contato entre etapas e gerenciar colunas | Aprovado | Aprovado |
| Contatos/CRM, Kanban e LGPD > LGPD: exporta todos os dados do contato e apaga definitivamente | Aprovado | Aprovado |
| Painel e relatórios com dados reais do banco > indicadores refletem exatamente o que aconteceu | Aprovado | Aprovado |
| Painel e relatórios com dados reais do banco > plano e uso | Aprovado | Aprovado |

#### `tests/e2e/app.spec.ts` — Playwright/Chromium (10 testes)

| Teste | Resultado | Duração |
|---|---|---|
| cadastro leva ao painel com indicadores zerados e aviso de WhatsApp não conectado | Aprovado | 1.2s |
| todas as páginas do menu abrem sem erro | Aprovado | 817ms |
| canal WhatsApp novo aparece como "Não conectado" com URL de webhook | Aprovado | 510ms |
| cria e edita contato; aparece no Kanban | Aprovado | 918ms |
| cria fluxo no editor visual, adiciona bloco, salva nova versão e ativa | Aprovado | 997ms |
| configura IA e adiciona documento à base de conhecimento | Aprovado | 620ms |
| equipe gera link de convite; relatórios e auditoria mostram dados reais | Aprovado | 670ms |
| layout responsivo no celular (menu recolhível) | Aprovado | 1.0s |
| logout e login novamente; senha errada mostra erro | Aprovado | 1.1s |
| nenhum erro de JavaScript no console durante a navegação | Aprovado | 4ms |

## 4. Falhas encontradas durante o desenvolvimento e correções

Cada item abaixo aconteceu de verdade em uma execução anterior; a execução final (seção 3) já inclui a correção.

- [auth] "rate limit no login devolve 429": 1ª execução falhou (expected [401,401,429] to equal [401,401,401]). Causa: o cadastro usa o mesmo limitador (chave IP+e-mail) e consumiu 1 tentativa. Correção: no teste, o limite passou a considerar o cadastro (limite 4 = 1 cadastro + 3 logins). Produto sem alteração.
- [flows] "palavra-chave tem prioridade… coleta variáveis": falhou porque a expectativa ignorava que o bloco Perguntar registra uma etapa ao perguntar e outra ao receber a resposta. Comportamento do produto mantido (é o desejado para auditoria); expectativa corrigida.
- [flows] "bloco HTTP… SSRF": falhou porque a proteção SSRF fazia DNS real e o domínio fictício não resolve no sandbox (resposta enviada foi o ramo de erro). Correção no produto: resolvedor DNS injetável apenas em NODE_ENV=test e mensagem clara "Não foi possível resolver o domínio" quando o DNS falha. Teste ampliado: domínio que resolve para IP privado também é bloqueado.
- [ia] "bloco IA dentro de um fluxo com saída de transferência": falhou porque o provedor fake (dublê de teste) tratava o marcador "(nenhuma informação relevante…)" como contexto e respondia em vez de pedir transferência. Correção no FakeProvider (só existe em teste). Lógica de produção não mudou.
- [e2e/infra] Playwright não detectava o servidor (webServer timeout): o sandbox tem proxy HTTP configurado e as checagens de 127.0.0.1 passavam pelo proxy (404). Correção: script test:e2e define NO_PROXY=127.0.0.1,localhost; porta trocada para 4319 (a 3100 já estava ocupada por outro processo).
- [e2e] "cria e edita contato": seletor ambíguo (botão "Abrir" x "Abrir menu"). Correção do teste: exact: true.
- [webhook, só no PostgreSQL] "atualizações de status avançam": falhou no Postgres (63/64) e passou no SQLite. Causa: o mock da Graph API gerava ids "wamid.OUT1, OUT2…" reiniciados a cada arquivo de teste; o teste buscava a mensagem por waMessageId sem filtrar canal e o Postgres devolveu outra linha. Correção no mock: ids únicos globais (como os reais da Meta). Produto sem alteração (a unicidade real é por canal + id).

- [execução] Na rodada final, a suíte SQLite foi disparada **ao mesmo tempo** que a suíte PostgreSQL. O script `test:pg` regenera o cliente Prisma para PostgreSQL e isso quebrou a rodada SQLite em andamento (10 reprovados, 54 não executados, erro "Environment variable not found: DATABASE_URL"). Não é defeito do produto: as duas suítes não podem rodar em paralelo no mesmo diretório. A rodada foi repetida isoladamente (104/104). O log inválido foi mantido como `evidencias/vitest-sqlite-INVALIDA-execucao-paralela.txt` por transparência.

Correções de produto feitas fora de falhas de teste (achadas em revisão visual ou de requisitos):
- Botão de menu móvel aparecia no desktop (precedência de CSS) — corrigido.
- Bloco novo no editor surgia fora da área visível — agora é posicionado ao lado do bloco selecionado e a visão é enquadrada.
- Modelo padrão da IA `gemini-2.0-flash` foi **desligado pelo Google em 01/06/2026** — padrão trocado para `gemini-3.5-flash-lite`.
- Versão padrão da Graph API `v21.0` expira em 21/01/2027 — padrão trocado para `v26.0`.
- O health check consultava o banco e o agendador consultava a cada 5 s, o que impediria o Neon gratuito de escalar a zero — health check leve (`/api/health`), checagem completa em `/api/health/db` e agendador que só consulta o banco quando há espera pendente (teste "Agendador econômico" adicionado).

## 5. Limitações dos testes (o que NÃO foi provado)

- **Nenhuma conexão real com a Meta foi feita.** Toda a Graph API foi simulada com um `fetch` falso **apenas em `NODE_ENV=test`** (o código de produção recusa a troca do `fetch`). Formato dos payloads segue a documentação oficial, mas só um número real conectado confirma a integração de ponta a ponta.
- **Nenhum provedor de IA real foi chamado.** Gemini e OpenAI foram testados só na montagem (fábrica de provedores); as respostas vieram do provedor fake determinístico. O formato das requisições segue a documentação, mas não foi validado contra as APIs reais.
- **Docker não estava disponível** no sandbox: o `Dockerfile` não foi construído nem executado. O `render.yaml` não foi aplicado (nenhuma conta foi criada).
- E2E rodou apenas no Chromium (sem Firefox/WebKit) e com SQLite; o PostgreSQL foi coberto pelas suítes de integração e pelo smoke de produção.
- Não há testes de carga/desempenho nem de acessibilidade automatizados.
- O DNS do bloco HTTP é simulado nos testes (o sandbox não resolve domínios fictícios); a proteção SSRF com IP literal é testada sem simulação.
- O rate limit usa memória do processo: com mais de uma instância seria preciso um armazenamento compartilhado (no plano grátis há uma única instância).
