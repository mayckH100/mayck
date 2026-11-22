/**
 * v1.44.0 — Script do chat para o site do cliente (servido em /widget.js).
 * Uso: <script src="https://.../widget.js" data-org="CHAVE" async></script>
 * Sem dependências, dentro de Shadow DOM (não mexe no visual do site) e só com textContent (nada de HTML do servidor).
 */
export const WIDGET_JS = String.raw`(function () {
  'use strict';
  var s = document.currentScript || (function () { var l = document.querySelectorAll('script[data-org]'); return l[l.length - 1]; })();
  if (!s) return;
  var key = s.getAttribute('data-org') || '';
  if (!/^[0-9a-f]{32}$/.test(key) || window['__mckChat_' + key]) return;
  window['__mckChat_' + key] = true;
  var base = new URL(s.src, location.href).origin;
  var api = base + '/api/public/chat/' + key;
  var store = 'mck_chat_' + key;
  function rnd() { var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  var st = {}; try { st = JSON.parse(localStorage.getItem(store) || '{}') || {}; } catch (e) { st = {}; }
  if (!/^[0-9a-f]{32,64}$/.test(st.v || '')) { st.v = rnd(); }
  function save() { try { localStorage.setItem(store, JSON.stringify(st)); } catch (e) { /* modo anônimo */ } }
  save();
  var cfg = null, open = false, last = null, timer = null, seen = {};

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var css = document.createElement('style');
  css.textContent = [
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    '.btn{width:58px;height:58px;border-radius:50%;border:0;color:#fff;font-size:26px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25)}',
    '.box{position:absolute;right:0;bottom:72px;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 110px);background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}',
    '.box.on{display:flex}',
    '.head{color:#fff;padding:14px 16px;font-weight:700;display:flex;justify-content:space-between;align-items:center}',
    '.head button{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}',
    '.msgs{flex:1;overflow-y:auto;padding:12px;background:#f6f7f9;display:flex;flex-direction:column;gap:8px}',
    '.m{max-width:82%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.35;white-space:pre-wrap;word-wrap:break-word}',
    '.m.e{background:#fff;border:1px solid #e5e7eb;align-self:flex-start}',
    '.m.v{color:#fff;align-self:flex-end}',
    '.m img{display:block;max-width:200px;margin-bottom:6px;border-radius:6px}',
    '.m.p{opacity:.6}',
    'form{display:flex;gap:6px;padding:10px;border-top:1px solid #eee;background:#fff}',
    'input,textarea{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:9px;font-size:14px;resize:none}',
    'form button{border:0;color:#fff;border-radius:8px;padding:0 14px;font-weight:700;cursor:pointer}',
    '.id{padding:12px;display:flex;flex-direction:column;gap:8px;border-top:1px solid #eee}',
    '.id button{border:0;color:#fff;border-radius:8px;padding:10px;font-weight:700;cursor:pointer}',
    '.err{color:#b91c1c;font-size:12px;padding:0 12px 6px}',
    '.small{font-size:11px;color:#6b7280;text-align:center;padding:4px}'
  ].join('');
  root.appendChild(css);
  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; }
  var box = el('div', 'box');
  var head = el('div', 'head'); var title = el('span', '', 'Fale com a gente'); var close = el('button', '', '×');
  close.setAttribute('aria-label', 'Fechar'); head.appendChild(title); head.appendChild(close);
  var msgs = el('div', 'msgs'); var err = el('div', 'err');
  var idBox = el('div', 'id'); var nameIn = el('input'); nameIn.placeholder = 'Seu nome'; nameIn.maxLength = 60;
  var phoneIn = el('input'); phoneIn.placeholder = 'Seu WhatsApp (opcional)'; phoneIn.maxLength = 20; phoneIn.inputMode = 'tel';
  var idBtn = el('button', '', 'Começar conversa'); idBox.appendChild(nameIn); idBox.appendChild(phoneIn); idBox.appendChild(idBtn);
  var form = el('form'); var ta = el('textarea'); ta.rows = 1; ta.placeholder = 'Escreva sua mensagem…'; ta.maxLength = 2000;
  var send = el('button', '', 'Enviar'); send.type = 'submit'; form.appendChild(ta); form.appendChild(send);
  box.appendChild(head); box.appendChild(msgs); box.appendChild(err); box.appendChild(idBox); box.appendChild(form);
  box.appendChild(el('div', 'small', 'Chat por MCKBOT'));
  var btn = el('button', 'btn', '💬'); btn.setAttribute('aria-label', 'Abrir chat');
  root.appendChild(box); root.appendChild(btn);

  function color(c) { btn.style.background = c; head.style.background = c; send.style.background = c; idBtn.style.background = c; }
  color('#d90429');
  function needId() { return cfg && cfg.askName && !st.n; }
  function layout() { idBox.style.display = needId() ? 'flex' : 'none'; form.style.display = needId() ? 'none' : 'flex'; }
  function add(m, pend) {
    if (m.id && seen[m.id]) return; if (m.id) seen[m.id] = 1;
    var d = el('div', 'm ' + (m.de === 'visitante' ? 'v' : 'e') + (pend ? ' p' : ''));
    if (m.de === 'visitante') d.style.background = (cfg && cfg.color) || '#d90429';
    if (m.imagem && m.imagem.indexOf(base + '/api/public/pix/') === 0) { var i = el('img'); i.src = m.imagem; i.alt = 'QR code Pix'; d.appendChild(i); }
    d.appendChild(document.createTextNode(m.texto || ''));
    msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d;
  }
  function req(method, path, body) {
    return fetch(api + path, { method: method, headers: body ? { 'Content-Type': 'text/plain' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'omit' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Falha'); return j; }); });
  }
  var pend = [];
  function poll() {
    req('GET', '/messages?visitor=' + st.v + (last ? '&after=' + encodeURIComponent(last) : '')).then(function (j) {
      (j.items || []).forEach(function (m) {
        last = m.criadoEm;
        if (m.de === 'visitante' && pend.length) { var p = pend.shift(); if (p.parentNode) p.parentNode.removeChild(p); }
        add(m);
      });
    }).catch(function () {});
  }
  function start() { if (!timer) { poll(); timer = setInterval(poll, 4000); } }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  btn.onclick = function () { open = !open; box.classList.toggle('on', open); if (open) { start(); setTimeout(function () { (needId() ? nameIn : ta).focus(); }, 50); } else stop(); };
  close.onclick = function () { open = false; box.classList.remove('on'); stop(); };
  idBtn.onclick = function () { var n = nameIn.value.trim(); if (!n) { nameIn.focus(); return; } st.n = n; st.p = phoneIn.value.trim(); save(); layout(); ta.focus(); };
  form.onsubmit = function (e) {
    e.preventDefault(); var t = ta.value.trim(); if (!t) return;
    ta.value = ''; err.textContent = '';
    var p = add({ de: 'visitante', texto: t }, true); if (p) pend.push(p);
    req('POST', '/messages', { visitor: st.v, text: t, name: st.n || undefined, phone: st.p || undefined }).then(function () { setTimeout(poll, 1500); })
      .catch(function (x) { err.textContent = x.message || 'Não foi possível enviar. Tente de novo.'; if (p && p.parentNode) p.parentNode.removeChild(p); pend = pend.filter(function (q) { return q !== p; }); ta.value = t; });
  };
  ta.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.onsubmit(e); } };
  req('GET', '/config').then(function (c) {
    cfg = c; title.textContent = c.title || 'Fale com a gente'; color(c.color || '#d90429');
    if (c.welcome) add({ de: 'empresa', texto: c.welcome });
    layout();
    (document.body || document.documentElement).appendChild(host);
  }).catch(function () { /* chat indisponível neste site: não mostra o botão */ });
})();
`;
