// Launches the "holodeck": a throwaway browser profile with the extension
// loaded and a set of sample tabs across two windows, so every action has
// something to work on.
//
//   make dev                          # Brave by default
//   BROWSER=/path/to/chromium make dev
//
// The profile lives at ~/.holodeck/<browser>/ and is reused between runs, so
// settings you change persist. Delete it with `make dev-clean`. Nothing in
// ~/.holodeck is real; it exists to be trashed by humans and AI agents alike.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [
    process.env.BROWSER,
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser'
].filter(Boolean);
const CHROME = CANDIDATES.find((c) => existsSync(c));
if (!CHROME) {
    console.error('No Chromium-based browser found. Set BROWSER=/path/to/binary');
    process.exit(2);
}
export const HOLODECK = process.env.HOLODECK || join(homedir(), '.holodeck');
const browserSlug = basename(CHROME).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-browser$/, '');
export const PROFILE = join(HOLODECK, browserSlug);

// First launch: name the profile so every window's profile chip says where
// you are. Chrome reads profile.name from the Default profile's Preferences.
const prefs = join(PROFILE, 'Default', 'Preferences');
if (!existsSync(prefs)) {
    mkdirSync(dirname(prefs), { recursive: true });
    writeFileSync(prefs, JSON.stringify({ profile: { name: '🧪 holodeck' } }));
}

const WINDOW_1 = [
    'https://github.com/hacktoolkit/organize-tabs-chrome-extension/pull/8',
    'https://github.com/hacktoolkit/organize-tabs-chrome-extension/pull/8/files',
    'https://github.com/hacktoolkit/organize-tabs-chrome-extension/pull/7',
    'https://github.com/hacktoolkit/organize-tabs-chrome-extension/issues',
    'https://www.linkedin.com/in/jontsai/',
    'https://www.linkedin.com/in/jontsai/details/experience/',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://en.wikipedia.org/wiki/Tab_(interface)?utm_source=test#History',
    'http://en.wikipedia.org/wiki/Tab_(interface)',
    'chrome://newtab/'
];
const WINDOW_2 = [
    'https://news.ycombinator.com/',
    'https://news.ycombinator.com/newest',
    'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
    'https://stackoverflow.com/q/11227809',
    'https://developer.chrome.com/docs/extensions/reference/api/tabGroups',
    'https://developer.chrome.com/docs/extensions/reference/api/tabs',
    'chrome://newtab/'
];

const args = [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...WINDOW_1,
    '--new-window',
    ...WINDOW_2
];
const child = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
child.unref();
console.log(`Launched ${CHROME}`);
console.log(`Holodeck profile: ${PROFILE}`);
console.log('');
console.log('Two windows with sample tabs are open: duplicates by rule (PR subpages, LinkedIn');
console.log('profile pages, YouTube short link, Stack Overflow /q/), by normalization (wikipedia');
console.log('with utm/fragment/http), and blank tabs. Click the toolbar icon or right-click a page.');
console.log('After editing source files, reload the extension at chrome://extensions.');
