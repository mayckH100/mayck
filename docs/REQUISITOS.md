# MCKBOT — Requisitos e diferenças em relação à referência (BotZap)

Fonte da análise da referência: leitura somente-leitura do painel BotZap (organização MCKIPTV) feita em 25/10/2026. Nada foi copiado de marca, textos de marketing ou código; foi reproduzido apenas o **comportamento observável**, com identidade própria (nome, logo SVG, cores, textos).

## 1. Objetivo

SaaS multi-organização para automatizar atendimento no WhatsApp usando **exclusivamente a API oficial (WhatsApp Cloud API da Meta)**, com fluxos visuais, Inbox humano, Kanban, CRM, IA com base de conhecimento e relatórios — hospedável em plano gratuito.

## 2. Mapa módulo a módulo

| Módulo da referência | Comportamento observado no BotZap | Como ficou no MCKBOT | Diferença |
|---|---|---|---|
| **Visão geral** | Mensagens hoje, fluxos ativos, tempo médio de resposta ("Em breve"), dispositivos, contatos, mensagens 7 dias; banner de bloqueio | Painel com dados reais do banco: conversas abertas/aguardando humano/encerradas, mensagens recebidas/enviadas/falhas (24h e 7d), fluxos ativos, **taxa de sucesso das execuções**, **falhas recentes** (execuções e mensagens), **status de cada integração** (WhatsApp, IA, parceiros), **uso de IA**, tempo médio da 1ª resposta | Tempo de resposta implementado (não "em breve"); banner honesto de "WhatsApp não conectado" |
| **Perfil** | E-mail somente leitura, nome, WhatsApp, troca de senha (mín. 6) | Igual + senha mínima de 8, troca de senha encerra as outras sessões, dados da organização (nome e fuso horário) | Mais seguro; organização editável |
| **Dispositivos** | Pareamento multi-device (QR/pair code, motor não oficial), card com status, estatísticas Hoje/7d/30d/Total, Reiniciar, Diagnósticos (JSON), Configurações | **Canais WhatsApp** pela **Cloud API oficial**: Phone Number ID, WABA ID, token de acesso e App Secret (cifrados), URL de webhook por canal + token de verificação, botão **Verificar conexão** (consulta real à Graph API), estatísticas Hoje/7d/30d/Total, diagnóstico (último webhook, último erro, versão da API), desconectar, excluir | **Mudança de tecnologia**: API oficial em vez de pareamento não oficial (sem risco de banimento por automação não autorizada). Status fica "Não conectado" até a verificação real passar |
| **Fluxos (lista)** | Busca, importar JSON, novo fluxo, seleção múltipla, exportar/excluir, status | Busca, importar/exportar JSON, novo, ativar/pausar, duplicar, excluir, **versão atual**, **contagem de execuções por resultado** | Sem seleção em massa (ações por linha); acrescenta duplicar e versão |
| **Editor de fluxos** | React Flow; gatilhos mensagem recebida / palavra-chave (contém/igual) / primeira mensagem / webhook HTTP; blocos Condição, Ação·tag, Mensagem (9 tipos), HTTP JSON com mapeamento, Espera, Aguardar resposta; contadores ok/alerta/erro por nó | React Flow; gatilhos **mensagem recebida, palavra-chave (contém/igual, várias palavras), primeira mensagem, horário (dias + janela no fuso da org)**; blocos **Enviar texto, Enviar mídia (imagem/vídeo/documento/áudio), Menu de opções (texto numerado ou botões), Perguntar e salvar variável (validação texto/número/e-mail/telefone), Condição (9 operadores, E/OU), Resposta com IA, Aguardar, Webhook HTTP (mapeamento JSON→variáveis, Testar requisição, integração com credencial cifrada), Etiqueta/etapa do Kanban, Transferir para humano, Encerrar**; contadores ok/alerta/erro por bloco; validação antes de ativar; **versionamento com restauração**; **histórico de execuções com cada etapa** | Gatilho "Webhook HTTP" de entrada não implementado (substituído por "Horário"); figurinha, localização, vCard e enquete não implementados no envio; acrescenta bloco de IA, transferência, versionamento, prioridade e proteção contra loop |
| **Inbox** | Abertas/Finalizadas, busca, Kanban inline, Finalizar, rótulos Automação/Você, aviso de janela de 24h, enviar fluxo, anexar, áudio | Abertas / **Aguardando humano** / Encerradas, busca, etapa do Kanban inline, Assumir, Devolver ao robô, Encerrar/Reabrir, rótulos Automação/IA/Atendente/Sistema, status de entrega (enviada/entregue/lida/falhou com motivo), **notas internas**, **Enviar fluxo**, bloqueio fora da janela de 24h com **envio de modelo aprovado** | Sem gravação de áudio e sem upload de arquivo (envio de mídia por URL via fluxo/API); atualização por polling (5–8 s), sem WebSocket |
| **Kanban** | Colunas Sem coluna/Novo/Em atendimento/Qualificado/Ganho, arrastar, busca, 6 ordenações, editar coluna, abrir conversa | Igual (arrastar e soltar + seletor "Mover para" acessível), colunas padrão Novo/Em atendimento/Qualificado/Ganho/Perdido, criar/renomear/recolorir/excluir colunas, 6 ordenações, abrir conversa | Seletor de dispositivo removido (canal é por conversa) |
| **Integração de parceiro (PlusTV)** | Página proprietária por parceiro: credenciais, variáveis {{…}}, modelos, importação de clientes | **Integrações** genéricas: nome, URL base, cabeçalho de autenticação com valor cifrado, botão Testar; usadas pelo bloco Webhook HTTP sem expor a chave no fluxo. Importação de contatos em lote fica em **Contatos** | Genérico (qualquer API) em vez de um parceiro específico; sem notificações de vencimento pré-prontas |
| **Assinatura/Planos** | Trial, 3 planos com PIX, add-ons | Página **Plano** com plano atual e uso dos limites (números, membros, fluxos), limites aplicados (ex.: convites) | **Sem cobrança**: não há meio de pagamento integrado (requisito: não contratar nem pagar nada). Sem botão de assinatura decorativo |
| **Equipe** | Convite por e-mail, papéis Proprietário/Admin/Membro | Papéis **Proprietário / Administrador / Atendente** com RBAC aplicado no servidor; convite gera **link de uso único (7 dias)** para copiar; alterar papel (só proprietário), remover, cancelar convite | Sem envio de e-mail (não há SMTP configurado — o link é exibido honestamente) |
| Guia do WhatsApp | Páginas educativas | **Boas práticas**: janela de 24h, qualidade do número, modelos, IA responsável, LGPD | Conteúdo voltado à API oficial |
| — (não existe) | IA só como campo `openai_apikey` no JSON do dispositivo | **Inteligência artificial**: provedor (Gemini ou OpenAI/compatível), modelo, URL base, chave cifrada, instruções, tom, temperatura, máx. tokens, limites diário/mensal, palavras de transferência, mensagem de fallback, resposta automática quando nenhum fluxo dispara, **base de conhecimento com RAG**, **testar**, **uso** | Módulo novo |
| — (não existe) | Contatos só dentro do Inbox/Kanban | **Contatos/CRM**: busca, etiquetas, notas, campos coletados pelos fluxos, opt-out, importação, histórico de conversas, **LGPD: exportar e apagar** | Módulo novo |
| — (não existe) | Só contadores soltos | **Relatórios** (7/30/90 dias): mensagens e conversas por dia, enviadas por robô/IA/equipe, tempo da 1ª resposta, desempenho por fluxo, IA, funil do Kanban, mensagens por atendente | Módulo novo |
| — (não existe) | — | **Auditoria**: últimas 200 ações com usuário, IP e detalhes | Módulo novo |

## 3. Requisitos funcionais implementados

### 3.1 Canal WhatsApp Cloud API
- Webhook por canal: `GET/POST /api/webhooks/whatsapp/:channelId`.
- Verificação `hub.mode=subscribe` + `hub.verify_token` (comparação em tempo constante) → devolve `hub.challenge`.
- POST autenticado por **X-Hub-Signature-256** (HMAC-SHA256 do corpo bruto com o App Secret cifrado); assinatura ausente/errada → 401 e nada é gravado.
- Recebimento de texto, respostas de botão/lista, botões de modelo, mídias (registradas com o tipo) e localização.
- **Idempotência por message id** (índice único canal + id da Meta + verificação prévia + trava por contato) — reenvios e reenvios simultâneos não duplicam mensagem nem execução de fluxo.
- **Status** sent → delivered → read (nunca regride) e failed com motivo.
- Envio com **retries** (backoff exponencial em erro de rede, 429 e 5xx; sem repetir 4xx).
- Janela de 24h: fora dela só sai **modelo aprovado**; texto livre fica FAILED com explicação.
- Sem credenciais verificadas, nada é enviado: a mensagem fica FAILED com "Canal WhatsApp não conectado". O status só vira CONNECTED depois de uma consulta real bem-sucedida à Graph API.
- Opt-out: "SAIR", "PARAR", "STOP", "DESCADASTRAR" marcam o contato e interrompem automações para ele.

### 3.2 Motor de fluxos
- Grafo de nós/arestas (formato do React Flow), validado com Zod e com regras de negócio antes de ativar.
- Seleção do fluxo pelo gatilho mais específico (palavra-chave > primeira mensagem > horário > qualquer mensagem), desempate por prioridade.
- Estado por conversa (`FlowRun`: bloco atual, variáveis, tipo de espera); **um run ativo por conversa**; retomada atômica WAITING→RUNNING.
- **Proteção contra loop**: limite de passos por segmento de execução (`FLOW_MAX_STEPS`, padrão 50) → FAILED com motivo.
- **Proteção contra duplicidade**: `triggerMessageId` único por run + idempotência de mensagens.
- **Versionamento**: cada salvamento cria versão nova; execuções em andamento continuam na versão em que começaram; restaurar cria nova versão.
- **Registro de cada execução e etapa** (`FlowRunStep` com status ok/alerta/erro e detalhe) e contadores por bloco no editor.
- Aguardar: retomado pelo agendador; o agendador só consulta o banco quando existe espera pendente (economia no plano grátis).
- Bloco HTTP com proteção **SSRF** (bloqueia localhost, redes privadas, link-local e domínios que resolvem para IP interno).

### 3.3 IA
- Provedores: **Google Gemini** (padrão `gemini-3.5-flash-lite`, recomendado pelo Google para projetos novos e disponível no plano gratuito) e **OpenAI ou compatível** (URL base configurável). Provedor **fake determinístico** só existe com `NODE_ENV=test`.
- Chave cifrada com **AES-256-GCM** (IV aleatório, tag de autenticação) usando `MASTER_KEY`; a API nunca devolve a chave (só os 4 últimos caracteres).
- **RAG simples**: documentos fragmentados (~700 caracteres) e ranqueados por BM25 em português (sem acentos e sem stopwords); os 3 melhores trechos entram no prompt.
- **Não inventar preços/políticas**: (1) regra no prompt; (2) pergunta sobre preço/política sem trecho relevante → não chama o modelo, transfere; (3) resposta que cita valor ausente do contexto é bloqueada e transferida.
- Transferência para humano: palavras configuráveis, token `[TRANSFERIR]` do modelo, falha do provedor (após 1 nova tentativa), limite diário/mensal atingido.
- Uso registrado (tokens, latência, sucesso, transferência, erro).

### 3.4 Segurança e plataforma
- Senhas com **bcrypt (custo 12)**; sessão em cookie **httpOnly, SameSite=Lax, Secure em produção**, token guardado como SHA-256 no banco, expiração de 7 dias.
- **CSRF**: cabeçalho `X-Requested-With` obrigatório em mutações + token CSRF ligado à sessão.
- **RBAC** aplicado no servidor (Proprietário, Administrador, Atendente).
- **Isolamento multi-organização**: todas as consultas de negócio filtram por `orgId` da sessão; acesso a id de outra organização → 404.
- **Rate limiting**: login/cadastro/convite (por IP + e-mail), API geral, webhook (por canal).
- **Validação Zod** em todas as entradas; Helmet com CSP restritiva; `trust proxy` para IP real atrás do Render.
- **Auditoria** das ações sensíveis; **LGPD**: exportar (JSON) e apagar definitivamente os dados de um contato.

## 4. Fora do escopo / pendências conhecidas

- Envio de e-mail (convites) — sem SMTP; o link é mostrado para copiar.
- Cobrança de planos — nenhum meio de pagamento integrado.
- Download de mídias recebidas (a Cloud API exige baixar pelo media id com o token); hoje é registrado apenas o tipo.
- Gatilho "webhook HTTP de entrada" (disparar fluxo por chamada externa).
- Tipos de mensagem: figurinha, localização, contato vCard, enquete, lista interativa (há menu numerado e botões).
- Atualização em tempo real por WebSocket (Inbox usa polling).
- Embeddings vetoriais no RAG (usa BM25, sem custo extra).
- Cadastro de modelos (templates) pelo painel — os modelos são criados no Gerenciador do WhatsApp da Meta e enviados pelo nome.
