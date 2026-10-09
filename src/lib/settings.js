// Settings persistence. Preferences and rules live in chrome.storage.sync so
// they follow the browser profile across machines; chrome.storage.local is the
// fallback when sync is unavailable and the home of caches (remote rules).

import { DEFAULT_MEDIA_PATTERNS, DEFAULT_NORMALIZATION, DEFAULT_RULES } from './url.js';

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = {
    // which duplicate to keep: 'recent' (last accessed), 'first' (leftmost), 'deepest' (longest URL)
    survivorPolicy: 'recent',
    // close a freshly opened tab when its URL is already open elsewhere
    autoDedupe: false,
    // show a preview before closing tabs from the popup
    confirmClose: true,
    // show the duplicate count on the toolbar icon
    showBadge: true,
    // "stale" means not accessed for this many days
    staleDays: 7,
    // only create a tab group when at least this many tabs share a host
    minGroupSize: 2,
    // collapse groups created by "Group by domain"
    collapseGroups: false,
    // bookmark folder used by "Park window"
    parkFolderName: 'Organize Tabs',
    normalization: { ...DEFAULT_NORMALIZATION },
    // leave windows that hold a meeting or playing media alone when
    // consolidating or splitting
    protectMediaWindows: true,
    // URL patterns that count as a meeting or media player even when silent
    mediaPatterns: [...DEFAULT_MEDIA_PATTERNS],
    // popup and context-menu layout: section order, per-section action order,
    // and a favorites tray shown first
    layout: {
        sections: ['windows', 'cleanup', 'organize'],
        actions: {},
        favorites: []
    },
    // optional URL of a JSON file with {"rules": [...]} to merge in
    remoteRulesUrl: '',
    remoteRefreshHours: 24
};

const SYNC_KEYS = ['settings', 'rules'];

function area(name) {
    return chrome.storage && chrome.storage[name] ? chrome.storage[name] : null;
}

async function readArea(name, keys) {
    const store = area(name);
    if (!store) {
        return {};
    }
    try {
        return await store.get(keys);
    } catch (e) {
        console.warn(`storage.${name}.get failed`, e);
        return {};
    }
}

async function writeArea(name, data) {
    const store = area(name);
    if (!store) {
        return false;
    }
    try {
        await store.set(data);
        return true;
    } catch (e) {
        console.warn(`storage.${name}.set failed`, e);
        return false;
    }
}

export function mergeSettings(stored) {
    const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    s.normalization = {
        ...DEFAULT_NORMALIZATION,
        ...((stored && stored.normalization) || {})
    };
    const layout = (stored && stored.layout) || {};
    s.layout = {
        sections: Array.isArray(layout.sections) && layout.sections.length ? [...layout.sections] : [...DEFAULT_SETTINGS.layout.sections],
        actions: { ...(layout.actions || {}) },
        favorites: Array.isArray(layout.favorites) ? [...layout.favorites] : []
    };
    return s;
}

// Orders a list of actions ({id, group}) by a layout: returns
// { sections: [{ id, actions }], favorites: [action] }. Unknown sections and
// actions fall back to their registry order, so a stale layout never hides
// anything.
export function applyLayout(actions, layout) {
    const groups = [];
    for (const a of actions) {
        if (!groups.includes(a.group)) groups.push(a.group);
    }
    const sectionOrder = [
        ...(layout?.sections || []).filter((g) => groups.includes(g)),
        ...groups.filter((g) => !(layout?.sections || []).includes(g))
    ];
    const byId = new Map(actions.map((a) => [a.id, a]));
    const sections = sectionOrder.map((id) => {
        const inGroup = actions.filter((a) => a.group === id);
        const wanted = (layout?.actions?.[id] || []).filter((x) => inGroup.some((a) => a.id === x));
        const ordered = [
            ...wanted.map((x) => byId.get(x)),
            ...inGroup.filter((a) => !wanted.includes(a.id))
        ];
        return { id, actions: ordered };
    });
    const favorites = (layout?.favorites || []).filter((x) => byId.has(x)).map((x) => byId.get(x));
    return { sections, favorites };
}

// Returns { settings, rules, remoteRules, source } where rules are the user's
// own rules (defaults on first run) and remoteRules is the cached remote list.
// Both areas are read and the more recently saved copy wins, so a save that
// fell back to local (sync quota) is not shadowed by stale sync data.
export async function loadSettings() {
    const [sync, local] = await Promise.all([
        readArea('sync', [...SYNC_KEYS, 'savedAt']),
        readArea('local', [...SYNC_KEYS, 'savedAt'])
    ]);
    const has = (d) => !!(d.settings || d.rules);
    let data = {};
    let source = 'sync';
    if (has(sync) && has(local)) {
        if ((local.savedAt || 0) > (sync.savedAt || 0)) {
            data = local;
            source = 'local';
        } else {
            data = sync;
        }
    } else if (has(local)) {
        data = local;
        source = 'local';
    } else if (has(sync)) {
        data = sync;
    }
    const cache = await readArea('local', ['remoteRules', 'remoteRulesMeta']);
    return {
        settings: mergeSettings(data.settings),
        rules: Array.isArray(data.rules) ? data.rules : defaultRules(),
        remoteRules: Array.isArray(cache.remoteRules) ? cache.remoteRules : [],
        remoteRulesMeta: cache.remoteRulesMeta || null,
        source
    };
}

export function defaultRules() {
    return DEFAULT_RULES.map((r) => ({ ...r, enabled: true, builtin: true }));
}

export async function saveSettings({ settings, rules }) {
    const payload = {};
    if (settings) {
        payload.settings = mergeSettings(settings);
    }
    if (rules) {
        payload.rules = rules;
    }
    payload.savedAt = Date.now();
    // sync has an 8KB per-item limit; fall back to local when it refuses
    const ok = await writeArea('sync', payload);
    if (!ok) {
        await writeArea('local', payload);
        return 'local';
    }
    // keep local in step so a later fallback compares against fresh data
    await writeArea('local', payload);
    return 'sync';
}

// Effective rule list: the user's rules first, then remote rules that do not
// share a name with a local one.
export function effectiveRules(rules, remoteRules) {
    const names = new Set((rules || []).map((r) => r.name));
    const extra = (remoteRules || []).filter((r) => !names.has(r.name));
    return [...(rules || []), ...extra.map((r) => ({ ...r, remote: true }))];
}

export function exportBundle({ settings, rules }) {
    return {
        app: 'organize-tabs',
        version: SETTINGS_VERSION,
        exportedAt: new Date().toISOString(),
        settings: mergeSettings(settings),
        rules: rules || []
    };
}

// Accepts a full export bundle or a bare {rules: [...]} / [...] list.
export function parseImport(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error(`Not valid JSON: ${e.message}`);
    }
    if (Array.isArray(data)) {
        data = { rules: data };
    }
    if (!data || typeof data !== 'object') {
        throw new Error('Expected a JSON object');
    }
    const out = {};
    if (data.settings && typeof data.settings === 'object') {
        out.settings = mergeSettings(data.settings);
    }
    if (data.rules !== undefined) {
        if (!Array.isArray(data.rules)) {
            throw new Error('"rules" must be an array');
        }
        data.rules.forEach((r, i) => {
            if (!r || typeof r.match !== 'string' || typeof r.key !== 'string') {
                throw new Error(`Rule ${i + 1} needs string "match" and "key"`);
            }
        });
        out.rules = data.rules.map((r) => ({
            name: r.name || `Rule`,
            match: r.match,
            key: r.key,
            enabled: r.enabled !== false
        }));
    }
    if (!out.settings && !out.rules) {
        throw new Error('Nothing to import: no "settings" or "rules" found');
    }
    return out;
}

export async function fetchRemoteRules(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    const parsed = parseImport(await res.text());
    const rules = parsed.rules || [];
    const meta = { url, fetchedAt: Date.now(), count: rules.length, error: null };
    await writeArea('local', { remoteRules: rules, remoteRulesMeta: meta });
    return meta;
}

export async function recordRemoteError(url, error) {
    const cache = await readArea('local', ['remoteRulesMeta']);
    const meta = { ...(cache.remoteRulesMeta || {}), url, error: String(error) };
    await writeArea('local', { remoteRulesMeta: meta });
    return meta;
}

export async function clearRemoteRules() {
    const store = area('local');
    if (store) {
        await store.remove(['remoteRules', 'remoteRulesMeta']);
    }
}
