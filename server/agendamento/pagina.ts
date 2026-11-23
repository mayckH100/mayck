/**
 * v1.46.0 — HTML e script da página pública de agendamento (/agendar/:slug).
 * Página leve (sem o app React), feita para celular. Todo texto vindo do servidor entra com textContent.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function paginaHtml(slug: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Agendar horário</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f6fb;color:#1c2333}
main{max-width:560px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:4px 0 6px}h2{font-size:16px;margin:22px 0 10px}p{margin:0 0 8px;line-height:1.45}
.muted{color:#5b6475;font-size:14px}.card{background:#fff;border:1px solid #e3e7ef;border-radius:12px;padding:14px;margin-bottom:10px}
.opc{display:block;width:100%;text-align:left;background:#fff;border:1px solid #d6dbe6;border-radius:12px;padding:12px 14px;margin:0 0 8px;font:inherit;cursor:pointer;min-height:48px}
.opc[aria-pressed=true]{border-color:#2563eb;box-shadow:0 0 0 2px #2563eb33;background:#eff5ff}
.opc strong{display:block}.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid #d6dbe6;background:#fff;border-radius:10px;padding:10px 12px;font:inherit;min-width:72px;min-height:44px;cursor:pointer}
.chip[aria-pressed=true]{background:#2563eb;color:#fff;border-color:#2563eb}.dias{overflow-x:auto;flex-wrap:nowrap;padding-bottom:6px}
label{display:block;font-size:14px;font-weight:600;margin:12px 0 4px}input,textarea{width:100%;font:inherit;padding:12px;border:1px solid #cfd5e1;border-radius:10px;background:#fff}
button.principal{width:100%;margin-top:16px;background:#16a34a;color:#fff;border:0;border-radius:12px;padding:14px;font:inherit;font-weight:700;min-height:50px;cursor:pointer}
button.principal[disabled]{opacity:.6;cursor:wait}.erro{background:#fdecec;color:#9b1c1c;border-radius:10px;padding:10px 12px;margin-top:12px}
.ok{background:#e9f9ef;border:1px solid #b7ebc8;border-radius:12px;padding:18px;text-align:center}.ok .grande{font-size:40px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}footer{margin-top:28px;text-align:center;font-size:12px;color:#8a92a3}footer a{color:inherit}
</style></head>
<body><main id="app" data-slug="${esc(slug)}">
<p class="muted" id="carregando">Carregando…</p>
<noscript><p>Ative o JavaScript do navegador para agendar.</p></noscript>
</main>
<footer>Agendamento online · <a href="/" rel="nofollow">MCKBOT</a></footer>
<script src="/agendar.js" defer></script>
</body></html>`;
}

export const AGENDAR_JS = String.raw`(function(){
"use strict";
var app=document.getElementById("app");var slug=app.getAttribute("data-slug");var aberto=Date.now();
var st={info:null,servico:null,dia:null,hora:null,horarios:null,enviando:false};
var DS=["dom","seg","ter","qua","qui","sex","sáb"];
function el(t,a,txt){var e=document.createElement(t);if(a)for(var k in a){if(k==="class")e.className=a[k];else e.setAttribute(k,a[k]);}if(txt!=null)e.textContent=txt;return e;}
function api(path,opt){opt=opt||{};return fetch("/api/public/agendar/"+encodeURIComponent(slug)+(path||""),{method:opt.method||"GET",headers:opt.body?{"content-type":"application/json","x-requested-with":"mckbot"}:{},body:opt.body?JSON.stringify(opt.body):undefined}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok)throw new Error(j.error||"Não foi possível concluir. Tente de novo.");return j;});},function(){throw new Error("Sem conexão. Verifique sua internet e tente de novo.");});}
function diaTxt(iso){var p=iso.split("-");var d=new Date(Number(p[0]),Number(p[1])-1,Number(p[2]));return DS[d.getDay()]+" "+p[2]+"/"+p[1];}
function render(){
 app.textContent="";var i=st.info;
 app.appendChild(el("h1",null,i.titulo));
 if(i.intro)app.appendChild(el("p",{class:"muted"},i.intro));
 app.appendChild(el("h2",null,"1. Escolha o serviço"));
 i.servicos.forEach(function(s){var b=el("button",{class:"opc",type:"button","aria-pressed":String(st.servico===s.id)});b.appendChild(el("strong",null,s.nome));
  b.appendChild(el("span",{class:"muted"},s.duracaoMin+" min"+(s.preco?" · "+s.preco:"")));if(s.descricao){b.appendChild(el("br"));b.appendChild(el("span",{class:"muted"},s.descricao));}
  b.onclick=function(){st.servico=s.id;st.hora=null;st.horarios=null;if(st.dia)carregarHorarios();render();};app.appendChild(b);});
 if(!st.servico)return;
 app.appendChild(el("h2",null,"2. Escolha o dia"));
 if(!i.dias.length){app.appendChild(el("p",{class:"muted"},"Sem dias disponíveis no momento."));return;}
 var cd=el("div",{class:"chips dias"});i.dias.forEach(function(d){var c=el("button",{class:"chip",type:"button","aria-pressed":String(st.dia===d)},diaTxt(d));c.onclick=function(){st.dia=d;st.hora=null;carregarHorarios();};cd.appendChild(c);});app.appendChild(cd);
 if(!st.dia)return;
 app.appendChild(el("h2",null,"3. Escolha o horário"));
 if(st.horarios===null){app.appendChild(el("p",{class:"muted"},"Buscando horários livres…"));return;}
 if(!st.horarios.length){app.appendChild(el("p",{class:"muted"},"Nenhum horário livre neste dia. Escolha outro dia."));return;}
 var ch=el("div",{class:"chips"});st.horarios.forEach(function(h){var c=el("button",{class:"chip",type:"button","aria-pressed":String(st.hora===h)},h);c.onclick=function(){st.hora=h;render();};ch.appendChild(c);});app.appendChild(ch);
 if(!st.hora)return;
 app.appendChild(el("h2",null,"4. Seus dados"));
 var f=el("form",{novalidate:"novalidate"});
 f.appendChild(el("label",{for:"nome"},"Nome"));var nome=el("input",{id:"nome",name:"nome",autocomplete:"name",maxlength:"80",required:"required"});f.appendChild(nome);
 f.appendChild(el("label",{for:"wa"},"WhatsApp com DDD"));var wa=el("input",{id:"wa",name:"whatsapp",type:"tel",inputmode:"tel",autocomplete:"tel",placeholder:"(11) 91234-5678",maxlength:"20",required:"required"});f.appendChild(wa);
 f.appendChild(el("label",{for:"obs"},"Observação (opcional)"));var obs=el("textarea",{id:"obs",rows:"2",maxlength:"300"});f.appendChild(obs);
 var hp=el("div",{class:"hp","aria-hidden":"true"});hp.appendChild(el("label",{for:"site"},"Não preencha"));var site=el("input",{id:"site",name:"site",tabindex:"-1",autocomplete:"off"});hp.appendChild(site);f.appendChild(hp);
 var serv=i.servicos.filter(function(s){return s.id===st.servico})[0];
 f.appendChild(el("p",{class:"muted",style:"margin-top:12px"},serv.nome+" · "+diaTxt(st.dia)+" às "+st.hora));
 var btn=el("button",{class:"principal",type:"submit"},"Confirmar agendamento");f.appendChild(btn);
 var erro=el("div",{class:"erro",role:"alert",hidden:"hidden"});f.appendChild(erro);
 f.onsubmit=function(ev){ev.preventDefault();if(st.enviando)return;erro.hidden=true;
  if(nome.value.trim().length<2){erro.textContent="Informe seu nome.";erro.hidden=false;nome.focus();return;}
  if(wa.value.replace(/\D/g,"").length<10){erro.textContent="Informe seu WhatsApp com DDD.";erro.hidden=false;wa.focus();return;}
  st.enviando=true;btn.disabled=true;btn.textContent="Agendando…";
  api("",{method:"POST",body:{servicoId:st.servico,dia:st.dia,hora:st.hora,nome:nome.value,whatsapp:wa.value,observacao:obs.value,site:site.value,t:Date.now()-aberto}}).then(function(r){sucesso(serv,r);},function(e){st.enviando=false;btn.disabled=false;btn.textContent="Confirmar agendamento";erro.textContent=e.message;erro.hidden=false;if(/não está mais livre|ocupado/.test(e.message)){st.hora=null;carregarHorarios();}});};
 app.appendChild(f);
}
function sucesso(serv,r){app.textContent="";var b=el("div",{class:"ok"});b.appendChild(el("div",{class:"grande"},"✅"));b.appendChild(el("h1",null,"Agendado!"));
 b.appendChild(el("p",null,serv.nome+" · "+diaTxt(st.dia)+" às "+st.hora));
 b.appendChild(el("p",{class:"muted"},r&&r.confirmacaoWhatsApp===false?"A empresa vai confirmar com você em breve.":"Você vai receber a confirmação no seu WhatsApp."));app.appendChild(b);}
function carregarHorarios(){st.horarios=null;render();var d=st.dia,s=st.servico;api("/horarios?servico="+encodeURIComponent(s)+"&dia="+d).then(function(r){if(st.dia===d&&st.servico===s){st.horarios=r.horarios;render();}},function(e){st.horarios=[];render();});}
if(!slug){app.textContent="";app.appendChild(el("h1",null,"Página não encontrada"));return;}
api("").then(function(i){st.info=i;document.title="Agendar · "+i.titulo;if(i.servicos.length===1)st.servico=i.servicos[0].id;render();},function(e){app.textContent="";app.appendChild(el("h1",null,"Agendamento indisponível"));app.appendChild(el("p",{class:"muted"},e.message));});
})();`;
