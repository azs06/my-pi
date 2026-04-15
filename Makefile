# Makefile for my-pi binary builds

BIN      := dist/my-pi
MENUBAR  := dist/my-pi-menubar
SRC      := src/index.ts
SWIFT    := menubar/main.swift
BUN      := bun
BUILD    := $(BUN) build $(SRC) --compile --minify
BUILD_DBG := $(BUN) build $(SRC) --compile --sourcemap=inline

# Pi SDK ships assets that must live beside the Bun binary at runtime.
# (package.json → version, theme/ → TUI themes, export-html/ → HTML export)
PI_SDK   := node_modules/@mariozechner/pi-coding-agent

.PHONY: build build-debug build-all menubar clean run run-menubar install copy-assets

## ── Menubar app (macOS only) ───────────────────────────────────────────────
menubar: dist
	swiftc -strict-concurrency=minimal \
	       -o $(MENUBAR) $(SWIFT) \
	       -framework AppKit
	@echo "✅  Menubar binary: $(MENUBAR)  ($$(du -sh $(MENUBAR) | cut -f1))"

## Run the menubar app (builds my-pi + menubar first if missing)
run-menubar: build menubar
	open -a Terminal $(MENUBAR) || $(MENUBAR) &
	@echo "✅  Menubar launched."

## ── Default: minified release build for the current machine ────────────────
build: dist copy-assets
	$(BUILD) --outfile $(BIN)
	@echo "✅  Release binary: $(BIN)  ($$(du -sh $(BIN) | cut -f1))"

## ── Debug build: no minification + inline source maps ──────────────────────
build-debug: dist copy-assets
	$(BUILD_DBG) --outfile dist/my-pi-debug
	@echo "✅  Debug binary:   dist/my-pi-debug  ($$(du -sh dist/my-pi-debug | cut -f1))"

## ── Cross-platform release builds ──────────────────────────────────────────
build-all: dist copy-assets
	$(BUILD) --target=bun-darwin-arm64  --outfile dist/my-pi-mac-arm64
	$(BUILD) --target=bun-darwin-x64    --outfile dist/my-pi-mac-x64
	$(BUILD) --target=bun-linux-arm64   --outfile dist/my-pi-linux-arm64
	$(BUILD) --target=bun-linux-x64     --outfile dist/my-pi-linux-x64
	@echo "✅  All binaries built:"
	@ls -lh dist/my-pi-*

## ── Copy Pi SDK runtime assets next to the binary ──────────────────────────
# Pi's config.js looks for these in dirname(process.execPath) when it
# detects it's running inside a Bun compiled binary.
copy-assets: dist
	@echo "📦  Copying Pi SDK runtime assets → dist/"
	@rm -rf dist/theme dist/export-html dist/package.json
	@cp    $(PI_SDK)/package.json              dist/package.json
	@cp -r $(PI_SDK)/dist/modes/interactive/theme \
	       dist/theme
	@cp -r $(PI_SDK)/dist/core/export-html    dist/export-html

## ── Helpers ────────────────────────────────────────────────────────────────
dist:
	@mkdir -p dist

## Run the release binary (builds first if missing)
run: build
	$(BIN)

## Install to /usr/local/bin (current-machine build)
install: build
	cp $(BIN) /usr/local/bin/my-pi
	@echo "✅  Installed to /usr/local/bin/my-pi"

## Remove build artefacts
clean:
	rm -rf dist/
