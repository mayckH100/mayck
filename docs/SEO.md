# SEO e tráfego orgânico do site /empresa

Estado em 21/11/2026 (v1.39.0). Site: https://mckbot.onrender.com (raiz = home do site da empresa).

## Onde ficam os arquivos
- Páginas do site: `web/public/empresa/*.html` (home, MCKBOT, MCK Mensagens, planos, ajuda, contato, novidades e 6 páginas `whatsapp-para-*.html`).
- Blog: textos em `content/blog/<slug>.md` (front matter + Markdown simples; formato no topo de `scripts/site-blog.py`); páginas geradas em `web/public/empresa/blog/` (índice, artigos, `rss.xml`). Não editar o HTML gerado à mão.
- Geradores (idempotentes), nesta ordem: `python3 scripts/site-segmentos.py` → `python3 scripts/site-profissional.py --precos <plans.json>` → `python3 scripts/site-blog.py`.
- Sitemap: `web/public/sitemap.xml` (o gerador do blog acrescenta o blog). Teste: `tests/unit/site-blog.test.ts` e `tests/unit/site-seo.test.ts`.
- Depois de cada deploy que mude páginas: `npm run indexnow` (Bing e outros) e, no Search Console, reenviar o sitemap.

## Regras de conteúdo
- Português claro, útil de verdade, 1.000–1.800 palavras, H1 único, H2 por seção, FAQ no fim (vira FAQPage), CTA "Teste grátis 7 dias" → /cadastro, links para mckbot/mck-mensagens/planos e páginas por segmento.
- Nunca citar concorrentes pelo nome (CONAR). Sem depoimentos, números de clientes, prêmios ou selos inventados. Preço só "veja Planos" (os preços mudam no Master).
- Sobre a IA: ela só passa a conversa para uma pessoa quando o cliente pede (regra de 03/11).
- Título do artigo começa pela palavra-chave e termina com "| MCK Desenvolvimento" (as páginas institucionais começam com "MCK DESENVOLVIMENTO").

## Palavras-chave (pesquisa de 21/11/2026, sugestões de busca)
Publicados: lista de transmissão whatsapp business (27/11, /empresa/blog/lista-de-transmissao-whatsapp-business.html) · crm para whatsapp (24/11, /empresa/blog/crm-para-whatsapp.html) · chatbot para whatsapp · como automatizar whatsapp business · ia para responder whatsapp · mensagem automática whatsapp business exemplos · como evitar banimento no whatsapp / disparo de mensagens · funil de vendas whatsapp · agendamento pelo whatsapp · erp para pequenas empresas.

## Calendário (2 artigos novos por semana)
| Semana | Artigo 1 | Artigo 2 |
|---|---|---|
| 23/11 | ✅ CRM para WhatsApp: como organizar clientes e vendas (24/11) | ✅ Lista de transmissão do WhatsApp Business: limites e alternativas (27/11) |
| 30/11 | Pedidos pelo WhatsApp para restaurantes e delivery | WhatsApp Business API oficial x conexão por QR code |
| 07/12 | Como vender pelo WhatsApp: técnicas e roteiros | Mensagem de cobrança pelo WhatsApp: modelos e cuidados |
| 14/12 | Pré-vendas (SDR) com IA para pequenas empresas | Controle de estoque: planilha x sistema |
| 21/12 | LGPD no WhatsApp: guia prático | Venda balcão (PDV) para pequenos negócios |
Ao publicar: escrever o .md, rodar `scripts/site-blog.py`, testes, changelog + versão, deploy, IndexNow, sitemap no Search Console e pedir indexação das novas.

## Search Console (conta maycksilvacf, propriedade https://mckbot.onrender.com/)
- Cota de "Solicitar indexação" é baixa e compartilhada entre agentes: pedir 1 por dia nesta ordem até acabar: /empresa/blog/, /empresa/mckbot.html, /empresa/planos.html, /empresa/mck-mensagens.html, artigos do blog, páginas por segmento.
