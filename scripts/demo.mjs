// Records a demo video of the extension from the holodeck.
//
//   make demo        # writes promo/demo.mp4, promo/demo.gif and promo/stills/*.png
//
// A headless browser runs the extension. A local "stage" page composes, per
// frame, a live map of the browser's windows and tabs (left) with a screenshot
// of the popup (right), a cursor and a caption. Each composed frame is captured
// to PNG and ffmpeg assembles the video. ffmpeg comes from ffmpeg-static,
// installed into the holodeck (make demo does this).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(EXT, 'promo');
const STILLS = join(OUT, 'stills');
const HOLODECK = process.env.HOLODECK || join(homedir(), '.holodeck');
const FFMPEG = process.env.FFMPEG || join(HOLODECK, 'tools', 'node_modules', 'ffmpeg-static', 'ffmpeg');
if (!existsSync(FFMPEG)) {
    console.error(`ffmpeg not found at ${FFMPEG}. Run: npm install --prefix ~/.holodeck/tools ffmpeg-static`);
    process.exit(2);
}
const CANDIDATES = [
    process.env.BROWSER,
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
].filter(Boolean);
const CHROME = CANDIDATES.find((c) => existsSync(c));
if (!CHROME) {
    console.error('No Chromium-based browser found. Set BROWSER=/path/to/binary');
    process.exit(2);
}
const PORT = Number(process.env.PORT) || 9340;
const FPS = 12;
const W = 1280;
const H = 720;
const SCALE = 1.5; // 1920x1080 output
const POPUP_W = 340;
const POPUP_H = 580;
const POPUP_X = W - POPUP_W - 40;
const POPUP_Y = 40;

mkdirSync(join(HOLODECK, 'tmp'), { recursive: true });
mkdirSync(STILLS, { recursive: true });
const profile = mkdtempSync(join(HOLODECK, 'tmp', 'organize-tabs-demo-'));
const framesDir = join(profile, 'frames');
mkdirSync(framesDir);

const chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
async function waitFor(pred, tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const t = (await targets()).find(pred); if (t) return t; } catch (e) { /* not up */ }
        await sleep(250);
    }
    throw new Error('timeout waiting for target');
}
class CDP {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map();
        ws.addEventListener('message', (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
                msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
            }
        });
    }
    static async connect(url) { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return new CDP(ws); }
    send(m, p = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
    async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
}
async function findExtensionId() {
    for (let i = 0; i < 60; i++) {
        let list = [];
        try { list = await targets(); } catch (e) { /* not up */ }
        for (const t of list.filter((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'))) {
            try {
                const cdp = await CDP.connect(t.webSocketDebuggerUrl);
                const name = await cdp.eval('chrome.runtime.getManifest().name');
                cdp.ws.close();
                if (name === 'Organize Tabs') return new URL(t.url).host;
            } catch (e) { /* next */ }
        }
        await sleep(250);
    }
    throw new Error('extension not found');
}

// ----- the stage page --------------------

const icon = readFileSync(join(EXT, 'img', 'icon128.png')).toString('base64');
const STAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif;color:#eef0f6;-webkit-font-smoothing:antialiased}
body{background:radial-gradient(1200px 700px at 20% 0%,#2a2f52 0%,#12141c 60%,#0c0d13 100%)}
#map{position:absolute;left:40px;top:40px;width:${POPUP_X - 80}px;height:${H - 150}px;display:flex;flex-direction:column;gap:14px;overflow:hidden}
.win{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:10px 12px;transition:all .2s}
.win.focused{border-color:#7d8bff;box-shadow:0 0 0 1px #7d8bff44, 0 10px 30px rgba(0,0,0,.4)}
.win h3{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9aa0b8;display:flex;gap:8px;align-items:center}
.win h3 .dots{display:inline-flex;gap:4px}.win h3 .dots i{width:8px;height:8px;border-radius:50%;background:#3a3f55;display:block}
.win h3 .dots i:nth-child(1){background:#ff5f57}.win h3 .dots i:nth-child(2){background:#febc2e}.win h3 .dots i:nth-child(3){background:#28c840}
.win h3 .n{margin-left:auto;font-weight:500;letter-spacing:0;text-transform:none}
.strip{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tab{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:7px;background:#232736;border:1px solid rgba(255,255,255,.08);font-size:12.5px;white-space:nowrap;color:#dfe2ec}
.tab.active{background:#2d3246;border-color:rgba(255,255,255,.25)}
.tab.pinned{padding:5px 7px}
.tab .fav{width:12px;height:12px;border-radius:3px;background:#5b6cff;flex:0 0 12px;opacity:.9}
.tab .sub{color:#8f95ad;font-size:11px}
.grp{display:inline-flex;align-items:center;gap:6px;padding:3px 6px 3px 4px;border-radius:9px;border:2px solid var(--c)}
.grp .gl{font-size:11px;font-weight:700;color:#0c0d13;background:var(--c);padding:1px 7px;border-radius:6px}
.media{color:#ff6b6b}
#popup{position:absolute;left:${POPUP_X}px;top:${POPUP_Y}px;width:${POPUP_W}px;height:${POPUP_H}px;border-radius:14px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08);background:#1b1e29}
#popup img{display:block;width:${POPUP_W}px;height:${POPUP_H}px}
#caption{position:absolute;left:40px;right:${W - POPUP_X + 24}px;bottom:34px;font-size:22px;line-height:1.3;color:#eef0f6;display:flex;align-items:center;gap:14px}
#caption img{width:28px;height:28px;border-radius:7px}
#caption b{font-weight:650}
#cursor{position:absolute;width:22px;height:30px;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));z-index:10}
#overlay{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:radial-gradient(1200px 700px at 30% 0%,#2a2f52 0%,#12141c 60%,#0c0d13 100%);z-index:20;text-align:center}
#overlay img{width:96px;height:96px;border-radius:22px;margin-bottom:26px}
#overlay h1{margin:0 0 12px;font-size:58px;letter-spacing:-0.025em}
#overlay p{margin:0;font-size:24px;color:#b4b9d0;max-width:760px;line-height:1.4}
#overlay .url{margin-top:28px;font-size:22px;color:#7d8bff}
.hidden{display:none}
</style></head><body>
<div id="map"></div>
<div id="popup"><img id="popupimg" alt=""></div>
<div id="caption"><img src="data:image/png;base64,${icon}"><span id="captiontext"></span></div>
<svg id="cursor" viewBox="0 0 22 30"><path d="M2 2 L2 23 L7.5 18 L11 27 L15 25.5 L11.5 17 L19 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>
<div id="overlay"><img src="data:image/png;base64,${icon}"><h1 id="ovh"></h1><p id="ovp"></p><div class="url" id="ovu"></div></div>
<script>
const COLORS={grey:'#9aa0b8',blue:'#7d8bff',red:'#ff6b6b',yellow:'#ffd166',green:'#4cd08a',pink:'#ff7ab6',purple:'#b388ff',cyan:'#5fd4e8',orange:'#ffa052'};
function host(u){try{const h=new URL(u).hostname.replace(/^www\\./,'');return h}catch{return u}}
function short(u){const h=host(u);if(h==='youtu.be')return 'youtube';const p=h.split('.');if(p.length<=2)return p[0];const s=new Set(['co','com','org','net']);let i=p.length-2;if(s.has(p[i])&&p[i+1].length===2&&i>0)i-=1;return p[i]}
function pathBit(u){try{const x=new URL(u);const parts=x.pathname.split('/').filter(Boolean);if(x.hostname.includes('meet.google'))return 'call';if(x.hostname.includes('youtube'))return 'video';if(parts.length===0)return '';const last=parts[parts.length-1];return parts.length>=2&&/^(pull|issues|in|browse)$/.test(parts[parts.length-2])?parts[parts.length-2]+'/'+last:last}catch{return ''}}
window.__idx=window.__idx||{};
window.render=function(s){
  const map=document.getElementById('map');map.innerHTML='';
  for(const w of s.windows){
    const tabs=s.tabs.filter(t=>t.windowId===w.id&&!/^(chrome-extension|file|chrome):/.test(t.url));
    if(tabs.length===0)continue;
    if(!window.__idx[w.id])window.__idx[w.id]=Object.keys(window.__idx).length+1;
    const div=document.createElement('div');div.className='win'+(w.focused?' focused':'');
    div.innerHTML='<h3><span class="dots"><i></i><i></i><i></i></span>Window '+window.__idx[w.id]+'<span class="n">'+tabs.length+' tab'+(tabs.length===1?'':'s')+'</span></h3>';
    const strip=document.createElement('div');strip.className='strip';
    let i=0;
    while(i<tabs.length){
      const t=tabs[i];
      if(t.groupId!==-1){
        const g=s.groups.find(g=>g.id===t.groupId);
        const wrap=document.createElement('span');wrap.className='grp';wrap.style.setProperty('--c',COLORS[g?g.color:'grey']||'#9aa0b8');
        wrap.innerHTML='<span class="gl">'+((g&&g.title)||'')+'</span>';
        while(i<tabs.length&&tabs[i].groupId===t.groupId){wrap.appendChild(chip(tabs[i],s));i++}
        strip.appendChild(wrap);
      }else{strip.appendChild(chip(t,s));i++}
    }
    div.appendChild(strip);map.appendChild(div);
  }
  document.getElementById('popupimg').src='data:image/png;base64,'+s.popup;
  document.getElementById('captiontext').innerHTML=s.caption||'';
  const c=document.getElementById('cursor');c.style.left=s.cursor.x+'px';c.style.top=s.cursor.y+'px';c.style.display=s.cursor.hidden?'none':'block';
  const ov=document.getElementById('overlay');
  if(s.overlay){ov.style.display='flex';document.getElementById('ovh').textContent=s.overlay.title;document.getElementById('ovp').textContent=s.overlay.text;document.getElementById('ovu').textContent=s.overlay.url||''}else{ov.style.display='none'}
  return true;
};
function chip(t,s){const e=document.createElement('span');e.className='tab'+(t.active?' active':'')+(t.pinned?' pinned':'');
  const media=t.audible||/meet\\.google|youtube\\.com\\/watch/.test(t.url);
  e.innerHTML='<span class="fav" style="background:'+hue(host(t.url))+'"></span>'+(t.pinned?'📌':'')+(media?'<span class="media">●</span>':'')+'<span>'+short(t.url)+'</span>'+(pathBit(t.url)&&!t.pinned?'<span class="sub">'+pathBit(t.url)+'</span>':'');
  return e}
function hue(h){let x=0;for(const ch of h)x=(x*31+ch.charCodeAt(0))>>>0;return 'hsl('+(x%360)+' 70% 62%)'}
</script></body></html>`;

// ----- recording helpers --------------------

let frameNo = 0;
let cursor = { x: W / 2, y: H / 2, hidden: false };
let caption = '';
let overlay = null;
let popup, stage, windowIndex = {};

async function snapshot() {
    const [tabs, windows, groups] = await Promise.all([
        popup.eval('chrome.tabs.query({})'),
        popup.eval("chrome.windows.getAll({ windowTypes: ['normal'] })"),
        popup.eval('chrome.tabGroups.query({})')
    ]);
    for (const w of windows) {
        if (!windowIndex[w.id]) windowIndex[w.id] = Object.keys(windowIndex).length + 1;
    }
    const shot = await popup.send('Page.captureScreenshot', { format: 'png' });
    return { tabs, windows, groups, popup: shot.data, windowIndex };
}

async function frame(count = 1) {
    const s = await snapshot();
    const state = { ...s, cursor, caption, overlay };
    await stage.send('Runtime.evaluate', { expression: `window.render(${JSON.stringify(state)})`, awaitPromise: true, returnByValue: true });
    await sleep(40);
    const shot = await stage.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    for (let i = 0; i < count; i++) {
        writeFileSync(join(framesDir, `f${String(frameNo++).padStart(5, '0')}.png`), buf);
    }
    return buf;
}

async function still(name) {
    const buf = await frame(1);
    writeFileSync(join(STILLS, name), buf);
}

const ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

async function moveTo(x, y, frames = 10) {
    const from = { ...cursor };
    for (let i = 1; i <= frames; i++) {
        const t = ease(i / frames);
        cursor = { x: from.x + (x - from.x) * t, y: from.y + (y - from.y) * t, hidden: false };
        await frame();
    }
}

// Centre of a popup element, in stage coordinates.
async function popupTarget(selectorExpr) {
    const r = await popup.eval(`(() => { const el = ${selectorExpr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!r) throw new Error(`popup element not found: ${selectorExpr}`);
    return { x: POPUP_X + r.x, y: POPUP_Y + r.y };
}

async function clickPopup(selectorExpr, { settle = 10, before = 10 } = {}) {
    const p = await popupTarget(selectorExpr);
    await moveTo(p.x, p.y, before);
    await popup.eval(`(() => { const el = ${selectorExpr}; el.click(); return true; })()`);
    await sleep(500);
    for (let i = 0; i < settle; i++) await frame();
}

const action = (name) => `[...document.querySelectorAll('.action')].find((b) => b.textContent.includes(${JSON.stringify(name)}))`;

async function say(text, hold = 0) {
    caption = text;
    for (let i = 0; i < hold; i++) await frame();
}

// ----- the storyboard --------------------

try {
    const extId = await findExtensionId();
    const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browser = await CDP.connect(info.webSocketDebuggerUrl);

    // The stage and the popup each live in a window of type "popup". The
    // extension only ever touches windows of type "normal", so the demo's own
    // pages are invisible to every action and to the stats. A bootstrap tab
    // creates them, then closes itself.
    const stageFile = join(profile, 'stage.html');
    writeFileSync(stageFile, STAGE_HTML);
    const popupUrl = `chrome-extension://${extId}/src/popup.html`;
    await browser.send('Target.createTarget', { url: `${popupUrl}?bootstrap` });
    const bootT = await waitFor((t) => t.url === `${popupUrl}?bootstrap`);
    const boot = await CDP.connect(bootT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) {
        if (await boot.eval(`typeof chrome !== 'undefined' && !!chrome.windows && location.protocol === 'chrome-extension:'`).catch(() => false)) break;
        await sleep(250);
    }
    await boot.eval(`chrome.windows.create({ url: 'file://${stageFile}', type: 'popup', width: ${W}, height: ${H}, focused: false })`);
    await boot.eval(`chrome.windows.create({ url: '${popupUrl}', type: 'popup', width: ${POPUP_W}, height: ${POPUP_H}, focused: false })`);
    await sleep(800);
    const stageT = await waitFor((t) => t.url === `file://${stageFile}`);
    stage = await CDP.connect(stageT.webSocketDebuggerUrl);
    await stage.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
    await stage.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const popupT = await waitFor((t) => t.url === popupUrl);
    popup = await CDP.connect(popupT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) {
        if (await popup.eval(`typeof chrome !== 'undefined' && !!chrome.windows && location.protocol === 'chrome-extension:'`).catch(() => false)) break;
        await sleep(250);
    }
    await popup.send('Emulation.setDeviceMetricsOverride', { width: POPUP_W, height: POPUP_H, deviceScaleFactor: 2, mobile: false });
    await popup.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    // close the bootstrap tab and the browser's initial blank tab
    await popup.eval(`(async () => { const all = await chrome.tabs.query({}); const me = await chrome.tabs.getCurrent(); for (const t of all) { if (t.id !== me.id && (t.url.includes('?bootstrap') || t.url === 'about:blank')) { try { await chrome.tabs.remove(t.id); } catch (e) {} } } })()`);
    boot.ws.close();
    await popup.eval(`chrome.storage.sync.set({ settings: { confirmClose: true, showBadge: false } })`);

    // seed: three messy windows
    const W1 = [
        'https://github.com/dataro/app/pull/482',
        'https://github.com/dataro/app/pull/482/files',
        'https://github.com/dataro/app/pull/482/checks',
        'https://github.com/dataro/app/pull/479',
        'https://dataro.atlassian.net/browse/ENG-1201',
        'https://www.linkedin.com/in/alex-example/',
        'https://www.linkedin.com/in/alex-example/details/experience/',
        'https://meet.google.com/abc-defg-hij',
        'https://news.ycombinator.com/',
        'chrome://newtab/'
    ];
    const W2 = [
        'https://docs.google.com/document/d/1AbCdEf/edit',
        'https://docs.google.com/document/d/1AbCdEf/edit#heading=h.2',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ?si=share',
        'https://www.linkedin.com/in/sam-example/',
        'https://github.com/dataro/app/issues/77',
        'https://dataro.atlassian.net/jira/software/c/projects/ENG/boards/3?selectedIssue=ENG-1201'
    ];
    const W3 = [
        'https://en.wikipedia.org/wiki/Tab_(interface)',
        'https://en.wikipedia.org/wiki/Tab_(interface)?utm_source=x#History',
        'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster',
        'https://www.linkedin.com/in/jordan-example/',
        'chrome://newtab/'
    ];
    const w1 = await popup.eval(`chrome.windows.create({ url: ${JSON.stringify(W1)}, focused: false })`);
    await popup.eval(`chrome.windows.create({ url: ${JSON.stringify(W2)}, focused: false })`);
    await popup.eval(`chrome.windows.create({ url: ${JSON.stringify(W3)}, focused: false })`);
    await sleep(1500);
    await popup.eval(`(async () => { const [t] = await chrome.tabs.query({ url: 'https://news.ycombinator.com/' }); await chrome.tabs.update(t.id, { pinned: true }); const [li] = await chrome.tabs.query({ url: 'https://www.linkedin.com/in/alex-example/' }); await chrome.tabs.update(li.id, { active: true }); await chrome.windows.update(${w1.id}, { focused: true }); })()`);
    // drop any stray normal window that holds nothing but blank tabs (the
    // browser's initial window), so consolidate has no surprise target
    await popup.eval(`(async () => { const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }); for (const w of wins) { if (w.tabs.every((t) => t.url === 'about:blank' || t.url === 'chrome://newtab/')) { try { await chrome.windows.remove(w.id); } catch (e) {} } } })()`);
    await popup.eval('location.reload()');
    await sleep(1500);

    // 1. title
    cursor = { x: W / 2 + 200, y: H - 60, hidden: true };
    overlay = { title: 'Organize Tabs 2.0', text: 'Tabs, under control. One click to group, sort and deduplicate every window.', url: '' };
    await frame(FPS * 2);
    overlay = null;
    cursor.hidden = false;

    // 2. the mess
    await say('Three windows and a mess: the same pull request open <b>three times</b>, a profile twice, a doc twice.', FPS * 2);
    await still('01-before.png');

    // 3. dedupe
    await say('<b>Deduplicate</b> knows a PR and its Files tab are the same page, and shows you what it will close first.');
    await clickPopup(action('Deduplicate'), { settle: FPS * 1.5 });
    await still('02-dedupe-preview.png');
    await clickPopup(`document.querySelector('#panel-confirm')`, { settle: FPS * 1.5 });
    await say('Seven duplicates gone. The pinned, active or most recent copy stays. <b>Undo</b> is one click away.', FPS * 1.5);
    await still('03-after-dedupe.png');

    // 4. close tabs like this one (entity)
    await say('On a LinkedIn profile? <b>Close Tabs Like This One</b> can close every open profile, and keep this one.');
    await clickPopup(action('Like This One'), { settle: FPS });
    await clickPopup(`[...document.querySelectorAll('.scope input')].at(-1)`, { settle: FPS });
    await still('04-scope.png');
    await clickPopup(`document.querySelector('#panel-confirm')`, { settle: FPS * 1.5 });

    // 5. group by domain
    await say('<b>Group Tabs by Domain</b> uses native tab groups, one per site, in every window.');
    await clickPopup(action('Group Tabs by Domain'), { settle: FPS * 2 });
    await still('05-grouped.png');

    // 6. pull media
    await say('On a call? <b>Pull Meetings &amp; Media</b> moves the meeting and the video into their own window.');
    await clickPopup(action('Pull Meetings'), { settle: FPS * 2 });
    await popup.eval(`chrome.windows.update(${w1.id}, { focused: true })`);
    await sleep(300);
    await still('06-media.png');

    // 7. consolidate
    await say('<b>Consolidate</b> brings everything else into one sorted window. Groups come along, the meeting window is left alone.');
    await popup.eval(`chrome.windows.update(${w1.id}, { focused: true })`);
    await sleep(300);
    await clickPopup(action('Consolidate Unpinned'), { settle: FPS * 2.5 });
    await still('07-consolidated.png');

    // 8. sort / help
    await say('Previews before every close, undo after, keyboard shortcuts, settings that sync. Rules are editable, with a live tester.');
    await clickPopup(`document.querySelector('#help-toggle')`, { settle: FPS * 2 });
    await still('08-help.png');

    // 9. end card
    cursor.hidden = true;
    overlay = { title: 'Organize Tabs', text: 'Free and open source. No tracking, nothing leaves your browser.', url: 'chrome.google.com/webstore  ·  github.com/hacktoolkit/organize-tabs-chrome-extension' };
    await frame(FPS * 3);

    console.log(`captured ${frameNo} frames`);

    // ----- assemble --------------------
    const mp4 = join(OUT, 'demo.mp4');
    const gif = join(OUT, 'demo.gif');
    const palette = join(profile, 'palette.png');
    const run = (args) => {
        const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
        if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
    };
    run(['-framerate', String(FPS), '-i', join(framesDir, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-crf', '20', '-movflags', '+faststart', mp4]);
    run(['-framerate', String(FPS), '-i', join(framesDir, 'f%05d.png'), '-vf', 'fps=10,scale=960:-1:flags=lanczos,palettegen=max_colors=128', palette]);
    run(['-framerate', String(FPS), '-i', join(framesDir, 'f%05d.png'), '-i', palette, '-lavfi', 'fps=10,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4', gif]);
    console.log('wrote', mp4);
    console.log('wrote', gif);
    console.log('stills in', STILLS);
} finally {
    chrome.kill('SIGKILL');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
}
