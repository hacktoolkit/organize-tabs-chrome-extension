// Popup: renders the action list, previews destructive actions, and sends
// everything to the service worker to run.

import { loadSettings } from './lib/settings.js';

const GROUPS = [
    { id: 'organize', title: 'Organize' },
    { id: 'cleanup', title: 'Clean up' },
    { id: 'windows', title: 'Windows' }
];

const SHORTCUT_COMMANDS = new Set([
    'dedupe', 'sortWindow', 'groupByDomain', 'closeScope', 'closeBlank', 'closeStale',
    'discardStale', 'consolidateAll', 'consolidateUnpinned', 'parkWindow', 'pullMedia', 'undo'
]);

const ICONS = {
    groupByDomain: 'M3 5h7v6H3zM14 5h7v6h-7zM3 13h7v6H3zM14 13h7v6h-7z',
    sortWindow: 'M4 6h16M4 12h10M4 18h6M18 10v8m0 0l-3-3m3 3l3-3',
    ungroupWindow: 'M4 8h6v8H4zM14 8h6v8h-6zM10 12h4',
    consolidateAll: 'M4 4h16v6H4zM4 14h16v6H4zM12 10v4',
    consolidateUnpinned: 'M4 4h16v6H4zM8 14h8v6H8z',
    splitByDomain: 'M4 4h16v5H4zM4 15h7v5H4zM13 15h7v5h-7zM12 9v3',
    dedupe: 'M7 7h10v10H7zM4 4h10v3M4 4v10h3M17 14l4 4M21 14l-4 4',
    closeScope: 'M12 3l9 4.5v9L12 21l-9-4.5v-9zM9 10l6 6M15 10l-6 6',
    closeStale: 'M12 3a9 9 0 110 18 9 9 0 010-18zM12 7v5l3 2',
    discardStale: 'M5 4h14v4H5zM6 8l1 12h10l1-12M10 12v5M14 12v5',
    closeBlank: 'M4 5h16v14H4zM9 10l6 6M15 10l-6 6',
    parkWindow: 'M6 3h12v18l-6-4-6 4zM9 8h6',
    restoreParked: 'M6 3h12v18l-6-4-6 4zM12 7v6M9 10l3 3 3-3',
    pullMedia: 'M3 6h13v12H3zM16 10l5-3v10l-5-3M7 9.5v5l4-2.5z',
    focusAllWindows: 'M3 8h12v11H3zM9 3h12v11h-3M9 3v5',
    undo: 'M9 14l-4-4 4-4M5 10h9a5 5 0 010 10h-3'
};

const $ = (sel) => document.querySelector(sel);

let actions = [];
let stats = null;
let currentTab = null;
let panelState = null;

function send(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else if (!response || !response.ok) {
                reject(new Error(response?.error || 'No response'));
            } else {
                resolve(response.result);
            }
        });
    });
}

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) {
        if (c === null || c === undefined) continue;
        node.append(c.nodeType ? c : document.createTextNode(c));
    }
    return node;
}

function icon(id) {
    const d = ICONS[id] || 'M4 12h16';
    const wrap = el('span', { class: 'ic' });
    wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    return wrap;
}

function countFor(actionId) {
    if (!stats) return null;
    switch (actionId) {
        case 'dedupe': return stats.duplicates;
        case 'closeBlank': return stats.blank;
        case 'closeStale': return stats.stale;
        case 'discardStale': return stats.stale;
        case 'pullMedia': return stats.media;
        case 'undo': return stats.undo ? stats.undo.count : 0;
        default: return null;
    }
}

let shortcuts = {};

function renderActions() {
    const root = $('#actions');
    root.innerHTML = '';
    for (const g of GROUPS) {
        const list = actions.filter((a) => a.group === g.id);
        if (list.length === 0) continue;
        const section = el('div', { class: 'section' }, [el('h2', { text: g.title })]);
        for (const a of list) {
            const count = countFor(a.id);
            const btn = el('button', {
                class: 'action',
                title: document.body.classList.contains('help') ? '' : a.help,
                onclick: () => activate(a)
            }, [
                icon(a.id),
                el('span', { class: 'lbl' }, [
                    el('b', { text: a.name }),
                    el('small', { text: a.help })
                ]),
                shortcuts[a.id] ? el('kbd', { text: shortcuts[a.id] }) : null,
                count !== null ? el('span', { class: `pill cnt ${count ? '' : 'zero'}`, text: String(count) }) : null
            ]);
            if (a.id === 'undo' && !(stats && stats.undo)) {
                btn.disabled = true;
            }
            section.append(btn);
        }
        root.append(section);
    }
}

function renderStats() {
    const s = stats;
    const node = $('#stats');
    if (!s) {
        node.textContent = 'Counting tabs…';
        return;
    }
    const parts = [
        `<b>${s.tabs}</b> tabs`,
        `<b>${s.windows}</b> window${s.windows === 1 ? '' : 's'}`,
        s.groups ? `<b>${s.groups}</b> group${s.groups === 1 ? '' : 's'}` : null,
        s.duplicates ? `<b>${s.duplicates}</b> duplicate${s.duplicates === 1 ? '' : 's'}` : null,
        s.stale ? `<b>${s.stale}</b> stale` : null
    ].filter(Boolean);
    node.innerHTML = parts.join(' · ');
    const undo = $('#undo');
    undo.hidden = !s.undo;
    if (s.undo) {
        undo.textContent = `Undo (${s.undo.count})`;
    }
}

async function refresh() {
    try {
        stats = await send({ type: 'stats' });
    } catch (e) {
        stats = null;
    }
    renderStats();
    renderActions();
}

let toastTimer = null;
function toast(message, { error = false, undo = false } = {}) {
    const node = $('#toast');
    node.className = `toast${error ? ' error' : ''}`;
    node.innerHTML = '';
    node.append(el('span', { text: message }));
    if (undo) {
        node.append(el('button', { text: 'Undo', onclick: () => run({ id: 'undo', name: 'Undo' }) }));
    }
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, undo ? 6000 : 3000);
}

async function run(action, args = {}) {
    try {
        const result = await send({ type: 'run', action: action.id, args });
        closePanel();
        toast(result.message || 'Done', { undo: !!result.closed });
        await refresh();
    } catch (e) {
        toast(e.message, { error: true });
    }
}

function baseArgs() {
    return currentTab ? { tabId: currentTab.id, windowId: currentTab.windowId } : {};
}

async function activate(action) {
    const confirm = await needsConfirm();
    if (action.hasOptions) {
        return openScopePanel(action);
    }
    if (action.hasPreview && confirm) {
        return openPreview(action, baseArgs());
    }
    return run(action, baseArgs());
}

async function needsConfirm() {
    try {
        const { settings } = await loadSettings();
        return settings.confirmClose !== false;
    } catch (e) {
        return true;
    }
}

function openPanel(title) {
    $('#panel-title').textContent = title;
    $('#panel-body').innerHTML = '';
    $('#panel').hidden = false;
}

function closePanel() {
    $('#panel').hidden = true;
    panelState = null;
}

function renderItems(items) {
    if (!items || items.length === 0) {
        return el('div', { class: 'empty', text: 'Nothing matches.' });
    }
    const MAX = 60;
    const list = el('ul', { class: 'list' });
    for (const it of items.slice(0, MAX)) {
        const fav = it.favIconUrl && !it.favIconUrl.startsWith('chrome://')
            ? el('img', { src: it.favIconUrl, alt: '' })
            : el('span', { class: 'fav' });
        list.append(el('li', {}, [
            fav,
            el('span', { class: 't' }, [
                el('b', { text: it.title || it.url }),
                el('span', { text: it.url })
            ])
        ]));
    }
    const wrap = el('div', {}, [list]);
    if (items.length > MAX) {
        wrap.append(el('div', { class: 'more', text: `and ${items.length - MAX} more` }));
    }
    return wrap;
}

async function openPreview(action, args) {
    openPanel(action.name);
    $('#panel-body').append(el('div', { class: 'empty', text: 'Loading…' }));
    try {
        const preview = await send({ type: 'preview', action: action.id, args });
        $('#panel-title').textContent = preview.title || action.name;
        $('#panel-body').innerHTML = '';
        $('#panel-body').append(renderItems(preview.items));
        const confirm = $('#panel-confirm');
        confirm.textContent = preview.confirmLabel || 'Confirm';
        confirm.disabled = !preview.items || preview.items.length === 0;
        confirm.className = action.id === 'restoreParked' ? 'primary' : 'danger';
        panelState = { action, args };
    } catch (e) {
        closePanel();
        toast(e.message, { error: true });
    }
}

async function openScopePanel(action) {
    openPanel(action.name);
    $('#panel-body').append(el('div', { class: 'empty', text: 'Loading…' }));
    try {
        const opts = await send({ type: 'options', action: action.id, args: baseArgs() });
        const body = $('#panel-body');
        body.innerHTML = '';
        if (!opts.tab || opts.scopes.length === 0) {
            body.append(el('div', { class: 'empty', text: 'The current tab has no closable scope.' }));
            $('#panel-confirm').disabled = true;
            return;
        }
        const state = { scope: opts.scopes[0].id, keepCurrent: true };
        const scopesNode = el('div', { class: 'scopes' });
        const listHolder = el('div');

        let requestSeq = 0;
        async function updateList() {
            const seq = ++requestSeq;
            listHolder.innerHTML = '';
            listHolder.append(el('div', { class: 'empty', text: 'Loading…' }));
            const args = { ...baseArgs(), scope: state.scope, keepCurrent: state.keepCurrent };
            const preview = await send({ type: 'preview', action: action.id, args });
            if (seq !== requestSeq) {
                return; // a newer selection superseded this response
            }
            listHolder.innerHTML = '';
            listHolder.append(renderItems(preview.items));
            const confirm = $('#panel-confirm');
            confirm.textContent = preview.confirmLabel;
            confirm.disabled = preview.items.length === 0;
            confirm.className = 'danger';
            panelState = { action, args };
            scopesNode.querySelectorAll('.scope').forEach((n) => {
                n.classList.toggle('on', n.dataset.scope === state.scope);
            });
        }

        for (const s of opts.scopes) {
            const input = el('input', { type: 'radio', name: 'scope', value: s.id });
            input.checked = s.id === state.scope;
            const row = el('label', { class: 'scope', 'data-scope': s.id }, [
                input,
                el('span', { class: 'l' }, [
                    el('b', { text: s.id === 'entity' ? 'Same kind of page' : s.id === 'section' ? 'Same section' : 'Same domain' }),
                    el('span', { text: s.label })
                ]),
                el('span', { class: 'pill', text: String(s.count) })
            ]);
            input.addEventListener('change', () => { state.scope = s.id; updateList(); });
            scopesNode.append(row);
        }
        const keep = el('input', { type: 'checkbox' });
        keep.checked = true;
        keep.addEventListener('change', () => { state.keepCurrent = keep.checked; updateList(); });
        body.append(scopesNode, el('label', { class: 'check' }, [keep, 'Keep the current tab open']), listHolder);
        await updateList();
    } catch (e) {
        closePanel();
        toast(e.message, { error: true });
    }
}

async function loadShortcuts() {
    try {
        const commands = await chrome.commands.getAll();
        for (const c of commands) {
            if (c.shortcut && SHORTCUT_COMMANDS.has(c.name)) {
                shortcuts[c.name] = c.shortcut;
            }
        }
    } catch (e) { /* ignore */ }
}

async function init() {
    $('#panel-close').addEventListener('click', closePanel);
    $('#panel-cancel').addEventListener('click', closePanel);
    $('#panel-confirm').addEventListener('click', () => {
        if (panelState) run(panelState.action, panelState.args);
    });
    $('#undo').addEventListener('click', () => run({ id: 'undo', name: 'Undo' }));
    $('#open-options').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });

    const helpToggle = $('#help-toggle');
    let helpOn = false;
    try {
        helpOn = (await chrome.storage.local.get('popupHelp')).popupHelp === true;
    } catch (e) { /* ignore */ }
    document.body.classList.toggle('help', helpOn);
    helpToggle.classList.toggle('on', helpOn);
    helpToggle.addEventListener('click', async () => {
        helpOn = !helpOn;
        document.body.classList.toggle('help', helpOn);
        helpToggle.classList.toggle('on', helpOn);
        renderActions();
        try { await chrome.storage.local.set({ popupHelp: helpOn }); } catch (e) { /* ignore */ }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('#panel').hidden) closePanel();
    });

    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        currentTab = tab || null;
    } catch (e) { currentTab = null; }

    await loadShortcuts();
    try {
        actions = await send({ type: 'actions' });
    } catch (e) {
        $('#actions').append(el('div', { class: 'empty', text: `Could not reach the extension: ${e.message}` }));
        return;
    }
    renderActions();
    await refresh();
}

init();
