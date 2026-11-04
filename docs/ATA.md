# ATA do projeto MCK (passagem de bastão entre agentes)

Regra: todo agente (Hark, Daniel, Lucas) lê esta ATA na primeira mensagem de cada conversa, antes de agir, e atualiza ao terminar. Este repositório é PÚBLICO: nunca colocar senhas, tokens, chaves, códigos, cartões, endereço residencial ou dados de clientes aqui.

Formato de cada atualização: data, quem fez, o que foi feito, o que foi passado, dificuldades, o que falta, o que melhorar.

## Caminhos
- Código: este repositório (mayckH100/mayck), branch única `master`.
- Deploy: Render Free (mckbot.onrender.com). O Render Free bloqueia SMTP; e-mail sai pela API do Brevo.
- Site da empresa: /empresa. MCK Mensagens: /mensagem.
- Documentação: docs/DEPLOY.md, docs/REQUISITOS.md, docs/AGENDA.md, docs/RELATORIO_TESTES.md.

## Regras
- Corrigir sem mexer nos dados de produção, sem migração destrutiva e sem quebrar o que funciona. Rodar os testes antes de cada commit.
- Nada é publicado em nome da empresa (posts, e-mails, mensagens) sem aprovação do Mayck.
- Tudo gratuito por enquanto: não contratar serviço pago sem pedido do Mayck.
- Diferenciar sempre da "MCK Desenvolvimento de Sistemas LTDA" (outra empresa, desde 2007) e do Grupo MCK Automação.

## Estado em 2026-11-02 (Hark)
### Feito
- E-mail pela API do Brevo (backup nunca vai para login @smtp-brevo.com). Testes unitários 115/115.
- Site /empresa: og:image, canonical, robots.txt e sitemap.xml.
- Canais gratuitos criados: Instagram @mckdesenvolvimento, YouTube @mckdesenvolvimento, LinkedIn /company/mckdesenvolvimento, Perfil da Empresa no Google (aguardando verificação por vídeo), Bing Places (aguardando carta).
- Plano de marketing orgânico de 90 dias.

- 2026-11-02 (Hark): conta grátis da Brevo criada no e-mail da empresa; BREVO_API_KEY, MAIL_FROM e BACKUP_EMAIL configurados no Render. Backup por e-mail funcionando (commit 980de4f: o .bkp vai dentro de .zip, porque a API do Brevo recusa a extensão .bkp). Primeiro backup OK em 2026-11-02 22:12.
- 2026-11-02 (Hark): pop-up central "renove sua assinatura" no MCKBOT e no MCK Mensagens quando o produto está VENCIDA/BLOQUEADA ou a API responde 402; reabre a cada clique (exceto pagamento, perfil/segurança e Sair). Commit 1b9ff8f; ainda sem deploy.
- 2026-11-02 (Hark): Painel Master → aba "Avisos": pop-up central com imagem (PNG/JPG/WEBP ≤ 2 MB, imagem no banco) para os clientes, por app/público/período, 1x por dia por usuário; renovação tem prioridade. Migração 0030_avisos (só aditiva); ainda sem deploy.
- 2026-11-02 (Hark): CNPJ alfanumérico aceito (cadastro, login, clientes; regra oficial ASCII−48), GET /healthz (200/503, checa o banco) e testes de tela Playwright (cadastro com código, renovação, Avisos); workflow do GitHub Actions pronto em docs/ci/e2e.yml — falta copiar para .github/workflows (token sem permissão 'workflow'). Baileys: sem release com o PR #2765, patch mantido. Sem deploy.
- 2026-11-02 (Hark): lembrete por e-mail ao titular 5 dias antes de vencer o teste/plano (RENEWAL_REMINDER_DAYS, padrão 5; por produto, sem repetir, nada entre 21h e 8h de Brasília, desligável no Perfil; só e-mail, pois não há WhatsApp da plataforma) e aba Master → "Vencimentos" (números por produto, listas de 7 dias, link wa.me). Migração 0031_lembretes_vencimento (só aditiva). Sem deploy.
- 2026-11-02 (Hark): alerta de WhatsApp desconectado (QR e API oficial): > 5 min fora do ar → aviso no app (MCKBOT e MCK Mensagens) + e-mail Brevo para Proprietário/Admin com link para Canais; ignora reconexão rápida e reinício/deploy, 1 alerta por queda + lembrete único em 24 h, opção no Perfil; resumo diário (8h) para SUPERADMIN_EMAILS com canais fora > 1 h. Migração 0032_alerta_whatsapp (só aditiva). Sem deploy.
- 2026-11-03 (Hark): convite da Equipe agora sai por e-mail (Brevo, mesmo mailer dos códigos) com quem convidou, papel, módulos e canais; "Reenviar convite" (60 s entre envios, máx. 5); link copiável fica como alternativa. Causa do aviso "e-mail não configurado": texto fixo na tela e rota que nunca enviava. Permissões por membro (módulos + canais WhatsApp), aplicadas no servidor (403 / listas filtradas). Migração 0033_permissoes_equipe (só aditiva; membros antigos mantêm o acesso). Sem deploy.

- 2026-11-03 (Hark): SEO etapa 1 do site /empresa (commits 2fbdea6 e 28da821): JSON-LD em todas as páginas (Organization com CNPJ, fundador e sameAs Facebook; WebSite; SoftwareApplication do MCKBOT e do MCK Mensagens com os preços exibidos hoje; FAQPage na ajuda; BreadcrumbList nas internas), títulos e descrições com "MCK Desenvolvimento", H1 da home com a entidade, botão flutuante de WhatsApp (desligado até haver número: constante MCK_WHATSAPP_NUMERO em site.js ou campo WhatsApp do Master), rodapé com Facebook e Instagram/YouTube/TikTok/Kwai comentados, sitemap com lastmod, robots liberando /api/public. Raiz "/": description, canonical para /empresa/, og e texto estático no #root (some quando o React monta); telas do app com X-Robots-Tag noindex,follow (a raiz continua indexável); /mensagem com meta noindex. Sem redirecionar "/" (o PWA abre em /?source=pwa). Preços do JSON-LD são fixos no HTML: se mudar preço no Master, atualizar o JSON-LD. Teste novo tests/unit/site-seo.test.ts.
- 2026-11-03 (Hark): editor de fluxos — conexão do "Menu de opções" saía da bolinha vizinha. Causa: o React Flow só remede as saídas quando o bloco muda de tamanho; ao adicionar/remover opções as medidas ficavam velhas (a edge era desenhada e pegava na posição antiga), e os rótulos (space-around) não batiam com as bolinhas; opções sem id viravam "opt-undefined" repetido. Correção: updateNodeInternals quando as saídas mudam, rótulo e bolinha na mesma posição a 36 px (área de toque 28/32 px), ids únicos e estáveis (server/flows/handles.ts, usado pelo editor e pelo motor; grafos antigos são corrigidos ao abrir/salvar) e seletor "Ir para o bloco…" em cada opção/saída no painel. IA: timeout por chamada (AI_TIMEOUT_MS, 20 s) e total (AI_TOTAL_TIMEOUT_MS, 45 s), resposta vazia/bloqueada (SAFETY, RECITATION, candidates vazio) tenta de novo uma vez e depois manda o texto de falha (sem transferir, regra de 2026-11-03 abaixo), motivo no log ([ia]) e em Uso; generateAiReply nunca lança; "Testar" sempre sai de "Consultando…" com erro legível. Testes 702/702.
- 2026-11-03 (Hark): editor de fluxos em 1280 px — bloco Início inacessível. Causa: o canvas fica com ~470 px entre a paleta e as propriedades e o fitView parava no zoom mínimo padrão (0,5), cortando o Início na borda; cada bloco novo chamava fitView de novo. Correção: minZoom 0,1, fitView com padding em px descontando painéis que cubram o canvas (web/src/lib/flowCamera.ts), opções estáveis, sem fitView ao adicionar bloco (centraliza só o novo, mantendo o zoom), botão ⤢ para enquadrar, setas do teclado movem a câmera, painéis mais estreitos entre 1101 e 1440 px. Botão "Início / Gatilho" na barra (seleciona, centraliza e abre o gatilho); o "Início" da paleta seleciona o existente; seletor "Depois do gatilho, ir para" no Início. Motor: first_message já ignorava a palavra; o "oi" vinha da troca de tipo no editor (ficava salvo e aparecia na legenda). Agora a troca de tipo/salvar limpa os campos de outros tipos e a legenda mostra "Primeira mensagem (qualquer texto)". Obs.: "primeira mensagem" = contato que nunca mandou mensagem (contact.lastMessageAt vazio). Testes 716/716.
- 2026-11-03 (Hark): SEO etapa 2 — raiz "/" indexável. Visitante e buscador (sem cookie mck_sid) recebem em "/" a home do site da empresa (mesmo HTML de /empresa/, title "MCK DESENVOLVIMENTO · …", canonical https://mckbot.onrender.com/, sem noindex); quem tem cookie de sessão, abre pelo PWA (/?source=pwa), volta do Mercado Pago (?billing=) ou usa /?app=1 recebe o app como antes (server/lib/siteHtml.ts). Login em /login (antigo, continua) e /entrar (novo); demais telas do app com X-Robots-Tag noindex,follow; /index.html → 301 "/". /empresa e /empresa/ servem a mesma home com canonical na raiz. Titles das páginas começam com "MCK DESENVOLVIMENTO". Sitemap: "/" no lugar de /empresa/, lastmod 2026-11-03. Search Console: meta google-site-verification fixa no HTML da raiz, de /empresa/ e do index.html do app; GOOGLE_SITE_VERIFICATION (opcional) injeta outra pelo servidor. Service worker mck-v2: só guarda como casca offline a resposta com X-MCK-Shell: app (nunca a landing). IndexNow: chave pública em /08ccd9f0a80a4c0a5925baf8268ec34f.txt e `npm run indexnow` (scripts/indexnow.mjs; lê o sitemap publicado e envia para api.indexnow.org) — rodar após cada deploy que mude páginas. Testes novos: tests/unit/site-root.test.ts, casos novos em site-seo e spa. Testes 727/727. Deploy manual do commit a148ac6 Live às 15:10 (Brasília); conferido com curl (raiz com H1, CNPJ, canonical e meta de verificação; login responde; /healthz 200). IndexNow enviado (HTTP 202, 9 URLs). Falta: clicar em "Verificar" no Search Console e enviar o sitemap lá.
- 2026-11-03 (Hark): novidades + banner de atualização + cartão de prévia (commit 1897228, deploy Live 16:04 BRT, /healthz ok, IndexNow 200). Novidade "Fluxos mais fáceis, IA mais confiável e site renovado" publicada no site por migração de dados 0036_novidade_2026_11_03 (um INSERT com id fixo e WHERE NOT EXISTS, destino só "site"; sem login no Master). Banner discreto que fecha: site /empresa (site.js, inserido por JS, conteúdo da página continua no HTML) e app MCKBOT/MCK Mensagens (NovidadeBanner): mostra a novidade mais recente de /api/novidades?limit=1 por 14 dias ou até fechar (localStorage mck:novidade:fechada:<id>), link /empresa/novidades#novidade-<id>. Links do próprio site no texto da novidade viram clicáveis. Cartão do Facebook: og:image 1200x630 (captura do Inbox) com width/height/type/alt em todas as páginas, og:title da raiz "MCK DESENVOLVIMENTO | Atendimento e vendas no WhatsApp com IA", /cadastro com og próprio no HTML (conferido com UA facebookexternalhit). Redes (server/social): só Instagram (via Página do Facebook) e YouTube têm credenciais no Render; Instagram já conectado e publicando; LinkedIn implementado sem credenciais; TikTok não implementado; não há publicação na Página do Facebook pela API. Próxima novidade: aba Novidades do Master (destino "Site") ou nova migração no mesmo padrão.
- 2026-11-03 (Hark): aviso de atendimento humano NA HORA da transferência para vários "Números de aviso" (Perfil › Organização; antes só lembrete após N min para o WhatsApp reserva, que estava vazio, e falha nunca repetia), com nome, telefone, motivo, WhatsApp e link; nota/status de falha, até 3 tentativas, "Enviar teste", e-mail ao Proprietário/Admin se for o próprio número; alerta no Inbox sem número. IA: SUBSTITUI a regra anterior — falha/vazio/"não sei"/limite NÃO transferem mais (texto de falha e segue com a IA); só transfere se o cliente pedir humano (detector em código, server/ai/humanRequest.ts); blocos de fluxo continuam. Site da MCK + preços atuais como conhecimento (só superadmin liga, IA › Configuração), "Diferenciais vs concorrentes", pesquisa Google opcional só em Gemini 2.5 Flash/Lite (grátis), Kanban automático pela IA (desligado por padrão), busca da base com radical/título. Migração 0037_aviso_atendimento_ia (só aditiva). Sem deploy.
### Dificuldades
- Verificação do Google só por vídeo gravado ao vivo no app.
- TikTok só pode ser concluído no app do celular.
- Bing Places só verifica por carta.
- Conector do GitHub no Hark bloqueado (chamado aberto).

### Falta fazer
- Verificar o Perfil do Google (vídeo) e concluir o TikTok.
- Instagram: link do site e categoria.
- Avaliar tornar o repositório privado.
- Posts: nenhum publicado; todos precisam de aprovação.

### O que melhorar
- E-mails da Brevo saem com remetente Gmail (IP compartilhado, DKIM padrão): podem cair em Promoções/spam. Um domínio próprio resolveria.
- Repositório público: considerar torná-lo privado.
- Manter esta ATA curta e atual (estado, não histórico).


## Estado em 2026-11-03 (Hark) — MCK ERP
### Feito
 - Arquitetura do ERP (DER, máquina de estados do pedido, plano em 5 etapas) em docs/ERP.md.
 - Etapa 1 (Fundação + CRM) codificada: server/erp, web/src/erp, migração 0038_erp_crm (só aditiva), módulo de permissão erp_crm, menu "MCK ERP · CRM".
 - Decisão do Mayck: fiscal e cobrança são configurados pelo próprio cliente (certificado A1 dele, assistente "Conectar SEFAZ"; credenciais do banco dele). A MCK não contrata provedor.
### Passado
 - Testes enxutos a pedido do Mayck (economizar crédito): typecheck do servidor e da web ok; tests/unit/erp-crm.test.ts e permissoes.test.ts passaram. Suíte completa não rodada nesta entrega.
### Dificuldades
 - Conector do GitHub no Hark segue bloqueado; o push foi feito com token de acesso restrito ao repositório.
### Falta fazer
 - Testar no deploy: abrir /erp, cadastrar cliente pelo CNPJ, criar e mover oportunidade.
 - Etapa 2: Produtos, Estoque/WMS e Vendas/OMS (aguarda aprovação do Mayck).
### O que melhorar
 - Rodar a suíte completa (npm test) antes de liberar para clientes.

### Atualização 2026-11-03 (noite) — ERP Etapa 2
 - Feito: Produtos, Estoque/WMS e Vendas/OMS (ver docs/ERP.md). Migração 0039_erp_estoque_vendas, só aditiva. Menu renomeado para "MCK ERP".
 - Testes: typecheck servidor/web e build da web ok; 19 testes do ERP e permissões passaram. Suíte completa não rodada (economia de crédito, pedido do Mayck).
 - Falta: testar no deploy (cadastrar produto, dar entrada, criar orçamento, enviar, separar com QR, faturar). Próxima: Etapa 3, Compras + Produção/MRP (aguarda aprovação).

### Atualização 2026-11-03 (noite, 2) — ERP estoque completo
 - Pedido do Mayck: estoque completo antes da Etapa 3 e ERP no nível de empresa grande. Feito: entrada por XML de NF-e com de-para por fornecedor e fator, lote interno ligado ao lote do fornecedor, etiquetas QR (Zebra ZPL via Zebra Browser Print e impressora comum), inventário cego com aprovação. Migração 0040, só aditiva.
 - Testes: 26 testes do ERP/permissões/healthz passaram; typecheck e build ok; suíte completa não rodada.
 - Próxima: Etapa 3 (Compras com recebimento cego + Produção/MRP).

## Atualização 2026-11-03 (noite, 3) — Hark
- **Feito:** Etapa 3 do MCK ERP: Compras (solicitação com aprovação, cotação com mapa, pedido de compra com alçada, recebimento pela NF-e com confronto de quantidade/preço e recebimento cego) e Produção/MRP (estrutura multinível, roteiro, custo padrão, OP com reserva, apontamento com backflush, lote interno e genealogia, MRP que gera OPs e solicitação). Migração `0041` (aditiva). Detalhes em `docs/ERP.md`.
- **Verificado:** suíte completa `npm test` (92 arquivos, 824 testes) passou antes do commit; typecheck servidor e web; build web.
- **Falta:** aplicar 0038–0041 no Postgres (só com aprovação do Mayck); testar impressão Zebra em hardware; Etapa 4 (Fiscal + Financeiro).
- **Melhorar:** MRP com baldes de tempo, capacidade finita e apontamento por operação.

## Atualização 2026-11-03 (noite, 4) — Hark
- **Combinado com o Mayck:** seguir todas as etapas sem pedir permissão a cada uma; correções com o app no ar.
- **Feito:** Etapa 4: Financeiro (contas, plano de contas, a receber/a pagar gerados por evento, baixa parcial com juros, estorno, Pix copia-e-cola, OFX e conciliação, aging, fluxo, DRE) e Fiscal (emitente, certificado A1 cifrado, regras, NF-e 4.00 assinada a partir do pedido, transmissão, cancelamento, DANFE). Migração `0042` (aditiva). Detalhes em `docs/ERP.md`.
- **Etapa 5 (BI) também entregue:** painel único e CSV (ver `docs/ERP.md`). Migração `0043` (aditiva).
- **Falta:** testar NF-e em homologação com o certificado real; aplicar 0038–0043 no Postgres e conferir o deploy no Render; SEFAZ próprias (MG, PR, RS...), ST/DIFAL, NFC-e/NFS-e; impressão Zebra em hardware.

## Atualização 2026-11-03 (noite, 5) — Hark
- **Feito**: ERP no ar às 20:37 (deploy manual de `8f8a8a1` no Render, aprovado pelo Mayck; migrações 0038–0043 aplicadas no Postgres sem erro). Ajustes pedidos: clientes e fornecedores em cadastros separados; contas da empresa (água, luz, internet...) separadas dos fornecedores; alertas diários por WhatsApp (contas a pagar, estoque mínimo, produto sem saída em 15 dias); código de barras automático no produto; custo + "Adicionar custo"; etiqueta com lote interno, lote do fornecedor e validade; "Estimativa de compra". Detalhes em `docs/ERP.md` (Ajustes pós-lançamento).
- **Também**: Venda balcão; importar/exportar planilhas (clientes, fornecedores, produtos) com modelo; menu em categorias (ERP, MCKBOT, Mensagens no topo); Plano Completo R$ 100 (ERP + MCKBOT + Mensagens).
- **Também (2)**: custos extras no CMV; custo de NF-e só com senha + log + aviso ao proprietário; aba Relatórios com envio às 22h; aba Funcionários com áreas de acesso do ERP.
- **Regra do Mayck**: toda etapa/módulo novo entra com modelo de planilha, importação e exportação.
- **Passado**: Auto-Deploy do Render está On Commit, mas `8f8a8a1` não disparou sozinho (check do GitHub falhou 0/1). O start roda `prisma migrate deploy`: todo deploy aplica as migrações pendentes.
- **Falta**: aplicar `0044_erp_alertas` (aditiva) com aprovação; TLS da SEFAZ (`SEFAZ_CA_PEM`) antes de nota real; homologação da NF-e; impressão em Zebra real; ver o check do GitHub; dois canais de WhatsApp pediram QR novo após o reinício.
