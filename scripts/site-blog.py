#!/usr/bin/env python3
"""Blog do site /empresa (v1.39.0). Idempotente: pode rodar de novo sem duplicar nada.

Uso:  python3 scripts/site-blog.py
  - lê os artigos em content/blog/*.md (front matter simples + Markdown básico, ver formato abaixo);
  - gera web/public/empresa/blog/index.html e web/public/empresa/blog/<slug>.html com o mesmo topo/rodapé do site
    (molde: web/public/empresa/mckbot.html), H1/H2, sumário, FAQ, CTA "Teste grátis 7 dias" → /cadastro,
    canonical, Open Graph/Twitter e JSON-LD (BlogPosting + FAQPage + BreadcrumbList; índice com CollectionPage + ItemList);
  - acrescenta "Blog" no menu e no rodapé de todas as páginas do site, o bloco "Leia também no blog" nas páginas por
    segmento, no MCKBOT e no MCK Mensagens, e "Do blog" na home;
  - acrescenta os estilos do blog no site.css (entre marcadores) e as URLs no sitemap.xml (lastmod = data do artigo).
Ordem ao regenerar o site: site-segmentos.py → site-profissional.py → site-blog.py.

Formato de um artigo (content/blog/<slug>.md):
  ---
  slug: meu-artigo                (vira /empresa/blog/meu-artigo.html)
  title: "H1 do artigo"
  seo_title: "Título da aba/Google (até ~60 caracteres)"
  description: "Meta description (até ~160 caracteres)"
  keyword: "palavra-chave principal"
  categoria: "Rótulo curto"
  data: "AAAA-MM-DD"               (publicação; opcional atualizado: "AAAA-MM-DD")
  resumo: "Frase do cartão no índice"
  related: [slug-a, slug-b]
  ---
  Markdown: ## e ### títulos, parágrafos, listas "- " e "1. ", "> " citação, tabelas "| a | b |", **negrito**,
  *itálico*, `código`, [texto](/link). [[CTA]] insere a caixa de teste grátis. A seção "## Perguntas frequentes"
  com "### Pergunta" + resposta vira o FAQ (acordeão + FAQPage).
Sem depoimentos, números ou selos inventados; sem citar concorrentes pelo nome (CONAR).
"""
import html, json, math, re, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / 'web' / 'public'
EMP = PUB / 'empresa'
OUT = EMP / 'blog'
SRC = ROOT / 'content' / 'blog'
BASE = 'https://mckbot.onrender.com'
BLOG = f'{BASE}/empresa/blog/'
ORG = f'{BASE}/empresa/#organizacao'
SITE = f'{BASE}/empresa/#site'
AUTOR = 'Equipe MCK Desenvolvimento'
V = '2026112502'  # versão do site.css/site.js (cache)
MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

# Páginas do site → artigos relacionados ("Leia também no blog").
LIGACOES = {
    'whatsapp-para-corretora-de-seguros.html': ['funil-de-vendas-no-whatsapp', 'ia-para-responder-clientes-no-whatsapp', 'como-evitar-banimento-no-whatsapp'],
    'whatsapp-para-salao-de-beleza-e-barbearia.html': ['agendamento-pelo-whatsapp', 'mensagem-automatica-whatsapp-business-exemplos', 'ia-para-responder-clientes-no-whatsapp'],
    'whatsapp-para-clinicas-e-consultorios.html': ['agendamento-pelo-whatsapp', 'ia-para-responder-clientes-no-whatsapp', 'mensagem-automatica-whatsapp-business-exemplos'],
    'whatsapp-para-lojas-e-comercio.html': ['crm-para-whatsapp', 'erp-para-pequenas-empresas', 'funil-de-vendas-no-whatsapp'],
    'whatsapp-para-restaurantes-e-delivery.html': ['chatbot-para-whatsapp', 'mensagem-automatica-whatsapp-business-exemplos', 'erp-para-pequenas-empresas'],
    'whatsapp-para-prestadores-de-servico.html': ['agendamento-pelo-whatsapp', 'funil-de-vendas-no-whatsapp', 'como-automatizar-whatsapp-business'],
    'mckbot.html': ['chatbot-para-whatsapp', 'ia-para-responder-clientes-no-whatsapp', 'como-automatizar-whatsapp-business'],
    'mck-mensagens.html': ['como-evitar-banimento-no-whatsapp', 'funil-de-vendas-no-whatsapp', 'ia-para-responder-clientes-no-whatsapp'],
    'planos.html': ['erp-para-pequenas-empresas', 'crm-para-whatsapp', 'funil-de-vendas-no-whatsapp'],
}
HOME_DESTAQUES = ['chatbot-para-whatsapp', 'como-evitar-banimento-no-whatsapp', 'erp-para-pequenas-empresas']

e = lambda t: html.escape(str(t), quote=True)


# ---------------- leitura dos artigos ----------------
def front(text):
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        raise SystemExit('artigo sem front matter')
    meta = {}
    for line in m.group(1).splitlines():
        if not line.strip():
            continue
        k, v = line.split(':', 1)
        v = v.strip()
        if v.startswith('[') and v.endswith(']'):
            meta[k.strip()] = [x.strip() for x in v[1:-1].split(',') if x.strip()]
        else:
            meta[k.strip()] = v[1:-1] if len(v) >= 2 and v[0] == v[-1] == '"' else v
    return meta, m.group(2)


def slugify(t):
    import unicodedata
    t = unicodedata.normalize('NFKD', t).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')[:60]


def inline(t):
    t = e(t)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<![*\w])\*([^*\n]+)\*(?![*\w])', r'<em>\1</em>', t)

    def link(m):
        txt, url = m.group(1), m.group(2)
        ext = url.startswith('http')
        return f'<a href="{url}"' + (' target="_blank" rel="noopener"' if ext else '') + f'>{txt}</a>'
    return re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', link, t)


def cta_box():
    return ('<aside class="post-cta"><div><strong>Quer ver isso funcionando no seu WhatsApp?</strong>'
            '<p>Teste grátis por 7 dias, sem cartão no cadastro. Conecte pelo QR code e configure em poucos minutos.</p></div>'
            '<div class="acts"><a class="btn red" href="/cadastro">Teste grátis 7 dias</a>'
            '<a class="btn ghost" href="/empresa/planos.html">Ver planos</a></div></aside>')


def markdown(md):
    """Markdown básico → (html do corpo, sumário [(id, título)], faq [(pergunta, resposta)])."""
    lines = md.strip('\n').split('\n')
    out, toc, faq = [], [], []
    in_faq, para, i = False, [], 0
    used = set()

    def flush():
        if para:
            out.append('<p>' + inline(' '.join(para)) + '</p>')
            para.clear()

    def hid(t):
        b = slugify(t) or 'secao'
        s, n = b, 2
        while s in used:
            s, n = f'{b}-{n}', n + 1
        used.add(s)
        return s
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s:
            flush(); i += 1; continue
        if s == '[[CTA]]':
            flush(); out.append(cta_box()); i += 1; continue
        if s.startswith('## '):
            flush()
            t = s[3:].strip()
            in_faq = t.lower().startswith('perguntas frequentes')
            if in_faq:
                i += 1
                q, a = None, []
                while i < len(lines) and not lines[i].startswith('## '):
                    x = lines[i].strip()
                    if x.startswith('### '):
                        if q:
                            faq.append((q, ' '.join(a).strip()))
                        q, a = x[4:].strip(), []
                    elif x:
                        a.append(x)
                    i += 1
                if q:
                    faq.append((q, ' '.join(a).strip()))
                continue
            k = hid(t)
            toc.append((k, t))
            out.append(f'<h2 id="{k}">{inline(t)}</h2>')
            i += 1; continue
        if s.startswith('### '):
            flush(); out.append(f'<h3>{inline(s[4:].strip())}</h3>'); i += 1; continue
        if s.startswith('> '):
            flush()
            q = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                q.append(inline(lines[i].strip()[1:].strip()))
                i += 1
            out.append('<blockquote><p>' + '<br>'.join(q) + '</p></blockquote>')
            continue
        if re.match(r'^[-*] ', s):
            flush()
            items = []
            while i < len(lines) and re.match(r'^[-*] ', lines[i].strip()):
                items.append('<li>' + inline(lines[i].strip()[2:]) + '</li>')
                i += 1
            out.append('<ul>' + ''.join(items) + '</ul>')
            continue
        if re.match(r'^\d+\. ', s):
            flush()
            items = []
            while i < len(lines) and re.match(r'^\d+\. ', lines[i].strip()):
                items.append('<li>' + inline(re.sub(r'^\d+\. ', '', lines[i].strip())) + '</li>')
                i += 1
            out.append('<ol>' + ''.join(items) + '</ol>')
            continue
        if s.startswith('|'):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                if not all(re.match(r'^:?-{2,}:?$', c) for c in cells):
                    rows.append(cells)
                i += 1
            head, body = rows[0], rows[1:]
            out.append('<div class="tbl"><table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr></thead><tbody>' +
                       ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in body) + '</tbody></table></div>')
            continue
        para.append(s)
        i += 1
    flush()
    return '\n'.join(out), toc, faq


def palavras(md):
    t = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', md)
    t = re.sub(r'[#>*`|\[\]]', ' ', t)
    return len(t.split())


def data_br(iso):
    d = datetime.date.fromisoformat(iso)
    return f'{d.day} de {MESES[d.month - 1]} de {d.year}'


def carregar():
    arts = []
    for f in sorted(SRC.glob('*.md')):
        meta, md = front(f.read_text(encoding='utf8'))
        assert meta['slug'] == f.stem, f
        body, toc, faq = markdown(md)
        meta.update(body=body, toc=toc, faq=faq, palavras=palavras(md),
                    url=f'{BLOG}{meta["slug"]}.html', path=f'/empresa/blog/{meta["slug"]}.html',
                    atualizado=meta.get('atualizado', meta['data']))
        meta['minutos'] = max(1, math.ceil(meta['palavras'] / 200))
        arts.append(meta)
    arts.sort(key=lambda a: (a['data'], a['slug']), reverse=True)
    return arts


# ---------------- molde (topo e rodapé do site) ----------------
def molde():
    h = (EMP / 'mckbot.html').read_text(encoding='utf8')
    topo = h[h.index('<body>') + len('<body>'):h.index('<main>')]
    rodape = h[h.index('</main>') + len('</main>'):h.index('</body>')]
    org = None
    m = re.search(r'<script type="application/ld\+json">(.*?)</script>', h, re.S)
    for n in json.loads(m.group(1)).get('@graph', []):
        if n.get('@type') == 'Organization':
            org = n
    topo = re.sub(r' class="?on"?(?=[ >])', '', topo)
    return topo, rodape, org


def head(title, desc, url, og_type, extra_meta, graph):
    ld = json.dumps({'@context': 'https://schema.org', '@graph': graph}, ensure_ascii=False, separators=(',', ':'))
    img = f'{BASE}/empresa/assets/img/og.jpg'
    alt = 'MCK DESENVOLVIMENTO: atendimento e vendas no WhatsApp com IA'
    return ('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
            f'<title>{e(title)}</title><meta name="description" content="{e(desc)}"><meta name="theme-color" content="#d90429">\n'
            f'<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}"><meta property="og:type" content="{og_type}">'
            f'<meta property="og:image" content="{img}"><meta property="og:image:secure_url" content="{img}"><meta property="og:image:type" content="image/jpeg">'
            f'<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="{alt}">'
            f'<meta property="og:locale" content="pt_BR"><meta property="og:site_name" content="MCK DESENVOLVIMENTO"><meta property="og:url" content="{url}">{extra_meta}'
            f'<link rel="canonical" href="{url}">\n'
            '<!-- icons:start --><link rel="icon" href="/logo.svg" type="image/svg+xml"><link rel="icon" href="/logo-192.png" type="image/png" sizes="192x192">'
            '<link rel="apple-touch-icon" href="/logo-apple-180.png" sizes="180x180"><!-- icons:end -->'
            f'<link rel="stylesheet" href="/empresa/assets/site.css?v={V}">'
            '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">'
            f'<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{e(title)}"><meta name="twitter:description" content="{e(desc)}">'
            f'<meta name="twitter:image" content="{img}"><meta name="twitter:image:alt" content="{alt}"><meta name="author" content="{AUTOR}">'
            f'<link rel="alternate" type="application/rss+xml" title="Blog da MCK DESENVOLVIMENTO" href="/empresa/blog/rss.xml">'
            f'<script type="application/ld+json">{ld}</script></head><body>')


def base_graph(org):
    return [org, {'@type': 'WebSite', '@id': SITE, 'url': f'{BASE}/empresa/', 'name': 'MCK DESENVOLVIMENTO',
                  'alternateName': 'MCK Desenvolvimento Software', 'inLanguage': 'pt-BR', 'publisher': {'@id': ORG}}]


def crumbs_ld(url, itens):
    return {'@type': 'BreadcrumbList', '@id': f'{url}#breadcrumb',
            'itemListElement': [{'@type': 'ListItem', 'position': n + 1, 'name': nome, 'item': u} for n, (nome, u) in enumerate(itens)]}


def card(a):
    return (f'<a class="card post-card" href="{a["path"]}"><span class="post-cat">{e(a["categoria"])}</span>'
            f'<h3>{e(a["title"])}</h3><p>{e(a["resumo"])}</p>'
            f'<span class="post-meta">{data_br(a["data"])} · {a["minutos"]} min de leitura</span></a>')


BAND = ('<section><div class="wrap"><div class="band"><div><h2>Teste grátis por 7 dias. Sem cartão no cadastro.</h2>'
        '<p>Crie sua conta em poucos minutos e veja o WhatsApp da sua empresa trabalhando por você.</p></div>'
        '<div class="acts"><a class="btn white" href="/cadastro">Teste grátis 7 dias</a>'
        '<a class="btn outline-w" href="/empresa/contato.html">Falar com a equipe</a></div></div></div></section>')


def pagina_artigo(a, arts, topo, rodape, org):
    title = f'{a["seo_title"]} | MCK Desenvolvimento'
    pub = f'{a["data"]}T09:00:00-03:00'
    mod = f'{a["atualizado"]}T09:00:00-03:00'
    extra = (f'<meta property="article:published_time" content="{pub}"><meta property="article:modified_time" content="{mod}">'
             f'<meta property="article:author" content="{AUTOR}"><meta property="article:section" content="{e(a["categoria"])}">')
    graph = base_graph(org) + [
        crumbs_ld(a['url'], [('MCK DESENVOLVIMENTO', f'{BASE}/'), ('Blog', BLOG), (a['title'], a['url'])]),
        {'@type': 'BlogPosting', '@id': f'{a["url"]}#artigo', 'mainEntityOfPage': {'@type': 'WebPage', '@id': a['url']},
         'headline': a['title'][:110], 'description': a['description'], 'image': [f'{BASE}/empresa/assets/img/og.jpg'],
         'datePublished': pub, 'dateModified': mod, 'inLanguage': 'pt-BR', 'wordCount': a['palavras'],
         'keywords': a['keyword'], 'articleSection': a['categoria'],
         'author': {'@type': 'Organization', 'name': AUTOR, 'url': f'{BASE}/empresa/'},
         'publisher': {'@id': ORG}, 'isPartOf': {'@id': f'{BLOG}#blog'}},
    ]
    if a['faq']:
        graph.append({'@type': 'FAQPage', '@id': f'{a["url"]}#faq', 'inLanguage': 'pt-BR',
                      'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': r}} for q, r in a['faq']]})
    rel = [x for s in a.get('related', []) for x in arts if x['slug'] == s][:3]
    toc = ''.join(f'<li><a href="#{k}">{inline(t)}</a></li>' for k, t in a['toc'])
    faq = ''.join(f'<details><summary>{e(q)}</summary><p>{inline(r)}</p></details>' for q, r in a['faq'])
    return (head(title, a['description'], a['url'], 'article', extra, graph) + topo + '<main>\n'
            f'<section class="hero sub post-hero"><div class="wrap"><div>'
            f'<nav class="crumbs" aria-label="Você está em"><a href="/">Início</a> › <a href="/empresa/blog/">Blog</a> › <span>{e(a["categoria"])}</span></nav>'
            f'<span class="eyebrow">{e(a["categoria"])}</span><h1>{e(a["title"])}</h1>\n'
            f'<p class="lead">{e(a["resumo"])}</p>'
            f'<p class="post-by">Por {AUTOR} · <time datetime="{a["data"]}">{data_br(a["data"])}</time> · {a["minutos"]} min de leitura</p></div></div></section>\n'
            f'<section class="post-wrap"><div class="wrap post-grid"><article class="post">\n'
            f'<details class="toc" open><summary>Neste artigo</summary><ol>{toc}' + ('<li><a href="#perguntas">Perguntas frequentes</a></li>' if faq else '') + '</ol></details>\n'
            f'{a["body"]}\n' +
            (f'<h2 id="perguntas">Perguntas frequentes</h2><div class="faq">{faq}</div>\n' if faq else '') +
            f'{cta_box()}</article>\n'
            '<aside class="post-side"><div class="card"><strong>MCK DESENVOLVIMENTO</strong><p>Atendimento, campanhas e vendas no WhatsApp com IA, e ERP para pequenas empresas.</p>'
            '<a class="btn red block" href="/cadastro">Teste grátis 7 dias</a><a class="btn ghost block" href="/empresa/planos.html">Planos e preços</a>'
            '<p class="side-links"><a href="/empresa/mckbot.html">MCKBOT</a> · <a href="/empresa/mck-mensagens.html">MCK Mensagens</a> · <a href="/empresa/blog/">Mais artigos</a></p></div></aside>'
            '</div></section>\n' +
            ('<section class="alt"><div class="wrap"><div class="center"><span class="eyebrow">Continue lendo</span><h2>Artigos relacionados</h2></div>'
             '<div class="grid g3 post-list" style="margin-top:32px">' + ''.join(card(x) for x in rel) + '</div></div></section>\n' if rel else '') +
            BAND + '\n</main>' + rodape + '</body></html>\n')


def pagina_indice(arts, topo, rodape, org):
    title = 'Blog da MCK DESENVOLVIMENTO: WhatsApp, IA e vendas para pequenos negócios'
    desc = 'Guias práticos sobre atendimento no WhatsApp, chatbot, inteligência artificial, funil de vendas, boas práticas de envio, LGPD e gestão com ERP para pequenas empresas.'
    graph = base_graph(org) + [
        crumbs_ld(BLOG, [('MCK DESENVOLVIMENTO', f'{BASE}/'), ('Blog', BLOG)]),
        {'@type': 'Blog', '@id': f'{BLOG}#blog', 'url': BLOG, 'name': 'Blog da MCK DESENVOLVIMENTO', 'description': desc,
         'inLanguage': 'pt-BR', 'publisher': {'@id': ORG}, 'isPartOf': {'@id': SITE},
         'blogPost': [{'@id': f'{a["url"]}#artigo'} for a in arts]},
        {'@type': 'CollectionPage', '@id': f'{BLOG}#pagina', 'url': BLOG, 'name': title, 'description': desc, 'inLanguage': 'pt-BR',
         'isPartOf': {'@id': SITE}, 'breadcrumb': {'@id': f'{BLOG}#breadcrumb'},
         'mainEntity': {'@type': 'ItemList', 'itemListElement': [{'@type': 'ListItem', 'position': n + 1, 'url': a['url'], 'name': a['title']} for n, a in enumerate(arts)]}},
    ]
    cats = []
    for a in arts:
        if a['categoria'] not in cats:
            cats.append(a['categoria'])
    return (head(title, desc, BLOG, 'website', '', graph) + topo + '<main>\n'
            '<section class="hero sub post-hero"><div class="wrap"><div>'
            '<nav class="crumbs" aria-label="Você está em"><a href="/">Início</a> › <span>Blog</span></nav>'
            '<span class="eyebrow">Blog da MCK</span><h1>WhatsApp, IA e vendas para pequenos negócios</h1>\n'
            '<p class="lead">Guias práticos, sem enrolação, para atender melhor, vender mais pelo WhatsApp e organizar a gestão da sua empresa.</p>'
            '<p class="post-by">Por ' + AUTOR + '</p></div></div></section>\n'
            '<section><div class="wrap"><div class="chips post-cats">' + ''.join(f'<span class="chip">{e(c)}</span>' for c in cats) + '</div>'
            '<div class="grid g3 post-list" style="margin-top:28px">' + ''.join(card(a) for a in arts) + '</div></div></section>\n'
            '<section class="alt"><div class="wrap center"><span class="eyebrow">Soluções por segmento</span><h2>Veja como funciona no seu tipo de negócio</h2>'
            '<div class="chips" style="justify-content:center;margin-top:20px">'
            '<a class="chip" href="/empresa/whatsapp-para-clinicas-e-consultorios.html">Clínicas e consultórios</a>'
            '<a class="chip" href="/empresa/whatsapp-para-salao-de-beleza-e-barbearia.html">Salão e barbearia</a>'
            '<a class="chip" href="/empresa/whatsapp-para-lojas-e-comercio.html">Lojas e comércio</a>'
            '<a class="chip" href="/empresa/whatsapp-para-restaurantes-e-delivery.html">Restaurantes e delivery</a>'
            '<a class="chip" href="/empresa/whatsapp-para-prestadores-de-servico.html">Prestadores de serviço</a>'
            '<a class="chip" href="/empresa/whatsapp-para-corretora-de-seguros.html">Corretoras de seguros</a></div></div></section>\n' +
            BAND + '\n</main>' + rodape + '</body></html>\n')


def rss(arts):
    items = ''.join(
        f'<item><title>{e(a["title"])}</title><link>{a["url"]}</link><guid isPermaLink="true">{a["url"]}</guid>'
        f'<pubDate>{datetime.datetime.fromisoformat(a["data"] + "T09:00:00-03:00").strftime("%a, %d %b %Y %H:%M:%S -0300")}</pubDate>'
        f'<description>{e(a["description"])}</description></item>' for a in arts)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Blog da MCK DESENVOLVIMENTO</title>'
            f'<link>{BLOG}</link><description>WhatsApp, IA e vendas para pequenos negócios</description><language>pt-BR</language>{items}</channel></rss>\n')


# ---------------- páginas existentes do site ----------------
def nav_blog(h):
    if '<a href="/empresa/blog/">Blog</a>' not in h:
        h = re.sub(r'(<nav class="main">.*?<a href="/empresa/novidades"[^>]*>Novidades</a>)', r'\1<a href="/empresa/blog/">Blog</a>', h, count=1, flags=re.S)
    if 'class="ft-blog"' not in h:
        h = h.replace('<a href="/empresa/contato.html">Contato</a><a href="mailto:',
                      '<a href="/empresa/contato.html">Contato</a><a class="ft-blog" href="/empresa/blog/">Blog</a><a href="mailto:', 1)
    h = re.sub(r'site\.css\?v=\d+', f'site.css?v={V}', h)
    h = re.sub(r'site\.js\?v=\d+', f'site.js?v={V}', h)
    return h


def bloco_leia(slugs, arts, titulo='Leia também no blog'):
    sel = [a for s in slugs for a in arts if a['slug'] == s]
    return ('<!-- blog-links:start --><section id="blog"><div class="wrap"><div class="center"><span class="eyebrow">Do blog da MCK</span>'
            f'<h2>{titulo}</h2></div><div class="grid g3 post-list" style="margin-top:32px">' + ''.join(card(a) for a in sel) +
            '</div><p class="center" style="margin-top:24px"><a class="btn ghost" href="/empresa/blog/">Ver todos os artigos</a></p></div></section><!-- blog-links:end -->\n')


BAND_RE = re.compile(r'<section><div class="wrap"><div class="band">')


def inserir_bloco(h, bloco):
    h = re.sub(r'<!-- blog-links:start -->.*?<!-- blog-links:end -->\n?', '', h, flags=re.S)
    m = list(BAND_RE.finditer(h))
    if not m:
        return h.replace('</main>', bloco + '</main>', 1)
    p = m[-1].start()
    return h[:p] + bloco + h[p:]


def sitemap(arts):
    p = PUB / 'sitemap.xml'
    x = p.read_text(encoding='utf8')
    x = re.sub(r'\s*<url><loc>https://mckbot\.onrender\.com/empresa/blog/[^<]*</loc>.*?</url>', '', x)
    ult = max(a['atualizado'] for a in arts)
    linhas = [f'  <url><loc>{BLOG}</loc><lastmod>{ult}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>']
    linhas += [f'  <url><loc>{a["url"]}</loc><lastmod>{a["atualizado"]}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>' for a in arts]
    x = x.replace('</urlset>', '\n'.join(linhas) + '\n</urlset>')
    p.write_text(x, encoding='utf8')


CSS = '''/* blog:start — v1.39.0 */
@media (max-width:1440px) and (min-width:981px){nav.main a{padding:8px 6px;font-size:14.5px}header.site .wrap{gap:14px}.hdr-cta{gap:8px}}
.hero.sub.post-hero .wrap{display:block;text-align:left}.hero.sub.post-hero h1,.hero.sub.post-hero .lead{margin-left:0;margin-right:0}
.post-hero h1{font-size:clamp(28px,3.2vw,42px);max-width:900px}.post-hero .lead{max-width:820px}
.crumbs{font-size:14px;color:#b9b9c4;margin-bottom:14px}.crumbs a{color:#fff}
.post-by{font-size:14px;color:#b9b9c4;margin:6px 0 0}
.post-wrap{padding-top:48px}
.post-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:48px;align-items:start}
.post{max-width:760px;font-size:17px;line-height:1.75;color:var(--ink2)}
.post h2{font-size:clamp(24px,2.4vw,30px);margin:1.8em 0 .6em;scroll-margin-top:90px}
.post h3{font-size:20px;margin:1.4em 0 .5em}
.post ul,.post ol{padding-left:1.3em;margin:0 0 1.1em}.post li{margin:.35em 0}
.post blockquote{margin:1.2em 0;padding:16px 20px;border-left:4px solid var(--red);background:var(--bg);border-radius:0 12px 12px 0;font-size:16px}
.post blockquote p{margin:0}
.post code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:.9em}
.post .tbl{overflow-x:auto;margin:1.2em 0}.post table{width:100%;border-collapse:collapse;font-size:15px}
.post th,.post td{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}.post th{background:var(--bg)}
.post .faq{margin-top:12px}
.toc{border:1px solid var(--line);border-radius:var(--r);padding:16px 20px;margin:0 0 28px;background:#fff}
.toc summary{font-weight:700;cursor:pointer}.toc ol{margin:10px 0 0;padding-left:1.2em;font-size:15px}.toc li{margin:.25em 0}
.post-cta{display:flex;gap:20px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:32px 0;padding:22px 24px;border-radius:var(--r);background:linear-gradient(135deg,#141418,#2a0a10);color:#fff}
.post-cta p{margin:6px 0 0;color:#c9c9d3;font-size:15px}.post-cta .acts{display:flex;gap:10px;flex-wrap:wrap}.post-cta .btn.ghost{background:transparent;color:#fff;border-color:rgba(255,255,255,.4)}
.post-side{position:sticky;top:96px}.post-side .card{display:flex;flex-direction:column;gap:10px}.post-side p{font-size:15px;color:var(--muted);margin:0}
.post-side .side-links{font-size:14px}
a.card.post-card{display:flex;flex-direction:column;gap:8px;color:inherit}a.card.post-card:hover{text-decoration:none;border-color:var(--red)}
a.card.post-card h3{font-size:19px;margin:0}a.card.post-card p{margin:0;color:var(--muted);font-size:15px}
.post-cat{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--red)}
.post-meta{font-size:13px;color:var(--muted);margin-top:auto}
.post-cats .chip{cursor:default;background:var(--bg);color:var(--ink2);border:1px solid var(--line)}
@media (max-width:980px){.post-grid{grid-template-columns:1fr}.post-side{position:static}header.site.open .hdr-cta{top:calc(72px + 372px)}}
@media (max-width:560px){.post{font-size:16px}.post-cta{padding:18px}}
/* blog:end */
'''


def css():
    p = EMP / 'assets' / 'site.css'
    x = p.read_text(encoding='utf8')
    x = re.sub(r'/\* blog:start.*?/\* blog:end \*/\n?', '', x, flags=re.S)
    p.write_text(x.rstrip('\n') + '\n' + CSS, encoding='utf8')


def main():
    arts = carregar()
    css()
    for f in sorted(EMP.glob('*.html')):
        h = nav_blog(f.read_text(encoding='utf8'))
        if f.name in LIGACOES:
            h = inserir_bloco(h, bloco_leia(LIGACOES[f.name], arts))
        if f.name == 'index.html':
            h = inserir_bloco(h, bloco_leia(HOME_DESTAQUES, arts, 'Guias para vender mais pelo WhatsApp'))
        f.write_text(h, encoding='utf8')
    topo, rodape, org = molde()
    OUT.mkdir(exist_ok=True)
    for a in arts:
        (OUT / f'{a["slug"]}.html').write_text(pagina_artigo(a, arts, topo, rodape, org), encoding='utf8')
    (OUT / 'index.html').write_text(pagina_indice(arts, topo, rodape, org), encoding='utf8')
    (OUT / 'rss.xml').write_text(rss(arts), encoding='utf8')
    sitemap(arts)
    for a in arts:
        print(f'{a["palavras"]:5d} palavras  {a["path"]}')
    print('ok', len(arts), 'artigos')


if __name__ == '__main__':
    main()
