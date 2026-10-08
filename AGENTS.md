# Organize Tabs: notes for AI agents and contributors

## What this is

A Chrome extension (Manifest V3) that groups, sorts, deduplicates and tidies tabs. It is the maintainer's daily driver, used across many machines and browser profiles. Keep it that way: vanilla JavaScript, no build step, no runtime dependencies.

## Layout

```
manifest.json
src/background.js      service worker: message router, context menus, shortcuts, auto-dedupe, badge
src/lib/url.js         pure URL logic: normalization, entity rules, duplicate detection, sort order (tested)
src/lib/settings.js    chrome.storage.sync persistence, export/import, remote rules
src/lib/actions.js     the action registry and everything that touches the tabs/windows/bookmarks APIs
src/popup.*            toolbar popup (sends messages, runs nothing itself)
src/options.*          settings page
src/ui.css             shared design tokens, light and dark
test/url.test.js       node --test suite for src/lib/url.js
scripts/e2e.mjs        headless browser test over the DevTools protocol
scripts/dev.mjs        launches the holodeck dev profile with sample tabs
scripts/screenshots.mjs renders README images and 1280x800 store screenshots
STORE_LISTING.md       Chrome Web Store copy, permission justifications, privacy answers
```

## Rules of the road

- **All tab operations run in the service worker.** The popup only sends `chrome.runtime.sendMessage` and renders results. Chrome closes the popup the moment a window is created or focused, which kills any logic running there.
- **Never move a pinned tab.** Every action filters them out or leaves them at their index.
- **Never break a tab group.** Sort keeps groups contiguous. Cross-window moves go through `moveTabsPreservingGroups` in `src/lib/actions.js`, which moves whole groups, merges into a same-named group in the destination, and rebuilds partial groups.
- **Windows holding a meeting or playing media are primary.** Consolidate and Split go through `withoutProtectedWindows`; new window-rearranging actions should too. `isMediaTab` in `src/lib/url.js` defines media (audible, or a URL matching the user's media patterns).
- **Anything that closes tabs goes through `closeTabs`** so it lands in the undo stack, and exposes a `preview` so the popup can show the list first.
- **Pure logic lives in `src/lib/url.js`** and gets a unit test. New duplicate rules go in `DEFAULT_RULES` with a case in `test/url.test.js` showing the URL variants that must collapse and one that must not.
- Keep the existing code style (`.prettierrc`: 4 spaces, single quotes, semicolons).

## Testing

```sh
make test      # unit tests, no browser needed
make e2e       # every action in a real headless browser
make dev       # interactive: the holodeck
```

### The holodeck

Browser testing never touches a real profile. Automated and interactive runs use the **holodeck**, a throwaway sandbox at `~/.holodeck/` (override with `HOLODECK=`):

- `make dev` opens Brave (or `BROWSER=/path/to/chromium make dev`) on `~/.holodeck/brave`, named "🧪 holodeck" in the profile chip, with this folder loaded as an unpacked extension and two windows of sample tabs that hit every rule. The profile persists between runs. `make dev-clean` deletes it.
- `make e2e` creates a fresh profile under `~/.holodeck/tmp/` and removes it when the run ends.
- Google Chrome's branded build ignores `--load-extension`, so the scripts default to Brave. Loading unpacked through `chrome://extensions` works in any browser.

Agents may launch, inspect and destroy anything under `~/.holodeck/` without asking.

CI (`.github/workflows/ci.yml`) runs `make check`, `make test` on Node 22 and 24, and `make e2e` on Ubuntu with Chrome for Testing from `@puppeteer/browsers`. When `CI` is set the e2e script adds `--no-sandbox` and friends for containers.

## Releasing

1. Bump `version` in `manifest.json` and `package.json`. The manifest `description` is the store summary and must stay at or under 132 characters.
2. `make screenshots` if the UI changed, and update `STORE_LISTING.md` if actions or permissions changed.
3. Merge, tag `vX.Y.Z`, create a GitHub Release with the CI zip attached.
4. Upload the zip to the Chrome Web Store dashboard and paste from `STORE_LISTING.md`.
