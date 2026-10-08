# Chrome Web Store listing kit

Everything to paste into the developer dashboard for a release. Regenerate the images with `make screenshots`.

Listing: <https://chrome.google.com/webstore/detail/organize-tabs/ebnlpacdgjnofakgfgbildmjdhbibnpa>
Dashboard: <https://chrome.google.com/webstore/devconsole>

## Package

`make package` builds `organize_tabs-<version>.zip`. CI attaches the same zip to every run as the `organize-tabs-zip` artifact.

## Store listing tab

**Summary** (comes from `manifest.json` → `description`, max 132 characters):

> Group, sort, deduplicate and tidy tabs. Catches duplicate PRs, tickets, profiles and docs even when the URLs differ.

**Category:** Productivity → Tools (Workflow & Planning also fits)

**Language:** English

**Detailed description:**

```
Organize Tabs is for people who keep a lot of tabs open. One click groups, sorts, deduplicates and tidies tabs across every window, and it knows that a pull request, a ticket, a profile or a document is the same page even when the URL is different.

DEDUPLICATE, PROPERLY
A pull request and its Files tab. A Jira issue and its board link. A LinkedIn profile and its Experience page. A YouTube video and its short link. A Google Doc in edit and view mode. Built-in rules collapse all of these to one tab and keep the pinned, active, or most recently viewed copy. Rules are editable, with a live tester, and you can add your own.

TURN IT ON AND FORGET IT
Auto-deduplicate closes a freshly opened link that is already open somewhere and jumps you to the existing tab. Off by default.

CLOSE TABS LIKE THIS ONE
From any tab, close everything on the same domain, in the same section of the site, or the same kind of page: every open pull request, every profile. Keep the one you are on. Always with a preview first, always with undo.

ORGANIZE
• Group Tabs by Domain using native tab groups
• Sort Tabs in Window by site and URL, keeping groups together
• Consolidate every window into one, or split windows by domain
• Pinned tabs never move. Tab groups travel between windows intact and merge into a group with the same name.

MEETINGS AND MEDIA
Pull every meeting and playing tab into its own window with one click. Windows holding a call or a player are left alone by Consolidate and Split, so a tidy-up never pulls the meeting out from under you.

CLEAN UP
• Close stale tabs you have not looked at in days
• Free memory by discarding stale tabs without closing them
• Close blank tabs
• Park a whole window to a dated bookmark folder, and restore it later as a tab group
• Undo the last close

SETTINGS THAT FOLLOW YOU
Preferences and rules sync with your browser profile. Export and import JSON to move between profiles, or point at a rules file you host and it refreshes on a schedule.

Keyboard shortcuts for every action, a duplicate count on the toolbar icon, a right-click menu, light and dark themes, inline help.

Vanilla JavaScript, no build step, no dependencies, no tracking, no network requests except an optional rules file you configure. Open source under the MIT license: https://github.com/hacktoolkit/organize-tabs-chrome-extension
```

**Screenshots** (1280x800, upload in this order from `promo/store/`):

1. `1-popup.png` — the popup with live counts
2. `2-dedupe.png` — duplicate preview
3. `3-scope.png` — close tabs like this one
4. `4-help.png` — inline help
5. `5-rules.png` — settings and rules

**Icon:** `img/icon128.png`

**Small promo tile (440x280) and marquee (1400x560):** optional; not generated yet.

## Privacy tab

**Single purpose:**

> Organize Tabs organizes the user's open browser tabs: grouping, sorting, deduplicating, closing and moving them between windows.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `tabs` | Read tab URLs and titles to find duplicates, sort by URL, group by site, and show previews; move and close tabs. This is the extension's entire function. |
| `tabGroups` | Create, name and colour tab groups for "Group Tabs by Domain", and keep existing groups intact when sorting or moving tabs between windows. |
| `storage` | Save the user's preferences and duplicate rules, synced with the browser profile, plus the session undo stack. |
| `bookmarks` | "Park Window to Bookmarks" saves the current window's tabs into a bookmark folder the user names, and "Restore Last Parked" reopens them. No other bookmarks are read or modified. |
| `contextMenus` | Offer every action from the page right-click menu. |
| `alarms` | Refresh the optional remote rules file on the schedule the user sets. |
| Optional host permissions `https://*/*`, `http://*/*` | Requested at runtime, only for the origin of a remote rules file the user explicitly configures, so it can be fetched when the host does not send CORS headers. Never requested otherwise. |

**Remote code:** No. All code ships in the package. The optional remote rules file is JSON data, parsed and validated, never executed.

**Data usage:** The extension does not collect, transmit or sell any user data. Tab URLs and titles are processed locally in the browser only. Check "Does not collect or use user data" or the equivalent; if the form insists on a declaration, the only data handled is "Website content (URLs and page titles of open tabs)", used for the extension's core functionality, not transmitted off the device.

**Privacy policy URL:** the README section "Privacy" at https://github.com/hacktoolkit/organize-tabs-chrome-extension#privacy

## Distribution tab

Visibility: Public. Regions: all.

## Why users see a permission prompt on this update

Version 2.0.0 adds `tabGroups`, `storage`, `bookmarks` and `alarms`. Chrome disables the extension until the user accepts the new permissions. Mention it in the release notes.

## Release notes (paste into the GitHub Release)

See the pull request description for v2.0.0: https://github.com/hacktoolkit/organize-tabs-chrome-extension/pull/9
