import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SETTINGS,
    defaultRules,
    effectiveRules,
    exportBundle,
    mergeSettings,
    parseImport
} from '../src/lib/settings.js';
import { DEFAULT_MEDIA_PATTERNS, DEFAULT_RULES, TRACKING_PARAMS } from '../src/lib/url.js';

test('mergeSettings fills defaults and merges normalization', () => {
    const s = mergeSettings({ staleDays: 3, normalization: { stripWww: false } });
    assert.equal(s.staleDays, 3);
    assert.equal(s.normalization.stripWww, false);
    assert.equal(s.normalization.ignoreFragment, true);
    assert.deepEqual(s.normalization.trackingParams, TRACKING_PARAMS);
    assert.deepEqual(s.mediaPatterns, DEFAULT_MEDIA_PATTERNS);
    assert.deepEqual(mergeSettings(undefined), { ...DEFAULT_SETTINGS, normalization: mergeSettings().normalization });
});

test('defaultRules are enabled copies of the built-ins', () => {
    const rules = defaultRules();
    assert.equal(rules.length, DEFAULT_RULES.length);
    assert.ok(rules.every((r) => r.enabled && r.builtin));
    rules[0].name = 'changed';
    assert.notEqual(DEFAULT_RULES[0].name, 'changed');
});

test('effectiveRules appends remote rules unless a local rule has the same name', () => {
    const local = [{ name: 'A', match: 'a', key: 'a' }];
    const remote = [{ name: 'A', match: 'x', key: 'x' }, { name: 'B', match: 'b', key: 'b' }];
    const out = effectiveRules(local, remote);
    assert.deepEqual(out.map((r) => r.name), ['A', 'B']);
    assert.equal(out[0].match, 'a');
    assert.equal(out[1].remote, true);
    assert.deepEqual(effectiveRules(undefined, undefined), []);
});

test('parseImport accepts a bundle, a {rules} object, or a bare array', () => {
    const bundle = exportBundle({ settings: { staleDays: 9 }, rules: [{ name: 'R', match: 'm', key: 'k' }] });
    assert.equal(bundle.app, 'organize-tabs');
    const parsed = parseImport(JSON.stringify(bundle));
    assert.equal(parsed.settings.staleDays, 9);
    assert.deepEqual(parsed.rules, [{ name: 'R', match: 'm', key: 'k', enabled: true }]);
    assert.deepEqual(parseImport('{"rules":[{"match":"m","key":"k","enabled":false}]}').rules, [
        { name: 'Rule', match: 'm', key: 'k', enabled: false }
    ]);
    assert.equal(parseImport('[{"match":"m","key":"k"}]').rules.length, 1);
    assert.equal(parseImport('{"rules":[]}').rules.length, 0);
});

test('parseImport rejects bad input with a readable message', () => {
    assert.throws(() => parseImport('not json'), /Not valid JSON/);
    assert.throws(() => parseImport('42'), /Expected a JSON object/);
    assert.throws(() => parseImport('{"rules": "x"}'), /must be an array/);
    assert.throws(() => parseImport('{"rules": [{"match": 1}]}'), /Rule 1 needs/);
    assert.throws(() => parseImport('{"foo": 1}'), /Nothing to import/);
});

test('applyLayout orders sections and actions, tolerates stale ids, builds favorites', async () => {
    const { applyLayout } = await import('../src/lib/settings.js');
    const actions = [
        { id: 'a1', group: 'organize' },
        { id: 'a2', group: 'organize' },
        { id: 'c1', group: 'cleanup' },
        { id: 'w1', group: 'windows' }
    ];
    // default-ish layout
    let r = applyLayout(actions, { sections: ['windows', 'cleanup', 'organize'], actions: {}, favorites: [] });
    assert.deepEqual(r.sections.map((s) => s.id), ['windows', 'cleanup', 'organize']);
    assert.deepEqual(r.sections[2].actions.map((a) => a.id), ['a1', 'a2']);
    assert.deepEqual(r.favorites, []);
    // custom order within a section, with an unknown id and a missing one
    r = applyLayout(actions, { sections: ['organize'], actions: { organize: ['a2', 'ghost'] }, favorites: ['w1', 'ghost', 'c1'] });
    assert.deepEqual(r.sections.map((s) => s.id), ['organize', 'cleanup', 'windows']);
    assert.deepEqual(r.sections[0].actions.map((a) => a.id), ['a2', 'a1']);
    assert.deepEqual(r.favorites.map((a) => a.id), ['w1', 'c1']);
    // no layout at all
    r = applyLayout(actions, undefined);
    assert.deepEqual(r.sections.map((s) => s.id), ['organize', 'cleanup', 'windows']);
});

test('mergeSettings normalises a partial or broken layout', async () => {
    const { mergeSettings } = await import('../src/lib/settings.js');
    assert.deepEqual(mergeSettings({}).layout, { sections: ['windows', 'cleanup', 'organize'], actions: {}, favorites: [] });
    const s = mergeSettings({ layout: { sections: 'nope', favorites: ['dedupe'] } });
    assert.deepEqual(s.layout.sections, ['windows', 'cleanup', 'organize']);
    assert.deepEqual(s.layout.favorites, ['dedupe']);
    assert.deepEqual(s.layout.actions, {});
});
