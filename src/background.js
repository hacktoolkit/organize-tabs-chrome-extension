// Service worker. All tab operations run here so they survive the popup
// closing (creating or focusing a window closes the popup).

import { ACTIONS, ACTION_BY_ID, closeTabs, forgetOwnTab, isOwnTab, loadContext, stats } from './lib/actions.js';
import { applyLayout, clearRemoteRules, fetchRemoteRules, recordRemoteError } from './lib/settings.js';
import { canonicalize, isBlankUrl } from './lib/url.js';

const MENU_ROOT = 'organizeTabs';
const REMOTE_ALARM = 'refreshRemoteRules';
const GROUP_TITLES = {
    organize: 'Organize',
    cleanup: 'Clean up',
    windows: 'Windows'
};

// ----- MESSAGES FROM POPUP / OPTIONS --------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => {
            console.error('Organize Tabs action failed', message, error);
            sendResponse({ ok: false, error: error.message || String(error) });
        });
    return true; // keep the channel open for the async response
});

async function handleMessage(message) {
    const { type, action: actionId, args = {} } = message || {};
    const action = actionId ? ACTION_BY_ID[actionId] : null;
    switch (type) {
        case 'stats':
            return stats();
        case 'actions':
            return ACTIONS.map(({ id, name, group, help, preview, options }) => ({
                id,
                name,
                group,
                help,
                hasPreview: typeof preview === 'function',
                hasOptions: typeof options === 'function'
            }));
        case 'options':
            if (!action || !action.options) {
                throw new Error(`No options for ${actionId}`);
            }
            return action.options(args);
        case 'preview':
            if (!action || !action.preview) {
                throw new Error(`No preview for ${actionId}`);
            }
            return action.preview(args);
        case 'run': {
            if (!action) {
                throw new Error(`Unknown action ${actionId}`);
            }
            const result = await action.run(args);
            scheduleBadge();
            return result;
        }
        case 'settingsChanged':
            await rebuildContextMenus();
            await scheduleRemoteRefresh();
            scheduleBadge();
            return true;
        case 'fetchRemoteRules':
            return refreshRemoteRules(true);
        default:
            throw new Error(`Unknown message type ${type}`);
    }
}

// ----- CONTEXT MENUS --------------------

let menuBuild = Promise.resolve();

function rebuildContextMenus() {
    // serialize: onInstalled and onStartup can both fire at launch
    menuBuild = menuBuild.then(buildContextMenus, buildContextMenus);
    return menuBuild;
}

async function buildContextMenus() {
    const ctx = await loadContext();
    const { sections, favorites } = applyLayout(ACTIONS, ctx.settings.layout);
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: MENU_ROOT, title: 'Organize Tabs', contexts: ['all'] });
    const seen = new Set();
    const add = (action, suffix = '') => {
        chrome.contextMenus.create({
            id: `${action.id}${suffix}`,
            parentId: MENU_ROOT,
            title: action.name,
            contexts: ['all']
        });
    };
    if (favorites.length > 0) {
        favorites.forEach((a) => add(a, ':fav'));
        chrome.contextMenus.create({ id: 'sep-favorites', parentId: MENU_ROOT, type: 'separator', contexts: ['all'] });
    }
    sections.forEach((section, i) => {
        if (i > 0) {
            chrome.contextMenus.create({ id: `sep-${section.id}`, parentId: MENU_ROOT, type: 'separator', contexts: ['all'] });
        }
        section.actions.forEach((a) => {
            if (!seen.has(a.id)) {
                seen.add(a.id);
                add(a);
            }
        });
    });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const action = ACTION_BY_ID[String(info.menuItemId).replace(/:fav$/, '')];
    if (!action) {
        return;
    }
    try {
        // The context menu has no preview step; it acts on the clicked tab.
        await action.run({ tabId: tab?.id, windowId: tab?.windowId, scope: 'domain' });
    } catch (e) {
        console.error(`Context menu action ${action.id} failed`, e);
    }
    scheduleBadge();
});

// ----- KEYBOARD COMMANDS --------------------

chrome.commands.onCommand.addListener(async (command, tab) => {
    const action = ACTION_BY_ID[command];
    if (!action) {
        return;
    }
    try {
        await action.run({ tabId: tab?.id, windowId: tab?.windowId, scope: 'domain' });
    } catch (e) {
        console.error(`Command ${command} failed`, e);
    }
    scheduleBadge();
});

// ----- AUTO-DEDUPE --------------------

// Tabs created in the last few seconds are candidates: if their URL resolves to
// something already open, close the new tab and focus the existing one.
const recentlyCreated = new Map();
const AUTO_DEDUPE_WINDOW_MS = 8000;

chrome.tabs.onCreated.addListener((tab) => {
    recentlyCreated.set(tab.id, Date.now());
    for (const [id, at] of recentlyCreated) {
        if (Date.now() - at > AUTO_DEDUPE_WINDOW_MS) {
            recentlyCreated.delete(id);
        }
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    recentlyCreated.delete(tabId);
    forgetOwnTab(tabId);
    scheduleBadge();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
        scheduleBadge();
    }
    if (!changeInfo.url || isBlankUrl(changeInfo.url)) {
        return;
    }
    if (isOwnTab(tabId)) {
        // Undo and Restore reopen tabs on purpose; never auto-close those
        recentlyCreated.delete(tabId);
        return;
    }
    const createdAt = recentlyCreated.get(tabId);
    if (!createdAt || Date.now() - createdAt > AUTO_DEDUPE_WINDOW_MS) {
        return;
    }
    const ctx = await loadContext();
    if (!ctx.settings.autoDedupe) {
        return;
    }
    const { key } = canonicalize(changeInfo.url, ctx.compiled, ctx.settings.normalization);
    const all = await chrome.tabs.query({});
    const existing = all.find(
        (t) =>
            t.id !== tabId &&
            t.incognito === tab.incognito &&
            canonicalize(t.url || t.pendingUrl || '', ctx.compiled, ctx.settings.normalization).key === key
    );
    if (!existing) {
        return;
    }
    recentlyCreated.delete(tabId);
    await closeTabs([{ ...tab, url: changeInfo.url }], 'Auto-dedupe');
    try {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
    } catch (e) {
        // the existing tab may have gone away in the meantime
    }
});

// ----- BADGE --------------------

let badgeTimer = null;

function scheduleBadge() {
    if (badgeTimer) {
        clearTimeout(badgeTimer);
    }
    badgeTimer = setTimeout(updateBadge, 750);
}

async function updateBadge() {
    badgeTimer = null;
    try {
        const ctx = await loadContext();
        if (!ctx.settings.showBadge) {
            await chrome.action.setBadgeText({ text: '' });
            return;
        }
        const s = await stats();
        await chrome.action.setBadgeBackgroundColor({ color: '#5b6cff' });
        await chrome.action.setBadgeText({ text: s.duplicates > 0 ? String(s.duplicates) : '' });
        await chrome.action.setTitle({
            title: `Organize Tabs: ${s.tabs} tabs, ${s.duplicates} duplicates`
        });
    } catch (e) {
        console.warn('badge update failed', e);
    }
}

// ----- REMOTE RULES --------------------

// Keeps the alarm in step with the settings without restarting its countdown
// on every save, drops the cache when the URL is removed or changed, and
// fetches right away when the cache is missing or older than the period.
async function scheduleRemoteRefresh() {
    const ctx = await loadContext();
    const url = ctx.settings.remoteRulesUrl;
    const hours = Math.max(1, Number(ctx.settings.remoteRefreshHours) || 24);
    const period = hours * 60;
    const existing = await chrome.alarms.get(REMOTE_ALARM);
    if (!url) {
        if (existing) {
            await chrome.alarms.clear(REMOTE_ALARM);
        }
        if (ctx.remoteRules.length > 0 || ctx.remoteRulesMeta) {
            await clearRemoteRules();
            scheduleBadge();
        }
        return;
    }
    if (!existing || existing.periodInMinutes !== period) {
        chrome.alarms.create(REMOTE_ALARM, { periodInMinutes: period });
    }
    const meta = ctx.remoteRulesMeta;
    const stale = !meta || meta.url !== url || !meta.fetchedAt || Date.now() - meta.fetchedAt > period * 60000;
    if (stale) {
        if (meta && meta.url !== url) {
            await clearRemoteRules();
        }
        await refreshRemoteRules();
    }
}

async function refreshRemoteRules(force = false) {
    const ctx = await loadContext();
    const url = ctx.settings.remoteRulesUrl;
    if (!url) {
        return null;
    }
    try {
        const meta = await fetchRemoteRules(url);
        scheduleBadge();
        return meta;
    } catch (e) {
        const meta = await recordRemoteError(url, e.message || e);
        if (force) {
            throw new Error(`Could not fetch rules: ${meta.error}`);
        }
        return meta;
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REMOTE_ALARM) {
        refreshRemoteRules();
    }
});

// ----- LIFECYCLE --------------------

chrome.runtime.onInstalled.addListener(async (details) => {
    await rebuildContextMenus();
    await scheduleRemoteRefresh();
    scheduleBadge();
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});

chrome.runtime.onStartup.addListener(() => {
    rebuildContextMenus();
    scheduleRemoteRefresh();
    scheduleBadge();
});

chrome.windows.onRemoved.addListener(scheduleBadge);
scheduleBadge();
