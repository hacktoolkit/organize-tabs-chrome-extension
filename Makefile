VERSION := $(shell jq < manifest.json .version -r)
.PHONY: help test check e2e dev dev-clean clean package

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

## package - creates a new package
package: clean test
	7z a organize_tabs-${VERSION}.zip `cat FILES`

## e2e - run the browser end-to-end test (needs Brave or Chromium)
e2e:
	node scripts/e2e.mjs

## dev - launch a throwaway browser profile with the extension and sample tabs
dev:
	node scripts/dev.mjs

## dev-clean - delete the throwaway dev profile
dev-clean:
	rm -rf "$${TMPDIR:-/tmp}/organize-tabs-dev-profile"
