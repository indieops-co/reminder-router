/**
 * The tiny inbox served at http://127.0.0.1:<port>/ — a stopgap until the menu-bar
 * app exists, and a handy debugging view forever. Deliberately small: due now,
 * today, tomorrow, later, recurring, recently completed. No chrome.
 */
export function inboxHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Handoffs</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#6b6b6b;--bg:#fbfaf7;--card:#fff;--line:#e6e2da;--due:#d64545;--soon:#d98b1f;--ok:#2f8f5b;--accent:#3b5bdb}
@media(prefers-color-scheme:dark){:root{--fg:#ececec;--muted:#9a9a9a;--bg:#161616;--card:#1f1f1f;--line:#2c2c2c;--accent:#7c93f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:18px 16px 60px}
h1{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:22px 0 6px;font-weight:600;display:flex;justify-content:space-between}
h1 span{font-weight:400;letter-spacing:0;text-transform:none}
form{display:flex;gap:6px;margin-bottom:6px}
input{flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
input.when{flex:0 0 190px}
button{font:inherit;font-size:12px;padding:5px 9px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.row{display:grid;grid-template-columns:8px 1fr auto;gap:10px;align-items:start;padding:8px 10px;background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:4px}
.dot{width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--ok)}.dot.due{background:var(--due)}.dot.soon{background:var(--soon)}
.title{font-weight:600}.meta{color:var(--muted);font-size:12px}.meta b{color:var(--fg);font-weight:500}
.ctx{margin-top:4px;color:var(--muted);font-size:12px;white-space:pre-wrap}.ctx.hide{display:none}
.acts{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}.acts button{padding:3px 7px}
.empty{color:var(--muted);padding:6px 10px;font-size:12px}.code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted)}
#toast{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:6px 12px;border-radius:8px;font-size:12px;opacity:0;transition:opacity .2s}
</style></head><body><main>
<form id="add"><input id="title" placeholder="Remind me to…  (e.g. check deployment in 30m)" autofocus><input id="when" class="when" placeholder="when (optional)"><button class="primary">Add</button></form>
<div id="root"></div>
</main><div id="toast"></div>
<script>
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(path,opts){const r=await fetch(path,{headers:{'content-type':'application/json'},...opts});const j=await r.json();if(!r.ok)throw new Error(j.error||r.statusText);return j}
function toast(m){const t=$('#toast');t.textContent=m;t.style.opacity=1;clearTimeout(t._t);t._t=setTimeout(()=>t.style.opacity=0,1800)}
function row(h,kind){const p=h.project?'<span class="code">'+esc(h.project.code)+'</span> <b>'+esc(h.project.name)+'</b> · ':'';
const dot=h.status==='due'?'due':(new Date(h.trigger_at)-Date.now()<3600e3?'soon':'');
const acts=h.actions.map((a,i)=>'<button data-act="open" data-i="'+i+'" title="'+esc(a.uri)+'">'+esc(a.label)+'</button>').join('');
const ctx=[h.reason_paused&&('Paused: '+h.reason_paused),h.next_action&&('Next: '+h.next_action),h.context_summary].filter(Boolean).join('\\n');
const done=kind==='completed';
return '<div class="row" data-id="'+h.id+'"><div class="dot '+dot+'"></div><div><div class="title">'+esc(h.title)+' <span class="code">#'+h.id+'</span></div>'+
'<div class="meta">'+p+esc(h.when_label)+(h.recurrence_label?' · ↻ '+esc(h.recurrence_label):'')+(h.status==='snoozed'?' · snoozed':'')+'</div>'+
(ctx?'<div class="ctx">'+esc(ctx)+'</div>':'')+'</div><div class="acts">'+(done?'<button data-act="reopen">Reopen</button>':acts+
'<button data-act="snooze15">15m</button><button data-act="snooze60">1h</button><button data-act="tomorrow">Tmrw</button><button data-act="done">Done</button>')+'</div></div>'}
function section(name,list,kind,extra){return '<h1>'+name+' <span>'+(extra||list.length)+'</span></h1>'+(list.length?list.map(h=>row(h,kind)).join(''):'<div class="empty">Nothing here.</div>')}
async function render(){const d=await api('/inbox');document.title=(d.counts.due?'('+d.counts.due+') ':'')+'Handoffs';
$('#root').innerHTML=section('Due now',d.due,'due')+section('Today',d.today)+section('Tomorrow',d.tomorrow)+section('Later',d.later)+section('Recurring',d.recurring,'rec',d.counts.recurring+' active')+section('Completed',d.completed,'completed')}
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-act]');if(!b)return;const id=b.closest('.row').dataset.id;const act=b.dataset.act;
try{if(act==='reopen'){await api('/handoffs/'+id+'/reopen',{method:'POST'})}else{const r=await api('/actions',{method:'POST',body:JSON.stringify({id:+id,action:act,index:+(b.dataset.i||0)})});toast(r.message)}await render()}catch(err){toast(err.message)}});
$('#add').addEventListener('submit',async e=>{e.preventDefault();const title=$('#title').value.trim();const when=$('#when').value.trim();if(!title)return;
try{await api('/handoffs',{method:'POST',body:JSON.stringify({title,when:when||undefined,source:'manual'})});$('#title').value='';$('#when').value='';toast('Added');render()}catch(err){toast(err.message)}});
render();setInterval(render,15000);
</script></body></html>`;
}
