# Makefile for my-pi binary builds

BIN      := dist/my-pi
BIN_MAC_ARM := dist/my-pi-mac-arm64
BIN_MAC_X64 := dist/my-pi-mac-x64
BIN_MAC_UNIVERSAL := dist/my-pi-mac-universal
MENUBAR  := dist/my-pi-menubar
MENUBAR_ARM := dist/my-pi-menubar-arm64
MENUBAR_X64 := dist/my-pi-menubar-x64
MENUBAR_UNIVERSAL := dist/my-pi-menubar-universal
APP_NAME := MyPi
APP_DIR  := dist/$(APP_NAME).app
APP_CONTENTS := $(APP_DIR)/Contents
APP_RESOURCES := $(APP_CONTENTS)/Resources
APP_RUNTIME := $(APP_RESOURCES)/runtime
APP_BIN  := $(APP_CONTENTS)/MacOS/$(APP_NAME)
APP_PLIST := $(APP_CONTENTS)/Info.plist
APP_ENV_EXAMPLE := $(APP_RESOURCES)/env.example
APP_PROJECT := $(APP_RESOURCES)/project-dir.txt
SRC      := src/index.ts
SWIFT    := menubar/main.swift
APP_INFO := menubar/Info.plist
BUN      := bun
SWIFTC   := xcrun swiftc
LIPO     := xcrun lipo
MACOS_MIN_VERSION ?= 13.0
BUILD    := $(BUN) build $(SRC) --compile --minify
BUILD_DBG := $(BUN) build $(SRC) --compile --sourcemap=inline

# Pi SDK ships assets that must live beside the Bun binary at runtime.
# (package.json → version, theme/ → TUI themes, export-html/ → HTML export)
PI_SDK   := node_modules/@mariozechner/pi-coding-agent

.PHONY: build build-debug build-mac-arm build-mac-x64 build-mac-universal \
        build-all menubar menubar-arm64 menubar-x64 menubar-universal \
        app app-universal clean run run-menubar run-app install copy-assets

## ── Menubar app (macOS only) ───────────────────────────────────────────────
menubar: dist
	$(SWIFTC) -strict-concurrency=minimal \
	         -o $(MENUBAR) $(SWIFT) \
	         -framework AppKit
	@echo "✅  Menubar binary: $(MENUBAR)  ($$(du -sh $(MENUBAR) | cut -f1))"

menubar-arm64: dist
	$(SWIFTC) -target arm64-apple-macos$(MACOS_MIN_VERSION) \
	         -strict-concurrency=minimal \
	         -o $(MENUBAR_ARM) $(SWIFT) \
	         -framework AppKit
	@echo "✅  Menubar binary: $(MENUBAR_ARM)"

menubar-x64: dist
	$(SWIFTC) -target x86_64-apple-macos$(MACOS_MIN_VERSION) \
	         -strict-concurrency=minimal \
	         -o $(MENUBAR_X64) $(SWIFT) \
	         -framework AppKit
	@echo "✅  Menubar binary: $(MENUBAR_X64)"

menubar-universal: menubar-arm64 menubar-x64
	$(LIPO) -create -output $(MENUBAR_UNIVERSAL) $(MENUBAR_ARM) $(MENUBAR_X64)
	@echo "✅  Universal menubar binary: $(MENUBAR_UNIVERSAL)  ($$(du -sh $(MENUBAR_UNIVERSAL) | cut -f1))"

## Run the menubar app (builds my-pi + menubar first if missing)
run-menubar: build menubar
	open -a Terminal $(MENUBAR) || $(MENUBAR) &
	@echo "✅  Menubar launched."

## Package the menubar as a self-contained macOS .app bundle
app: build menubar
	@rm -rf $(APP_DIR)
	@mkdir -p $(APP_CONTENTS)/MacOS $(APP_RUNTIME)
	@cp $(MENUBAR) $(APP_BIN)
	@chmod +x $(APP_BIN)
	@cp $(APP_INFO) $(APP_PLIST)
	@cp $(BIN) $(APP_RUNTIME)/my-pi
	@cp dist/package.json $(APP_RUNTIME)/package.json
	@cp .env.example $(APP_ENV_EXAMPLE)
	@rm -rf $(APP_RUNTIME)/theme $(APP_RUNTIME)/export-html
	@cp -r dist/theme $(APP_RUNTIME)/theme
	@cp -r dist/export-html $(APP_RUNTIME)/export-html
	@printf "%s\n" "$(CURDIR)" > $(APP_PROJECT)
	@echo "✅  macOS app bundle: $(APP_DIR)"

## Package a universal macOS .app bundle for GitHub Releases
app-universal: build-mac-universal menubar-universal
	@rm -rf $(APP_DIR)
	@mkdir -p $(APP_CONTENTS)/MacOS $(APP_RUNTIME)
	@cp $(MENUBAR_UNIVERSAL) $(APP_BIN)
	@chmod +x $(APP_BIN)
	@cp $(APP_INFO) $(APP_PLIST)
	@cp $(BIN_MAC_UNIVERSAL) $(APP_RUNTIME)/my-pi
	@cp dist/package.json $(APP_RUNTIME)/package.json
	@cp .env.example $(APP_ENV_EXAMPLE)
	@rm -rf $(APP_RUNTIME)/theme $(APP_RUNTIME)/export-html
	@cp -r dist/theme $(APP_RUNTIME)/theme
	@cp -r dist/export-html $(APP_RUNTIME)/export-html
	@printf "%s\n" "$(CURDIR)" > $(APP_PROJECT)
	@echo "✅  Universal macOS app bundle: $(APP_DIR)"

## Launch the packaged macOS app
run-app: app
	open $(APP_DIR)
	@echo "✅  MyPi.app launched."

## ── Default: minified release build for the current machine ────────────────
build: dist copy-assets
	$(BUILD) --outfile $(BIN)
	@echo "✅  Release binary: $(BIN)  ($$(du -sh $(BIN) | cut -f1))"

build-mac-arm: dist copy-assets
	$(BUILD) --target=bun-darwin-arm64 --outfile $(BIN_MAC_ARM)
	@echo "✅  macOS arm64 binary: $(BIN_MAC_ARM)  ($$(du -sh $(BIN_MAC_ARM) | cut -f1))"

build-mac-x64: dist copy-assets
	$(BUILD) --target=bun-darwin-x64 --outfile $(BIN_MAC_X64)
	@echo "✅  macOS x64 binary: $(BIN_MAC_X64)  ($$(du -sh $(BIN_MAC_X64) | cut -f1))"

build-mac-universal: build-mac-arm build-mac-x64
	$(LIPO) -create -output $(BIN_MAC_UNIVERSAL) $(BIN_MAC_ARM) $(BIN_MAC_X64)
	@echo "✅  Universal macOS binary: $(BIN_MAC_UNIVERSAL)  ($$(du -sh $(BIN_MAC_UNIVERSAL) | cut -f1))"

## ── Debug build: no minification + inline source maps ──────────────────────
build-debug: dist copy-assets
	$(BUILD_DBG) --outfile dist/my-pi-debug
	@echo "✅  Debug binary:   dist/my-pi-debug  ($$(du -sh dist/my-pi-debug | cut -f1))"

## ── Cross-platform release builds ──────────────────────────────────────────
build-all: build-mac-arm build-mac-x64 build-mac-universal dist copy-assets
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
