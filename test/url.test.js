import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_RULES,
    canonicalize,
    compareTabs,
    compileRules,
    findDuplicates,
    groupTitleForHost,
    hostOf,
    isStale,
    normalizeUrl,
    scopesFor,
    sectionOf
} from '../src/lib/url.js';

const { compiled, errors } = compileRules(DEFAULT_RULES);

test('default rules all compile', () => {
    assert.equal(errors.length, 0);
    assert.equal(compiled.length, DEFAULT_RULES.length);
});

test('normalizeUrl strips fragment, www, tracking params, trailing slash', () => {
    assert.equal(
        normalizeUrl('http://www.Example.com/a/b/?utm_source=x&b=2&a=1#frag'),
        'https://example.com/a/b?a=1&b=2'
    );
    assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
});

test('normalizeUrl respects options', () => {
    assert.equal(
        normalizeUrl('http://www.example.com/a#x', {
            ignoreScheme: false,
            stripWww: false,
            ignoreFragment: false
        }),
        'http://www.example.com/a#x'
    );
});

test('normalizeUrl leaves non-web URLs alone apart from the fragment', () => {
    assert.equal(normalizeUrl('chrome://extensions/#foo'), 'chrome://extensions/');
    assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('hostOf and sectionOf', () => {
    assert.equal(hostOf('https://www.GitHub.com/dataro/x'), 'github.com');
    assert.equal(sectionOf('https://github.com/dataro/x/pull/1'), 'github.com/dataro');
    assert.equal(sectionOf('https://github.com/'), 'github.com');
    assert.equal(hostOf('chrome://newtab/'), 'newtab');
    assert.equal(hostOf('about:blank'), null);
});

const same = (a, b) => {
    assert.equal(canonicalize(a, compiled).key, canonicalize(b, compiled).key, `${a} vs ${b}`);
};
const different = (a, b) => {
    assert.notEqual(canonicalize(a, compiled).key, canonicalize(b, compiled).key, `${a} vs ${b}`);
};

test('GitHub PR subpages collapse to one key', () => {
    same(
        'https://github.com/dataro/app/pull/123',
        'https://github.com/dataro/app/pull/123/files'
    );
    same(
        'https://github.com/dataro/app/pull/123/commits/abc',
        'https://github.com/dataro/app/pull/123#discussion_r1'
    );
    different(
        'https://github.com/dataro/app/pull/123',
        'https://github.com/dataro/app/pull/124'
    );
    different(
        'https://github.com/dataro/app/pull/123',
        'https://github.com/dataro/app/issues/123'
    );
    assert.equal(
        canonicalize('https://github.com/dataro/app/pull/123/files', compiled).rule,
        'GitHub pull request'
    );
});

test('Bitbucket PR subpages collapse', () => {
    same(
        'https://bitbucket.org/dataro/app/pull-requests/55',
        'https://bitbucket.org/dataro/app/pull-requests/55/diff'
    );
    same(
        'https://bitbucket.org/dataro/app/pull-requests/55/overview',
        'https://bitbucket.org/dataro/app/pull-requests/55/commits'
    );
});

test('Jira issue forms collapse', () => {
    same(
        'https://dataro.atlassian.net/browse/ENG-123',
        'https://dataro.atlassian.net/jira/software/c/projects/ENG/boards/1?selectedIssue=ENG-123'
    );
    same(
        'https://dataro.atlassian.net/browse/ENG-123?focusedCommentId=1',
        'https://dataro.atlassian.net/browse/ENG-123'
    );
    different(
        'https://dataro.atlassian.net/browse/ENG-123',
        'https://dataro.atlassian.net/browse/ENG-1234'
    );
});

test('LinkedIn profile subpages collapse', () => {
    same(
        'https://www.linkedin.com/in/someone/',
        'https://www.linkedin.com/in/someone/details/experience/'
    );
    same(
        'https://linkedin.com/in/someone?trk=x',
        'https://www.linkedin.com/in/someone/recent-activity/all/'
    );
    different('https://www.linkedin.com/in/someone/', 'https://www.linkedin.com/in/other/');
});

test('YouTube forms collapse', () => {
    same(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
        'https://youtu.be/dQw4w9WgXcQ?si=abc'
    );
    same(
        'https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ',
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ'
    );
});

test('Google Docs edit vs view collapse', () => {
    same(
        'https://docs.google.com/document/d/abc123/edit#heading=h.1',
        'https://docs.google.com/document/d/abc123/view'
    );
    same(
        'https://docs.google.com/spreadsheets/d/abc123/edit#gid=0',
        'https://docs.google.com/spreadsheets/d/abc123/edit#gid=999'
    );
});

test('Notion page ids collapse regardless of slug', () => {
    same(
        'https://www.notion.so/dataro/Some-Title-f0c129ab6a8342c2ba1c766719d1d73e',
        'https://www.notion.so/f0c129ab6a8342c2ba1c766719d1d73e?pvs=4'
    );
    same(
        'https://app.notion.com/p/f0c129ab6a8342c2ba1c766719d1d73e',
        'https://app.notion.com/p/navigation-f0c129ab6a8342c2ba1c766719d1d73e'
    );
});

test('HubSpot, Slack, Figma, Amazon, Stack Overflow, Reddit, X', () => {
    same(
        'https://app.hubspot.com/contacts/123/record/0-2/456/',
        'https://app.hubspot.com/contacts/123/record/0-2/456/?interaction=note'
    );
    same(
        'https://app.hubspot.com/contacts/123/company/456',
        'https://app.hubspot.com/contacts/123/record/company/456'
    );
    same(
        'https://app.slack.com/client/T1/C1/thread/C1-1.2',
        'https://app.slack.com/client/T1/C1/thread/C1-1.2?x=1'
    );
    different('https://app.slack.com/client/T1/C1', 'https://app.slack.com/client/T1/C1/thread/C1-1.2');
    same('https://www.figma.com/file/AbC/x?node-id=1', 'https://www.figma.com/design/AbC/y');
    same(
        'https://www.amazon.com/Some-Product/dp/B000000001/ref=sr_1',
        'https://www.amazon.com/gp/product/B000000001'
    );
    same('https://stackoverflow.com/questions/123/how', 'https://stackoverflow.com/q/123');
    same(
        'https://www.reddit.com/r/foo/comments/abc12/title/',
        'https://old.reddit.com/r/foo/comments/abc12/'
    );
    same('https://twitter.com/a/status/1', 'https://x.com/b/status/1');
});

test('plain URLs fall back to normalization', () => {
    const c = canonicalize('https://www.example.com/x?utm_source=a#y', compiled);
    assert.equal(c.rule, null);
    assert.equal(c.key, 'https://example.com/x');
});

test('compileRules reports bad regexes without throwing', () => {
    const r = compileRules([{ name: 'bad', match: '(', key: 'x' }, { match: 'ok', key: 'k' }]);
    assert.equal(r.compiled.length, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].rule.name, 'bad');
});

test('custom rule with named groups', () => {
    const r = compileRules([
        { name: 'ticket', match: '^https://t\\.example/(?<id>\\d+)', key: 'ticket:${id}' }
    ]);
    assert.equal(canonicalize('https://t.example/42/x', r.compiled).key, 'ticket:42');
});

test('findDuplicates keeps pinned, then active, then most recent', () => {
    const tabs = [
        { id: 1, url: 'https://github.com/o/r/pull/1', lastAccessed: 100, windowId: 1, index: 0 },
        { id: 2, url: 'https://github.com/o/r/pull/1/files', lastAccessed: 300, windowId: 1, index: 1 },
        { id: 3, url: 'https://github.com/o/r/pull/1/commits', lastAccessed: 200, windowId: 2, index: 0 },
        { id: 4, url: 'https://github.com/o/r/pull/2', lastAccessed: 200, windowId: 2, index: 1 },
        { id: 5, url: 'chrome://newtab/', windowId: 2, index: 2 },
        { id: 6, url: 'chrome://newtab/', windowId: 2, index: 3 },
        { id: 7, url: 'https://github.com/o/r/pull/1', incognito: true, windowId: 3, index: 0 }
    ];
    let sets = findDuplicates(tabs, compiled, {}, 'recent');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].keep.id, 2);
    assert.deepEqual(sets[0].close.map((t) => t.id).sort(), [1, 3]);

    tabs[0].pinned = true;
    sets = findDuplicates(tabs, compiled, {}, 'recent');
    assert.equal(sets[0].keep.id, 1);

    tabs[0].pinned = false;
    tabs[2].active = true;
    sets = findDuplicates(tabs, compiled, {}, 'recent');
    assert.equal(sets[0].keep.id, 3);

    tabs[2].active = false;
    sets = findDuplicates(tabs, compiled, {}, 'first');
    assert.equal(sets[0].keep.id, 1);
    sets = findDuplicates(tabs, compiled, {}, 'deepest');
    assert.equal(sets[0].keep.id, 3);
});

test('scopesFor offers domain, section and entity', () => {
    const scopes = scopesFor('https://github.com/dataro/app/pull/1/files', compiled);
    assert.deepEqual(scopes.map((s) => s.id), ['domain', 'section', 'entity']);
    assert.equal(scopes[0].label, 'github.com');
    assert.equal(scopes[1].label, 'github.com/dataro');
    assert.equal(scopes[2].label, 'GitHub pull requests');
    assert.ok(scopes[2].test('https://github.com/other/repo/pull/9'));
    assert.ok(!scopes[2].test('https://github.com/other/repo/issues/9'));
    assert.ok(scopes[1].test('https://github.com/dataro/other'));
    assert.ok(!scopes[1].test('https://github.com/other/x'));

    const plain = scopesFor('https://example.com/', compiled);
    assert.deepEqual(plain.map((s) => s.id), ['domain']);
    assert.deepEqual(scopesFor('chrome://newtab/', compiled).map((s) => s.id), ['domain']);
});

test('compareTabs clusters subdomains and ignores scheme/www', () => {
    const tabs = [
        { url: 'https://mail.google.com/x' },
        { url: 'https://www.github.com/b' },
        { url: 'http://docs.google.com/y' },
        { url: 'https://github.com/a' },
        { url: 'chrome://newtab/' }
    ];
    const urls = [...tabs].sort(compareTabs).map((t) => t.url);
    assert.deepEqual(urls, [
        'https://github.com/a',
        'https://www.github.com/b',
        'http://docs.google.com/y',
        'https://mail.google.com/x',
        'chrome://newtab/'
    ]);
});

test('isStale', () => {
    const now = 10 * 86400000;
    assert.ok(isStale({ lastAccessed: 1 }, 7, now));
    assert.ok(!isStale({ lastAccessed: now - 86400000 }, 7, now));
    assert.ok(!isStale({}, 7, now));
    assert.ok(isStale({ active: false }, 0, now));
    assert.ok(!isStale({ active: true }, 0, now));
});

test('groupTitleForHost', () => {
    assert.equal(groupTitleForHost('github.com'), 'github');
    assert.equal(groupTitleForHost('dataro.atlassian.net'), 'atlassian');
    assert.equal(groupTitleForHost('bbc.co.uk'), 'bbc');
    assert.equal(groupTitleForHost('news.bbc.co.uk'), 'bbc');
    assert.equal(groupTitleForHost('localhost'), 'localhost');
});
