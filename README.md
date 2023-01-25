# Organize Tabs Google Chrome Extension

This plugin enables the following operations:

- **Collate Tabs** - Groups all tabs into separate windows, grouped by hostname, and sorted by URL. Ignores windows with pinned tabs.
- **Consolidate Tabs** - Combines all tabs across all windows into one window, sorted by URL. Ignores windows with pinned tabs.
- **Deduplicate Tabs** - Enumerates through all tabs, and keeps only the first copy of a tab with a unique URL, and closes the remaining tabs with duplicate URLs. Recommend running this *after* running **Collate Tabs**.
- **Sort Tabs in Window** - Sorts tabs in current window by URL.
- **Close All Tabs from this Domain** - Close all tabs opened to the same domain/host as the current tab.
- **Close Blank Tabs** - Closes all blank tabs.
- **Bring All Windows To Front** - Focuses all windows in session and tiles them. Useful for rediscovering misplaced windows.

Available on the Google Chrome Webstore: <https://chrome.google.com/webstore/detail/organize-tabs/ebnlpacdgjnofakgfgbildmjdhbibnpa>

## Screenshots

![image](https://github.com/hacktoolkit/organize-tabs-chrome-extension/raw/master/promo/screenshot1.png)

## Development and Testing

1. Clone this repository locally.
1. In Google Chrome, go to `Manage Extensions` (<chrome://extensions/>).
1. Enable `Developer mode`.
1. Press `Load unpacked` and navigate to the folder with `manifest.json`, and `Select`.
1. Voilà!

## Building and publishing

See: https://developer.chrome.com/webstore/publish


## Contributing

Contributions are welcome. Please fork the repository and submit a pull request from your local branch.

## Support

Check out <a href="https://github.com/hacktoolkit/chrome-extensions">other Chrome extensions</a> made by Hacktoolkit!

## License

MIT. See LICENSE.md.

Logo: Derived from `window-restore` [icon](https://fontawesome.com/icons/window-restore?style=regular) from Font Awesome (License: <https://fontawesome.com/license>).
