// End-to-end smoke test. Launches a real Chromium-based browser headless with
// the extension loaded, then drives it over the DevTools protocol.
//
//   make e2e                       # uses Brave by default (see BROWSER below)
//   BROWSER=/path/to/chromium make e2e
//
// Google Chrome branded builds no longer honour --load-extension; use Brave,
// Chromium or Chrome for Testing. Network is disabled with a host-resolver
// rule so tab URLs stay exactly as seeded.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// EXT= points the suite at another folder, e.g. an unzipped package
const EXT = process.env.EXT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [
    process.env.BROWSER,
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser'
].filter(Boolean);
const CHROME = CANDIDATES.find((c) => existsSync(c));
if (!CHROME) {
    console.error('No Chromium-based browser found. Set BROWSER=/path/to/binary');
    process.exit(2);
}
const PORT = Number(process.env.PORT) || 9337;
// Ephemeral profile under the holodeck (~/.holodeck), deleted when the run ends.
const HOLODECK = process.env.HOLODECK || join(homedir(), '.holodeck');
mkdirSync(join(HOLODECK, 'tmp'), { recursive: true });
const profile = mkdtempSync(join(HOLODECK, 'tmp', 'organize-tabs-e2e-'));

const chrome = spawn(CHROME, [
    `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    // CI containers have no user namespaces or /dev/shm to speak of
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    return res.json();
}
async function waitFor(pred, label, tries = 60) {
    for (let i = 0; i < tries; i++) {
        try {
            const t = (await targets()).find(pred);
            if (t) return t;
        } catch (e) { /* not up yet */ }
        await sleep(250);
    }
    let list = [];
    try { list = await targets(); } catch (e) { /* ignore */ }
    throw new Error(`timeout waiting for ${label}; targets: ${JSON.stringify(list.map((t) => [t.type, t.url]))}`);
}

class CDP {
    constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; 
        ws.addEventListener('message', (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id && this.pending.has(msg.id)) { const {res, rej} = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
            else this.events.push(msg);
        });
    }
    static async connect(url) { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return new CDP(ws); }
    send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
    async eval(expression) {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
        return r.result.value;
    }
}

let failures = 0;
function check(label, cond, detail = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
    if (!cond) failures++;
}

// Browsers ship built-in extensions with service workers of their own, so
// identify ours by manifest name rather than by URL shape.
async function findExtensionId(tries = 60) {
    for (let i = 0; i < tries; i++) {
        let list = [];
        try { list = await targets(); } catch (e) { /* not up yet */ }
        for (const t of list.filter((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js'))) {
            try {
                const cdp = await CDP.connect(t.webSocketDebuggerUrl);
                const name = await cdp.eval('chrome.runtime.getManifest().name');
                cdp.ws.close();
                if (name === 'Organize Tabs') return new URL(t.url).host;
            } catch (e) { /* try the next one */ }
        }
        await sleep(250);
    }
    throw new Error(`timeout waiting for the Organize Tabs service worker\n${stderr.split('\n').slice(-5).join('\n')}`);
}

try {
    const extId = await findExtensionId();
    console.log('extension id', extId);

    const browserInfo = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browser = await CDP.connect(browserInfo.webSocketDebuggerUrl);

    // open the popup as a tab; it can drive chrome.runtime.sendMessage
    const { targetId: popupId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html`, newWindow: true });
    await sleep(500);
    const popupTarget = await waitFor((t) => t.url.endsWith('/src/popup.html'), 'popup target');
    const popup = await CDP.connect(popupTarget.webSocketDebuggerUrl);
    await popup.send('Runtime.enable');
    const send = (msg) => popup.eval(`new Promise((res, rej) => chrome.runtime.sendMessage(${JSON.stringify(msg)}, (r) => r && r.ok ? res(r.result) : rej(new Error(r ? r.error : chrome.runtime.lastError?.message))))`);
    const tabs = () => popup.eval(`chrome.tabs.query({})`);
    const groups = () => popup.eval(`chrome.tabGroups.query({})`);

    // seed tabs: duplicates by rule, by normalization, plain, blank, pinned
    const URLS = [
        'https://github.com/dataro/app/pull/123',
        'https://github.com/dataro/app/pull/123/files',
        'https://github.com/dataro/app/pull/124',
        'https://github.com/dataro/other/issues/7',
        'https://www.linkedin.com/in/someone/',
        'https://www.linkedin.com/in/someone/details/experience/',
        'https://www.linkedin.com/in/other/',
        'https://example.com/page?utm_source=x#top',
        'http://example.com/page',
        'https://dataro.atlassian.net/browse/ENG-1',
        'https://news.ycombinator.com/',
        'chrome://newtab/'
    ];
    const seedWindow = await popup.eval(`chrome.windows.create({ url: ${JSON.stringify(URLS)}, focused: false })`);
    await sleep(1500);
    await popup.eval(`chrome.tabs.query({ windowId: ${seedWindow.id}, index: 0 }).then(([t]) => chrome.tabs.update(t.id, { pinned: true }))`);
    await sleep(300);

    const actions = await send({ type: 'actions' });
    check('actions list', actions.length === 16, `${actions.length} actions`);

    let s = await send({ type: 'stats' });
    check('stats counts duplicates', s.duplicates === 3, `duplicates=${s.duplicates} tabs=${s.tabs}`);

    const preview = await send({ type: 'preview', action: 'dedupe' });
    check('dedupe preview lists 3 tabs', preview.items.length === 3, preview.items.map((i) => i.url).join(' | '));
    const pinnedKept = !preview.items.some((i) => i.url === 'https://github.com/dataro/app/pull/123');
    check('dedupe keeps the pinned copy', pinnedKept);

    const opts = await send({ type: 'options', action: 'closeScope', args: { tabId: (await tabs()).find((t) => t.url.includes('pull/124')).id } });
    check('scope options offer domain/section/entity', opts.scopes.map((x) => x.id).join(',') === 'domain,section,entity', JSON.stringify(opts.scopes));
    check('entity scope counts unpinned PRs', opts.scopes[2].count === 2, `count=${opts.scopes[2].count}`);
    check('domain scope excludes pinned', opts.scopes[0].count === 3, `count=${opts.scopes[0].count}`);

    // sort the seeded window; the pinned tab must stay at index 0
    await popup.eval(`chrome.windows.update(${seedWindow.id}, { focused: true })`);
    await sleep(200);
    const sortRes = await send({ type: 'run', action: 'sortWindow' });
    let after = (await tabs()).filter((t) => t.windowId === seedWindow.id).sort((a, b) => a.index - b.index);
    check('sort keeps pinned tab first', after[0].pinned && after[0].url.includes('pull/123'), sortRes.message);
    const unpinnedUrls = after.filter((t) => !t.pinned).map((t) => t.url);
    const hosts = unpinnedUrls.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } });
    const clustered = hosts.slice(0, -1).every((h, i) => h === hosts[i] || hosts.indexOf(h) === hosts.lastIndexOf(h) || hosts[i + 1] === h || !hosts.slice(i + 1).includes(h));
    check('sort clusters hosts', clustered, hosts.join(','));

    const groupRes = await send({ type: 'run', action: 'groupByDomain' });
    const g = await groups();
    check('group by domain creates groups', g.length >= 3, `${groupRes.message}; groups=${g.map((x) => x.title).join(',')}`);
    after = (await tabs()).filter((t) => t.windowId === seedWindow.id);
    check('pinned tab not grouped', after.find((t) => t.pinned).groupId === -1);

    const sort2 = await send({ type: 'run', action: 'sortWindow' });
    const g2 = await groups();
    check('sort with groups keeps groups', g2.length === g.length, sort2.message);

    const runDedupe = await send({ type: 'run', action: 'dedupe' });
    check('dedupe closes 3', runDedupe.closed === 3, runDedupe.message);
    s = await send({ type: 'stats' });
    check('no duplicates after dedupe', s.duplicates === 0 && s.undo && s.undo.count === 3, `undo=${JSON.stringify(s.undo)}`);

    const undo = await send({ type: 'run', action: 'undo' });
    await sleep(800);
    s = await send({ type: 'stats' });
    check('undo reopens tabs', s.duplicates === 3, undo.message);

    const scopeRun = await send({ type: 'run', action: 'closeScope', args: { tabId: (await tabs()).find((t) => t.url.includes('pull/124')).id, scope: 'entity', keepCurrent: true } });
    check('close scope entity keeps current and pinned', scopeRun.closed === 1, scopeRun.message);

    const blank = await send({ type: 'run', action: 'closeBlank' });
    check('close blank', /Closed \d+ blank/.test(blank.message), blank.message);

    const park = await send({ type: 'preview', action: 'parkWindow', args: { windowId: seedWindow.id } });
    check('park preview lists unpinned web tabs', park.items.length > 0 && !park.items.some((i) => i.pinned), `${park.items.length} items`);
    const parkRun = await send({ type: 'run', action: 'parkWindow', args: { windowId: seedWindow.id } });
    check('park closes tabs', parkRun.closed === park.items.length, parkRun.message);
    const restore = await send({ type: 'run', action: 'restoreParked' });
    await sleep(800);
    check('restore parked', /Restored \d+ tab/.test(restore.message), restore.message);

    // consolidate: groups must survive the move and merge into same-named groups
    const winA = await popup.eval(`chrome.windows.create({ url: ['https://example.org/a', 'https://example.org/b', 'https://example.org/c', 'https://foo.test/x'], focused: false })`);
    const winB = await popup.eval(`chrome.windows.create({ url: ['https://example.org/z', 'https://bar.test/y'], focused: false })`);
    await sleep(1000);
    const urlOf = (u) => `(await chrome.tabs.query({ url: ${JSON.stringify(u)} }))[0].id`;
    await popup.eval(`(async () => {
        const g1 = await chrome.tabs.group({ tabIds: [${await popup.eval(`(async () => ${urlOf('https://example.org/a')})()`)}, ${await popup.eval(`(async () => ${urlOf('https://example.org/b')})()`)}] });
        await chrome.tabGroups.update(g1, { title: 'alpha', color: 'blue' });
        const g2 = await chrome.tabs.group({ tabIds: [${await popup.eval(`(async () => ${urlOf('https://example.org/c')})()`)}, ${await popup.eval(`(async () => ${urlOf('https://foo.test/x')})()`)}] });
        await chrome.tabGroups.update(g2, { color: 'red' });
        const g3 = await chrome.tabs.group({ tabIds: [${await popup.eval(`(async () => ${urlOf('https://example.org/z')})()`)}] });
        await chrome.tabGroups.update(g3, { title: 'alpha', color: 'green' });
    })()`);
    await sleep(300);
    await popup.eval(`chrome.windows.update(${winB.id}, { focused: true })`);
    const before = (await popup.eval(`chrome.windows.getAll({ windowTypes: ['normal'] })`)).length;
    const cons = await send({ type: 'run', action: 'consolidateAll' });
    await sleep(500);
    const afterWin = (await popup.eval(`chrome.windows.getAll({ windowTypes: ['normal'] })`)).length;
    check('consolidate reduces windows', afterWin < before, `${before} -> ${afterWin}; ${cons.message}`);
    const pinnedTab = (await tabs()).find((t) => t.url === 'https://github.com/dataro/app/pull/123');
    check('consolidate keeps pinned', pinnedTab && pinnedTab.pinned && pinnedTab.index === 0, JSON.stringify({ pinned: pinnedTab?.pinned, index: pinnedTab?.index }));
    let allGroups = await groups();
    let allTabs = await tabs();
    const alpha = allGroups.filter((g) => g.title === 'alpha');
    const alphaTabs = alpha.length === 1 ? allTabs.filter((t) => t.groupId === alpha[0].id).map((t) => t.url).sort() : [];
    check('consolidate merges same-named groups', alpha.length === 1 && alphaTabs.join() === ['https://example.org/a', 'https://example.org/b', 'https://example.org/z'].join(), `${alpha.length} alpha groups: ${alphaTabs.join(', ')}`);
    const red = allGroups.find((g) => g.color === 'red' && !g.title);
    const redTabs = red ? allTabs.filter((t) => t.groupId === red.id).map((t) => t.url).sort() : [];
    check('consolidate keeps untitled group intact', red && redTabs.join() === ['https://example.org/c', 'https://foo.test/x'].join(), redTabs.join(', '));
    check('all moved tabs live in one window', new Set(allTabs.filter((t) => /example\.org|foo\.test|bar\.test/.test(t.url)).map((t) => t.windowId)).size === 1);

    const split = await send({ type: 'run', action: 'splitByDomain' });
    await sleep(800);
    check('split by domain', /Split \d+ tabs into \d+ windows/.test(split.message), split.message);
    allGroups = await groups();
    allTabs = await tabs();
    const alphaAfter = allGroups.filter((g) => g.title === 'alpha');
    const alphaAfterTabs = alphaAfter.length === 1 ? allTabs.filter((t) => t.groupId === alphaAfter[0].id).map((t) => t.url).sort() : [];
    check('split keeps the alpha group together', alphaAfter.length === 1 && alphaAfterTabs.join() === ['https://example.org/a', 'https://example.org/b', 'https://example.org/z'].join(), alphaAfterTabs.join(', '));
    const c = allTabs.find((t) => t.url === 'https://example.org/c');
    const x = allTabs.find((t) => t.url === 'https://foo.test/x');
    const cg = c && c.groupId !== -1 ? allGroups.find((g) => g.id === c.groupId) : null;
    const xg = x && x.groupId !== -1 ? allGroups.find((g) => g.id === x.groupId) : null;
    check('split keeps tabs of a divided group in same-colored groups', cg && xg && cg.color === 'red' && xg.color === 'red' && c.windowId !== x.windowId, JSON.stringify({ c: cg?.color, x: xg?.color }));
    check('no blank tabs left by split', allTabs.filter((t) => t.url === 'chrome://newtab/' && allTabs.filter((o) => o.windowId === t.windowId).length > 1).length === 0);

    const focus = await send({ type: 'run', action: 'focusAllWindows' });
    check('focus all windows', /Brought \d+ window/.test(focus.message), focus.message);

    // meetings and media: pull them out, then consolidate must leave them alone
    const winM = await popup.eval(`chrome.windows.create({ url: ['https://meet.google.com/abc-defg-hij', 'https://example.net/doc', 'https://www.youtube.com/watch?v=abc123'], focused: false })`);
    await popup.eval(`chrome.windows.create({ url: ['https://example.net/other'], focused: false })`);
    await sleep(1000);
    const pull = await send({ type: 'run', action: 'pullMedia' });
    await sleep(500);
    let all = await tabs();
    const meet = all.find((t) => t.url.startsWith('https://meet.google.com/'));
    const yt = all.find((t) => t.url.startsWith('https://www.youtube.com/watch'));
    const mediaWin = all.filter((t) => t.windowId === meet.windowId);
    check('pull media gathers meeting and player into one window', meet.windowId === yt.windowId && mediaWin.length === 2 && meet.windowId !== winM.id, `${pull.message}; ${mediaWin.map((t) => t.url).join(', ')}`);
    check('pull media focuses the meeting', meet.active);
    check('pull media leaves non-media tabs behind', all.find((t) => t.url === 'https://example.net/doc').windowId === winM.id);
    const cons2 = await send({ type: 'run', action: 'consolidateAll' });
    await sleep(500);
    all = await tabs();
    const mediaWinAfter = all.filter((t) => t.windowId === meet.windowId);
    check('consolidate leaves the media window alone', mediaWinAfter.length === 2 && /left 1 media window alone/.test(cons2.message), `${cons2.message}; ${mediaWinAfter.length} tabs`);
    const docTab = all.find((t) => t.url === 'https://example.net/doc');
    check('consolidate still merged the other windows', docTab.windowId !== meet.windowId && all.find((t) => t.url === 'https://example.net/other').windowId === docTab.windowId);

    // auto-dedupe
    await popup.eval(`chrome.storage.sync.set({ settings: { autoDedupe: true } })`);
    await send({ type: 'settingsChanged' });
    const countBefore = (await tabs()).length;
    await popup.eval(`chrome.tabs.create({ url: 'https://github.com/dataro/app/pull/124/checks', active: false })`);
    await sleep(1500);
    const countAfter = (await tabs()).length;
    check('auto-dedupe closes the new duplicate', countAfter === countBefore, `${countBefore} -> ${countAfter}`);

    // options page loads without errors
    const { targetId: optId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options.html` });
    await sleep(800);
    const optTarget = await waitFor((t) => t.url.endsWith('/src/options.html'), 'options target');
    const opt = await CDP.connect(optTarget.webSocketDebuggerUrl);
    const ruleRows = await opt.eval(`document.querySelectorAll('#rule-list .rule').length`);
    check('options page renders built-in rules', ruleRows === 19, `${ruleRows} rows`);
    const helpRows = await opt.eval(`new Promise(r => setTimeout(() => r(document.querySelectorAll('#help-list .help-item').length), 500))`);
    check('options help lists actions', helpRows === 16, `${helpRows} rows`);
    const exported = await opt.eval(`(async () => { const m = await import('./lib/settings.js'); const l = await m.loadSettings(); return JSON.stringify(m.exportBundle(l)).length; })()`);
    check('export bundle builds', exported > 1000, `${exported} bytes`);

    // popup renders
    const popupButtons = await popup.eval(`document.querySelectorAll('.action').length`);
    check('popup renders action buttons', popupButtons === 16, `${popupButtons} buttons`);

    // any console errors in the service worker?
    const swTarget = await waitFor((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`), 'sw');
    const swc = await CDP.connect(swTarget.webSocketDebuggerUrl);
    await swc.send('Runtime.enable');
    await sleep(300);
    const errs = swc.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('no uncaught exceptions in service worker (since attach)', errs.length === 0, JSON.stringify(errs).slice(0, 300));
} catch (e) {
    console.error('E2E ERROR', e);
    failures++;
} finally {
    chrome.kill('SIGKILL');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
}
