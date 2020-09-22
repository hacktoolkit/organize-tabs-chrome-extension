# Organize Tabs Google Chrome Extension

This plugin enables the following operations:

- **Collate Tabs** - Groups all of your tabs into separate windows, grouped by hostname, and sorted by URL. Ignores windows with pinned tabs.
- **Deduplicate Tabs** - Enumerates through all tabs, and keeps only the first copy of a tab with a unique URL, and closes the remaining tabs with duplicate URLs. Recommend running this *after* running **Collate Tabs**.
- **Close Blank Tabs** - Closes all blank tabs

Available on the Google Chrome Webstore: [PENDING]

## Screenshots

![image](https://user-images.githubusercontent.com/422501/93855418-528f1e00-fc6c-11ea-94e1-3a76d875e5b8.png)

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


## License

MIT. See LICENSE.

Logo: Derived from `window-restore` [icon](https://fontawesome.com/icons/window-restore?style=regular) from Font Awesome (License: <https://fontawesome.com/license>).
