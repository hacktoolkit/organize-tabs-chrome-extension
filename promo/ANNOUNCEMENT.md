# Launch posts for Organize Tabs 2.0

Post once the Chrome Web Store review approves 2.0.0. Attach `promo/demo.mp4` (LinkedIn, X) or `promo/demo.gif`, and the stills from `promo/stills/` where a static image works better. Plain-text copies of each post are in `promo/posts/`.

Links:
- Blog post (publish this first, then link to it): https://www.jontsai.com/2026/10/10/organize-tabs-2-0
- Store: https://chrome.google.com/webstore/detail/organize-tabs/ebnlpacdgjnofakgfgbildmjdhbibnpa
- Source: https://github.com/hacktoolkit/organize-tabs-chrome-extension

---

## LinkedIn

Attach `demo.mp4`. First line is the hook; LinkedIn truncates after about 200 characters until "see more". Short lines and a blank line between every unit: LinkedIn keeps single line breaks but renders long paragraphs as a wall.

```
I open every link I get pinged and use the tabs as my to-do list.

By Friday that's 100+ tabs. The same pull request open three times. A browser eating memory.

So I rebuilt Organize Tabs, the Chrome extension I wrote in 2020 and have used every day since.

Version 2.0 is out today. Free and open source.

What's new:

→ Deduplicate that understands pages.
A PR and its Files tab. A Jira issue and its board link. A LinkedIn profile and its Experience page. One key, one tab.

→ Auto-dedupe.
Open a link that's already open, and it closes the new tab and takes you to the existing one.

→ Close tabs like this one.
Every open pull request. Every profile. Keep the one you're on.

→ Tab groups that survive.
Group by domain, sort with groups intact, consolidate windows and the groups come along.

→ Meetings are sacred.
Pull the call into its own window with one click. Tidying never touches it.

→ Preview before every close. Undo after.
Settings sync across your profiles, with JSON export and import.

Vanilla JavaScript. No build step. No dependencies. No tracking. Nothing leaves your browser.

Full write-up with the demo:
https://www.jontsai.com/2026/10/10/organize-tabs-2-0

Chrome Web Store:
https://chrome.google.com/webstore/detail/organize-tabs/ebnlpacdgjnofakgfgbildmjdhbibnpa

Source:
https://github.com/hacktoolkit/organize-tabs-chrome-extension

If a site's URLs should count as the same page and don't, open an issue with two example URLs. A rule is a ten-line PR.

#chrome #productivity #opensource #browserextension
```

---

## X / Twitter

Thread of three. Attach `demo.mp4` to the first post. Each post is under 280 characters.

**1/**
```
Organize Tabs 2.0 is out. The Chrome extension I've used daily since 2020, rebuilt.

It knows a PR and its Files tab are the same page. A Jira issue and its board link. A LinkedIn profile and its Experience tab. One key, one tab.

Free, open source, no tracking.
```

**2/**
```
Also new:
• Close tabs like this one: every open PR, every profile, keep the one you're on
• Tab groups survive sorting and consolidating
• Meetings get their own window, never touched by cleanups
• Preview before every close, undo after
• Settings sync + JSON export
```

**3/**
```
Vanilla JS, no build step, no dependencies. Rules are editable JSON with a live tester, so if your site's URLs should collapse and don't, it's a ten-line PR.

Store: https://chrome.google.com/webstore/detail/organize-tabs/ebnlpacdgjnofakgfgbildmjdhbibnpa
Code: https://github.com/hacktoolkit/organize-tabs-chrome-extension
Write-up: https://www.jontsai.com/2026/10/10/organize-tabs-2-0
```

---

## Show HN

Title (under 80 characters):

```
Show HN: Organize Tabs – Chrome extension that dedupes PRs, tickets and profiles
```

URL: `https://www.jontsai.com/2026/10/10/organize-tabs-2-0` (the write-up with the demo video; the repo is linked from it and from the comment below)

First comment, posted immediately after submitting. HN rewards specifics and candour about how it works and what it does not do.

```
I open every link I'm pinged and use the open tabs as a to-do list. By the end of the week that's 100+ tabs across several windows, with the same GitHub PR open as /pull/123, /pull/123/files and /pull/123/checks, the same LinkedIn profile open twice, and the same Jira issue open as /browse/ENG-1 and as ?selectedIssue=ENG-1 on a board.

Every tab deduper I tried compares exact URLs, so none of those count as duplicates. This one works differently: a URL is first normalized (scheme, www, fragment, trailing slash, tracking params, query order), then run through a list of rules, each a regex plus a key template. A rule like

  ^https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)  ->  github:$1/$2/pull/$3

makes every subpage of a PR the same key. 19 rules ship for GitHub, Bitbucket, GitLab, Jira, Confluence, LinkedIn, YouTube, Google Docs/Drive, Notion, HubSpot, Slack, Figma, Amazon, Stack Overflow, Reddit and X. They're editable JSON with a live tester, and you can point the extension at a rules file you host so the same rules follow you across machines.

The same rules power "close tabs like this one": from any PR you can close every open PR (same kind of page), everything under github.com/myorg (same section), or everything on github.com (same domain), keeping the one you're on. There's a preview before anything closes and an undo after.

Other things I cared about:

- It never moves a pinned tab, and it never breaks a tab group. Sort keeps groups contiguous; consolidating windows moves whole groups and merges same-named ones.
- Windows with a meeting or playing media are left alone by consolidate/split, and there's a one-click "pull meetings and media into their own window". I'm usually on a call while tidying.
- Vanilla JS, Manifest V3, no build step, no dependencies, no network calls except the optional rules file you configure. Nothing leaves the browser.

Testing was the fun part. The pure URL logic has a node --test suite. The whole extension is also driven end to end in a real headless Chromium over the DevTools protocol: it seeds tabs, clicks every action, and asserts on the resulting windows, groups and pinned state. That runs in CI on every push, and the same harness records the demo video in the README.

Limitations: Chrome has no API for the tab-strip right-click menu, so actions live in the toolbar popup, the page context menu and keyboard shortcuts. "Stale tab" detection uses lastAccessed, which needs Chrome 121+. It can't tell a paused video from a playing one without a content script, so silent media detection is URL-based.

Source: https://github.com/hacktoolkit/organize-tabs-chrome-extension
Store: https://chrome.google.com/webstore/detail/organize-tabs/ebnlpacdgjnofakgfgbildmjdhbibnpa

Happy to answer questions, and if a site's URLs should collapse and don't, two example URLs in an issue is enough for me to add a rule.
```
