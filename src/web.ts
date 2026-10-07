import { orderedRowIds, ROWS } from './addon.ts';
import { EST_CALL, EST_CALLS_PER_RUN, priceFor, PROVIDERS } from './ai.ts';
import { mask } from './crypto.ts';
import type { Secrets, Settings } from './store.ts';

export const LANGUAGES: Record<string, string> = {
  'en-US': 'English',
  'de-DE': 'Deutsch',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'it-IT': 'Italiano',
  'pt-BR': 'Português (BR)',
  'ja-JP': '日本語',
};
export const REFRESH_HOURS = [1, 3, 6, 12, 24];
export const TIMEZONES = [
  'Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam',
  'Europe/Warsaw', 'Europe/Istanbul', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Dependent fields via CSS :has(); JavaScript only for sorting and live status (allowed via CSP nonce)
const CSS = `
:root{color-scheme:dark;--bg:#09090b;--panel:#131316;--panel2:#1b1b20;--line:#27272e;--text:#f4f4f6;--muted:#8e8e9a;--accent:#e50914;--ok:#22c55e;--r:16px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}[hidden]{display:none!important}
body{margin:0;min-height:100vh;color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  background:radial-gradient(900px 420px at 50% -160px,rgba(229,9,20,.28),transparent 70%),var(--bg)}
main{max-width:680px;margin:0 auto;padding:28px 16px 120px}
a{color:var(--text);text-underline-offset:3px}code{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:-.02em;margin-bottom:28px}
.brand img{width:32px;height:32px}.brand .home{display:flex;align-items:center;gap:10px;color:inherit;text-decoration:none}
.brand .sp{flex:1}
h1{font-size:34px;line-height:1.1;letter-spacing:-.03em;margin:0 0 10px}
.lead{color:var(--muted);font-size:17px;margin:0 0 24px}
.sec{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:22px;margin:18px 0}
.sec>h2{display:flex;align-items:center;gap:12px;font-size:18px;letter-spacing:-.01em;margin:0 0 4px}
.sec>h2 b{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);font-size:13px}
.sec>p.sub{color:var(--muted);margin:0 0 16px}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:22px 0 8px}
.muted{color:var(--muted)}.small{font-size:13px}
label{display:block;margin:14px 0 0;font-weight:600;font-size:14px}
label>span{display:block;font-weight:400;color:var(--muted);font-size:13px;margin-top:2px}
input[type=text],input[type=password],input[type=email],select,textarea{display:block;width:100%;margin-top:6px;padding:11px 13px;border-radius:10px;
  border:1px solid var(--line);background:#0d0d10;color:var(--text);font:inherit;outline:none;transition:border-color .15s}
input:focus,select:focus,textarea:focus{border-color:#55555f}textarea{min-height:84px;resize:vertical}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:#fff;border:0;border-radius:10px;
  padding:11px 18px;font-family:inherit;font-weight:600;font-size:15px;cursor:pointer;text-decoration:none;transition:filter .15s}
button:hover,.btn:hover{filter:brightness(1.12)}
.ghost{background:var(--panel2);border:1px solid var(--line);color:var(--text)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
.note{border-radius:12px;padding:12px 14px;margin:0 0 18px;border:1px solid var(--line);background:var(--panel)}
.note.ok{border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.08)}.note.err{border-color:rgba(229,9,20,.5);background:rgba(229,9,20,.08)}
/* Rows */
.rows{display:grid;gap:6px}
.row{display:grid;grid-template-columns:auto auto 1fr auto auto;gap:10px;align-items:center;padding:6px 6px 6px 6px;border-radius:12px;background:var(--panel2)}
.row.dragging{opacity:.4}.handle{cursor:grab;color:var(--muted);padding:4px 2px;user-select:none;touch-action:none}
.mv{display:flex;flex-direction:column}.mv button{background:transparent;color:var(--muted);padding:0 6px;font-size:12px;line-height:1.2;border-radius:6px}.mv button:hover{color:var(--text);background:#0d0d10}
.pill.g{min-width:52px;text-align:center;white-space:nowrap}.pill.fy{color:#ffb4b8;border-color:rgba(229,9,20,.45)}
.row input[type=text]{margin:0;background:transparent;border-color:transparent;padding:8px 10px}
.row:has(.sw:not(:checked)) input[type=text]{color:var(--muted)}
.row input[type=text]:hover,.row input[type=text]:focus{border-color:var(--line);background:#0d0d10}
.pill{font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.sw{appearance:none;-webkit-appearance:none;width:40px;height:24px;border-radius:999px;background:#3a3a44;position:relative;cursor:pointer;margin:0;flex:none;transition:background .15s}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s}
.sw:checked{background:var(--accent)}.sw:checked::after{transform:translateX(16px)}
.check{display:flex;align-items:center;gap:10px;font-weight:400;margin-top:12px}
/* Connections */
.conn{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border-radius:12px;background:var(--panel2);margin-top:10px}
.conn b{display:block}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#55555f;margin-right:6px}.dot.on{background:var(--ok)}
details.inline{margin-top:10px}details.inline>summary{list-style:none;cursor:pointer}details.inline>summary::-webkit-details-marker{display:none}
.code{font:700 30px ui-monospace,monospace;letter-spacing:.25em;margin:8px 0}
/* AI fields only for the selected provider */
.ai-only,.p-ollama,.p-openai,.p-anthropic,.p-gemini,.p-openrouter{display:none}
form:has(#aiProvider option:not([value=""]):checked) .ai-only{display:block}
${Object.keys(PROVIDERS).map((k) => `form:has(#aiProvider option[value="${k}"]:checked) .p-${k}`).join(',')}{display:block}
form:has(#metaSource option[value=cinemeta]:checked) .meta-only{display:none}
.jobs{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.job{display:grid;grid-template-columns:auto minmax(70px,auto) 1fr;gap:4px 10px;align-items:baseline;font-size:13px}
.job .dot{margin:0;align-self:center}.job.done .dot{background:var(--ok)}.job.error .dot{background:var(--accent)}
.job.running .dot,.job.queued .dot{background:#f5a524;animation:pulse .9s infinite alternate}@keyframes pulse{to{opacity:.25}}
.jobs.single .job{grid-template-columns:auto 1fr}.jobs.single .job b{display:none}
details.adv{margin-top:18px;border-top:1px solid var(--line);padding-top:14px}details.adv>summary{cursor:pointer;font-weight:600}
/* Save bar */
.bar{position:fixed;left:0;right:0;bottom:0;padding:12px 16px;background:var(--bg);border-top:1px solid var(--line)}
.bar>div{max-width:680px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
.install input{font:13px ui-monospace,monospace}
.top{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.top .btn,.top button{padding:7px 12px;font-size:13px}
.row-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.danger{color:#ff8a8f;border-color:rgba(229,9,20,.45)}
.foot{margin:40px 0 0;font-size:12px;color:var(--muted)}.foot p{margin:8px 0}.foot img{opacity:.8}
/* Step layout: sidebar on desktop, drawer on phones, one step at a time when JS runs */
main:has(.shell){max-width:1100px}
.shell{display:grid;grid-template-columns:230px minmax(0,1fr);gap:32px;align-items:start}
.js .step{margin-top:0}
.side{position:sticky;top:20px;display:flex;flex-direction:column;gap:2px}
.side-h{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 12px 6px}.side-h:first-child{margin-top:0}
.side a{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;color:var(--muted);text-decoration:none;font-weight:600}
.side a b{display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:50%;background:var(--panel2);border:1px solid var(--line);font-size:12px;color:var(--text)}
.side a:hover{background:var(--panel);color:var(--text)}
.side a[aria-current]{background:var(--panel);color:var(--text);box-shadow:inset 3px 0 0 var(--accent)}
.side a.done b{background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.5)}
.burger{display:none}.scrim{display:none}
.psw select{margin:0;padding:7px 30px 7px 12px;font-size:13px;font-weight:600;max-width:180px}.savebtns{display:inline-flex;gap:8px}
.js .step:not(.on),.js [data-steps]:not(.on){display:none}
.bar>div.wide{max-width:1100px;padding:0 16px 0 278px}.bar .sp{flex:1}
.pager{max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block}
#dirty{color:#ffb4b8}
.shell~.foot{margin-left:262px}
@media (max-width:860px){
  .shell{display:block}.burger{display:inline-flex}.pl,#dirty{display:none!important}.pager{max-width:none}.bar button{padding:10px 11px;font-size:14px;white-space:nowrap}.bar .actions{gap:6px}.bar>div.wide{padding:0}.shell~.foot{margin-left:0}
  .side{position:fixed;z-index:30;top:0;left:0;bottom:0;width:min(300px,84vw);overflow-y:auto;background:var(--bg);border-right:1px solid var(--line);padding:20px 12px;transform:translateX(-102%);transition:transform .2s}
  .nav-open .side{transform:none}.nav-open .scrim{display:block;position:fixed;inset:0;z-index:25;background:rgba(0,0,0,.55)}
}
.hero-cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:24px}
`;

// Attribution required by TMDB, plus "unofficial" notice and optional legal links (IMPRINT_URL / PRIVACY_URL)
const legal = { imprint: process.env.IMPRINT_URL, privacy: process.env.PRIVACY_URL };
const safeUrl = (u?: string) => (u && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '');
const FOOTER = `<footer class="foot"><a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer"><img src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg" alt="TMDB" width="90" height="12"></a>
<p>This product uses the TMDB API but is not endorsed or certified by TMDB. Couchpilot is an unofficial community project and not affiliated with Nuvio, TMDB, AniList, Trakt or Simkl.</p>
${[safeUrl(legal.imprint) && `<a href="${esc(safeUrl(legal.imprint))}" target="_blank" rel="noopener noreferrer">Imprint</a>`, safeUrl(legal.privacy) && `<a href="${esc(safeUrl(legal.privacy))}" target="_blank" rel="noopener noreferrer">Privacy</a>`].filter(Boolean).join(' · ')}</footer>`;

const page = (title: string, body: string, nonce = '', script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Couchpilot</title><link rel="icon" href="/logo.svg" type="image/svg+xml"><style>${CSS}</style></head>
<body><main>${body}${FOOTER}</main>${script && nonce ? `<script nonce="${esc(nonce)}">${script}</script>` : ''}</body></html>`;

const support = (url?: string) => (url ? `<a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Support ♥</a>` : '');
const brand = (extra = '') => `<div class="brand"><a href="/" class="home" aria-label="Couchpilot home"><img src="/logo.svg" alt="">Couchpilot</a><span class="sp"></span><div class="top">${extra}</div></div>`;

export const homePage = (publicUrl: string, supportUrl?: string, error?: string) =>
  page(
    'Home',
    `${brand(`${support(supportUrl)}<a class="btn ghost" href="/login">Log in</a>`)}
${error ? `<div class="note err">${esc(error)}</div>` : ''}
<h1>Your couch,<br>on autopilot.</h1>
<p class="lead">Personal rows for Nuvio: trending, new releases, anime and picks from your watch history, ranked by the AI of your choice. Replaces Cinemeta.</p>
<form method="post" action="/start"><button>Configure now</button></form>
<p class="small muted">No account needed. All you need is a free TMDB key. You can set a password at the end if you like.</p>
<div class="hero-cards">
<div class="sec" style="margin:0"><b>Already set up?</b><p class="small muted">Tap “Configure” on the addon in Nuvio, or log in with your account ID.</p><a class="btn ghost" href="/login">Log in</a></div>
<div class="sec" style="margin:0"><b>Anime rows only</b><p class="small muted">No setup and no TMDB key, plus search and metadata.</p><input type="text" readonly value="${esc(publicUrl)}/manifest.json"></div>
</div>`,
  );

export const loginPage = (error?: string, supportUrl?: string) =>
  page(
    'Log in',
    `${brand(`${support(supportUrl)}<a class="btn ghost" href="/">Back</a>`)}
<h1>Log in</h1><p class="lead">With your account ID and password.</p>
${error ? `<div class="note err">${esc(error)}</div>` : ''}
<form method="post" action="/login" class="sec">
<label>Account ID<input type="text" name="accountId" required maxlength="36" autocomplete="username" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></label>
<label>Password<input type="password" name="password" required maxlength="200" autocomplete="current-password"></label>
<div class="actions"><button>Log in</button></div></form>
<p class="small muted">No password set? Open the configuration via “Configure” on the addon in Nuvio.</p>`,
  );

// Sorting: arrows (phone) and drag & drop on the handle (desktop). The order of the hidden "order" inputs is saved.
// Live status: polls /status while a job is running.
const PAGE_JS = `
document.documentElement.classList.add('js');
const steps=[...document.querySelectorAll('.step')],links=[...document.querySelectorAll('.side a[href^="#"]')];
const prevB=document.getElementById('prev'),nextB=document.getElementById('next');
const idx=()=>steps.findIndex(x=>x.classList.contains('on'));
function show(id,scroll){let i=steps.findIndex(x=>x.id===id);if(i<0)i=0;const cur=steps[i],p=steps[i-1],n=steps[i+1];
steps.forEach(x=>x.classList.toggle('on',x===cur));
document.querySelectorAll('[data-steps]').forEach(e=>e.classList.toggle('on',e.dataset.steps.split(',').includes(cur.id)));
links.forEach(a=>a.getAttribute('href')==='#'+cur.id?a.setAttribute('aria-current','step'):a.removeAttribute('aria-current'));
prevB.hidden=!p;nextB.hidden=!n;if(p)prevB.querySelector('.pl').textContent=p.dataset.title;if(n)nextB.querySelector('.pl').textContent=n.dataset.title;
try{sessionStorage.setItem('cp-step',cur.id);}catch(e){}
history.replaceState(null,'','#'+cur.id);document.body.classList.remove('nav-open');if(scroll)window.scrollTo(0,0);}
links.forEach(a=>a.addEventListener('click',e=>{e.preventDefault();show(a.getAttribute('href').slice(1),true);}));
prevB.addEventListener('click',()=>show(steps[idx()-1].id,true));nextB.addEventListener('click',()=>show(steps[idx()+1].id,true));
let first=location.hash.slice(1);if(!first){try{first=sessionStorage.getItem('cp-step')||'';}catch(e){}}show(first,false);
const ps=document.getElementById('psel');ps&&ps.addEventListener('change',()=>ps.form.submit());
const bg=document.getElementById('burger');
bg.addEventListener('click',()=>{const o=document.body.classList.toggle('nav-open');bg.setAttribute('aria-expanded',String(o));});
document.getElementById('scrim').addEventListener('click',()=>{document.body.classList.remove('nav-open');bg.setAttribute('aria-expanded','false');});
const list=document.getElementById('rowlist');let drag=null;
// Unsaved changes: shown in the bar, and the browser asks before leaving the page
const cfg=document.getElementById('cfg'),dirtyEl=document.getElementById('dirty');let dirty=false;
const markDirty=()=>{dirty=true;dirtyEl.hidden=false;};
cfg.addEventListener('input',markDirty);cfg.addEventListener('change',markDirty);cfg.addEventListener('submit',()=>{dirty=false;});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
list.addEventListener('click',e=>{const b=e.target.closest('[data-mv]');if(!b)return;const r=b.closest('.row');
markDirty();if(b.dataset.mv==='up'&&r.previousElementSibling)list.insertBefore(r,r.previousElementSibling);
if(b.dataset.mv==='down'&&r.nextElementSibling)list.insertBefore(r.nextElementSibling,r);});
list.querySelectorAll('.handle').forEach(h=>{h.addEventListener('dragstart',e=>{drag=h.closest('.row');drag.classList.add('dragging');e.dataTransfer.effectAllowed='move';});
h.addEventListener('dragend',()=>{if(drag){drag.classList.remove('dragging');markDirty();}drag=null;});});
list.addEventListener('dragover',e=>{if(!drag)return;e.preventDefault();const r=e.target.closest('.row');if(!r||r===drag)return;
const b=r.getBoundingClientRect();list.insertBefore(drag,e.clientY<b.top+b.height/2?r:r.nextSibling);});
const jl=document.getElementById('jobs');
function jobLi(j){const li=document.createElement('li');li.className='job '+j.state;const d=document.createElement('span');d.className='dot';
const b=document.createElement('b');b.textContent=j.label;const t=document.createElement('span');t.className='muted';t.textContent=j.text||'not computed yet';li.append(d,b,t);return li;}
async function poll(){try{const r=await fetch('/status',{credentials:'same-origin'});const j=await r.json();
jl.replaceChildren(...j.jobs.map(jobLi));if(j.running)setTimeout(poll,3000);}catch(e){setTimeout(poll,10000);}}
if(jl&&(jl.dataset.running==='1'||/ok=(refresh|saved|savedall|synced|nuvio|trakt|simkl|imported|profile)/.test(location.search)))setTimeout(poll,1500);
const cb=document.getElementById('copyurl'),iu=document.getElementById('installurl');
cb&&cb.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(iu.value);}catch(e){iu.select();document.execCommand('copy');}
cb.textContent='Copied ✓';setTimeout(()=>cb.textContent='Copy URL',2000);});
iu&&iu.addEventListener('focus',()=>iu.select());
const imf=document.getElementById('importfile');
imf&&imf.addEventListener('change',async()=>{const f=imf.files[0];if(!f)return;if(f.size>20000){alert('File too large.');return;}
document.getElementById('importdata').value=await f.text();if(confirm('Replace this profile’s settings with the imported ones?'))document.getElementById('importform').submit();imf.value='';});
document.querySelectorAll('form[data-confirm]').forEach(f=>f.addEventListener('submit',e=>{if(!confirm(f.dataset.confirm))e.preventDefault();}));`;

const GROUP_PILL: Record<string, string> = { Movies: 'Movie', Series: 'Series', Anime: 'Anime' };

export function configPage(o: {
  nonce: string;
  accountId: string;
  profileId: string;
  profiles: { id: string; label: string; custom: boolean; nuvio?: string }[];
  defaultId: string;
  inheritedFrom?: string;
  nuvioShared?: boolean;
  hasPassword: boolean;
  installUrl: string;
  settings: Settings;
  secrets: Secrets;
  traktAvailable: boolean;
  traktPending: { userCode: string; url: string } | null;
  simklAvailable: boolean;
  simklPending: { userCode: string; url: string } | null;
  jobs: { id: string; label: string; text: string; running: boolean; state: string }[];
  aiUsage: { calls: number; in: number; out: number };
  supportUrl?: string;
  msg?: { ok: boolean; text: string };
}) {
  const s = o.settings;
  const isRoot = o.profileId === o.accountId;
  const rows = orderedRowIds(s)
    .map((id) => {
      const r = ROWS[id];
      const type = r.type === 'mixed' ? 'Mix' : r.type === 'movie' ? 'Movie' : 'Series';
      const pill = r.type === 'mixed' ? 'Mix' : r.group === 'Anime' ? (r.type === 'movie' ? 'Anime movie' : 'Anime') : type;
      return `<div class="row"><span class="handle" draggable="true" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
<input class="sw" type="checkbox" name="rows" value="${esc(id)}" aria-label="Show ${esc(r.name)}"${s.rows.includes(id) ? ' checked' : ''}>
<input type="text" name="name_${esc(id)}" maxlength="60" placeholder="${esc(r.name)}" value="${esc(s.names[id] ?? r.name)}" aria-label="Name for ${esc(r.name)}" title="${esc(GROUP_PILL[r.group] ?? r.group)} · ${type}">
<span class="pill g${r.personal ? ' fy' : ''}" title="${esc(r.group)}">${r.personal ? '★ ' : ''}${esc(pill)}</span>
<span class="mv"><button type="button" data-mv="up" aria-label="Move up">▲</button><button type="button" data-mv="down" aria-label="Move down">▼</button></span>
<input type="hidden" name="order" value="${esc(id)}"></div>`;
    })
    .join('');

  const conn = (name: string, on: boolean, detail: string, action: string) =>
    `<div class="conn"><div><b><span class="dot${on ? ' on' : ''}"></span>${name}</b><span class="small muted">${detail}</span></div>${action}</div>`;
  const pin = (name: string, p: { userCode: string; url: string }, check: string) =>
    `<div class="conn" style="display:block"><b>Confirm ${name}</b><p class="small muted" style="margin:4px 0">Open <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)}</a> and enter:</p>
<div class="code">${esc(p.userCode)}</div><form method="post" action="${check}"><button>I have confirmed</button></form></div>`;
  const disconnect = (path: string) => `<form method="post" action="${path}"><button class="ghost">Disconnect</button></form>`;
  const connect = (path: string) => `<form method="post" action="${path}"><button>Connect</button></form>`;

  const nuvio = o.nuvioShared
    ? conn('Nuvio Sync', true, `connected via the main profile's login${s.nuvioProfiles.length > 1 ? ', reads its own Nuvio profile' : ''}`, '')
    : o.secrets.nuvio
    ? conn('Nuvio Sync', true, `connected${s.nuvioProfiles.length > 1 ? ', every profile reads its own Nuvio profile (see step 5)' : ''}`, disconnect('/disconnect/nuvio'))
    : `<details class="inline"><summary>${conn('Nuvio Sync', false, 'not connected', '<span class="btn">Connect</span>')}</summary>
<form method="post" action="/connect/nuvio" class="sec" style="margin-top:8px">
<p class="small muted" style="margin:0">Your Nuvio login. The password is used once to sign in and is never stored.</p>
<label>Nuvio email<input type="email" name="email" required maxlength="200" autocomplete="off"></label>
<label>Nuvio password<input type="password" name="password" required maxlength="200" autocomplete="off"></label>
<div class="actions"><button>Connect Nuvio</button></div></form></details>`;
  const trakt = !o.traktAvailable
    ? conn('Trakt', false, 'not set up on this server', '')
    : o.secrets.trakt
      ? conn('Trakt', true, 'connected', disconnect('/disconnect/trakt'))
      : o.traktPending
        ? pin('Trakt', o.traktPending, '/connect/trakt/check')
        : conn('Trakt', false, 'not connected', connect('/connect/trakt'));
  const simkl = !o.simklAvailable
    ? conn('Simkl', false, 'not set up on this server', '')
    : o.secrets.simkl
      ? conn('Simkl', true, 'connected', disconnect('/disconnect/simkl'))
      : o.simklPending
        ? pin('Simkl', o.simklPending, '/connect/simkl/check')
        : conn('Simkl', false, 'not connected', connect('/connect/simkl'));
  const anilist = conn('AniList', !!s.anilistUser, s.anilistUser ? `@${esc(s.anilistUser)} (public list)` : 'enter your username in step 2', '');

  const hasHistory = !!(o.secrets.nuvio || o.secrets.trakt || o.secrets.simkl || s.anilistUser);
  const tmdb = o.secrets.tmdbKey;
  const ai = s.ai;
  const providerHints = Object.entries(PROVIDERS)
    .map(
      ([k, p]) =>
        `<span class="small muted p-${k}">${k === 'ollama' ? 'Key only needed if your Ollama requires one. ' : ''}Default model: <code>${esc(p.model)}</code> · <a href="${esc(p.keyUrl)}" target="_blank" rel="noopener noreferrer">${k === 'ollama' ? 'Set up Ollama' : `Get a ${esc(p.label)} API key`} ↗</a></span>`,
    )
    .join('');
  const multi = o.profiles.length > 1;
  const profileSelect = multi
    ? `<form method="post" action="/profile/switch" class="psw"><select name="id" id="psel" aria-label="Profile">${o.profiles
        .map((p) => `<option value="${esc(p.id)}"${p.id === o.profileId ? ' selected' : ''}>${esc(p.label)}</option>`)
        .join('')}</select><noscript><button class="ghost">Switch</button></noscript></form>`
    : '';
  // AI cost: real usage of the last 30 days plus an estimate for the chosen refresh interval
  const price = ai.provider ? priceFor(ai) : null;
  const usd = (i: number, out: number) => (price ? (i * price[0] + out * price[1]) / 1e6 : null);
  const money = (v: number | null) => (v === null ? 'price unknown for this model' : v < 0.01 ? '< $0.01' : `≈ $${v.toFixed(2)}`);
  const runsPerMonth = Math.min(24 / s.refreshHours, 40 / EST_CALLS_PER_RUN) * 30;
  const estIn = runsPerMonth * EST_CALLS_PER_RUN * EST_CALL.in;
  const estOut = runsPerMonth * EST_CALLS_PER_RUN * EST_CALL.out;
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const usageBox = ai.provider
    ? `<div class="conn" style="display:block"><b>Cost</b>
<p class="small muted" style="margin:4px 0">Last 30 days: ${o.aiUsage.calls} calls, ${k(o.aiUsage.in)} in / ${k(o.aiUsage.out)} out tokens, ${money(usd(o.aiUsage.in, o.aiUsage.out))}</p>
<p class="small muted" style="margin:0">Estimate when you use Nuvio daily, refreshing every ${s.refreshHours} h: ${money(usd(estIn, estOut))} per month (max. 40 calls/day). ${ai.provider === 'ollama' ? 'Ollama runs on your own hardware, so there are no API costs.' : 'Prices are list prices and may change; your provider’s dashboard is exact.'}</p></div>`
    : '';
  const label = (id: string) => o.profiles.find((p) => p.id === id)?.label ?? 'default profile';
  const inherit = !!o.inheritedFrom;
  const scopeNote = multi
    ? `<div class="note" data-steps="rows,ai,settings">${inherit
        ? `<b>${esc(label(o.profileId))} uses the shared settings.</b> “Save for all” keeps every profile in sync, “Only this profile” fine-tunes just this one.`
        : `<b>${esc(label(o.profileId))} has its own settings.</b> “Save for all” applies them to every profile, “Only this profile” keeps them here.`}</div>`
    : '';
  const steps: [string, string, boolean][] = [
    ['history', 'Watch history', hasHistory],
    ['rows', 'Rows', false],
    ['ai', 'AI', !!ai.provider],
    ['settings', 'Settings', !!tmdb],
    ['profiles', 'Profiles', multi],
    ['finish', 'Install & account', false],
  ];
  return page(
    'Configure',
    `${brand(`${support(o.supportUrl)}${o.hasPassword ? '<form method="post" action="/logout"><button class="ghost">Log out</button></form>' : ''}${profileSelect}<button type="button" class="ghost burger" id="burger" aria-label="Menu" aria-expanded="false" aria-controls="side">☰</button>`)}
<div class="shell">
<nav class="side" id="side" aria-label="Setup steps">
<p class="side-h">Setup</p>
${steps.map(([id, title, done], i) => `<a href="#${id}"${done ? ' class="done"' : ''}><b>${done ? '✓' : i + 1}</b>${title}</a>`).join('')}
</nav>
<div class="scrim" id="scrim"></div>
<div class="content">
${o.msg ? `<div class="note ${o.msg.ok ? 'ok' : 'err'}">${esc(o.msg.text)}</div>` : ''}
${tmdb ? '' : '<div class="note err"><b>TMDB key missing.</b> Without it, movie, series and For You rows stay empty. Get one for free and add it in step 4.</div>'}

<section class="sec step" id="history" data-title="Watch history"><h2><b>1</b>Watch history</h2>
<p class="sub">Your “For You” rows are built from this. Read-only, nothing is ever changed.</p>
${nuvio}${trakt}${simkl}${anilist}
${hasHistory || multi ? `<div class="actions">${hasHistory ? `<form method="post" action="/refresh"><button class="ghost">Recompute${multi ? ' this profile' : ' For You rows'}</button></form>` : ''}${multi ? `<form method="post" action="/refresh"><input type="hidden" name="all" value="1"><button class="ghost">Recompute all profiles</button></form>` : ''}</div>` : ''}
<h3>${multi ? 'Status per profile' : 'Last run'}</h3>
<ul class="jobs${multi ? '' : ' single'}" id="jobs" data-running="${o.jobs.some((j) => j.running) ? '1' : '0'}">${(multi ? o.jobs : o.jobs.filter((j) => j.id === o.profileId))
  .map((j) => `<li class="job ${esc(j.state)}"><span class="dot"></span><b>${esc(j.label)}</b><span class="muted">${esc(j.text || 'not computed yet')}</span></li>`)
  .join('')}</ul>
</section>

${scopeNote}
<form method="post" action="/configure" id="cfg">
<section class="sec step" id="rows" data-title="Rows"><h2><b>2</b>Rows</h2>
<p class="sub">Toggle = show, ★ = from your watch history. Reorder with the arrows or drag the handle. Click a name to rename it, empty = default name. “Mix” shows movies and series in one row.</p>
<div class="rows" id="rowlist">${rows}</div>
${s.nuvioProfiles.length > 1 ? `<label>Nuvio profile for this profile’s “For You” rows<select name="nuvioProfile">${s.nuvioProfiles.map((p) => `<option value="${p.index}"${p.index === s.nuvioProfile ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
<label>AniList username<span>Optional, for anime recommendations. Your list must be public.</span><input type="text" name="anilistUser" maxlength="20" value="${esc(s.anilistUser)}" placeholder="e.g. timon"></label>
</section>

<section class="sec step" id="ai" data-title="AI"><h2><b>3</b>AI</h2>
<p class="sub">Optional. Ranks the For You rows by your taste, names genre mixes and writes short reasons. Without AI you get a default ranking.</p>
<label>Provider<select name="aiProvider" id="aiProvider"><option value="">No AI</option>${Object.entries(PROVIDERS)
      .map(([k, v]) => `<option value="${k}"${k === ai.provider ? ' selected' : ''}>${esc(v.label)}</option>`)
      .join('')}</select></label>
<label class="p-ollama">Ollama URL<span>Publicly reachable over https, e.g. via a Cloudflare Tunnel.</span><input type="text" name="aiBaseUrl" maxlength="300" value="${esc(ai.baseUrl)}" placeholder="https://ollama.your-domain.com"></label>
<div class="ai-only">
<label>API key${o.secrets.aiKey ? `<span>Saved: <code>${esc(mask(o.secrets.aiKey))}</code>. Leave empty to keep it. For security it is deleted when you switch provider.</span>` : ''}<input type="password" name="aiKey" maxlength="400" autocomplete="off" placeholder="${o.secrets.aiKey ? '••••••••' : 'Paste your key'}"></label>
<div style="margin-top:6px">${providerHints}</div>
${o.secrets.aiKey ? '<label class="check"><input class="sw" type="checkbox" name="removeAiKey" value="1">Delete saved key</label>' : ''}
<label>Model<span>Empty = the provider’s default model.</span><input type="text" name="aiModel" maxlength="100" value="${esc(ai.model)}"></label>
<label>Your wishes<span>The AI takes this into account every time.</span><textarea name="aiPrompt" maxlength="500" placeholder="e.g. more thrillers and sci-fi, no rom-coms, older classics are welcome">${esc(s.aiPrompt)}</textarea></label>
<label class="check"><input class="sw" type="checkbox" name="aiReasons" value="1"${s.aiReasons ? ' checked' : ''}>Short reason in the description (“Because you liked Dark …”)</label>
${usageBox}
<p class="small muted">At most 40 AI calls per day, so your key can’t be drained.</p>
</div>
</section>

<section class="sec step" id="settings" data-title="Settings"><h2><b>4</b>Settings</h2>
<label>TMDB API key<span>${tmdb ? `Saved: <code>${esc(mask(tmdb))}</code>. Leave empty to keep it.` : 'Required for movie, series and For You rows.'} <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">Get one for free ↗</a></span>
<input type="password" name="tmdbKey" placeholder="${tmdb ? '••••••••' : 'API key or read access token'}" autocomplete="off" maxlength="400"></label>
${tmdb ? '<label class="check"><input class="sw" type="checkbox" name="removeTmdb" value="1">Delete saved key</label>' : ''}
<label>Refresh rows<select name="refreshHours">${REFRESH_HOURS.map((h) => `<option value="${h}"${h === s.refreshHours ? ' selected' : ''}>every ${h} hour${h > 1 ? 's' : ''}</option>`).join('')}</select></label>
<label>Metadata source<span>Detail pages and episodes. “Enhanced” keeps Cinemeta’s IMDb rating and episode IDs and adds TMDB on top. Needs the TMDB key.</span><select name="metaSource" id="metaSource">
<option value="enhanced"${s.meta.source === 'enhanced' ? ' selected' : ''}>Enhanced (Cinemeta + TMDB)</option>
<option value="cinemeta"${s.meta.source === 'cinemeta' ? ' selected' : ''}>Cinemeta only</option></select></label>
<div class="meta-only">
<label class="check"><input class="sw" type="checkbox" name="metaLocalize" value="1"${s.meta.localize ? ' checked' : ''}>Titles, descriptions, genres and episode names in the metadata language</label>
<label class="check"><input class="sw" type="checkbox" name="metaCast" value="1"${s.meta.cast ? ' checked' : ''}>Cast and director/creator</label>
<label class="check"><input class="sw" type="checkbox" name="metaTrailers" value="1"${s.meta.trailers ? ' checked' : ''}>Trailers (YouTube)</label>
<label class="check"><input class="sw" type="checkbox" name="metaEpisodes" value="1"${s.meta.episodes ? ' checked' : ''}>Episode thumbnails and plots</label>
<p class="small muted" style="margin:6px 0 0">Always included: HD background, localized poster and title logo.</p>
</div>
<label>Metadata language<select name="language">${Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}"${k === s.language ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
<label>Time zone<span>For the time-of-day row (feel-good, late night, weekend).</span><select name="timezone">${TIMEZONES.map((t) => `<option${t === s.timezone ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
</section>
</form>

<section class="sec step" id="profiles" data-title="Profiles"><h2><b>5</b>Profiles</h2>
<p class="sub">One profile per Nuvio profile, each with its own watch history and install URL. Switch profiles at the top. Settings are shared unless you save them for one profile only.</p>
${o.profiles
  .map(
    (p) => `<div class="conn"><div><b>${esc(p.label)}${p.id === o.profileId ? ' <span class="pill">open</span>' : ''}</b>
<span class="small muted">${p.nuvio ? `Nuvio: ${esc(p.nuvio)} · ` : ''}${p.custom ? 'own settings' : 'shared settings'}</span></div>
<div class="row-actions">${p.custom && p.id === o.profileId && p.id !== o.defaultId ? `<form method="post" action="/profile/inherit"><input type="hidden" name="on" value="1"><button class="ghost">Use shared settings</button></form>` : ''}
${p.id === o.accountId ? '' : `<form method="post" action="/profile/delete" data-confirm="Delete profile “${esc(p.label)}”? Its install URL stops working."><input type="hidden" name="id" value="${esc(p.id)}"><button class="ghost danger" aria-label="Delete profile ${esc(p.label)}">Delete</button></form>`}</div></div>`,
  )
  .join('')}
${o.secrets.nuvio ? `<form method="post" action="/profile/sync"><div class="actions"><button class="ghost">Import profiles from Nuvio</button></div></form>` : '<p class="small muted">Connect Nuvio Sync in step 1 and your Nuvio profiles are added automatically.</p>'}
<details class="adv"><summary class="muted">Add a profile manually</summary>
<form method="post" action="/profile/new"><label>Name<input type="text" name="label" maxlength="30" placeholder="e.g. Lisa" required></label>
<div class="actions"><button class="ghost">Create profile</button></div></form></details>
</section>

<section class="sec step" id="finish" data-title="Install & account"><h2><b>6</b>Install &amp; account</h2>
<h3 style="margin-top:6px">Install${multi ? ` · ${esc(label(o.profileId))}` : ''}</h3>
<p class="small muted" style="margin:0 0 8px">Save first, then add this URL in Nuvio under Addons${multi ? ', in the matching Nuvio profile. Every profile has its own URL, so turn off “Use primary addons” for that profile in Nuvio' : ''}. Treat it like a password: whoever has it can change your settings (but nobody can see your keys).</p>
<input type="text" readonly value="${esc(o.installUrl)}" id="installurl">
<div class="actions"><button type="button" id="copyurl">Copy URL</button>
<form method="post" action="/configure/token"><button class="ghost">Generate new URL</button></form></div>
<p class="small muted">A new URL disables the old one immediately and signs out other devices.</p>
<h3>Account <span class="pill">optional</span></h3>
<p class="small muted" style="margin:0">Your account ID: <code>${esc(o.accountId)}</code></p>
<p class="small muted">${o.hasPassword ? 'Password is set. You can always log in with your account ID and password.' : 'Without a password you can only get back here via “Configure” on the addon in Nuvio. With a password you can also log in with your account ID.'}</p>
<form method="post" action="/account/password">
<input type="text" name="username" value="${esc(o.accountId)}" autocomplete="username" hidden>
<label>${o.hasPassword ? 'New password' : 'Set a password'}<span>At least 10 characters.</span><input type="password" name="password" required minlength="10" maxlength="200" autocomplete="new-password"></label>
<label>Repeat password<input type="password" name="password2" required minlength="10" maxlength="200" autocomplete="new-password"></label>
<div class="actions"><button class="ghost">${o.hasPassword ? 'Change password' : 'Save password'}</button></div></form>
<h3>Backup</h3>
<p class="small muted" style="margin:0 0 8px">Don’t want a password? Export your settings as a file and import them later or on another instance. Watch-history logins are never included.</p>
<form method="post" action="/export"><label class="check"><input class="sw" type="checkbox" name="keys" value="1">Include TMDB and AI keys (keep the file private)</label>
<div class="actions"><button class="ghost">Export settings</button></div></form>
<form method="post" action="/import" id="importform"><input type="hidden" name="data" id="importdata">
<div class="actions"><label class="btn ghost" style="margin:0">Import settings<input type="file" accept="application/json,.json" id="importfile" hidden></label></div></form>
<details class="adv"><summary class="muted">${isRoot ? 'Delete account' : 'Delete this profile'}</summary>
<form method="post" action="/account/delete"><p class="small muted">${isRoot ? 'Permanently deletes the account, all profiles, keys and settings.' : 'Deletes only this profile.'}</p>
<label class="check"><input class="sw" type="checkbox" name="confirm" value="yes" required>Yes, delete permanently</label>
<div class="actions"><button>Delete permanently</button></div></form></details>
</section>

</div></div>
<div class="bar"><div class="actions wide" style="margin:0 auto;flex-wrap:nowrap"><button type="button" class="ghost pager" id="prev" hidden>← <span class="pl"></span></button><span class="sp"></span><span class="small" id="dirty" hidden>Unsaved changes</span><span id="savebtn" class="savebtns">${multi ? '<button form="cfg" name="scope" value="this" class="ghost">Only this profile</button><button form="cfg" name="scope" value="all">Save for all</button>' : '<button form="cfg" name="scope" value="this">Save</button>'}</span><button type="button" class="ghost pager" id="next" hidden><span class="pl"></span> →</button></div></div>`,
    o.nonce,
    PAGE_JS,
  );
}
