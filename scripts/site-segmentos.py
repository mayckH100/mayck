#!/usr/bin/env python3
"""Páginas de SEO por segmento do site /empresa (aprovado pelo dono em 05/11/2026).

Usa o HTML atual do repositório (web/public/empresa/mckbot.html) como molde do cabeçalho/rodapé,
para não perder o trabalho de SEO feito direto nos arquivos. Idempotente: rodar de novo regrava as
6 páginas, o bloco <!-- segmentos --> da home e as URLs no sitemap.xml.

Uso (na raiz do repositório): python3 scripts/site-segmentos.py
"""
import json, os, re, sys, html as H

REPO = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
EMP = os.path.join(REPO, 'web/public/empresa')
SITE = 'https://mckbot.onrender.com'
LASTMOD = '2026-11-05'
ORG_ID = f'{SITE}/empresa/#organizacao'
SITE_ID = f'{SITE}/empresa/#site'

tpl = open(os.path.join(EMP, 'mckbot.html'), encoding='utf-8').read()
HEAD_START = tpl[:tpl.index('<title>')]
STYLE = re.search(r'<link rel="icon"[^\n]*?\.css\?v=\d+">', tpl).group(0)
SHELL_TOP = tpl[tpl.index('</head><body>') + len('</head><body>'):tpl.index('<main>')]
SHELL_TOP = SHELL_TOP.replace(' class=on>', '>')
FOOTER = tpl[tpl.index('</main>'):]
org_graph = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', tpl, re.S).group(1))['@graph']
ORG = next(n for n in org_graph if n['@type'] == 'Organization')
WEBSITE = next(n for n in org_graph if n['@type'] == 'WebSite')

e = H.escape

# Recursos reais dos apps (não inventar números nem depoimentos).
R = {
    'ia': ('🧠', 'IA 24h com o conteúdo da sua empresa', 'Você escreve as instruções e a base de conhecimento; a IA do MCKBOT responde no WhatsApp a qualquer hora, com os seus preços, prazos e regras.'),
    'agenda': ('📅', 'Agenda pelo WhatsApp', 'O cliente pede um horário e a IA marca na agenda, com link do Google Meet quando a reunião é online. Você recebe o aviso na hora.'),
    'pedidos': ('🛒', 'Pedidos pelo WhatsApp', 'Cadastre seus produtos e a IA monta o pedido na conversa. Cada pedido novo gera um aviso no seu WhatsApp.'),
    'aviso': ('🔔', 'Aviso de atendente', 'Quando o cliente pede para falar com uma pessoa, a conversa vai para a equipe e o seu WhatsApp particular recebe o aviso com o link da conversa.'),
    'equipe': ('👥', 'Equipe no mesmo número', 'Vários atendentes usam o mesmo WhatsApp, cada um com as suas permissões, sem perder o histórico.'),
    'funil': ('📊', 'Funil de leads', 'Kanban de vendas no MCKBOT e, no MCK Mensagens, campanhas para quem aceitou receber mensagens com a IA separando quem tem interesse.'),
    'erp': ('🧾', 'ERP com venda balcão', 'No Plano Completo, o MCK ERP registra vendas no balcão (PDV), estoque e financeiro, junto com o atendimento.'),
}

def card(k, texto=None):
    ico, t, d = R[k]
    return f'<div class="card"><div class="ico">{ico}</div><h3>{e(t)}</h3><p>{e(texto or d)}</p></div>'

SEGS = [
    dict(slug='whatsapp-para-corretora-de-seguros', nome='Corretora de seguros', curto='corretoras de seguros',
         title='MCK DESENVOLVIMENTO · WhatsApp com IA para corretora de seguros',
         desc='Atendimento no WhatsApp para corretoras de seguros: IA 24h que tira dúvidas sobre os seguros que você vende, agenda de reuniões, aviso de atendente e funil de leads. Teste grátis.',
         h1='WhatsApp com IA para corretora de seguros',
         lead='O cliente pede cotação à noite, no fim de semana ou no meio de outra conversa. Com o MCKBOT, a IA responde na hora com as informações da sua corretora, marca a conversa com o corretor e passa para a equipe quando o cliente quer falar com uma pessoa.',
         dores=['Pedido de cotação chega fora do horário e esfria até alguém responder.', 'As mesmas perguntas sobre coberturas, documentos e prazos tomam o dia da equipe.', 'Leads de campanhas se perdem no meio das conversas do WhatsApp.'],
         recursos=[('ia', 'Explique na base de conhecimento os seguros que você trabalha, os documentos pedidos e como funciona a cotação. A IA responde com esse conteúdo a qualquer hora.'),
                   ('agenda', 'A IA marca a conversa com o corretor no horário que o cliente escolher, com link do Google Meet se for online.'),
                   ('aviso', None), ('funil', 'Acompanhe cada lead no Kanban (novo, cotação enviada, fechado) e use o MCK Mensagens para falar com quem aceitou receber mensagens.'), ('equipe', None)],
         faq=[('A IA faz a cotação do seguro?', 'Não. A IA responde dúvidas com o conteúdo que você cadastrou e coleta os dados do cliente na conversa. A cotação e a proposta continuam com o corretor.'),
              ('Posso usar o número de WhatsApp que a corretora já tem?', 'Sim. Você conecta o número lendo um QR code, como no WhatsApp Web. A API oficial da Meta também está disponível.')]),
    dict(slug='whatsapp-para-salao-de-beleza-e-barbearia', nome='Salão de beleza e barbearia', curto='salões de beleza e barbearias',
         title='MCK DESENVOLVIMENTO · WhatsApp com IA para salão de beleza e barbearia',
         desc='Agendamento e atendimento no WhatsApp para salão de beleza e barbearia: IA 24h com seus serviços e preços, agenda pelo WhatsApp, aviso de atendente e equipe no mesmo número.',
         h1='WhatsApp com IA para salão de beleza e barbearia',
         lead='Enquanto você está atendendo na cadeira, o WhatsApp não para. O MCKBOT responde preços e serviços com as informações do seu salão, marca horários na agenda e chama você quando o cliente quer falar com uma pessoa.',
         dores=['Cliente manda mensagem durante o atendimento e fica sem resposta.', 'Perguntas repetidas sobre preço, endereço e horário de funcionamento.', 'Agenda anotada em vários lugares e horários perdidos.'],
         recursos=[('ia', 'Cadastre serviços, preços, endereço e horário de funcionamento. A IA responde com isso, até de madrugada.'),
                   ('agenda', 'O cliente pede um horário pelo WhatsApp e a IA marca na agenda. Você recebe o aviso no seu celular.'),
                   ('aviso', None), ('equipe', 'Recepção e profissionais usam o mesmo número, cada um com o seu acesso.'), ('funil', None)],
         faq=[('A IA marca o horário sozinha?', 'Sim. Com a agenda ligada, a IA marca o horário que o cliente pediu e você recebe o aviso no WhatsApp. Você pode remarcar ou cancelar pelo app.'),
              ('Preciso saber programar?', 'Não. Você escreve as informações do salão em português, como se explicasse para um funcionário novo, e testa a IA antes de ligar.')]),
    dict(slug='whatsapp-para-clinicas-e-consultorios', nome='Clínica e consultório', curto='clínicas e consultórios',
         title='MCK DESENVOLVIMENTO · WhatsApp com IA para clínicas e consultórios',
         desc='Atendimento no WhatsApp para clínicas e consultórios: IA 24h com as informações da clínica, agenda pelo WhatsApp, aviso de atendente e recepção inteira no mesmo número.',
         h1='WhatsApp com IA para clínicas e consultórios',
         lead='A recepção atende telefone, paciente no balcão e dezenas de conversas no WhatsApp ao mesmo tempo. O MCKBOT responde as dúvidas administrativas com as informações da clínica, marca horários e transfere para a recepção quando o paciente pede.',
         dores=['Paciente espera muito por resposta e procura outro lugar.', 'Recepção sobrecarregada com perguntas sobre convênios, endereço e preparo.', 'Pedidos de horário fora do expediente ficam para o dia seguinte.'],
         recursos=[('ia', 'Cadastre especialidades, convênios aceitos, endereço e orientações administrativas. A IA responde com esse conteúdo, inclusive fora do expediente.'),
                   ('agenda', 'O paciente pede um horário e a IA marca na agenda; a recepção recebe o aviso na hora.'),
                   ('aviso', None), ('equipe', 'Toda a recepção no mesmo número, com permissões por pessoa.'), ('funil', None)],
         faq=[('A IA dá orientação médica?', 'Não deve. Configure a IA para responder só dúvidas administrativas (horários, convênios, endereço) e transferir para a equipe qualquer pergunta clínica.'),
              ('Os dados dos pacientes ficam seguros?', 'Seguimos a LGPD, com controle de acesso por usuário e credenciais criptografadas. Veja a Política de Privacidade.')]),
    dict(slug='whatsapp-para-lojas-e-comercio', nome='Loja e comércio', curto='lojas e comércio',
         title='MCK DESENVOLVIMENTO · WhatsApp com IA e ERP para lojas e comércio',
         desc='WhatsApp com IA para lojas e comércio: atendimento 24h com seus produtos, pedidos pelo WhatsApp, venda balcão no MCK ERP, funil de leads e equipe no mesmo número. Teste grátis.',
         h1='WhatsApp com IA e venda balcão para lojas e comércio',
         lead='Seu cliente pergunta preço e disponibilidade pelo WhatsApp e compra no balcão. Com o MCKBOT a IA responde e anota pedidos na conversa; com o Plano Completo, o MCK ERP registra a venda balcão e o estoque no mesmo lugar.',
         dores=['Perguntas de preço e estoque o dia inteiro, sem tempo para vender.', 'Pedidos do WhatsApp anotados no papel.', 'Vendas do balcão e do WhatsApp em controles separados.'],
         recursos=[('ia', 'Cadastre produtos, preços e formas de pagamento. A IA responde com isso a qualquer hora.'),
                   ('pedidos', None), ('erp', None), ('funil', None), ('equipe', None)],
         faq=[('O ERP está em todos os planos?', 'O MCK ERP faz parte do Plano Completo (MCK ERP + MCKBOT + MCK Mensagens). Os preços atualizados estão nesta página.'),
              ('Consigo controlar o estoque?', 'Sim. No MCK ERP você cadastra produtos, dá entrada no estoque e a venda balcão avisa quando falta estoque antes de finalizar.')]),
    dict(slug='whatsapp-para-restaurantes-e-delivery', nome='Restaurante e delivery', curto='restaurantes e delivery',
         title='MCK DESENVOLVIMENTO · WhatsApp com IA para restaurante e delivery',
         desc='Pedidos e atendimento no WhatsApp para restaurante e delivery: IA com seu cardápio, pedidos na conversa com aviso no seu celular, aviso de atendente e equipe no mesmo número.',
         h1='WhatsApp com IA para restaurante e delivery',
         lead='No horário de pico, cada minuto sem resposta é um pedido a menos. O MCKBOT responde com o seu cardápio, monta o pedido na conversa e avisa no seu WhatsApp cada pedido novo.',
         dores=['Pico de mensagens no almoço e no jantar, com clientes esperando.', 'Perguntas repetidas sobre cardápio, taxa de entrega e horário.', 'Pedidos anotados errado ou esquecidos.'],
         recursos=[('ia', 'Cadastre cardápio, preços, área e taxa de entrega e horário de funcionamento. A IA responde com isso.'),
                   ('pedidos', 'Cadastre os itens do cardápio como produtos: a IA monta o pedido na conversa e você recebe o aviso de pedido novo no WhatsApp.'),
                   ('aviso', None), ('equipe', None), ('erp', None)],
         faq=[('A IA anota o pedido completo?', 'A IA monta o pedido com os produtos que você cadastrou e grava na conversa; você recebe o aviso e confere no app.'),
              ('Funciona no celular?', 'Sim. O app abre no navegador do celular e pode ser instalado na tela inicial.')]),
    dict(slug='whatsapp-para-prestadores-de-servico', nome='Prestador de serviço', curto='prestadores de serviço',
         title='MCK DESENVOLVIMENTO · WhatsApp com IA para prestadores de serviço',
         desc='Atendimento no WhatsApp para prestadores de serviço: IA 24h com seus serviços, agenda de visitas e reuniões, aviso de atendente e funil de leads no Kanban. Teste grátis por 7 dias.',
         h1='WhatsApp com IA para prestadores de serviço',
         lead='Quando você está em um serviço, não consegue responder quem pede orçamento. O MCKBOT responde com as informações do seu negócio, marca visitas e reuniões e organiza cada pedido de orçamento no funil.',
         dores=['Pedido de orçamento sem resposta enquanto você trabalha.', 'Visitas e retornos combinados por mensagem e esquecidos.', 'Sem saber quais orçamentos fecharam.'],
         recursos=[('ia', 'Cadastre serviços, região atendida e como funciona o orçamento. A IA responde e coleta os dados do cliente.'),
                   ('agenda', 'A IA marca visitas e reuniões na agenda e você recebe o aviso na hora.'),
                   ('funil', 'Cada pedido de orçamento vira um card no Kanban: novo, orçamento enviado, fechado.'), ('aviso', None), ('equipe', None)],
         faq=[('A IA passa o preço do orçamento?', 'Ela informa os valores que você cadastrou (por exemplo, preço da visita). Orçamentos sob medida continuam com você.'),
              ('Posso ter mais de um WhatsApp?', 'Sim. O MCKBOT aceita mais de um número conectado na mesma conta.')]),
]

def ld(seg, url):
    page_id = f'{url}#pagina'
    faq = {'@type': 'FAQPage', '@id': f'{url}#faq', 'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in seg['faq']]}
    graph = [ORG, WEBSITE,
             {'@type': 'BreadcrumbList', '@id': f'{url}#breadcrumb', 'itemListElement': [
                 {'@type': 'ListItem', 'position': 1, 'name': 'MCK DESENVOLVIMENTO', 'item': f'{SITE}/'},
                 {'@type': 'ListItem', 'position': 2, 'name': f'Para {seg["curto"]}', 'item': url}]},
             {'@type': 'WebPage', '@id': page_id, 'url': url, 'name': seg['title'].replace('MCK DESENVOLVIMENTO · ', '') + ' | MCK Desenvolvimento', 'description': seg['desc'], 'inLanguage': 'pt-BR',
              'isPartOf': {'@id': SITE_ID}, 'about': {'@id': ORG_ID}, 'breadcrumb': {'@id': f'{url}#breadcrumb'}, 'audience': {'@type': 'BusinessAudience', 'audienceType': seg['nome']}},
             {'@type': 'Service', '@id': f'{url}#servico', 'name': f'Atendimento no WhatsApp com IA para {seg["curto"]}', 'serviceType': 'Automação de atendimento no WhatsApp',
              'provider': {'@id': ORG_ID}, 'areaServed': {'@type': 'Country', 'name': 'Brasil'}, 'audience': {'@type': 'BusinessAudience', 'audienceType': seg['nome']}, 'url': url},
             faq]
    return json.dumps({'@context': 'https://schema.org', '@graph': graph}, ensure_ascii=False, separators=(',', ':'))

def build(seg):
    fname = seg['slug'] + '.html'
    url = f'{SITE}/empresa/{fname}'
    og_title = seg['title'].replace('MCK DESENVOLVIMENTO · ', '') + ' | MCK Desenvolvimento'
    head = (HEAD_START + f'<title>{e(seg["title"])}</title><meta name="description" content="{e(seg["desc"])}"><meta name="theme-color" content="#d90429">\n'
            f'<meta property="og:title" content="{e(og_title)}"><meta property="og:description" content="{e(seg["desc"])}"><meta property="og:type" content="website">'
            f'<meta property="og:image" content="{SITE}/empresa/assets/img/og.jpg"><meta property="og:image:secure_url" content="{SITE}/empresa/assets/img/og.jpg"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
            f'<meta property="og:image:alt" content="Tela do Inbox do MCKBOT: atendimento no WhatsApp com inteligência artificial"><meta property="og:locale" content="pt_BR"><meta property="og:url" content="{url}"><link rel="canonical" href="{url}">\n'
            f'{STYLE}<!-- seo:start --><meta name="robots" content="index,follow,max-image-preview:large"><meta property="og:site_name" content="MCK DESENVOLVIMENTO"><meta name="twitter:card" content="summary_large_image"><meta name="author" content="MCK DESENVOLVIMENTO">'
            f'<script type="application/ld+json">{ld(seg, url)}</script><!-- seo:end --></head><body>')
    dores = ''.join(f'<li>{e(d)}</li>' for d in seg['dores'])
    cards = ''.join(card(k, t) for k, t in seg['recursos'])
    faq = ''.join(f'<details><summary>{e(q)}</summary><p>{e(a)}</p></details>' for q, a in seg['faq'])
    outros = ''.join(f'<a class="chip" href="/empresa/{s["slug"]}.html">{e(s["nome"])}</a>' for s in SEGS if s is not seg)
    main = f'''<main>
<section class="hero sub"><div class="wrap"><div><span class="eyebrow">Para {e(seg["curto"])}</span><h1>{e(seg["h1"])}</h1>
<p class="lead">{e(seg["lead"])}</p>
<div class="actions"><a class="btn red" href="/cadastro">Começar teste grátis de <span data-trial-days>7</span> dias</a><a class="btn outline-w" href="#precos">Ver preços</a></div>
<p class="fine">Sem cartão no cadastro · Conecta pelo QR code, como o WhatsApp Web · Suporte em português</p></div></div></section>
<section><div class="wrap split"><div><span class="eyebrow">O desafio</span><h2>O que trava o atendimento de {e(seg["curto"])} no WhatsApp</h2><ul class="check">{dores}</ul></div>
<div><span class="eyebrow">Como a MCK resolve</span><h2>MCKBOT e MCK Mensagens trabalhando por você</h2><p class="lead">O MCKBOT atende, agenda, anota pedidos e passa para a equipe quando precisa. O MCK Mensagens fala com a sua base de contatos que aceitou receber mensagens e separa quem tem interesse.</p></div></div></section>
<section class="alt"><div class="wrap"><div class="center"><span class="eyebrow">Recursos</span><h2>O que você usa no dia a dia</h2></div>
<div class="grid g3" style="margin-top:44px">{cards}</div></div></section>
<section id="precos"><div class="wrap center"><span class="eyebrow">Preços</span><h2>Planos e preços atualizados</h2><p class="lead"><span data-trial-days>7</span> dias de teste grátis em qualquer plano, sem cartão no cadastro.</p>
<div class="toggle" role="tablist"><button class="on" data-c="MENSAL">Mensal</button><button data-c="ANUAL">Anual (economize)</button></div>
<div class="plans" id="plans" style="text-align:left"><div class="card" style="grid-column:1/-1">Carregando planos…</div></div>
<p class="plan-note">Valores em reais (BRL), os mesmos cobrados no app. Pagamento por Pix, boleto ou cartão pelo Mercado Pago. Sem fidelidade.</p>
<p style="margin-top:20px"><a class="btn red" href="/cadastro">Criar conta e testar grátis</a></p></div></section>
<section class="alt" id="faq"><div class="wrap"><div class="center"><span class="eyebrow">Perguntas frequentes</span><h2>Dúvidas de {e(seg["curto"])}</h2></div><div class="faq">{faq}</div>
<p class="center" style="margin-top:28px">Outros segmentos: </p><div class="chips" style="justify-content:center">{outros}</div></div></section>
<section><div class="wrap"><div class="band"><div><h2>Teste grátis. Sem cartão no cadastro.</h2><p>Crie sua conta em poucos minutos e veja o WhatsApp da sua empresa trabalhando por você.</p></div><div class="acts"><a class="btn white" href="/cadastro">Começar teste grátis</a><a class="btn outline-w" href="/empresa/contato.html">Falar com a equipe</a></div></div></div></section>
'''
    out = head + SHELL_TOP + main + FOOTER
    open(os.path.join(EMP, fname), 'w', encoding='utf-8').write(out)
    return fname, url

def home_block():
    cards = ''.join(f'<a class="card seg" href="/empresa/{s["slug"]}.html"><h3>{e(s["nome"])}</h3><p>{e(s["desc"].split(":")[0])}.</p><span class="nov-link">Ver como funciona →</span></a>' for s in SEGS)
    return (f'<!-- segmentos:start --><section id="segmentos"><div class="wrap"><div class="center"><span class="eyebrow">Soluções por segmento</span><h2>Feito para o seu tipo de negócio</h2>'
            f'<p class="lead">Veja como o MCKBOT e o MCK Mensagens resolvem o atendimento no WhatsApp de cada segmento.</p></div><div class="grid g3" style="margin-top:44px">{cards}</div></div></section><!-- segmentos:end -->')

def main():
    urls = [build(s) for s in SEGS]
    # Home: bloco de segmentos antes de "Diferenciais" (ou atualiza o que já existe).
    p = os.path.join(EMP, 'index.html')
    s = open(p, encoding='utf-8').read()
    blk = home_block()
    if '<!-- segmentos:start -->' in s:
        s = re.sub(r'<!-- segmentos:start -->.*?<!-- segmentos:end -->', lambda m: blk, s, flags=re.S)
    else:
        anchor = '<section><div class="wrap"><div class="center"><span class="eyebrow">Diferenciais</span>'
        assert anchor in s, 'âncora Diferenciais não encontrada na home'
        s = s.replace(anchor, blk + '\n' + anchor, 1)
    # Rodapé de todas as páginas: coluna Produtos ganha "Por segmento".
    open(p, 'w', encoding='utf-8').write(s)
    # Sitemap
    sm = os.path.join(REPO, 'web/public/sitemap.xml')
    x = open(sm, encoding='utf-8').read()
    x = re.sub(r'\s*<url><loc>https://mckbot\.onrender\.com/empresa/whatsapp-para-[^<]+</loc>.*?</url>', '', x)
    add = ''.join(f'\n  <url><loc>{u}</loc><lastmod>{LASTMOD}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>' for _, u in urls)
    x = x.replace('<loc>https://mckbot.onrender.com/</loc><lastmod>2026-11-03</lastmod>', f'<loc>https://mckbot.onrender.com/</loc><lastmod>{LASTMOD}</lastmod>')
    x = x.replace('\n</urlset>', add + '\n</urlset>')
    open(sm, 'w', encoding='utf-8').write(x)
    for f, u in urls: print(u)

if __name__ == '__main__':
    main()
