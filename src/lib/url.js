// Pure URL logic: normalization, entity rules, duplicate detection, sorting.
// No Chrome APIs here so it can be unit tested with `node --test`.

export const TRACKING_PARAMS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'utm_id',
    'fbclid',
    'gclid',
    'dclid',
    'msclkid',
    'mc_cid',
    'mc_eid',
    'igshid',
    'ref',
    'ref_src',
    'ref_url',
    'si',
    '_hsenc',
    '_hsmi',
    'hsCtaTracking',
    'vero_id',
    'yclid',
    'trk',
    'trkInfo',
    'ocid',
    's',
    'feature'
];

// Built-in entity rules. `match` is a regex source tested against the raw URL,
// `key` is a template where $1..$9 refer to capture groups. Two tabs whose URLs
// produce the same key are considered duplicates even if the URLs differ.
export const DEFAULT_RULES = [
    {
        name: 'GitHub pull request',
        match: '^https?://github\\.com/([^/]+)/([^/]+)/pull/(\\d+)',
        key: 'github:$1/$2/pull/$3'
    },
    {
        name: 'GitHub issue',
        match: '^https?://github\\.com/([^/]+)/([^/]+)/issues/(\\d+)',
        key: 'github:$1/$2/issues/$3'
    },
    {
        name: 'Bitbucket pull request',
        match: '^https?://bitbucket\\.org/([^/]+)/([^/]+)/pull-requests/(\\d+)',
        key: 'bitbucket:$1/$2/pr/$3'
    },
    {
        name: 'GitLab merge request',
        match: '^https?://gitlab\\.com/(.+?)/-/merge_requests/(\\d+)',
        key: 'gitlab:$1/mr/$2'
    },
    {
        name: 'Jira issue',
        match: '^https?://([^/]+\\.atlassian\\.net)/(?:browse/|.*[?&]selectedIssue=)([A-Z][A-Z0-9]+-\\d+)',
        key: 'jira:$1/$2'
    },
    {
        name: 'Confluence page',
        match: '^https?://([^/]+\\.atlassian\\.net)/wiki/spaces/[^/]+/pages/(\\d+)',
        key: 'confluence:$1/$2'
    },
    {
        name: 'LinkedIn profile',
        match: '^https?://(?:[a-z]+\\.)?linkedin\\.com/in/([^/?#]+)',
        key: 'linkedin:in/$1'
    },
    {
        name: 'LinkedIn company',
        match: '^https?://(?:[a-z]+\\.)?linkedin\\.com/company/([^/?#]+)',
        key: 'linkedin:company/$1'
    },
    {
        name: 'YouTube video',
        match: '^https?://(?:(?:www|m)\\.youtube\\.com/watch\\?(?:.*&)?v=|youtu\\.be/)([\\w-]{6,})',
        key: 'youtube:$1'
    },
    {
        name: 'Google Docs / Sheets / Slides',
        match: '^https?://docs\\.google\\.com/(document|spreadsheets|presentation|forms)/d/([^/?#]+)',
        key: 'gdocs:$1/$2'
    },
    {
        name: 'Google Drive file',
        match: '^https?://drive\\.google\\.com/(?:file/d/|drive/folders/)([^/?#]+)',
        key: 'gdrive:$1'
    },
    {
        name: 'Notion page',
        match: '^https?://(?:www\\.)?(?:[^/]+\\.)?notion\\.(?:so|site|com)/(?:[^/?#]+/)*?[^/?#]*?([0-9a-f]{32})(?:[?#/]|$)',
        key: 'notion:$1'
    },
    {
        name: 'HubSpot record',
        match: '^https?://app(?:-[a-z0-9]+)?\\.hubspot\\.com/contacts/(\\d+)/(?:record/)?([\\w-]+)/(\\d+)',
        key: 'hubspot:$1/$2/$3'
    },
    {
        name: 'Slack channel or thread',
        match: '^https?://app\\.slack\\.com/client/([A-Z0-9]+)/([A-Z0-9]+)(?:/thread/[A-Z0-9]+-(\\d+\\.\\d+))?',
        key: 'slack:$1/$2/$3'
    },
    {
        name: 'Figma file',
        match: '^https?://(?:www\\.)?figma\\.com/(?:file|design|board|proto)/([\\w-]+)',
        key: 'figma:$1'
    },
    {
        name: 'Amazon product',
        match: '^https?://(?:www\\.)?amazon\\.[a-z.]+/(?:.*/)?(?:dp|gp/product)/([A-Z0-9]{10})',
        key: 'amazon:$1'
    },
    {
        name: 'Stack Overflow question',
        match: '^https?://stackoverflow\\.com/(?:questions|q)/(\\d+)',
        key: 'stackoverflow:$1'
    },
    {
        name: 'Reddit post',
        match: '^https?://(?:www|old|new)\\.reddit\\.com/r/([^/]+)/comments/([a-z0-9]+)',
        key: 'reddit:$1/$2'
    },
    {
        name: 'Twitter / X post',
        match: '^https?://(?:www\\.)?(?:twitter|x)\\.com/[^/]+/status/(\\d+)',
        key: 'x:$1'
    }
];

export const DEFAULT_NORMALIZATION = {
    ignoreScheme: true,
    stripWww: true,
    ignoreFragment: true,
    ignoreTrailingSlash: true,
    stripTrackingParams: true,
    sortQueryParams: true,
    trackingParams: TRACKING_PARAMS
};

export const BLANK_URLS = new Set([
    'chrome://newtab/',
    'chrome://new-tab-page/',
    'chrome://new-tab-page-third-party/',
    'brave://newtab/',
    'edge://newtab/',
    'about:blank',
    'about:newtab',
    ''
]);

export function isBlankUrl(url) {
    return BLANK_URLS.has(url || '');
}

export function parseUrl(url) {
    try {
        return new URL(url);
    } catch (e) {
        return null;
    }
}

export function isWebUrl(url) {
    const u = parseUrl(url);
    return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
}

// Hostname without a leading www., or null for non-web URLs.
export function hostOf(url) {
    const u = parseUrl(url);
    if (!u || !u.hostname) {
        return null;
    }
    return u.hostname.toLowerCase().replace(/^www\./, '');
}

// Host plus first path segment, e.g. github.com/dataro. Falls back to the host.
export function sectionOf(url) {
    const u = parseUrl(url);
    if (!u || !u.hostname) {
        return null;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const first = u.pathname.split('/').filter(Boolean)[0];
    return first ? `${host}/${first}` : host;
}

export function normalizeUrl(url, options = {}) {
    const opts = { ...DEFAULT_NORMALIZATION, ...options };
    const u = parseUrl(url);
    if (!u) {
        return url || '';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return opts.ignoreFragment ? url.split('#')[0] : url;
    }

    if (opts.ignoreScheme) {
        u.protocol = 'https:';
    }
    u.hostname = u.hostname.toLowerCase();
    if (opts.stripWww) {
        u.hostname = u.hostname.replace(/^www\./, '');
    }
    if (opts.ignoreFragment) {
        u.hash = '';
    }
    if (opts.stripTrackingParams || opts.sortQueryParams) {
        const tracking = new Set(
            (opts.trackingParams || []).map((p) => p.toLowerCase())
        );
        const kept = [];
        for (const [k, v] of u.searchParams.entries()) {
            if (opts.stripTrackingParams && tracking.has(k.toLowerCase())) {
                continue;
            }
            kept.push([k, v]);
        }
        if (opts.sortQueryParams) {
            kept.sort((a, b) =>
                a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1
            );
        }
        const params = new URLSearchParams();
        kept.forEach(([k, v]) => params.append(k, v));
        const qs = params.toString();
        u.search = qs ? `?${qs}` : '';
    }
    let out = u.toString();
    if (opts.ignoreTrailingSlash) {
        // strip a trailing slash on the path, but keep the root "/"
        out = out.replace(/\/(\?[^#]*)?$/, (m, q) =>
            u.pathname === '/' ? m : q || ''
        );
    }
    return out;
}

// Compile rule definitions into regexes. Invalid rules are skipped and reported
// via the returned `errors` array so the options page can show them.
export function compileRules(rules) {
    const compiled = [];
    const errors = [];
    (rules || []).forEach((rule, i) => {
        if (!rule || rule.enabled === false) {
            return;
        }
        if (!rule.match || !rule.key) {
            errors.push({ index: i, rule, error: 'match and key are required' });
            return;
        }
        try {
            compiled.push({
                name: rule.name || `Rule ${i + 1}`,
                re: new RegExp(rule.match, rule.flags || 'i'),
                key: rule.key
            });
        } catch (e) {
            errors.push({ index: i, rule, error: e.message });
        }
    });
    return { compiled, errors };
}

export function expandTemplate(template, match) {
    return template
        .replace(/\$\{(\w+)\}/g, (m, name) =>
            match.groups && match.groups[name] !== undefined
                ? match.groups[name]
                : ''
        )
        .replace(/\$(\d)/g, (m, n) => match[Number(n)] ?? '');
}

// Returns { key, rule } where rule is the matching rule name or null when only
// generic normalization applied.
export function canonicalize(url, compiledRules = [], normalization = {}) {
    if (!url) {
        return { key: '', rule: null };
    }
    for (const rule of compiledRules) {
        const match = rule.re.exec(url);
        if (match) {
            return {
                key: expandTemplate(rule.key, match).toLowerCase(),
                rule: rule.name
            };
        }
    }
    return { key: normalizeUrl(url, normalization), rule: null };
}

export function matchingRule(url, compiledRules = []) {
    for (const rule of compiledRules) {
        if (rule.re.test(url)) {
            return rule;
        }
    }
    return null;
}

// Which tab of a duplicate set to keep. Pinned beats active beats the policy.
export function survivorScore(tab, policy = 'recent') {
    let score = 0;
    if (tab.pinned) {
        score += 1e15;
    }
    if (tab.active) {
        score += 1e14;
    }
    if (policy === 'recent') {
        score += tab.lastAccessed || 0;
    } else if (policy === 'deepest') {
        score += (tab.url || '').length;
    } else if (policy === 'first') {
        score -= (tab.windowId || 0) * 1e6 + (tab.index || 0);
    }
    return score;
}

// Groups tabs by canonical key. Returns sets with more than one tab, each with
// a `keep` tab and `close` tabs.
export function findDuplicates(tabs, compiledRules, normalization, policy) {
    const byKey = new Map();
    for (const tab of tabs) {
        const url = tab.url || tab.pendingUrl || '';
        if (!url || isBlankUrl(url)) {
            continue;
        }
        const { key, rule } = canonicalize(url, compiledRules, normalization);
        // never treat a normal and an incognito tab as duplicates of each other
        const scoped = `${tab.incognito ? 'i:' : 'n:'}${key}`;
        if (!byKey.has(scoped)) {
            byKey.set(scoped, { key, rule, tabs: [] });
        }
        byKey.get(scoped).tabs.push(tab);
    }
    const sets = [];
    for (const entry of byKey.values()) {
        if (entry.tabs.length < 2) {
            continue;
        }
        const sorted = [...entry.tabs].sort(
            (a, b) => survivorScore(b, policy) - survivorScore(a, policy)
        );
        sets.push({
            key: entry.key,
            rule: entry.rule,
            keep: sorted[0],
            close: sorted.slice(1)
        });
    }
    return sets;
}

// Describes the scopes a "close tabs like this one" action can use for a URL.
export function scopesFor(url, compiledRules = []) {
    const host = hostOf(url);
    if (!host) {
        return [];
    }
    const scopes = [{ id: 'domain', label: host, test: (u) => hostOf(u) === host }];
    const section = sectionOf(url);
    if (section && section !== host) {
        scopes.push({
            id: 'section',
            label: section,
            test: (u) => sectionOf(u) === section
        });
    }
    const rule = matchingRule(url, compiledRules);
    if (rule) {
        scopes.push({
            id: 'entity',
            label: `${rule.name}s`,
            test: (u) => rule.re.test(u)
        });
    }
    return scopes;
}

// Sort key that clusters related hosts: reversed host labels, then path,
// then query. "docs.google.com" sorts next to "mail.google.com".
export function sortKey(url) {
    const u = parseUrl(url);
    if (!u || !u.hostname) {
        return `~${url || ''}`;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const reversed = host.split('.').reverse().join('.');
    return `${reversed} ${u.pathname.toLowerCase()} ${u.search}`;
}

export function compareTabs(a, b) {
    const ka = sortKey(a.url || a.pendingUrl);
    const kb = sortKey(b.url || b.pendingUrl);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function isStale(tab, days, now = Date.now()) {
    if (!tab.lastAccessed || days <= 0) {
        return days <= 0 ? !tab.active : false;
    }
    return now - tab.lastAccessed > days * 86400000;
}

// A short label for a tab group built from a host: "github" for github.com,
// "atlassian" for dataro.atlassian.net.
export function groupTitleForHost(host) {
    if (!host) {
        return '';
    }
    const parts = host.split('.');
    if (parts.length <= 2) {
        return parts[0];
    }
    // drop common public suffix parts (co.uk, com.au ...) and keep the brand
    const suffixes = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
    let i = parts.length - 2;
    if (suffixes.has(parts[i]) && parts[i + 1].length === 2 && i > 0) {
        i -= 1;
    }
    return parts[i];
}

export const GROUP_COLORS = [
    'grey',
    'blue',
    'red',
    'yellow',
    'green',
    'pink',
    'purple',
    'cyan',
    'orange'
];

export function colorForHost(host) {
    let hash = 0;
    for (const ch of host || '') {
        hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    }
    return GROUP_COLORS[hash % GROUP_COLORS.length];
}
