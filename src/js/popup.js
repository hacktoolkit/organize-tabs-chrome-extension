$(function () {
    // ----- CONSTANTS --------------------

    var HOST_REGEX = /https?:\/\/(?<host>[^\/]*).*/;
    var NEW_TAB_URL = 'chrome://newtab/';

    // ----- CORE VARIABLES --------------------

    var NUM_WINDOWS = null;
    var NUM_WINDOWS_WITH_RESOLVED_TABS = null;
    var WINDOW_TABS = {};
    var BUCKETS = {};

    // ----- OPTIONS --------------------

    // TODO: make this a configurable option
    var SKIP_WINDOWS_WITH_PINNED_TABS = false;

    // ----- CORE FUNCTIONS --------------------

    function resetVariables() {
        NUM_WINDOWS = 0;
        NUM_WINDOWS_WITH_RESOLVED_TABS = 0;
        WINDOW_TABS = {};
        BUCKETS = {};
    }

    function collateTabs() {
        // Algorithm:
        // 1. Go through all the windows/tabs in WINDOW_TABS, and build buckets of tabs keyed by hostname
        // 2. Loop through every bucket.
        //    a. For every bucket with multiple tabs, create a new window for that bucket and move all tabs to that new window, ordered by the URL
        //    b. For every bucket with single tabs, move all of those tabs to a new window
        // 3. Close all old windows

        // Build buckets of tabs keyed by hostname
        _.forEach(_.keys(WINDOW_TABS), function (windowId) {
            var tabs = WINDOW_TABS[windowId];
            _.forEach(tabs, function (tab) {
                var match = HOST_REGEX.exec(tab.url);
                if (match) {
                    var host = match.groups.host;

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
        var singleTabs = [];

        _.forEach(_.keys(BUCKETS), function (host) {
            var tabs = BUCKETS[host];
            if (_.size(tabs) === 1) {
                singleTabs.push(tabs[0]);
            } else {
                var orderedTabs = _.sortBy(tabs, [
                    function (tab) {
                        return tab.url;
                    }
                ]);

                // Create a new window and move tabs over
                moveTabsToNewWindow(orderedTabs, closeBlankTabs);
            }
        });

        // Create a new window for single tabs, and move over, and include a callback
        // to close old windows
        moveTabsToNewWindow(singleTabs, closeBlankTabs);
    }

    function consolidateTabs() {
        // Algorithm:
        // 1. Go through all the windows/tabs in WINDOW_TABS, and gather a list of all tabsa
        // 2. Move all tabs to a new window, ordered by the URL
        // 3. Close all old windows

        var combinedTabs = [];

        // Build buckets of tabs keyed by hostname
        _.forEach(_.keys(WINDOW_TABS), function (windowId) {
            var tabs = WINDOW_TABS[windowId];
            _.forEach(tabs, function (tab) {
                var match = HOST_REGEX.exec(tab.url);
                if (match) {
                    combinedTabs.push(tab);
                } else {
                    // skip non-matching URLS, e.g. chrome://newtab/
                }
            });
        });

        // Sort tabs by URL
        var orderedTabs = _.sortBy(combinedTabs, [
            function (tab) {
                return tab.url;
            }
        ]);

        // Create a new window and move tabs over
        moveTabsToNewWindow(orderedTabs, closeBlankTabs);
    }

    function moveTabsToNewWindow(tabs, callback) {
        var tabIds = _.map(tabs, function (tab) {
            return tab.id;
        });

        // https://developer.chrome.com/extensions/windows#method-create
        var createData = {};
        chrome.windows.create(createData, function (window) {
            // https://developer.chrome.com/extensions/tabs#method-move
            var moveProperties = {
                windowId: window.id,
                index: -1
            };
            chrome.tabs.move(tabIds, moveProperties, callback);
        });
    }

    function deduplicateTabs() {
        chrome.tabs.query({}, function (tabs) {
            var VISITED_URLS = {};
            _.forEach(tabs, function (tab) {
                var url = tab.url;
                if (typeof VISITED_URLS[url] === 'undefined') {
                    VISITED_URLS[url] = true;
                } else {
                    // already visited, close the tab
                    chrome.tabs.remove(tab.id);
                }
            });
        });
    }

    function sortWindowTabs() {
        chrome.tabs.query({ currentWindow: true }, function (tabs) {
            var orderedTabs = _.sortBy(tabs, [
                function (tab) {
                    return tab.url;
                }
            ]);

            var tabIds = _.map(orderedTabs, function (tab) {
                return tab.id;
            });

            var moveProperties = {
                index: -1
            };

            chrome.tabs.move(tabIds, moveProperties);
        });
    }

    // DEPRECATED in favor of closeBlankTabs, which is a superset of this
    function closeOrphanedWindows() {
        // close all windows whose only open tab is "chrome://newtab/"
        // https://developer.chrome.com/extensions/windows#method-remove
        var getInfo = {
            populate: true,
            windowTypes: ['normal']
        };
        var callback = function (windows) {
            _.forEach(windows, function (window) {
                if (_.size(window.tabs) === 1) {
                    if (window.tabs[0].url === NEW_TAB_URL) {
                        chrome.windows.remove(window.id);
                    }
                }
            });
        };
        chrome.windows.getAll(getInfo, callback);
    }

    function closeDomainTabs() {
        // https://developer.chrome.com/docs/extensions/reference/tabs/#get-the-current-tab

        var queryOptions = { active: true, currentWindow: true };
        chrome.tabs.query(queryOptions, function (tabs) {
            var tab = tabs[0];
            var match = HOST_REGEX.exec(tab.url);
            if (match) {
                var host = match.groups.host;
                closeTabsWithHostname(host);
            }
        });
    }

    function closeBlankTabs() {
        // https://developer.chrome.com/extensions/tabs#method-query
        var queryInfo = {
            url: NEW_TAB_URL
        };
        chrome.tabs.query(queryInfo, function (tabs) {
            var tabIds = _.map(tabs, function (tab) {
                return tab.id;
            });
            chrome.tabs.remove(tabIds);
        });
    }

    // ----- HELPER FUNCTIONS --------------------

    function closeTabsWithHostname(host) {
        // https://developer.chrome.com/docs/extensions/reference/tabs/#method-query
        // https://developer.chrome.com/docs/extensions/mv3/match_patterns/
        var urlPattern = '*://' + host + '/*';
        chrome.tabs.query({ url: urlPattern }, function (tabs) {
            _.forEach(tabs, function (tab) {
                chrome.tabs.remove(tab.id);
            });
        });
    }

    // ----- EVENT HANDLERS --------------------

    function handleCollateTabsClicked() {
        resetVariables();

        // https://developer.chrome.com/extensions/windows#method-getAll
        var getInfo = {
            populate: true,
            windowTypes: ['normal']
        };
        var callback = getWindowsCallbackFactory({ collate: true });
        chrome.windows.getAll(getInfo, callback);
    }

    function handleConsolidateTabsClicked() {
        resetVariables();

        // https://developer.chrome.com/extensions/windows#method-getAll
        var getInfo = {
            populate: true,
            windowTypes: ['normal']
        };
        var callback = getWindowsCallbackFactory({ consolidate: true });
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

    // ----- COLLATE / CONSOLIDATE TAB HELPERS --------------------

    function getWindowsCallbackFactory(cfg) {
        if (
            typeof cfg.collate === 'undefined' &&
            typeof cfg.consolidate === 'undefined'
        ) {
            throw "getWindowsCallbackFactory must be invoked in 'collate' or 'consolidate' mode";
        }

        var callback = function (windows) {
            var regularWindows = _.filter(windows, function (window) {
                return !window.incognito;
            });

            // set variables
            NUM_WINDOWS = _.size(regularWindows);
            NUM_WINDOWS_WITH_RESOLVED_TABS = 0;

            _.forEach(regularWindows, function (window) {
                // get all tabs in order to collate them
                // https://developer.chrome.com/extensions/tabs#method-query
                var queryInfo = {
                    windowId: window.id
                };
                var callback = makeHandleGotTabsForWindow(window, cfg);
                chrome.tabs.query(queryInfo, callback);
            });
        };

        return callback;
    }

    function makeHandleGotTabsForWindow(window, cfg) {
        var handler = function (tabs) {
            ++NUM_WINDOWS_WITH_RESOLVED_TABS;

            var pinnedTabs = _.filter(tabs, function (tab) {
                return tab.pinned;
            });

            var unpinnedTabs = _.filter(tabs, function (tab) {
                return !tab.pinned;
            });

            if (SKIP_WINDOWS_WITH_PINNED_TABS &&_.size(pinnedTabs) > 0) {
                // skip windows with pinned tabs
                return false;
            } else {
                // store tabs for further processing
                WINDOW_TABS[window.id] = unpinnedTabs;
            }

            if (NUM_WINDOWS_WITH_RESOLVED_TABS === NUM_WINDOWS) {
                // got all the windows
                if (cfg.collate) {
                    collateTabs();
                } else if (cfg.consolidate) {
                    consolidateTabs();
                }
            }
        };
        return handler;
    }

    // ----- INITIALIZATION --------------------

    function initEventHandlers() {
        $('.collate-tabs').click(handleCollateTabsClicked);
        $('.consolidate-tabs').click(handleConsolidateTabsClicked);
        $('.deduplicate-tabs').click(handleDeduplicateTabsClicked);
        $('.sort-window-tabs').click(handleSortWindowTabsClicked);
        $('.close-domain-tabs').click(handleCloseDomainTabsClicked);
        $('.close-orphans').click(handleCloseOrphansClicked);
        $('.close-blank-tabs').click(handleCloseBlankTabsClicked);
    }

    function init() {}

    initEventHandlers();
    init();
});
