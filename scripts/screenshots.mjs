// Renders Chrome Web Store screenshots (1280x800) and README images from the
// holodeck: launches a headless browser with the extension, seeds tabs,
// captures the popup and options page, then composes each capture onto a
// 1280x800 stage with a caption.
//
//   make screenshots            # writes promo/*.png and promo/store/*.png
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(EXT, 'promo');
const STORE = join(OUT, 'store');
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
const PORT = Number(process.env.PORT) || 9339;
const HOLODECK = process.env.HOLODECK || join(homedir(), '.holodeck');
mkdirSync(join(HOLODECK, 'tmp'), { recursive: true });
mkdirSync(STORE, { recursive: true });
const profile = mkdtempSync(join(HOLODECK, 'tmp', 'organize-tabs-shots-'));

const chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--no-first-run',
    '--no-default-browser-check',
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
    async shot(file, { width, height, scale = 2, dark = false }) {
        await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
        await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
        await sleep(350);
        const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(file, Buffer.from(r.data, 'base64'));
        return file;
    }
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

// A 1280x800 stage: dark gradient, headline, caption, and the capture scaled
// to fit on the right (or centred for wide captures).
function stageHtml({ png, title, caption, wide = false }) {
    const data = readFileSync(png).toString('base64');
    return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif;color:#eef0f6}
    body{background:radial-gradient(1200px 700px at 20% 0%,#2a2f52 0%,#12141c 60%,#0c0d13 100%)}
    .stage{position:relative;width:1280px;height:800px;display:flex;align-items:center;gap:40px;padding:0 64px;box-sizing:border-box}
    .text{flex:0 0 ${wide ? '1152px' : '420px'};${wide ? 'position:absolute;top:36px;left:64px;' : ''}}
    h1{margin:0 0 14px;font-size:${wide ? '34px' : '40px'};line-height:1.1;letter-spacing:-0.02em}
    p{margin:0;font-size:${wide ? '18px' : '20px'};line-height:1.45;color:#b4b9d0;max-width:${wide ? '900px' : '420px'}}
    .brand{position:absolute;left:64px;bottom:34px;display:flex;align-items:center;gap:10px;font-size:15px;color:#8f95ad}
    .brand img{width:22px;height:22px;border-radius:5px}
    .shot{${wide ? 'position:absolute;left:64px;top:140px;width:1152px;height:620px;' : 'flex:1;height:720px;'}display:flex;align-items:center;justify-content:center}
    .shot img{max-width:100%;max-height:100%;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08)}
    </style></head><body><div class="stage">
    <div class="text"><h1>${title}</h1><p>${caption}</p></div>
    <div class="shot"><img src="data:image/png;base64,${data}"></div>
    <div class="brand"><img src="file://${EXT}/img/icon32.png">Organize Tabs</div>
    </div></body></html>`;
}

try {
    const extId = await findExtensionId();
    const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browser = await CDP.connect(info.webSocketDebuggerUrl);

    const URLS = [
        'https://github.com/dataro/app/pull/123',
        'https://github.com/dataro/app/pull/123/files',
        'https://github.com/dataro/app/pull/124',
        'https://github.com/dataro/app/issues/7',
        'https://www.linkedin.com/in/someone/',
        'https://www.linkedin.com/in/someone/details/experience/',
        'https://www.linkedin.com/in/other/',
        'https://dataro.atlassian.net/browse/ENG-1',
        'https://dataro.atlassian.net/browse/ENG-2',
        'https://meet.google.com/abc-defg-hij',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://news.ycombinator.com/',
        'https://example.com/page?utm_source=x',
        'http://example.com/page',
        'chrome://newtab/'
    ];
    await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, newWindow: true, width: 340, height: 640 });
    const popupT = await waitFor((t) => t.url.endsWith('/src/popup.html'));
    const popup = await CDP.connect(popupT.webSocketDebuggerUrl);
    await popup.eval(`chrome.windows.create({ url: ${JSON.stringify(URLS)}, focused: false })`);
    await sleep(1200);
    // make the current tab a PR so the scope panel has an entity option
    await popup.eval(`(async () => { const [t] = await chrome.tabs.query({ url: 'https://github.com/dataro/app/pull/124' }); await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); })()`);
    await popup.eval('location.reload()');
    await sleep(1200);

    const P = { width: 340, height: 640 };
    const shots = {};
    shots.popup = await popup.shot(join(OUT, 'popup.png'), P);
    shots.popupDark = await popup.shot(join(OUT, 'popup-dark.png'), { ...P, dark: true });
    await popup.eval(`document.querySelector('#help-toggle').click()`); await sleep(300);
    shots.help = await popup.shot(join(OUT, 'popup-help.png'), P);
    await popup.eval(`document.querySelector('#help-toggle').click()`); await sleep(200);
    await popup.eval(`[...document.querySelectorAll('.action')].find(b => b.textContent.includes('Deduplicate')).click()`); await sleep(900);
    shots.preview = await popup.shot(join(OUT, 'preview.png'), P);
    await popup.eval(`document.querySelector('#panel-cancel').click()`); await sleep(200);
    await popup.eval(`[...document.querySelectorAll('.action')].find(b => b.textContent.includes('Like This')).click()`); await sleep(900);
    await popup.eval(`[...document.querySelectorAll('.scope input')].at(-1).click()`); await sleep(700);
    shots.scope = await popup.shot(join(OUT, 'scope.png'), P);
    await popup.eval(`document.querySelector('#panel-cancel').click()`);

    await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options.html#rules`, newWindow: true, width: 1180, height: 760 });
    const optT = await waitFor((t) => t.url.includes('/src/options.html'));
    const opt = await CDP.connect(optT.webSocketDebuggerUrl);
    await sleep(900);
    await opt.eval(`document.querySelector('#test-url').value = 'https://github.com/dataro/app/pull/123/files'; document.querySelector('#test-url').dispatchEvent(new Event('input')); document.querySelector('#rules').scrollIntoView(); window.scrollBy(0, -16)`);
    await sleep(300);
    shots.options = await opt.shot(join(OUT, 'options.png'), { width: 1180, height: 760, scale: 1 });

    // compose store screenshots
    const stages = [
        { file: '1-popup.png', png: shots.popup, title: 'Every tab action, one click away', caption: 'Group, sort, deduplicate, close by scope, park to bookmarks, pull meetings into their own window. Live counts show what each action will touch.' },
        { file: '2-dedupe.png', png: shots.preview, title: 'Duplicates, even when the URLs differ', caption: 'A pull request and its Files tab, a Jira issue and its board link, a LinkedIn profile and its Experience page: one key, one tab. Preview before anything closes, undo after.' },
        { file: '3-scope.png', png: shots.scope, title: 'Close tabs like this one', caption: 'Same domain, same section of the site, or the same kind of page: every open pull request, every profile. Keep the one you are on.' },
        { file: '4-help.png', png: shots.help, title: 'Help where you need it', caption: 'Flip on descriptions and shortcuts inline. Pinned tabs never move; tab groups stay together and travel between windows intact.' },
        { file: '5-rules.png', png: shots.options, title: 'Your rules, synced everywhere', caption: 'Edit the duplicate rules, test a URL live, export and import JSON, or point at a rules file in your dotfiles. Settings follow your browser profile.', wide: true }
    ];
    for (const st of stages) {
        const html = join(profile, `${st.file}.html`);
        writeFileSync(html, stageHtml(st));
        const { targetId } = await browser.send('Target.createTarget', { url: `file://${html}`, newWindow: true, width: 1280, height: 800 });
        const t = await waitFor((x) => x.id === targetId || x.url === `file://${html}`);
        const page = await CDP.connect(t.webSocketDebuggerUrl);
        await sleep(500);
        await page.shot(join(STORE, st.file), { width: 1280, height: 800, scale: 1, dark: true });
        page.ws.close();
        console.log('wrote', join('promo/store', st.file));
    }
    console.log('wrote', Object.values(shots).map((f) => f.replace(EXT + '/', '')).join(', '));
} finally {
    chrome.kill('SIGKILL');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
}
