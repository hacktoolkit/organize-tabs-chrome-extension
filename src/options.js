import {
    DEFAULT_SETTINGS,
    defaultRules,
    exportBundle,
    loadSettings,
    parseImport,
    saveSettings
} from './lib/settings.js';
import { canonicalize, compileRules, normalizeUrl, TRACKING_PARAMS } from './lib/url.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = { settings: { ...DEFAULT_SETTINGS }, rules: [], remoteRules: [], remoteRulesMeta: null, source: 'sync' };
let saveTimer = null;
let ruleErrors = new Map();

function send(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!response || !response.ok) reject(new Error(response?.error || 'No response'));
            else resolve(response.result);
        });
    });
}

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) {
        if (c === null || c === undefined) continue;
        node.append(c.nodeType ? c : document.createTextNode(c));
    }
    return node;
}

// ----- SAVE --------------------

function setSaveState(text, cls = '') {
    const node = $('#save-state');
    node.textContent = text;
    node.className = `save-state ${cls || 'muted'}`;
}

function scheduleSave() {
    setSaveState('Saving…');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
}

async function save() {
    saveTimer = null;
    try {
        const where = await saveSettings({ settings: state.settings, rules: state.rules });
        state.source = where;
        setSaveState(where === 'sync' ? 'Saved and synced' : 'Saved locally (sync unavailable)');
        renderSyncStatus();
        await send({ type: 'settingsChanged' });
    } catch (e) {
        setSaveState(`Save failed: ${e.message}`, 'pill warn');
    }
}

// ----- GENERAL --------------------

const BOOL_FIELDS = ['confirmClose', 'autoDedupe', 'showBadge', 'collapseGroups', 'protectMediaWindows'];
const NUM_FIELDS = ['staleDays', 'minGroupSize', 'remoteRefreshHours'];
const TEXT_FIELDS = ['survivorPolicy', 'parkFolderName', 'remoteRulesUrl'];
const NORM_FIELDS = ['ignoreScheme', 'stripWww', 'ignoreFragment', 'ignoreTrailingSlash', 'sortQueryParams', 'stripTrackingParams'];

function renderGeneral() {
    const s = state.settings;
    BOOL_FIELDS.forEach((f) => { $(`#${f}`).checked = !!s[f]; });
    NUM_FIELDS.forEach((f) => { $(`#${f}`).value = s[f]; });
    TEXT_FIELDS.forEach((f) => { $(`#${f}`).value = s[f] ?? ''; });
    NORM_FIELDS.forEach((f) => { $(`#n-${f}`).checked = !!s.normalization[f]; });
    $('#trackingParams').value = (s.normalization.trackingParams || TRACKING_PARAMS).join('\n');
    $('#mediaPatterns').value = (s.mediaPatterns || []).join('\n');
}

function bindGeneral() {
    BOOL_FIELDS.forEach((f) => $(`#${f}`).addEventListener('change', (e) => { state.settings[f] = e.target.checked; scheduleSave(); }));
    NUM_FIELDS.forEach((f) => $(`#${f}`).addEventListener('change', (e) => {
        const input = e.target;
        const min = input.min === '' ? -Infinity : Number(input.min);
        const max = input.max === '' ? Infinity : Number(input.max);
        const n = Number(input.value);
        const value = Number.isFinite(n) && input.value.trim() !== '' ? Math.min(max, Math.max(min, n)) : DEFAULT_SETTINGS[f];
        state.settings[f] = value;
        input.value = value;
        scheduleSave();
    }));
    TEXT_FIELDS.forEach((f) => $(`#${f}`).addEventListener('change', (e) => { state.settings[f] = e.target.value.trim(); scheduleSave(); }));
    NORM_FIELDS.forEach((f) => $(`#n-${f}`).addEventListener('change', (e) => { state.settings.normalization[f] = e.target.checked; scheduleSave(); runTester(); }));
    $('#trackingParams').addEventListener('change', (e) => {
        state.settings.normalization.trackingParams = e.target.value.split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
        scheduleSave();
        runTester();
    });
    $('#mediaPatterns').addEventListener('change', (e) => {
        state.settings.mediaPatterns = e.target.value.split('\n').map((p) => p.trim()).filter(Boolean);
        scheduleSave();
    });
    $('#remoteRulesUrl').addEventListener('change', async (e) => {
        const url = e.target.value.trim();
        if (url) {
            await requestOrigin(url);
        }
    });
}

// Ask for host permission on the remote rules origin so fetch works even when
// the host does not send CORS headers.
async function requestOrigin(url) {
    try {
        const origin = new URL(url).origin;
        await chrome.permissions.request({ origins: [`${origin}/*`] });
    } catch (e) {
        // user declined or the URL is malformed; fetch may still work with CORS
    }
}

// ----- RULES --------------------

function compiledRules() {
    const all = [...state.rules, ...state.remoteRules];
    const { compiled, errors } = compileRules(all);
    ruleErrors = new Map(errors.map((e) => [e.rule, e.error]));
    return compiled;
}

function ruleRow(rule, index, remote = false) {
    const row = el('div', { class: `rule${rule.enabled === false ? ' off' : ''}` });
    const toggle = el('input', { type: 'checkbox', title: 'Enabled' });
    toggle.checked = rule.enabled !== false;
    toggle.disabled = remote;
    toggle.addEventListener('change', () => { rule.enabled = toggle.checked; row.classList.toggle('off', !toggle.checked); scheduleSave(); runTester(); });
    const name = el('input', { type: 'text', class: 'name', value: rule.name || '', placeholder: 'Name' });
    const match = el('input', { type: 'text', class: 'match', value: rule.match || '', placeholder: 'match (regex)' });
    const key = el('input', { type: 'text', class: 'key', value: rule.key || '', placeholder: 'key template, e.g. site:$1' });
    [name, match, key].forEach((input) => {
        input.readOnly = remote;
        input.addEventListener('change', () => {
            rule.name = name.value.trim();
            rule.match = match.value;
            rule.key = key.value;
            delete rule.builtin;
            renderRules();
            scheduleSave();
            runTester();
        });
    });
    const del = el('button', { class: 'del ghost', title: 'Delete rule', text: '×', onclick: () => { state.rules.splice(index, 1); renderRules(); scheduleSave(); runTester(); } });
    del.disabled = remote;
    row.append(toggle, name, match, key, del);
    const err = ruleErrors.get(rule);
    if (err) {
        row.append(el('div', { class: 'err', text: `Invalid: ${err}` }));
    }
    return row;
}

function renderRules() {
    compiledRules();
    const list = $('#rule-list');
    list.innerHTML = '';
    if (state.rules.length === 0) {
        list.append(el('p', { class: 'muted', text: 'No rules. Duplicates are detected by normalized URL only.' }));
    }
    state.rules.forEach((rule, i) => list.append(ruleRow(rule, i)));

    const remoteWrap = $('#remote-rule-list');
    remoteWrap.hidden = state.remoteRules.length === 0;
    const remoteList = remoteWrap.querySelector('.rules');
    remoteList.innerHTML = '';
    state.remoteRules.forEach((rule, i) => remoteList.append(ruleRow(rule, i, true)));
}

function bindRules() {
    $('#rule-add').addEventListener('click', () => {
        state.rules.unshift({ name: '', match: '', key: '', enabled: true });
        renderRules();
        const first = $('#rule-list .rule input.name');
        if (first) first.focus();
    });
    $('#rule-reset').addEventListener('click', () => {
        if (!confirm('Replace your rules with the built-in set?')) return;
        state.rules = defaultRules();
        renderRules();
        scheduleSave();
        runTester();
    });
    $('#rule-json').addEventListener('click', () => {
        $('#rule-json-text').value = JSON.stringify(state.rules.map(({ name, match, key, enabled }) => ({ name, match, key, enabled: enabled !== false })), null, 2);
        $('#rule-json-error').hidden = true;
        $('#rule-json-editor').hidden = false;
    });
    $('#rule-json-cancel').addEventListener('click', () => { $('#rule-json-editor').hidden = true; });
    $('#rule-json-apply').addEventListener('click', () => {
        try {
            const parsed = parseImport($('#rule-json-text').value);
            state.rules = parsed.rules || [];
            $('#rule-json-editor').hidden = true;
            renderRules();
            scheduleSave();
            runTester();
        } catch (e) {
            const err = $('#rule-json-error');
            err.textContent = e.message;
            err.hidden = false;
        }
    });
    $('#test-url').addEventListener('input', runTester);
}

function runTester() {
    const url = $('#test-url').value.trim();
    const out = $('#test-result');
    if (!url) {
        out.textContent = '';
        return;
    }
    const compiled = compiledRules();
    const { key, rule } = canonicalize(url, compiled, state.settings.normalization);
    out.textContent = rule
        ? `${rule}  →  ${key}`
        : `No rule matched. Normalized URL  →  ${normalizeUrl(url, state.settings.normalization)}`;
}

// ----- SYNC & BACKUP --------------------

function renderSyncStatus() {
    $('#sync-status').textContent = state.source === 'sync'
        ? 'Sync storage is active.'
        : 'Sync storage is not available in this profile, so settings are stored locally.';
}

function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyImport(text) {
    const parsed = parseImport(text);
    if (parsed.settings) state.settings = parsed.settings;
    if (parsed.rules) state.rules = parsed.rules;
    renderGeneral();
    renderRules();
    scheduleSave();
    runTester();
    return `Imported ${parsed.settings ? 'settings' : ''}${parsed.settings && parsed.rules ? ' and ' : ''}${parsed.rules ? `${parsed.rules.length} rules` : ''}.`;
}

function bindSync() {
    $('#export').addEventListener('click', () => {
        const stamp = new Date().toISOString().slice(0, 10);
        download(`organize-tabs-${stamp}.json`, JSON.stringify(exportBundle(state), null, 2));
    });
    $('#copy').addEventListener('click', async () => {
        await navigator.clipboard.writeText(JSON.stringify(exportBundle(state), null, 2));
        setSaveState('Copied to clipboard');
    });
    $('#import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            $('#import-result').textContent = applyImport(await file.text());
        } catch (err) {
            $('#import-result').textContent = err.message;
        }
        e.target.value = '';
    });
    $('#import-apply').addEventListener('click', () => {
        try {
            $('#import-result').textContent = applyImport($('#import-text').value);
            $('#import-text').value = '';
        } catch (err) {
            $('#import-result').textContent = err.message;
        }
    });
    $('#remote-fetch').addEventListener('click', async () => {
        const url = $('#remoteRulesUrl').value.trim();
        state.settings.remoteRulesUrl = url;
        const status = $('#remote-status');
        if (!url) {
            status.textContent = 'Enter a URL first.';
            return;
        }
        await requestOrigin(url);
        await save();
        status.textContent = 'Fetching…';
        try {
            const meta = await send({ type: 'fetchRemoteRules' });
            const loaded = await loadSettings();
            state.remoteRules = loaded.remoteRules;
            state.remoteRulesMeta = meta;
            renderRules();
            renderRemoteStatus();
        } catch (e) {
            status.textContent = e.message;
        }
    });
}

function renderRemoteStatus() {
    const meta = state.remoteRulesMeta;
    const status = $('#remote-status');
    if (!state.settings.remoteRulesUrl) {
        status.textContent = '';
    } else if (!meta) {
        status.textContent = 'Not fetched yet.';
    } else if (meta.error) {
        status.textContent = `Last attempt failed: ${meta.error}`;
    } else {
        status.textContent = `${meta.count} rules, fetched ${new Date(meta.fetchedAt).toLocaleString()}`;
    }
}

// ----- HELP --------------------

async function renderHelp() {
    try {
        const actions = await send({ type: 'actions' });
        const list = $('#help-list');
        list.innerHTML = '';
        for (const a of actions) {
            list.append(el('div', { class: 'help-item' }, [el('b', { text: a.name }), el('span', { text: a.help })]));
        }
    } catch (e) {
        $('#help-list').textContent = e.message;
    }
    try {
        const commands = await chrome.commands.getAll();
        const list = $('#shortcut-list');
        list.innerHTML = '';
        for (const c of commands) {
            list.append(el('div', { class: 'help-item' }, [
                el('b', { text: c.name === '_execute_action' ? 'Open Organize Tabs' : c.description || c.name }),
                el('kbd', { text: c.shortcut || 'not set' })
            ]));
        }
    } catch (e) { /* ignore */ }
    $('#open-shortcuts').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
}

// ----- NAV --------------------

function bindNav() {
    const links = $$('nav a');
    const sections = links.map((a) => $(a.getAttribute('href')));
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${entry.target.id}`));
            }
        });
    }, { rootMargin: '-40% 0px -55% 0px' });
    sections.forEach((s) => observer.observe(s));
}

// ----- INIT --------------------

async function init() {
    $('#version').textContent = `v${chrome.runtime.getManifest().version}`;
    state = { ...state, ...(await loadSettings()) };
    renderGeneral();
    renderRules();
    renderSyncStatus();
    renderRemoteStatus();
    bindGeneral();
    bindRules();
    bindSync();
    bindNav();
    renderHelp();
    if (location.hash) {
        const target = $(location.hash);
        if (target) target.scrollIntoView();
    }
}

init();
