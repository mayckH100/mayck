// ---------- Botão flutuante de WhatsApp (todas as páginas /empresa) ----------
// CONFIGURAÇÃO: número comercial da MCK DESENVOLVIMENTO, só dígitos com DDI 55 + DDD (ex.: '5511999999999').
// Vazio = botão desligado. Se o número for cadastrado no Painel Master (Configurações > Site oficial > WhatsApp),
// ele tem prioridade e o botão aparece sozinho, sem precisar editar este arquivo.
var MCK_WHATSAPP_NUMERO = '5511993195300';
var MCK_WHATSAPP_TEXTO = 'Olá! Vim pelo site da MCK DESENVOLVIMENTO e quero saber mais sobre o MCKBOT e o MCK Mensagens.';
window.MCK_WA_BUTTON = function (url) {
  if (!/^https:\/\/wa\.me\/\d{10,15}$/.test(url || '')) return;
  var href = url + '?text=' + encodeURIComponent(MCK_WHATSAPP_TEXTO);
  var a = document.querySelector('a.wa-float');
  if (!a) {
    a = document.createElement('a');
    a.className = 'wa-float';
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', 'Falar com a MCK DESENVOLVIMENTO no WhatsApp');
    a.title = 'Falar no WhatsApp';
    a.innerHTML = '<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 7L3 29l6.4-2c2 1.1 4.3 1.7 6.6 1.7 7.2 0 13-5.7 13-12.8S23.2 3 16 3zm0 23.4c-2.1 0-4.1-.6-5.9-1.7l-.4-.3-3.8 1.2 1.2-3.7-.3-.4a10.4 10.4 0 0 1-1.7-5.7C5.1 10 10 5.3 16 5.3S26.9 10 26.9 15.8 22 26.4 16 26.4zm6-7.8c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.9 8.9 0 0 1-4.4-3.8c-.3-.6.3-.5.9-1.7.1-.2 0-.4 0-.5l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 0 0-.9.4 3.6 3.6 0 0 0-1.1 2.7c0 1.6 1.2 3.1 1.3 3.3s2.3 3.5 5.6 4.9c2.1.9 2.9 1 4 .8.6-.1 1.9-.8 2.2-1.5s.3-1.4.2-1.5-.3-.2-.6-.3z"/></svg><span>WhatsApp</span>';
    document.body.appendChild(a);
  }
  a.href = href;
};
if (/^\d{12,13}$/.test(MCK_WHATSAPP_NUMERO)) window.MCK_WA_BUTTON('https://wa.me/' + MCK_WHATSAPP_NUMERO);

(function () {
  var h = document.querySelector('header.site'), b = document.querySelector('.menu-btn');
  if (h && b) b.addEventListener('click', function () { h.classList.toggle('open'); });

  // Só um vídeo tocando por vez.
  var vids = document.querySelectorAll('video');
  vids.forEach(function (v) { v.addEventListener('play', function () { vids.forEach(function (o) { if (o !== v) o.pause(); }); }); });

  // Formulário de contato → abre o e-mail do visitante já preenchido.
  var f = document.querySelector('form.contact');
  if (f) f.addEventListener('submit', function (e) {
    e.preventDefault();
    var d = new FormData(f);
    var body = 'Nome: ' + d.get('nome') + '\nEmpresa: ' + (d.get('empresa') || '-') + '\nWhatsApp: ' + (d.get('whats') || '-') + '\nInteresse: ' + d.get('assunto') + '\n\n' + d.get('msg');
    location.href = 'mailto:' + (window.MCK_EMAIL || 'mckdevbr@gmail.com') + '?subject=' + encodeURIComponent('[Site] ' + d.get('assunto') + ' - ' + d.get('nome')) + '&body=' + encodeURIComponent(body);
  });


  // ---------- Dados do site vindos do Painel Master (Configurações > Site oficial) ----------
  // Se a API falhar, nada muda: fica o conteúdo estático das páginas.
  var DEF_EMAIL = 'mckdevbr@gmail.com';
  var DEF_FB = 'https://www.facebook.com/profile.php?id=61596189174050';
  var esc = function (t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  // Link de parceiro no site (?cupom=CODIGO): leva o cupom para o cadastro.
  var cupom = '';
  try { cupom = (new URLSearchParams(location.search).get('cupom') || '').trim().toUpperCase(); } catch (e) { cupom = ''; }
  if (!/^[A-Z0-9_-]{3,30}$/.test(cupom)) cupom = '';
  window.MCK_CUPOM = cupom;
  function withCupom(href, code) {
    if (!code || !/^\/(mensagem\/)?cadastro/.test(href) || /[?&]cupom=/.test(href)) return href;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'cupom=' + encodeURIComponent(code);
  }
  function tagSignupLinks(code) {
    if (!code) return;
    document.querySelectorAll('a[href^="/cadastro"], a[href^="/mensagem/cadastro"]').forEach(function (a) { a.setAttribute('href', withCupom(a.getAttribute('href'), code)); });
  }
  window.MCK_TAG_LINKS = function () { tagSignupLinks(window.MCK_CUPOM); };
  tagSignupLinks(cupom);

  function applySite(s) {
    if (!s || typeof s !== 'object') return;
    var email = typeof s.contactEmail === 'string' && /^[^\s@<>"]+@[^\s@<>"]+$/.test(s.contactEmail) ? s.contactEmail : '';
    if (email && email !== DEF_EMAIL) {
      window.MCK_EMAIL = email;
      document.querySelectorAll('a[href^="mailto:' + DEF_EMAIL + '"]').forEach(function (a) {
        a.setAttribute('href', a.getAttribute('href').replace(DEF_EMAIL, email));
        if (a.textContent.trim() === DEF_EMAIL) a.textContent = email;
      });
      // E-mail citado em texto corrido (FAQ, cartões).
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var n, list = [];
      while ((n = walker.nextNode())) if (n.nodeValue.indexOf(DEF_EMAIL) >= 0) list.push(n);
      list.forEach(function (t) { t.nodeValue = t.nodeValue.split(DEF_EMAIL).join(email); });
    }
    var fb = typeof s.facebookUrl === 'string' && /^https:\/\/(www\.|m\.)?(facebook|fb)\.com\//i.test(s.facebookUrl) ? s.facebookUrl : '';
    if (fb && fb !== DEF_FB) document.querySelectorAll('a[href^="https://www.facebook.com/profile.php"]').forEach(function (a) { a.setAttribute('href', fb); });
    if (s.whatsappUrl && /^https:\/\/wa\.me\/\d{10,15}$/.test(s.whatsappUrl)) {
      if (window.MCK_WA_BUTTON) window.MCK_WA_BUTTON(s.whatsappUrl);
      var strip = document.querySelector('.strip .wrap > span:last-child');
      if (strip && !strip.querySelector('.wa')) strip.insertAdjacentHTML('beforeend', ' <span class="hide-sm">·</span> <a class="wa" href="' + esc(s.whatsappUrl) + '" target="_blank" rel="noopener">WhatsApp</a>');
      var cc = document.querySelector('.contact-card');
      if (cc && !document.querySelector('.wa-card')) cc.insertAdjacentHTML('afterend', '<div class="card contact-card wa-card" style="margin-top:20px"><span class="eyebrow">WhatsApp</span><p><a class="big" href="' + esc(s.whatsappUrl) + '" target="_blank" rel="noopener">Chamar no WhatsApp</a></p><p>Atendimento comercial e suporte.</p></div>');
    }
    // Promoção em destaque (o servidor só manda se o cupom estiver ativo e válido).
    if (s.promo && s.promo.code && /^[A-Z0-9_-]{3,30}$/.test(s.promo.code)) {
      var code = s.promo.code;
      if (!window.MCK_CUPOM) { window.MCK_CUPOM = code; tagSignupLinks(code); }
      var txt = s.promo.text ? esc(s.promo.text) + ' ' : '';
      var bar = '<div class="promo-bar" style="background:#111;color:#fff;text-align:center;padding:10px 16px;font-size:15px">' + txt +
        'Use o cupom <strong style="letter-spacing:.5px">' + esc(code) + '</strong> &nbsp;<a href="' + withCupom('/cadastro', code) + '" style="color:#fff;text-decoration:underline;font-weight:700">Aproveitar</a></div>';
      var anchor = document.querySelector('.strip') || document.body.firstElementChild;
      if (anchor && !document.querySelector('.promo-bar')) anchor.insertAdjacentHTML('beforebegin', bar);
    }
    // Tutoriais completos abertos no site (liga/desliga no Master).
    if (s.tutorialsPublic && Array.isArray(s.tutorials) && s.tutorials.length) {
      var byApp = {};
      s.tutorials.forEach(function (t) { if (t && /^[a-z-]+$/.test(t.app) && /^\/api\/public\/site\/tutorials\//.test(t.video)) byApp[t.app] = t; });
      document.querySelectorAll('.card.tut').forEach(function (card) {
        var btn = card.querySelector('a.btn'), img = card.querySelector('img');
        if (!btn || !img) return;
        var app = btn.getAttribute('href') === '/mensagem/login' ? 'mck-mensagens' : 'mckbot';
        var t = byApp[app];
        if (!t) return;
        img.insertAdjacentHTML('afterend', '<video controls playsinline preload="none" style="width:100%;display:block;background:#000" poster="' + esc(img.getAttribute('src')) + '"><source src="' + esc(t.video) + '" type="video/mp4"><track kind="captions" srclang="pt-BR" label="Português" src="' + esc(t.captions) + '" default></video>');
        img.remove();
        btn.textContent = 'Abrir o app';
      });
      document.querySelectorAll('#tutoriais .lead').forEach(function (p) { p.textContent = 'Guias narrados em português, completos. Assista aqui mesmo ou dentro de cada app.'; });
      var vids2 = document.querySelectorAll('video');
      vids2.forEach(function (v) { v.addEventListener('play', function () { vids2.forEach(function (o) { if (o !== v) o.pause(); }); }); });
    }
  }
  if (window.fetch) fetch('/api/public/site').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(applySite).catch(function () { /* mantém o conteúdo estático */ });

  // Planos: preços e dias de teste vêm do próprio app (mesmos valores do painel Master).
  var box = document.getElementById('plans');
  if (!box) return;
  var LINKS = {
    MCKBOT: { trial: '/cadastro?plano=MCKBOT', login: '/login' },
    MCKMENSAGEM: { trial: '/mensagem/cadastro?plano=MCKMENSAGEM', login: '/mensagem/login' },
    COMBO: { trial: '/cadastro?plano=COMBO', login: '/login' }
  };
  var brl = function (c) { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
  var cycle = 'MENSAL', data = null;
  function render() {
    if (!data) return;
    document.querySelectorAll('[data-trial-days]').forEach(function (el) { el.textContent = data.trialDays; });
    box.innerHTML = data.plans.map(function (p) {
      var best = p.id === 'COMBO', price = p.prices[cycle], l = LINKS[p.id] || LINKS.MCKBOT;
      var save = cycle === 'ANUAL' && p.annualSavings > 0 ? 'Economize ' + brl(p.annualSavings) + ' por ano' : (cycle === 'ANUAL' ? '' : 'ou ' + brl(p.prices.ANUAL) + ' no plano anual');
      return '<div class="plan' + (best ? ' best' : '') + '">' + (best ? '<span class="badge">Mais completo</span>' : '') +
        '<h3>' + esc(p.label) + '</h3><p class="muted" style="color:var(--muted);margin:0">' + esc(p.desc) + '</p>' +
        '<div class="price">' + brl(price) + ' <small>/' + (cycle === 'MENSAL' ? 'mês' : 'ano') + '</small></div><div class="save">' + save + '</div>' +
        '<ul class="check">' + p.features.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        '<div class="acts"><a class="btn red block" href="' + l.trial + '">Começar teste grátis de ' + data.trialDays + ' dias</a>' +
        '<a class="btn ghost block" href="' + l.trial + '">Assinar ' + esc(p.label.replace('Combo MCKBOT + MCK Mensagens', 'o Combo')) + '</a>' +
        '<a href="' + l.login + '" style="text-align:center;font-size:14px">Já sou cliente: entrar e renovar</a></div></div>';
    }).join('');
  }
  document.querySelectorAll('.toggle button').forEach(function (bt) {
    bt.addEventListener('click', function () {
      document.querySelectorAll('.toggle button').forEach(function (o) { o.classList.remove('on'); });
      bt.classList.add('on'); cycle = bt.getAttribute('data-c'); render(); if (window.MCK_TAG_LINKS) window.MCK_TAG_LINKS();
    });
  });
  fetch('/api/public/plans').then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (j) { data = j; render(); if (window.MCK_TAG_LINKS) window.MCK_TAG_LINKS(); })
    .catch(function () { box.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center"><h3>Não foi possível carregar os valores agora</h3><p>Os preços aparecem ao criar sua conta, na tela Plano do app. Dúvidas: <a href="mailto:mckdevbr@gmail.com">mckdevbr@gmail.com</a></p><p style="margin-top:16px"><a class="btn red" href="/cadastro">Começar teste grátis</a></p></div>'; });
})();

// ---------- Novidades (/empresa/novidades): publicações aprovadas no Painel Master ----------
(function () {
  var box = document.getElementById('novidades-lista');
  if (!box) return;
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var safe = function (u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : ''; };
  var NOMES = { instagram: 'Instagram', youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok' };
  // Só links do próprio site viram clicáveis (texto já escapado).
  var linkify = function (t) { return t.replace(/https:\/\/mckbot\.onrender\.com(\/[A-Za-z0-9\-_\/.]*[A-Za-z0-9\-_\/])?/g, function (u) { return '<a href="' + u + '">' + u.replace(/^https:\/\//, '') + '</a>'; }); };
  var data = function (d) { try { return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }); } catch (e) { return ''; } };
  fetch('/api/novidades').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
    var items = (j && j.items) || [];
    if (!items.length) { box.innerHTML = '<p class="news-empty">Nenhuma novidade publicada ainda. Volte em breve!</p>'; return; }
    box.innerHTML = items.map(function (p) {
      var media = safe(p.mediaUrl), m = '';
      if (media && p.mediaType === 'image') m = '<img class="news-img" src="' + esc(media) + '" alt="' + esc(p.title) + '" loading="lazy">';
      var links = Object.keys(p.links || {}).map(function (k) { var u = safe(p.links[k]); return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">Ver no ' + esc(NOMES[k] || k) + '</a>' : ''; }).filter(Boolean);
      if (media && p.mediaType === 'video' && !(p.links || {}).youtube) links.unshift('<a href="' + esc(media) + '" target="_blank" rel="noopener">Assistir ao vídeo</a>');
      return '<article class="card news" id="novidade-' + esc(p.id) + '">' + m + '<div class="news-body"><span class="eyebrow">' + esc(data(p.publishedAt)) + '</span><h2>' + esc(p.title) + '</h2>' +
        (p.body ? '<p>' + linkify(esc(p.body)).replace(/\n/g, '<br>') + '</p>' : '') + (links.length ? '<p class="news-links">' + links.join(' · ') + '</p>' : '') + '</div></article>';
    }).join('');
    // Link do banner (/empresa/novidades#novidade-<id>): a lista chega depois do carregamento, então rola até o item.
    var alvo = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ block: 'start' });
  }).catch(function () { box.innerHTML = '<p class="news-empty">Não foi possível carregar as novidades agora. Tente de novo em instantes.</p>'; });
})();

// ---------- Banner de atualização: novidade mais recente, por 14 dias ou até o visitante fechar ----------
// Regra igual à do app (web/src/novidadeBanner.ts). Só acrescenta uma faixa; o conteúdo da página continua no HTML.
(function () {
  if (!window.fetch || !document.body) return;
  var DIAS = 14, DIA = 864e5;
  var chave = function (id) { return 'mck:novidade:fechada:' + id; };
  var fechada = function (id) { try { return localStorage.getItem(chave(id)) === '1'; } catch (e) { return false; } };
  fetch('/api/novidades?limit=1').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
    var n = j && j.items && j.items[0];
    if (!n || !n.id || !n.title || !n.publishedAt) return;
    var idade = Date.now() - Date.parse(n.publishedAt);
    if (!(idade <= DIAS * DIA && idade >= -DIA) || fechada(n.id)) return;
    var bar = document.createElement('div');
    bar.className = 'updbar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Novidade');
    var w = document.createElement('div'); w.className = 'wrap';
    var t = document.createElement('span'); t.className = 'ub-txt';
    var b = document.createElement('strong'); b.textContent = 'Novidade: ';
    t.appendChild(b); t.appendChild(document.createTextNode(n.title));
    var a = document.createElement('a'); a.className = 'ub-go'; a.textContent = 'Ver →';
    a.href = '/empresa/novidades#novidade-' + encodeURIComponent(n.id);
    var x = document.createElement('button'); x.type = 'button'; x.className = 'ub-x'; x.setAttribute('aria-label', 'Fechar aviso de novidade'); x.textContent = '×';
    x.addEventListener('click', function () { try { localStorage.setItem(chave(n.id), '1'); } catch (e) { /* sem localStorage: some só agora */ } bar.remove(); });
    w.appendChild(t); w.appendChild(a); w.appendChild(x); bar.appendChild(w);
    document.body.insertBefore(bar, document.body.firstChild);
  }).catch(function () { /* sem novidade, sem banner */ });
})();
