// Actions that touch the Chrome APIs. Every action has:
//   id, name, group, help            for menus and inline help
//   preview(args) -> { items, title } optional, for actions that close tabs
//   run(args)     -> { message, closed }
// All actions run inside the service worker so they survive the popup closing.

import {
    colorForHost,
    compareTabs,
    compileMediaPatterns,
    compileRules,
    findDuplicates,
    groupTitleForHost,
    hostOf,
    isBlankUrl,
    isMediaTab,
    isMediaUrl,
    isStale,
    isWebUrl,
    scopesFor
} from './url.js';
import { effectiveRules, loadSettings } from './settings.js';

const NO_GROUP = -1;
const UNDO_LIMIT = 10;

// ----- CONTEXT --------------------

export async function loadContext() {
    const loaded = await loadSettings();
    const { compiled, errors } = compileRules(
        effectiveRules(loaded.rules, loaded.remoteRules)
    );
    const media = compileMediaPatterns(loaded.settings.mediaPatterns);
    return { ...loaded, compiled, ruleErrors: errors, media };
}

// ----- MEDIA / MEETINGS --------------------

function mediaTabsIn(win, ctx) {
    return win.tabs.filter((t) => isMediaTab(t, ctx.media));
}

// Windows holding a meeting or playing media are "primary": consolidate and
// split leave them alone when the setting is on.
function withoutProtectedWindows(windows, ctx) {
    if (!ctx.settings.protectMediaWindows) {
        return { windows, protected: [] };
    }
    const protectedWins = windows.filter((w) => mediaTabsIn(w, ctx).length > 0);
    return {
        windows: windows.filter((w) => !protectedWins.includes(w)),
        protected: protectedWins
    };
}

// Tabs can only move between windows of type "normal". A meeting popped out
// into its own window (type "popup") or an installed web app (type "app")
// cannot be moved, so those are reported rather than attempted.
async function movableMediaTabs(ctx) {
    const all = await chrome.windows.getAll({ populate: true });
    const movable = [];
    let stuck = 0;
    for (const w of all) {
        for (const t of mediaTabsIn(w, ctx)) {
            if (w.type === 'normal' && !w.incognito) {
                movable.push(t);
            } else {
                stuck += 1;
            }
        }
    }
    return { media: movable, stuck };
}

async function pullMediaTabs(ctx) {
    const windows = await normalWindows();
    const { media, stuck } = await movableMediaTabs(ctx);
    const stuckNote = stuck > 0 ? ` (${plural(stuck, 'tab')} in popup or app windows left as is)` : '';
    if (media.length === 0) {
        return {
            message: stuck > 0
                ? `Media is already in ${plural(stuck, 'separate popup or app window')}`
                : 'No meeting or playing tabs found'
        };
    }
    // reuse a window that already holds only media tabs
    let target = windows.find(
        (w) => w.tabs.length > 0 && w.tabs.every((t) => isMediaTab(t, ctx.media) || isBlankUrl(t.url))
    );
    const toMove = media.filter((t) => !target || t.windowId !== target.id);
    let created = false;
    if (!target) {
        target = await chrome.windows.create({ focused: true });
        created = true;
    }
    const pinned = toMove.filter((t) => t.pinned);
    const unpinned = toMove.filter((t) => !t.pinned);
    let pinnedIndex = target.tabs ? target.tabs.filter((t) => t.pinned).length : 0;
    let failed = 0;
    for (const t of pinned) {
        try {
            await chrome.tabs.move(t.id, { windowId: target.id, index: pinnedIndex });
            await chrome.tabs.update(t.id, { pinned: true });
            pinnedIndex += 1;
        } catch (e) {
            console.warn('could not move pinned media tab', t.url, e);
            failed += 1;
        }
    }
    if (unpinned.length > 0) {
        try {
            await moveTabsPreservingGroups(unpinned, target.id);
        } catch (e) {
            console.warn('bulk media move failed, retrying one by one', e);
            for (const t of unpinned) {
                try {
                    await chrome.tabs.move(t.id, { windowId: target.id, index: -1 });
                } catch (e2) {
                    failed += 1;
                }
            }
        }
    }
    if (created) {
        await closeBlankTabsIn(target.id);
    }
    // bring the meeting (or the first media tab) to the front
    const focus =
        media.find((t) => isMediaUrl(t.url, ctx.media) && t.audible) ||
        media.find((t) => isMediaUrl(t.url, ctx.media)) ||
        media[0];
    try {
        await chrome.tabs.update(focus.id, { active: true });
        await chrome.windows.update(target.id, { focused: true });
    } catch (e) {
        // the focused tab may have refused to move; the window is still up
    }
    const failedNote = failed > 0 ? `, ${failed} could not be moved` : '';
    return {
        message: `${created ? 'Opened a window with' : 'Gathered'} ${plural(media.length - failed, 'media tab')}${failedNote}${stuckNote}`
    };
}

// ----- TAB / WINDOW HELPERS --------------------

async function normalWindows({ includeIncognito = false } = {}) {
    const windows = await chrome.windows.getAll({
        populate: true,
        windowTypes: ['normal']
    });
    return windows.filter((w) => includeIncognito || !w.incognito);
}

async function currentWindow() {
    try {
        return await chrome.windows.getLastFocused({
            populate: true,
            windowTypes: ['normal']
        });
    } catch (e) {
        const all = await normalWindows({ includeIncognito: true });
        return all[0] || null;
    }
}

async function activeTab(windowId) {
    const tabs = await chrome.tabs.query(
        windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true }
    );
    return tabs[0] || null;
}

function tabItem(tab) {
    return {
        id: tab.id,
        title: tab.title || tab.url || '',
        url: tab.url || tab.pendingUrl || '',
        favIconUrl: tab.favIconUrl || '',
        windowId: tab.windowId,
        pinned: !!tab.pinned
    };
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ----- UNDO --------------------

async function readUndo() {
    try {
        const data = await chrome.storage.session.get('undo');
        return Array.isArray(data.undo) ? data.undo : [];
    } catch (e) {
        return [];
    }
}

async function pushUndo(entry) {
    const stack = await readUndo();
    stack.push(entry);
    while (stack.length > UNDO_LIMIT) {
        stack.shift();
    }
    try {
        await chrome.storage.session.set({ undo: stack });
    } catch (e) {
        console.warn('could not record undo entry', e);
    }
}

// Closes tabs and records what was closed so it can be reopened.
export async function closeTabs(tabs, label) {
    const closable = tabs.filter((t) => t && typeof t.id === 'number');
    if (closable.length === 0) {
        return 0;
    }
    await pushUndo({
        label,
        at: Date.now(),
        tabs: closable
            .filter((t) => (t.url || t.pendingUrl) && !isBlankUrl(t.url))
            .map((t) => ({
                url: t.url || t.pendingUrl,
                windowId: t.windowId,
                pinned: !!t.pinned,
                incognito: !!t.incognito
            }))
    });
    await chrome.tabs.remove(closable.map((t) => t.id));
    return closable.length;
}

export async function undoLastClose() {
    const stack = await readUndo();
    const entry = stack.pop();
    if (!entry) {
        return { message: 'Nothing to undo' };
    }
    await chrome.storage.session.set({ undo: stack });
    const windows = await normalWindows({ includeIncognito: true });
    const known = new Set(windows.map((w) => w.id));
    const fallback = await currentWindow();
    let reopened = 0;
    for (const t of entry.tabs) {
        const windowId = known.has(t.windowId) ? t.windowId : fallback?.id;
        try {
            await chrome.tabs.create({
                url: t.url,
                windowId,
                pinned: t.pinned,
                active: false
            });
            reopened += 1;
        } catch (e) {
            console.warn('could not reopen', t.url, e);
        }
    }
    return {
        message: `Reopened ${plural(reopened, 'tab')} (${entry.label})`,
        reopened
    };
}

export async function undoAvailable() {
    const stack = await readUndo();
    const last = stack[stack.length - 1];
    return last ? { label: last.label, count: last.tabs.length, at: last.at } : null;
}

// ----- SORT (pinned-safe, group-safe) --------------------

// Final order: pinned tabs untouched, then tab groups sorted by title with
// their members sorted by URL, then ungrouped tabs sorted by URL.
export async function sortWindow(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    const pinnedCount = tabs.filter((t) => t.pinned).length;
    const unpinned = tabs.filter((t) => !t.pinned);

    const ungrouped = unpinned
        .filter((t) => t.groupId === NO_GROUP)
        .sort(compareTabs);
    for (const t of ungrouped) {
        await chrome.tabs.move(t.id, { index: -1 });
    }

    const groupIds = [...new Set(unpinned.map((t) => t.groupId))].filter(
        (id) => id !== NO_GROUP
    );
    const groups = [];
    for (const id of groupIds) {
        try {
            groups.push(await chrome.tabGroups.get(id));
        } catch (e) {
            // group vanished mid-sort
        }
    }
    groups.sort((a, b) => {
        const ta = (a.title || '').toLowerCase();
        const tb = (b.title || '').toLowerCase();
        return ta < tb ? -1 : ta > tb ? 1 : a.id - b.id;
    });

    let index = pinnedCount;
    for (const g of groups) {
        const members = unpinned
            .filter((t) => t.groupId === g.id)
            .sort(compareTabs);
        await chrome.tabGroups.move(g.id, { index });
        for (let j = 0; j < members.length; j++) {
            await chrome.tabs.move(members[j].id, { index: index + j });
        }
        // moving can drop a tab out of its group; put them back
        await chrome.tabs.group({ groupId: g.id, tabIds: members.map((m) => m.id) });
        index += members.length;
    }
    return { sorted: unpinned.length, groups: groups.length, pinned: pinnedCount };
}

// ----- GROUPING --------------------

async function groupWindowByDomain(win, ctx) {
    const { minGroupSize, collapseGroups } = ctx.settings;
    const candidates = win.tabs.filter(
        (t) => !t.pinned && t.groupId === NO_GROUP && isWebUrl(t.url)
    );
    const buckets = new Map();
    for (const t of candidates) {
        const host = hostOf(t.url);
        if (!buckets.has(host)) {
            buckets.set(host, []);
        }
        buckets.get(host).push(t);
    }
    let created = 0;
    let grouped = 0;
    for (const [host, tabs] of buckets) {
        if (tabs.length < Math.max(1, minGroupSize)) {
            continue;
        }
        const title = groupTitleForHost(host);
        const tabIds = tabs.sort(compareTabs).map((t) => t.id);
        const existing = await chrome.tabGroups.query({ windowId: win.id, title });
        if (existing.length > 0) {
            await chrome.tabs.group({ groupId: existing[0].id, tabIds });
        } else {
            const groupId = await chrome.tabs.group({
                tabIds,
                createProperties: { windowId: win.id }
            });
            await chrome.tabGroups.update(groupId, {
                title,
                color: colorForHost(host),
                collapsed: !!collapseGroups
            });
            created += 1;
        }
        grouped += tabIds.length;
    }
    return { created, grouped };
}

// ----- MOVING TABS BETWEEN WINDOWS --------------------

// Chrome drops a tab out of its group when the tab alone changes window.
// Moving the whole group with tabGroups.move keeps it intact, and when the
// destination already has a group with the same name the tabs join that one.
async function findEquivalentGroup(windowId, title) {
    if (!title) {
        return null;
    }
    const groups = await chrome.tabGroups.query({ windowId });
    return groups.find((g) => (g.title || '').toLowerCase() === title.toLowerCase()) || null;
}

async function moveTabsPreservingGroups(tabs, targetWindowId) {
    const ungrouped = tabs.filter((t) => t.groupId === NO_GROUP);
    if (ungrouped.length > 0) {
        await chrome.tabs.move(
            ungrouped.map((t) => t.id),
            { windowId: targetWindowId, index: -1 }
        );
    }
    const groupIds = [...new Set(tabs.map((t) => t.groupId))].filter((id) => id !== NO_GROUP);
    let merged = 0;
    let moved = 0;
    for (const groupId of groupIds) {
        const members = tabs.filter((t) => t.groupId === groupId);
        const tabIds = members.map((t) => t.id);
        let info = null;
        try {
            info = await chrome.tabGroups.get(groupId);
        } catch (e) {
            // group already gone; fall through and move the tabs plainly
        }
        const equivalent = info ? await findEquivalentGroup(targetWindowId, info.title) : null;
        if (equivalent) {
            await chrome.tabs.move(tabIds, { windowId: targetWindowId, index: -1 });
            await chrome.tabs.group({ groupId: equivalent.id, tabIds });
            merged += 1;
            continue;
        }
        // only carry the group over whole when every member is being moved;
        // otherwise the tabs staying behind would be dragged along
        let keptWhole = false;
        const wholeGroup = info
            ? (await chrome.tabs.query({ groupId })).length === members.length
            : false;
        if (info && wholeGroup) {
            try {
                await chrome.tabGroups.move(groupId, { windowId: targetWindowId, index: -1 });
                keptWhole = true;
            } catch (e) {
                // older Chrome cannot move a group across windows; rebuild it
            }
        }
        if (!keptWhole) {
            await chrome.tabs.move(tabIds, { windowId: targetWindowId, index: -1 });
            const newId = await chrome.tabs.group({
                tabIds,
                createProperties: { windowId: targetWindowId }
            });
            if (info) {
                await chrome.tabGroups.update(newId, {
                    title: info.title || '',
                    color: info.color,
                    collapsed: !!info.collapsed
                });
            }
        }
        moved += 1;
    }
    return { tabs: tabs.length, groupsMoved: moved, groupsMerged: merged };
}

// ----- CONSOLIDATE / SPLIT --------------------

async function consolidate({ includePinned }) {
    const ctx = await loadContext();
    const all = await normalWindows();
    const { windows, protected: protectedWins } = withoutProtectedWindows(all, ctx);
    if (windows.length < 2) {
        return {
            message:
                protectedWins.length > 0
                    ? `Nothing to consolidate outside ${plural(protectedWins.length, 'window')} with a meeting or media`
                    : 'Only one window open, nothing to consolidate'
        };
    }
    const focused = windows.find((w) => w.focused);
    const target =
        focused || windows.slice().sort((a, b) => b.tabs.length - a.tabs.length)[0];
    let moved = 0;
    let groupsKept = 0;
    let groupsMerged = 0;
    let pinnedIndex = target.tabs.filter((t) => t.pinned).length;

    for (const w of windows) {
        if (w.id === target.id) {
            continue;
        }
        const pinned = w.tabs.filter((t) => t.pinned);
        const unpinned = w.tabs.filter((t) => !t.pinned);
        if (includePinned) {
            for (const t of pinned) {
                // Chromium unpins a tab when it changes window; move then re-pin
                await chrome.tabs.move(t.id, { windowId: target.id, index: pinnedIndex });
                await chrome.tabs.update(t.id, { pinned: true });
                pinnedIndex += 1;
                moved += 1;
            }
        }
        if (unpinned.length > 0) {
            const r = await moveTabsPreservingGroups(unpinned, target.id);
            moved += r.tabs;
            groupsKept += r.groupsMoved;
            groupsMerged += r.groupsMerged;
        }
    }
    await sortWindow(target.id);
    await closeBlankTabsIn(target.id);
    const groupNote =
        groupsKept + groupsMerged > 0
            ? `, kept ${plural(groupsKept, 'group')}${groupsMerged ? ` and merged ${groupsMerged}` : ''}`
            : '';
    const mediaNote = protectedWins.length > 0 ? `; left ${plural(protectedWins.length, 'media window')} alone` : '';
    return {
        message: `Moved ${plural(moved, 'tab')} into one window and sorted it${groupNote}${mediaNote}`
    };
}

async function splitWindowsByDomain() {
    const ctx = await loadContext();
    const { windows, protected: protectedWins } = withoutProtectedWindows(await normalWindows(), ctx);
    const tabs = windows
        .flatMap((w) => w.tabs)
        .filter((t) => !t.pinned && isWebUrl(t.url));
    const buckets = new Map();
    for (const t of tabs) {
        const host = hostOf(t.url);
        if (!buckets.has(host)) {
            buckets.set(host, []);
        }
        buckets.get(host).push(t);
    }
    const multi = [...buckets.entries()]
        .filter(([, list]) => list.length > 1)
        .sort(([a], [b]) => (a < b ? -1 : 1));
    const singles = [...buckets.values()]
        .filter((list) => list.length === 1)
        .map((list) => list[0])
        .sort(compareTabs);

    // Sequential, one window at a time, so our own blank-tab cleanup cannot
    // race a window whose tabs have not arrived yet. Group membership travels
    // with the tabs.
    async function newWindowWith(list) {
        const win = await chrome.windows.create({ focused: false });
        await moveTabsPreservingGroups(list, win.id);
        await closeBlankTabsIn(win.id);
        return win;
    }

    let created = 0;
    for (const [, list] of multi) {
        await newWindowWith(list.sort(compareTabs));
        created += 1;
    }
    if (singles.length > 0) {
        await newWindowWith(singles);
        created += 1;
    }
    const mediaNote = protectedWins.length > 0 ? `; left ${plural(protectedWins.length, 'media window')} alone` : '';
    return { message: `Split ${plural(tabs.length, 'tab')} into ${plural(created, 'window')}${mediaNote}` };
}

// ----- CLOSERS --------------------

async function closeBlankTabsIn(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    const blank = tabs.filter((t) => isBlankUrl(t.url) && !t.pinned);
    if (blank.length > 0 && blank.length < tabs.length) {
        await chrome.tabs.remove(blank.map((t) => t.id));
    }
    return blank.length;
}

async function closeBlankTabsEverywhere() {
    const windows = await normalWindows({ includeIncognito: true });
    let closed = 0;
    for (const w of windows) {
        const blank = w.tabs.filter((t) => isBlankUrl(t.url) && !t.pinned);
        if (blank.length === 0) {
            continue;
        }
        // keep one blank tab in a window that has nothing else, so the
        // window itself survives
        const ids = blank.length === w.tabs.length ? blank.slice(1) : blank;
        if (ids.length > 0) {
            await chrome.tabs.remove(ids.map((t) => t.id));
            closed += ids.length;
        }
    }
    return closed;
}

async function duplicateItems(ctx) {
    const tabs = await chrome.tabs.query({});
    const sets = findDuplicates(
        tabs,
        ctx.compiled,
        ctx.settings.normalization,
        ctx.settings.survivorPolicy
    );
    return { sets, tabs: sets.flatMap((s) => s.close) };
}

async function scopeTabs(ctx, args) {
    const tab = args.tabId
        ? await chrome.tabs.get(args.tabId)
        : await activeTab();
    if (!tab) {
        return { tab: null, scopes: [], tabs: [] };
    }
    const url = tab.url || tab.pendingUrl || '';
    const all = await chrome.tabs.query({});
    const scopes = scopesFor(url, ctx.compiled).map((scope) => {
        const matches = all.filter(
            (t) =>
                t.incognito === tab.incognito &&
                !t.pinned &&
                scope.test(t.url || t.pendingUrl || '')
        );
        return { ...scope, matches };
    });
    const chosen = scopes.find((s) => s.id === (args.scope || 'domain')) || scopes[0];
    const tabs = chosen
        ? chosen.matches.filter((t) => !(args.keepCurrent && t.id === tab.id))
        : [];
    return { tab, scopes, chosen, tabs };
}

async function staleTabs(ctx, args) {
    const days = args.days ?? ctx.settings.staleDays;
    const all = await chrome.tabs.query({});
    return all.filter(
        (t) =>
            !t.pinned &&
            !t.active &&
            !t.audible &&
            !isBlankUrl(t.url) &&
            isStale(t, days)
    );
}

// ----- BOOKMARK PARKING --------------------

async function parkFolder(ctx, create) {
    const name = ctx.settings.parkFolderName || 'Organize Tabs';
    const found = (await chrome.bookmarks.search({ title: name })).filter((b) => !b.url);
    if (found.length > 0) {
        return found[0];
    }
    return create ? chrome.bookmarks.create({ title: name }) : null;
}

function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
        d.getHours()
    )}:${pad(d.getMinutes())}`;
}

async function parkableTabs(args) {
    const win = args.windowId
        ? await chrome.windows.get(args.windowId, { populate: true })
        : await currentWindow();
    if (!win) {
        return { win: null, tabs: [] };
    }
    return { win, tabs: win.tabs.filter((t) => !t.pinned && isWebUrl(t.url)) };
}

async function latestParkedFolder(ctx) {
    const root = await parkFolder(ctx, false);
    if (!root) {
        return null;
    }
    const children = (await chrome.bookmarks.getChildren(root.id)).filter((b) => !b.url);
    children.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
    if (!children[0]) {
        return null;
    }
    const items = (await chrome.bookmarks.getChildren(children[0].id)).filter((b) => b.url);
    return { folder: children[0], items };
}

// ----- ACTION REGISTRY --------------------

export const ACTIONS = [
    {
        id: 'groupByDomain',
        name: 'Group Tabs by Domain',
        group: 'organize',
        help: 'Puts tabs from the same site into a tab group, in every window. Pinned tabs and existing groups are left alone.',
        async run() {
            const ctx = await loadContext();
            const windows = await normalWindows({ includeIncognito: true });
            let created = 0;
            let grouped = 0;
            for (const w of windows) {
                const r = await groupWindowByDomain(w, ctx);
                created += r.created;
                grouped += r.grouped;
            }
            return {
                message: `Grouped ${plural(grouped, 'tab')} into ${plural(created, 'new group')}`
            };
        }
    },
    {
        id: 'sortWindow',
        name: 'Sort Tabs in Window',
        group: 'organize',
        help: 'Sorts the current window by site and URL. Pinned tabs stay put and tab groups stay together, sorted by name.',
        async run() {
            const win = await currentWindow();
            if (!win) {
                return { message: 'No window to sort' };
            }
            const r = await sortWindow(win.id);
            return { message: `Sorted ${plural(r.sorted, 'tab')} across ${plural(r.groups, 'group')}` };
        }
    },
    {
        id: 'ungroupWindow',
        name: 'Ungroup Tabs in Window',
        group: 'organize',
        help: 'Removes all tab groups in the current window without closing anything.',
        async run() {
            const win = await currentWindow();
            const ids = (win?.tabs || []).filter((t) => t.groupId !== NO_GROUP).map((t) => t.id);
            if (ids.length > 0) {
                await chrome.tabs.ungroup(ids);
            }
            return { message: `Ungrouped ${plural(ids.length, 'tab')}` };
        }
    },
    {
        id: 'consolidateAll',
        name: 'Consolidate All Tabs',
        group: 'organize',
        help: 'Moves every tab, pinned ones included, into the current window and sorts it. Tab groups come along, and a group joins an existing group with the same name.',
        run: () => consolidate({ includePinned: true })
    },
    {
        id: 'consolidateUnpinned',
        name: 'Consolidate Unpinned Tabs',
        group: 'organize',
        help: 'Moves unpinned tabs into the current window and sorts it. Pinned tabs stay in their windows; tab groups come along.',
        run: () => consolidate({ includePinned: false })
    },
    {
        id: 'splitByDomain',
        name: 'Split Windows by Domain',
        group: 'organize',
        help: 'One window per site, plus one window for sites with a single tab. Pinned tabs stay where they are and tab groups are kept. Prefer "Group Tabs by Domain" for a lighter touch.',
        run: splitWindowsByDomain
    },
    {
        id: 'dedupe',
        name: 'Deduplicate Tabs',
        group: 'cleanup',
        help: 'Closes tabs that point at the same thing. Understands PR, ticket, profile and document pages via the rules in Settings, and keeps the pinned, active or most recent copy.',
        async preview() {
            const ctx = await loadContext();
            const { sets, tabs } = await duplicateItems(ctx);
            return {
                title: `${plural(tabs.length, 'duplicate')} across ${plural(sets.length, 'set')}`,
                items: tabs.map(tabItem),
                confirmLabel: `Close ${plural(tabs.length, 'tab')}`
            };
        },
        async run() {
            const ctx = await loadContext();
            const { tabs } = await duplicateItems(ctx);
            const closed = await closeTabs(tabs, 'Deduplicate');
            return { message: `Closed ${plural(closed, 'duplicate')}`, closed };
        }
    },
    {
        id: 'closeScope',
        name: 'Close Tabs Like This One',
        group: 'cleanup',
        help: 'Closes tabs from the same domain, the same section of the site, or the same kind of page (all pull requests, all profiles). Pinned tabs are never closed.',
        async options(args = {}) {
            const ctx = await loadContext();
            const { tab, scopes } = await scopeTabs(ctx, args);
            return {
                tab: tab ? tabItem(tab) : null,
                scopes: scopes.map((s) => ({ id: s.id, label: s.label, count: s.matches.length }))
            };
        },
        async preview(args = {}) {
            const ctx = await loadContext();
            const { chosen, tabs } = await scopeTabs(ctx, args);
            return {
                title: chosen ? `${plural(tabs.length, 'tab')} from ${chosen.label}` : 'Nothing to close',
                items: tabs.map(tabItem),
                confirmLabel: `Close ${plural(tabs.length, 'tab')}`
            };
        },
        async run(args = {}) {
            const ctx = await loadContext();
            const { chosen, tabs } = await scopeTabs(ctx, args);
            const closed = await closeTabs(tabs, `Close ${chosen?.label || 'tabs'}`);
            return { message: `Closed ${plural(closed, 'tab')} from ${chosen?.label || 'scope'}`, closed };
        }
    },
    {
        id: 'closeStale',
        name: 'Close Stale Tabs',
        group: 'cleanup',
        help: 'Closes tabs you have not looked at for a while (the number of days is in Settings). Pinned, active and playing tabs are skipped.',
        async preview(args = {}) {
            const ctx = await loadContext();
            const tabs = await staleTabs(ctx, args);
            const days = args.days ?? ctx.settings.staleDays;
            return {
                title: `${plural(tabs.length, 'tab')} untouched for ${plural(days, 'day')}`,
                items: tabs.map(tabItem),
                confirmLabel: `Close ${plural(tabs.length, 'tab')}`
            };
        },
        async run(args = {}) {
            const ctx = await loadContext();
            const tabs = await staleTabs(ctx, args);
            const closed = await closeTabs(tabs, 'Close stale');
            return { message: `Closed ${plural(closed, 'stale tab')}`, closed };
        }
    },
    {
        id: 'discardStale',
        name: 'Free Memory (Discard Stale Tabs)',
        group: 'cleanup',
        help: 'Unloads stale tabs from memory without closing them. They reload when you click them.',
        async run(args = {}) {
            const ctx = await loadContext();
            const tabs = (await staleTabs(ctx, args)).filter((t) => !t.discarded);
            let discarded = 0;
            for (const t of tabs) {
                try {
                    await chrome.tabs.discard(t.id);
                    discarded += 1;
                } catch (e) {
                    // some tabs refuse to be discarded
                }
            }
            return { message: `Discarded ${plural(discarded, 'tab')}` };
        }
    },
    {
        id: 'closeBlank',
        name: 'Close Blank Tabs',
        group: 'cleanup',
        help: 'Closes empty new-tab pages everywhere, keeping one if a window would otherwise be empty.',
        async run() {
            const closed = await closeBlankTabsEverywhere();
            return { message: `Closed ${plural(closed, 'blank tab')}` };
        }
    },
    {
        id: 'parkWindow',
        name: 'Park Window to Bookmarks',
        group: 'cleanup',
        help: 'Saves every unpinned tab in the current window into a dated bookmark folder, then closes them. Restore later with "Restore Last Parked".',
        async preview(args = {}) {
            const { tabs } = await parkableTabs(args);
            return {
                title: `Park ${plural(tabs.length, 'tab')} to bookmarks`,
                items: tabs.map(tabItem),
                confirmLabel: `Park ${plural(tabs.length, 'tab')}`
            };
        },
        async run(args = {}) {
            const ctx = await loadContext();
            const { win, tabs } = await parkableTabs(args);
            if (tabs.length === 0) {
                return { message: 'Nothing to park' };
            }
            const root = await parkFolder(ctx, true);
            const folder = await chrome.bookmarks.create({
                parentId: root.id,
                title: `Parked ${stamp()} (${plural(tabs.length, 'tab')})`
            });
            for (const t of tabs) {
                await chrome.bookmarks.create({
                    parentId: folder.id,
                    title: t.title || t.url,
                    url: t.url
                });
            }
            const closed = await closeTabs(tabs, 'Park window');
            if (win && win.tabs.length === closed) {
                // keep the window alive with a blank tab
                await chrome.tabs.create({ windowId: win.id });
            }
            return { message: `Parked ${plural(closed, 'tab')} into "${folder.title}"`, closed };
        }
    },
    {
        id: 'restoreParked',
        name: 'Restore Last Parked',
        group: 'cleanup',
        help: 'Reopens the most recently parked folder as a tab group in the current window and removes the folder.',
        async preview() {
            const ctx = await loadContext();
            const parked = await latestParkedFolder(ctx);
            return {
                title: parked ? parked.folder.title : 'No parked folders',
                items: (parked?.items || []).map((b) => ({ id: b.id, title: b.title, url: b.url })),
                confirmLabel: `Restore ${plural(parked?.items.length || 0, 'tab')}`
            };
        },
        async run() {
            const ctx = await loadContext();
            const parked = await latestParkedFolder(ctx);
            if (!parked || parked.items.length === 0) {
                return { message: 'No parked folders to restore' };
            }
            const win = await currentWindow();
            const ids = [];
            for (const b of parked.items) {
                const t = await chrome.tabs.create({ windowId: win.id, url: b.url, active: false });
                ids.push(t.id);
            }
            const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: win.id } });
            await chrome.tabGroups.update(groupId, { title: parked.folder.title.replace(/^Parked /, '') });
            await chrome.bookmarks.removeTree(parked.folder.id);
            return { message: `Restored ${plural(ids.length, 'tab')} from "${parked.folder.title}"` };
        }
    },
    {
        id: 'pullMedia',
        name: 'Pull Meetings & Media to a Window',
        group: 'windows',
        help: 'Moves every tab that is playing audio or showing a meeting or video player into its own window and focuses the meeting. Consolidate and Split then leave that window alone.',
        async run() {
            const ctx = await loadContext();
            return pullMediaTabs(ctx);
        }
    },
    {
        id: 'focusAllWindows',
        name: 'Bring All Windows to Front',
        group: 'windows',
        help: 'Focuses every window in turn and cascades them so misplaced windows reappear.',
        async run() {
            const windows = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
            let count = 0;
            for (const w of windows) {
                count += 1;
                try {
                    await chrome.windows.update(w.id, {
                        focused: true,
                        left: 40 * count,
                        top: 40 * count,
                        state: w.state === 'minimized' ? 'normal' : w.state
                    });
                } catch (e) {
                    // fullscreen or locked windows can refuse
                }
            }
            return { message: `Brought ${plural(count, 'window')} to front` };
        }
    },
    {
        id: 'undo',
        name: 'Undo Last Close',
        group: 'windows',
        help: 'Reopens the tabs closed by the last Organize Tabs action in this browser session.',
        run: undoLastClose
    }
];

export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

// ----- STATS --------------------

export async function stats() {
    const ctx = await loadContext();
    const tabs = await chrome.tabs.query({});
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const groups = await chrome.tabGroups.query({});
    const dupes = findDuplicates(
        tabs,
        ctx.compiled,
        ctx.settings.normalization,
        ctx.settings.survivorPolicy
    );
    const undo = await undoAvailable();
    return {
        tabs: tabs.length,
        windows: windows.length,
        groups: groups.length,
        pinned: tabs.filter((t) => t.pinned).length,
        duplicates: dupes.reduce((n, s) => n + s.close.length, 0),
        stale: (await staleTabs(ctx, {})).length,
        blank: tabs.filter((t) => isBlankUrl(t.url) && !t.pinned).length,
        discarded: tabs.filter((t) => t.discarded).length,
        media: tabs.filter((t) => isMediaTab(t, ctx.media)).length,
        staleDays: ctx.settings.staleDays,
        ruleErrors: ctx.ruleErrors.length,
        undo
    };
}

export { duplicateItems };
