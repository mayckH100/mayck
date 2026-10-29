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
        '<h3>' + p.label + '</h3><p class="muted" style="color:var(--muted);margin:0">' + p.desc + '</p>' +
        '<div class="price">' + brl(price) + ' <small>/' + (cycle === 'MENSAL' ? 'mês' : 'ano') + '</small></div><div class="save">' + save + '</div>' +
        '<ul class="check">' + p.features.map(function (x) { return '<li>' + x.replace(/</g, '&lt;') + '</li>'; }).join('') + '</ul>' +
        '<div class="acts"><a class="btn red block" href="' + l.trial + '">Começar teste grátis de ' + data.trialDays + ' dias</a>' +
        '<a class="btn ghost block" href="' + l.trial + '">Assinar ' + p.label.replace('Combo MCKBOT + MCK Mensagens', 'o Combo') + '</a>' +
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
