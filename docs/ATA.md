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

### Dificuldades
- Verificação do Google só por vídeo gravado ao vivo no app.
- TikTok só pode ser concluído no app do celular.
- Bing Places só verifica por carta.
- Conector do GitHub no Hark bloqueado (chamado aberto).

### Falta fazer
- Verificar o Perfil do Google (vídeo) e concluir o TikTok.
- Instagram: link do site e categoria.
- Alerta quando o WhatsApp desconectar; avaliar tornar o repositório privado.
- Posts: nenhum publicado; todos precisam de aprovação.

### O que melhorar
- E-mails da Brevo saem com remetente Gmail (IP compartilhado, DKIM padrão): podem cair em Promoções/spam. Um domínio próprio resolveria.
- Repositório público: considerar torná-lo privado.
- Manter esta ATA curta e atual (estado, não histórico).
