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
