console.log('Organize Tabs Extension is loaded');

// ----- CONSTANTS --------------------

const HOST_REGEX = /https?:\/\/(?<host>[^\/]*).*/;
const NEW_TAB_URL = 'chrome://newtab/';

const ACTIONS = [
    {
        name: 'Collate Tabs',
        id: 'collateTabs',
        cls: 'collate-tabs',
        callback: handleCollateTabsClicked
    },
    {
        name: 'Consolidate All Tabs',
        id: 'consolidateAllTabs',
        cls: 'consolidate-all-tabs',
        callback: handleConsolidateAllTabsClicked
    },
    {
        name: 'Consolidate Pinned vs Unpinned Tabs',
        id: 'consolidatePinnedTabs',
        cls: 'consolidate-pinned-tabs',
        callback: handleConsolidatePinnedTabsClicked
    },
    {
        name: 'Deduplicate Tabs',
        id: 'deduplicateTabs',
        cls: 'deduplicate-tabs',
        callback: handleDeduplicateTabsClicked
    },
    {
        name: 'Sort Tabs in Window',
        id: 'sortWindowTabs',
        cls: 'sort-window-tabs',
        callback: handleSortWindowTabsClicked
    },
    {
        name: 'Close All Tabs from this Domain',
        id: 'closeDomainTabs',
        cls: 'close-domain-tabs',
        callback: handleCloseDomainTabsClicked
    },
    // {
    //     name: 'Close Orphaned Tabs',
    //     id: 'closeOrphans',
    //     cls: 'close-orphans',
    //     callback: handleCloseOrphansClicked
    // },
    {
        name: 'Close Blank Tabs',
        id: 'closeBlankTabs',
        cls: 'close-blank-tabs',
        callback: handleCloseBlankTabsClicked
    },
    {
        name: 'Bring All Windows To Front',
        id: 'focusAllWindows',
        cls: 'focus-all-windows',
        handleFocusAllWindowsClicked
    }
];

const ACTION_CALLBACKS = {};
ACTIONS.forEach((action) => {
    ACTION_CALLBACKS[action.id] = action.callback;
});

// ----- CORE VARIABLES --------------------

let NUM_WINDOWS = null;
let NUM_WINDOWS_WITH_RESOLVED_TABS = null;
let PINNED_TABS = [];
let WINDOW_TABS = {};
let BUCKETS = {};
let HOUSEKEEPING_DONE = false;

// ----- OPTIONS --------------------

// TODO: make this a configurable option
let SKIP_WINDOWS_WITH_PINNED_TABS = false;

// ----- CORE FUNCTIONS --------------------

function resetVariables() {
    NUM_WINDOWS = 0;
    NUM_WINDOWS_WITH_RESOLVED_TABS = 0;

    PINNED_TABS = [];
    WINDOW_TABS = {};
    BUCKETS = {};

    HOUSEKEEPING_DONE = false;
}

function collateTabs() {
    // Groups all tabs into separate windows, grouped by hostname, and sorted by URL. Ignores windows with pinned tabs.
    //
    // Algorithm:
    // 1. Go through all the windows/tabs in WINDOW_TABS, and build buckets of tabs keyed by hostname
    // 2. Loop through every bucket.
    //    a. For every bucket with multiple tabs, create a new window for that bucket and move all tabs to that new window, ordered by the URL
    //    b. For every bucket with single tabs, move all of those tabs to a new window
    // 3. Close all old windows

    // Build buckets of tabs keyed by hostname
    Object.keys(WINDOW_TABS).forEach((windowId) => {
        const tabs = WINDOW_TABS[windowId];
        tabs.forEach((tab) => {
            const match = HOST_REGEX.exec(tab.url);
            if (match) {
                const host = match.groups.host;

                if (typeof BUCKETS[host] === 'undefined') {
                    BUCKETS[host] = [];
                }

                BUCKETS[host].push(tab);
            } else {
                // skip non-matching URLS, e.g. chrome://newtab/
            }
        });
    });

    // Sort tabs by URL in each bucket
    // Identify buckets with single tabs
    const singleTabs = [];

    Object.keys(BUCKETS).forEach((host) => {
        const tabs = BUCKETS[host];
        if (tabs.length === 1) {
            singleTabs.push(tabs[0]);
        } else {
            const orderedTabs = tabs.sort(compareTabUrls);

            // Create a new window and move tabs over
            moveTabsToNewWindow(orderedTabs).then(function (movedTabs) {
                closeBlankTabs();
            });
        }
    });

    // Create a new window for single tabs, and move over, and include a callback
    // to close old windows
    moveTabsToNewWindow(singleTabs).then(function (movedTabs) {
        closeBlankTabs();
    });
}

function consolidateTabs() {
    // Combines all tabs across all windows into one window, sorted by URL. Ignores windows with pinned tabs.
    //
    // Algorithm:
    // 1. Go through all the windows/tabs in WINDOW_TABS, and gather a list of all tabs
    // 2. Move all tabs to a new window, ordered by the URL
    // 3. Close all old windows

    const combinedTabs = [];

    // Combine unpinned tabs for all windows, ordered by `windowId`
    const windowIds = Object.keys(WINDOW_TABS);
    windowIds.sort();
    windowIds.forEach((windowId) => {
        const tabs = WINDOW_TABS[windowId];
        tabs.forEach((tab) => {
            const match = HOST_REGEX.exec(tab.url);
            if (match) {
                // include tabs with actual webpages
                combinedTabs.push(tab);
            } else {
                // skip non-matching URLS, e.g. chrome://newtab/
            }
        });
    });

    // Sort unpinned tabs by URL
    const orderedCombinedTabs = combinedTabs.sort(compareTabUrls);

    // Combine pinned tabs with unpinned tabs
    const orderedTabs = PINNED_TABS.concat(orderedCombinedTabs);

    // Create a new window and move tabs over
    moveTabsToNewWindow(orderedTabs)
        .then(function (movedTabs) {
            return closeBlankTabs();
        })
        .then(function (closedTabs) {
            repinTabs();
        });
}

function moveTabsToNewWindow(tabs) {
    const tabIds = tabs.map((tab) => {
        return tab.id;
    });

    // https://developer.chrome.com/extensions/windows#method-create
    const createData = {};
    return chrome.windows.create(createData).then(function (window) {
        // https://developer.chrome.com/extensions/tabs#method-move
        const moveProperties = {
            windowId: window.id,
            index: -1
        };

        // Open bug in Chromium: https://bugs.chromium.org/p/chromium/issues/detail?id=876460&q=chrome.tabs.move&can=2
        // When moving pinned tabs via API, it becomes unpinned.
        // Also, when `tabIds` includes pinned tabs, the promise/callback fails to complete
        return chrome.tabs.move(tabIds, moveProperties);
    });
}

function deduplicateTabs() {
    chrome.tabs.query({}, function (tabs) {
        const VISITED_URLS = {};
        tabs.forEach((tab) => {
            // grab the base URL without the fragment identifier
            const url = tab.url.split('#')[0];
            if (typeof VISITED_URLS[url] === 'undefined') {
                VISITED_URLS[url] = true;
            } else {
                // already visited, close the tab
                chrome.tabs.remove(tab.id);
            }
        });
    });
}

function compareTabUrls(a, b) {
    const result = a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
    return result;
}

function sortWindowTabs() {
    chrome.tabs.query({ currentWindow: true }, function (tabs) {
        const orderedTabs = tabs.sort(compareTabUrls);

        const tabIds = orderedTabs.map((tab) => {
            return tab.id;
        });

        const moveProperties = {
            index: -1
        };

        chrome.tabs.move(tabIds, moveProperties);
    });
}

// DEPRECATED in favor of closeBlankTabs, which is a superset of this
function closeOrphanedWindows() {
    // close all windows whose only open tab is "chrome://newtab/"
    // https://developer.chrome.com/extensions/windows#method-remove
    const getInfo = {
        populate: true,
        windowTypes: ['normal']
    };
    const callback = function (windows) {
        windows.forEach((window) => {
            if (window.tabs.length === 1) {
                if (window.tabs[0].url === NEW_TAB_URL) {
                    chrome.windows.remove(window.id);
                }
            }
        });
    };
    chrome.windows.getAll(getInfo, callback);
}

function repinTabs() {
    // re-pin moved tabs that were previously pinned
    // https://developer.chrome.com/docs/extensions/reference/tabs/#method-update
    return Promise.all(
        PINNED_TABS.map((tab) => {
            return chrome.tabs.update(tab.id, { pinned: true });
        })
    );
}

function closeDomainTabs() {
    // https://developer.chrome.com/docs/extensions/reference/tabs/#get-the-current-tab

    const queryOptions = { active: true, currentWindow: true };
    return chrome.tabs.query(queryOptions, function (tabs) {
        const tab = tabs[0];
        const match = HOST_REGEX.exec(tab.url);
        if (match) {
            const host = match.groups.host;
            closeTabsWithHostname(host);
        }
    });
}

function closeBlankTabs() {
    // https://developer.chrome.com/extensions/tabs#method-query
    const queryInfo = {
        url: NEW_TAB_URL
    };
    return chrome.tabs.query(queryInfo).then(function (tabs) {
        const tabIds = tabs.map((tab) => {
            return tab.id;
        });
        return chrome.tabs.remove(tabIds);
    });
}

// ----- HELPER FUNCTIONS --------------------

function closeTabsWithHostname(host) {
    // https://developer.chrome.com/docs/extensions/reference/tabs/#method-query
    // https://developer.chrome.com/docs/extensions/mv3/match_patterns/
    const urlPattern = '*://' + host + '/*';
    chrome.tabs.query({ url: urlPattern }, function (tabs) {
        return Promise.all(
            tabs.map((tab) => {
                return chrome.tabs.remove(tab.id);
            })
        );
    });
}

// ----- EVENT HANDLERS --------------------

function handleCollateTabsClicked() {
    resetVariables();

    // https://developer.chrome.com/extensions/windows#method-getAll
    const getInfo = {
        populate: true,
        windowTypes: ['normal']
    };
    const callback = getWindowsCallbackFactory({ collate: true });
    chrome.windows.getAll(getInfo, callback);
}

function handleConsolidateAllTabsClicked() {
    resetVariables();

    // https://developer.chrome.com/extensions/windows#method-getAll
    const getInfo = {
        populate: true,
        windowTypes: ['normal']
    };
    const callback = getWindowsCallbackFactory({
        consolidate: true,
        allTabs: true
    });
    chrome.windows.getAll(getInfo, callback);
}

function handleConsolidatePinnedTabsClicked() {
    resetVariables();

    // https://developer.chrome.com/extensions/windows#method-getAll
    const getInfo = {
        populate: true,
        windowTypes: ['normal']
    };
    const callback = getWindowsCallbackFactory({ consolidate: true });
    chrome.windows.getAll(getInfo, callback);
}

function handleDeduplicateTabsClicked() {
    deduplicateTabs();
}

function handleSortWindowTabsClicked() {
    sortWindowTabs();
}

function handleCloseOrphansClicked() {
    closeOrphanedWindows();
}

function handleCloseDomainTabsClicked() {
    closeDomainTabs();
}

function handleCloseBlankTabsClicked() {
    closeBlankTabs();
}

function handleFocusAllWindowsClicked() {
    // TODO: unused?

    // Move all windows in session to the front
    //
    // https://developer.chrome.com/extensions/windows#method-getAll
    // https://developer.chrome.com/docs/extensions/reference/windows/#method-update
    const getInfo = {
        populate: false,
        windowTypes: ['normal', 'popup']
    };

    chrome.windows.getAll(getInfo, function (windows) {
        const leftOffset = 40;
        const topOffset = 40;
        const count = 1;
        windows.forEach((window) => {
            chrome.windows.update(window.id, {
                focused: true,
                left: leftOffset * count,
                top: topOffset * count
            });
            ++count;
        });
    });
}

// ----- COLLATE / CONSOLIDATE TAB HELPERS --------------------

function getWindowsCallbackFactory(cfg) {
    if (
        typeof cfg.collate === 'undefined' &&
        typeof cfg.consolidate === 'undefined'
    ) {
        throw "getWindowsCallbackFactory must be invoked in 'collate' or 'consolidate' mode";
    }

    const callback = function (windows) {
        const regularWindows = windows.filter((window) => {
            return !window.incognito;
        });

        // set variables
        NUM_WINDOWS = regularWindows.length;
        NUM_WINDOWS_WITH_RESOLVED_TABS = 0;

        regularWindows.forEach((window) => {
            // get all tabs in order to collate them
            // https://developer.chrome.com/extensions/tabs#method-query
            const queryInfo = {
                windowId: window.id
            };
            const callback = makeHandleGotTabsForWindow(window, cfg);
            chrome.tabs.query(queryInfo, callback);
        });
    };

    return callback;
}

function makeHandleGotTabsForWindow(window, cfg) {
    const handler = function (tabs) {
        ++NUM_WINDOWS_WITH_RESOLVED_TABS;

        const pinnedTabs = tabs.filter((tab) => {
            return tab.pinned;
        });

        const unpinnedTabs = tabs.filter((tab) => {
            return !tab.pinned;
        });

        if (SKIP_WINDOWS_WITH_PINNED_TABS && pinnedTabs.length > 0) {
            // skip windows with pinned tabs
            return false;
        } else {
            // store tabs for further processing
            if (cfg.allTabs) {
                PINNED_TABS = PINNED_TABS.concat(pinnedTabs);
            }
            WINDOW_TABS[window.id] = unpinnedTabs;
        }

        if (NUM_WINDOWS_WITH_RESOLVED_TABS === NUM_WINDOWS) {
            // got all the windows
            if (cfg.collate) {
                collateTabs();
            } else if (cfg.consolidate) {
                consolidateTabs();
            } else {
                // do nothing
            }
        }
    };
    return handler;
}

// ----- INITIALIZATION --------------------

function initEventHandlers() {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
        // console.log(info);
        // console.log(tab);
        const callback = ACTION_CALLBACKS[info.menuItemId];
        if (callback) {
            callback();
        } else {
            console.log(`No action callback for ${menuItemId}.`);
        }
    });
}

function init() {
    chrome.runtime.onInstalled.addListener(function () {
        console.log('Organize Tabs Extension is installed');
        const menuId = 'organizeTabsContextMenu';

        chrome.contextMenus.create({
            id: menuId,
            title: 'Organize Tabs',
            contexts: ['all']
        });

        // sub-menus
        ACTIONS.forEach((action) => {
            chrome.contextMenus.create({
                id: action.id,
                parentId: menuId,
                title: action.name,
                contexts: ['all']
            });
        });
    });
}

initEventHandlers();
init();
