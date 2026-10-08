VERSION := $(shell jq < manifest.json .version -r)
.PHONY: help test check e2e dev dev-clean screenshots clean package

## help - Display help about make targets for this Makefile
help:
	@cat Makefile | grep '^## ' --color=never | cut -c4- | sed -e "`printf 's/ - /\t- /;'`" | column -s "`printf '\t'`" -t

## test - run the unit tests
test:
	node --test

## check - syntax-check every script
check:
	@for f in src/*.js src/lib/*.js; do node --check $$f && echo "ok $$f"; done

## clean - remove all build artifacts
clean:
	rm -f *.zip

## package - build organize_tabs-<version>.zip for the Chrome Web Store (or Load unpacked after unzipping)
package: clean test
	zip -r -X organize_tabs-${VERSION}.zip `cat FILES` -x '*.DS_Store'

## e2e - run the browser end-to-end test (needs Brave or Chromium)
e2e:
	node scripts/e2e.mjs

## dev - launch the holodeck (throwaway browser profile at ~/.holodeck) with the extension and sample tabs
dev:
	node scripts/dev.mjs

## dev-clean - end program: delete the holodeck browser profiles
dev-clean:
	rm -rf "$${HOLODECK:-$$HOME/.holodeck}"/brave "$${HOLODECK:-$$HOME/.holodeck}"/chromium "$${HOLODECK:-$$HOME/.holodeck}"/tmp

## screenshots - render README and Chrome Web Store screenshots from the holodeck
screenshots:
	node scripts/screenshots.mjs
