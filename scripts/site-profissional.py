#!/usr/bin/env python3
"""Site /empresa mais profissional e com SEO melhor (v1.38.0). Idempotente: pode rodar de novo sem duplicar nada.

Uso:  python3 scripts/site-profissional.py [--precos caminho/plans.json]
  - converte as imagens .jpg de web/public/empresa/assets/img para .webp (mantém o .jpg como reserva e para o og:image);
  - em todas as páginas: favicons completos, twitter:* (título, descrição, imagem), <picture> com webp + width/height +
    lazy, pôster dos vídeos em webp, botão do topo "Teste grátis 7 dias" indo direto para /cadastro, redes sociais
    oficiais no rodapé (e no sameAs do JSON-LD), contato completo no rodapé, versão nova do CSS/JS;
  - home: hero mais curto com CTA claro, "Como funciona em 3 passos", "Segurança e confiança", FAQ (+ FAQPage) e o
    Plano Completo (MCK ERP) no JSON-LD com os preços da API pública (/api/public/plans);
  - sitemap: lastmod de hoje nas páginas do site.
Depois de mudar mckbot.html rode também scripts/site-segmentos.py e este script de novo (as páginas por segmento
usam o mckbot.html como molde).
"""
import json, re, sys, glob, os, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / 'web' / 'public'
EMP = PUB / 'empresa'
IMG = EMP / 'assets' / 'img'
BASE = 'https://mckbot.onrender.com'
from zoneinfo import ZoneInfo
HOJE = datetime.datetime.now(ZoneInfo('America/Sao_Paulo')).date().isoformat()  # dia de Brasília
V = '2026112102'  # igual ao de scripts/site-blog.py

SOCIAL = [
    ('ig', 'Instagram', 'https://www.instagram.com/mckdesenvolvimento/'),
    ('yt', 'YouTube', 'https://www.youtube.com/@mckdesenvolvimento'),
    ('in', 'LinkedIn', 'https://www.linkedin.com/company/mckdesenvolvimento'),
]
FB = 'https://www.facebook.com/profile.php?id=61596189174050'
WA = 'https://wa.me/5511993195300'


def webp_all():
    try:
        from PIL import Image
    except ImportError:
        print('PIL ausente: imagens .webp não geradas'); return
    for jpg in sorted(IMG.glob('*.jpg')):
        out = jpg.with_suffix('.webp')
        if out.exists() and out.stat().st_mtime >= jpg.stat().st_mtime:
            continue
        Image.open(jpg).convert('RGB').save(out, 'WEBP', quality=78, method=6)


def dims(src):
    try:
        from PIL import Image
        return Image.open(PUB / src.lstrip('/')).size
    except Exception:
        return None


ICONS = ('<!-- icons:start --><link rel="icon" href="/logo.svg" type="image/svg+xml">'
         '<link rel="icon" href="/logo-192.png" type="image/png" sizes="192x192">'
         '<link rel="apple-touch-icon" href="/logo-apple-180.png" sizes="180x180"><!-- icons:end -->')


def meta(h, attr, key):
    m = re.search(rf'<meta {attr}="{re.escape(key)}" content="([^"]*)"', h)
    return m.group(1) if m else None


def head_fixes(h):
    # favicons
    if '<!-- icons:start -->' not in h:
        h = h.replace('<link rel="icon" href="/logo.svg">', ICONS, 1)
    # twitter cards com título/descrição/imagem iguais ao og
    if 'name="twitter:title"' not in h and 'twitter:card' in h:
        t = meta(h, 'property', 'og:title') or ''
        d = meta(h, 'property', 'og:description') or meta(h, 'name', 'description') or ''
        i = meta(h, 'property', 'og:image') or f'{BASE}/empresa/assets/img/og.jpg'
        a = meta(h, 'property', 'og:image:alt') or 'MCK DESENVOLVIMENTO'
        tw = (f'<meta name="twitter:title" content="{t}"><meta name="twitter:description" content="{d}">'
              f'<meta name="twitter:image" content="{i}"><meta name="twitter:image:alt" content="{a}">')
        h = h.replace('<meta name="twitter:card" content="summary_large_image">',
                      '<meta name="twitter:card" content="summary_large_image">' + tw, 1)
    h = re.sub(r'site\.css\?v=\d+', f'site.css?v={V}', h)
    h = re.sub(r'site\.js\?v=\d+', f'site.js?v={V}', h)
    return h


def pictures(h, hero_first=False):
    first = [hero_first]

    def rep(m):
        tag = m.group(0)
        src = re.search(r'src="([^"]+)"', tag).group(1)
        alt = re.search(r'alt="([^"]*)"', tag).group(1)
        if not src.endswith('.jpg'):
            return tag
        webp = src[:-4] + '.webp'
        wh = dims(src)
        size = f' width="{wh[0]}" height="{wh[1]}"' if wh else ''
        if first[0]:
            load = ' fetchpriority="high" decoding="async"'
            first[0] = False
        else:
            load = ' loading="lazy" decoding="async"'
        return f'<picture><source srcset="{webp}" type="image/webp"><img src="{src}" alt="{alt}"{size}{load}></picture>'

    # só <img> ainda fora de <picture>
    return re.sub(r'(?<!type="image/webp">)<img src="/empresa/assets/img/[^"]+\.jpg"[^>]*>', rep, h)


def posters(h):
    return re.sub(r'poster="(/empresa/assets/img/reel\d)\.jpg"', r'poster="\1.webp"', h)


def header_footer(h):
    h = h.replace('<a class="btn red sm" href="/empresa/planos.html">Teste grátis 7 dias</a>',
                  '<a class="btn red sm" href="/cadastro">Teste grátis 7 dias</a>')
    # redes sociais oficiais (o comentário antigo com modelos sai)
    h = re.sub(r'<!-- Redes prontas para ligar:.*?-->', '', h, flags=re.S)
    if 'class="sn ig"' not in h:
        links = ''.join(f'<a class="sn {c}" href="{u}" target="_blank" rel="noopener me">{n}</a>' for c, n, u in SOCIAL)
        h = h.replace('Siga no Facebook</a>', 'Siga no Facebook</a>' + links, 1)
    # contato completo no rodapé (coluna Empresa)
    if 'class="ft-wa"' not in h:
        h = h.replace('<a href="mailto:mckdevbr@gmail.com">mckdevbr@gmail.com</a><a href="/privacidade.html">',
                      f'<a href="mailto:mckdevbr@gmail.com">mckdevbr@gmail.com</a><a class="ft-wa" href="{WA}" target="_blank" rel="noopener">WhatsApp (11) 99319-5300</a><a href="/empresa#seguranca">Segurança e LGPD</a><a href="/privacidade.html">', 1)
    if 'Atendimento em todo o Brasil' not in h:
        h = h.replace('CNPJ 58.460.367/0001-78</span><span>', 'CNPJ 58.460.367/0001-78 · Carapicuíba/SP · Atendimento em todo o Brasil</span><span>', 1)
    return h


def jsonld_graph(h):
    m = re.search(r'<script type="application/ld\+json">(.*?)</script>', h, re.S)
    if not m:
        return h, None, None
    return h, m, json.loads(m.group(1))


def put_graph(h, m, data):
    return h[:m.start(1)] + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + h[m.end(1):]


def fix_jsonld(h, plans=None, home=False, faq=None):
    h, m, data = jsonld_graph(h)
    if not data:
        return h
    graph = data.get('@graph', [])
    for n in graph:
        if n.get('@type') == 'Organization':
            same = n.setdefault('sameAs', [])
            for _, _, u in SOCIAL:
                if u not in same:
                    same.append(u)
            n['address'] = {'@type': 'PostalAddress', 'addressLocality': 'Carapicuíba', 'addressRegion': 'SP', 'addressCountry': 'BR'}
            n['contactPoint'] = {'@type': 'ContactPoint', 'contactType': 'customer support', 'email': 'mckdevbr@gmail.com',
                                 'telephone': '+55-11-99319-5300', 'availableLanguage': 'pt-BR', 'areaServed': 'BR'}
        if n.get('@type') == 'SoftwareApplication' and plans:
            pid = 'MCKBOT' if n.get('name') == 'MCKBOT' else 'MCKMENSAGEM' if n.get('name') == 'MCK Mensagens' else 'COMBO' if n.get('name') == 'MCK ERP' else None
            p = plans.get(pid)
            if p:
                for o in n.get('offers', []):
                    cyc = 'ANUAL' if 'anual' in o.get('name', '').lower() else 'MENSAL'
                    val = f"{p['prices'][cyc] / 100:.2f}"
                    o['price'] = val
                    o.get('priceSpecification', {})['price'] = val
    if home and plans and 'COMBO' in plans and not any(n.get('name') == 'MCK ERP' for n in graph):
        org = f'{BASE}/empresa/#organizacao'
        def offer(name, cyc, unit):
            val = f"{plans['COMBO']['prices'][cyc] / 100:.2f}"
            return {'@type': 'Offer', 'name': name, 'price': val, 'priceCurrency': 'BRL', 'url': f'{BASE}/empresa/planos.html',
                    'availability': 'https://schema.org/InStock', 'seller': {'@id': org},
                    'priceSpecification': {'@type': 'UnitPriceSpecification', 'price': val, 'priceCurrency': 'BRL', 'unitCode': unit,
                                           'referenceQuantity': {'@type': 'QuantitativeValue', 'value': 1, 'unitCode': unit}}}
        graph.append({'@type': 'SoftwareApplication', '@id': f'{BASE}/empresa/planos.html#plano-completo', 'name': 'MCK ERP',
                      'alternateName': 'Plano Completo MCK (MCK ERP + MCKBOT + MCK Mensagens)', 'url': f'{BASE}/empresa/planos.html',
                      'applicationCategory': 'BusinessApplication', 'applicationSubCategory': 'ERP para pequenas e médias empresas',
                      'operatingSystem': 'Web, Android, iOS (navegador / PWA)', 'inLanguage': 'pt-BR',
                      'description': 'ERP com vendas, balcão (PDV), estoque com lotes, compras, produção, financeiro, NF-e e indicadores, junto com o MCKBOT, o MCK Mensagens e o SDR com IA, em uma só cobrança.',
                      'image': f'{BASE}/empresa/assets/img/og.jpg', 'publisher': {'@id': org}, 'author': {'@id': org},
                      'offers': [offer('Plano Completo mensal', 'MENSAL', 'MON'), offer('Plano Completo anual', 'ANUAL', 'ANN')]})
    if faq and not any(n.get('@type') == 'FAQPage' for n in graph):
        graph.append({'@type': 'FAQPage', '@id': f'{BASE}/#faq', 'inLanguage': 'pt-BR',
                      'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in faq]})
    return put_graph(h, m, data)


# ---------------- home ----------------
HERO_OLD = re.compile(r'<section class="hero"><div class="wrap">.*?</div></section>\n', re.S)
HERO = ('<section class="hero"><div class="wrap"><div><span class="eyebrow">MCK DESENVOLVIMENTO · Software brasileiro</span>'
        '<h1>MCK Desenvolvimento: atendimento e vendas no WhatsApp com IA</h1>\n'
        '<p class="lead">Seu WhatsApp respondendo em segundos, 24 horas por dia, qualificando clientes e organizando as vendas. '
        'Robô, inteligência artificial, funil de vendas, campanhas e ERP em uma plataforma brasileira, simples de usar.</p>\n'
        '<div class="actions"><a class="btn red" href="/cadastro">Teste grátis 7 dias</a><a class="btn outline-w" href="/empresa/planos.html">Ver planos e preços</a></div>\n'
        '<ul class="trust-mini"><li>Sem cartão no cadastro</li><li>Conecta pelo QR code</li><li>Suporte em português</li><li>CNPJ 58.460.367/0001-78</li></ul></div>\n'
        '<div class="shot"><img src="/empresa/assets/img/bot-inbox.jpg" alt="Inbox do MCKBOT com a IA respondendo um cliente no WhatsApp"></div></div></section>\n')

STEPS_OLD = re.compile(r'<section class="alt"><div class="wrap"><div class="center"><span class="eyebrow">Como começar</span>.*?</div></div></div></section>', re.S)
STEPS = ('<section class="alt" id="como-funciona"><div class="wrap"><div class="center"><span class="eyebrow">Como funciona</span><h2>Comece em 3 passos</h2>'
         '<p class="lead">Do cadastro ao primeiro atendimento automático no mesmo dia.</p></div>\n'
         '<div class="grid g3 steps" style="margin-top:44px">\n'
         '<div class="step"><h3>Crie sua conta grátis</h3><p>Cadastro em poucos minutos, sem cartão. O teste de 7 dias começa na hora, com todos os recursos do plano escolhido.</p></div>\n'
         '<div class="step"><h3>Conecte o WhatsApp</h3><p>Leia o QR code com o celular da empresa, como no WhatsApp Web, e use o número que você já tem. A API oficial da Meta também está disponível.</p></div>\n'
         '<div class="step"><h3>Ensine a IA e comece a vender</h3><p>Conte o que sua empresa vende, preços e regras, teste a resposta antes de ligar e acompanhe cada contato no Kanban.</p></div></div>\n'
         '<p class="center" style="margin-top:36px"><a class="btn red" href="/cadastro">Teste grátis 7 dias</a></p></div></section>')

TRUST = ('<!-- confianca:start --><section class="alt" id="seguranca"><div class="wrap"><div class="center"><span class="eyebrow">Segurança e confiança</span>'
         '<h2>Seus dados e os dos seus clientes protegidos</h2><p class="lead">Empresa brasileira identificada pelo CNPJ, com regras claras de privacidade.</p></div>\n'
         '<div class="grid g3 trust" style="margin-top:44px">\n'
         '<div class="card"><div class="ico">🏢</div><h3>Empresa identificada</h3><p>MCK DESENVOLVIMENTO · CNPJ 58.460.367/0001-78 · Carapicuíba/SP. Fundada por Mayck Alessandro Silva Hilario.</p></div>\n'
         '<div class="card"><div class="ico">🔒</div><h3>Conexão e senhas protegidas</h3><p>Acesso sempre por HTTPS, verificação em duas etapas disponível, senhas e chaves de integração guardadas com criptografia.</p></div>\n'
         '<div class="card"><div class="ico">💾</div><h3>Cópia de segurança diária</h3><p>O banco de dados é copiado todos os dias, de forma automática e cifrada.</p></div>\n'
         '<div class="card"><div class="ico">⚖️</div><h3>LGPD na prática</h3><p>Consentimento registrado, opt-out automático ("SAIR") e quem pede para sair não recebe mais mensagens. Veja a <a href="/privacidade.html">Política de Privacidade</a>.</p></div>\n'
         '<div class="card"><div class="ico">👥</div><h3>Cada empresa vê só o que é dela</h3><p>Dados separados por empresa e permissões por membro da equipe (módulos e números de WhatsApp).</p></div>\n'
         '<div class="card"><div class="ico">💬</div><h3>Suporte de verdade</h3><p>Fale com a equipe pelo e-mail mckdevbr@gmail.com ou pelo WhatsApp (11) 99319-5300.</p></div>\n'
         '</div></div></section><!-- confianca:end -->\n')

FAQ = [
    ('O que a MCK DESENVOLVIMENTO faz?', 'É uma empresa brasileira de software (CNPJ 58.460.367/0001-78) que cria o MCKBOT (atendimento automático no WhatsApp com IA), o MCK Mensagens (campanhas e qualificação de leads no WhatsApp) e o MCK ERP (vendas, estoque, compras, financeiro e fiscal).'),
    ('Como funciona o teste grátis?', 'São 7 dias grátis, sem cartão no cadastro. Você cria a conta, conecta o WhatsApp pelo QR code e testa tudo. Só paga se decidir assinar.'),
    ('Preciso trocar meu número de WhatsApp?', 'Não. Você conecta o número que já usa, lendo o QR code como no WhatsApp Web. Quem preferir pode usar a API oficial da Meta.'),
    ('A inteligência artificial responde como a minha empresa?', 'Sim. Você escreve as instruções e a base de conhecimento (produtos, preços, prazos, regras) e testa as respostas antes de ligar. Se o cliente pedir uma pessoa, a conversa vai para a sua equipe.'),
    ('Quanto custa?', 'Os preços atualizados de cada plano (MCKBOT, MCK Mensagens e Plano Completo com o MCK ERP), mensal e anual, estão na página Planos e preços. O plano anual sai mais barato que 12 meses do mensal.'),
    ('Tem fidelidade ou multa?', 'Não. Os planos são mensais ou anuais, sem multa: você renova pelo próprio aplicativo quando quiser.'),
    ('Meus dados ficam seguros?', 'Sim. O acesso é sempre por HTTPS, as senhas e chaves ficam criptografadas, há verificação em duas etapas, cópia de segurança diária e cada empresa só vê os próprios dados, seguindo a LGPD.'),
]


def faq_html():
    items = ''.join(f'<details><summary>{q}</summary><p>{a}</p></details>' for q, a in FAQ)
    return ('<!-- faq-home:start --><section id="perguntas"><div class="wrap"><div class="center"><span class="eyebrow">Perguntas frequentes</span>'
            '<h2>Dúvidas comuns</h2></div><div class="faq" style="margin-top:32px">' + items +
            '</div><p class="center" style="margin-top:28px"><a class="btn ghost" href="/empresa/ajuda.html">Ver a Central de ajuda completa</a></p></div></section><!-- faq-home:end -->\n')


def home(h, plans):
    h = HERO_OLD.sub(lambda _m: HERO, h, count=1) if 'trust-mini' not in h else h
    if 'id="como-funciona"' not in h:
        h = STEPS_OLD.sub(lambda _m: STEPS, h, count=1)
    if '<!-- confianca:start -->' not in h:
        h = h.replace('<section class="dark" id="veja-em-acao">', TRUST + '<section class="dark" id="veja-em-acao">', 1)
    if '<!-- faq-home:start -->' not in h:
        h = h.replace('<section><div class="wrap"><div class="band">', faq_html() + '<section><div class="wrap"><div class="band">', 1)
    h = h.replace('<a class="btn white" href="/empresa/planos.html">Começar teste grátis</a>', '<a class="btn white" href="/cadastro">Teste grátis 7 dias</a>')
    # descrição/título um pouco mais diretos (mantêm a entidade no começo)
    h = h.replace('<title>MCK DESENVOLVIMENTO · software de atendimento e vendas no WhatsApp</title>',
                  '<title>MCK DESENVOLVIMENTO · Atendimento e vendas no WhatsApp com IA | Teste grátis</title>')
    return fix_jsonld(h, plans, home=True, faq=FAQ)


def sitemap():
    p = PUB / 'sitemap.xml'
    x = p.read_text(encoding='utf8')
    x = re.sub(r'(<loc>https://mckbot\.onrender\.com/(?:|empresa/[^<]*)</loc><lastmod>)\d{4}-\d{2}-\d{2}', rf'\g<1>{HOJE}', x)
    p.write_text(x, encoding='utf8')


def main():
    plans = None
    if '--precos' in sys.argv:
        raw = json.loads(Path(sys.argv[sys.argv.index('--precos') + 1]).read_text(encoding='utf8'))
        plans = {p['id']: p for p in raw['plans']}
    webp_all()
    for f in sorted(EMP.glob('*.html')):
        h = f.read_text(encoding='utf8')
        h = head_fixes(h)
        h = header_footer(h)
        if f.name == 'contato.html':
            h = re.sub(r'<title>MCK DESENVOLVIMENTO · Contato</title>', '<title>MCK DESENVOLVIMENTO · Contato: WhatsApp, e-mail e suporte</title>', h)
        if f.name == 'index.html':
            h = home(h, plans)
        else:
            h = fix_jsonld(h, plans)
        h = pictures(h, hero_first=(f.name == 'index.html'))
        h = posters(h)
        f.write_text(h, encoding='utf8')
    sitemap()
    print('ok', HOJE)


if __name__ == '__main__':
    main()
