# the shop

A cross-platform desktop app that browses Super Smash Bros. Melee skins distributed by creators on Patreon, and installs them into your Slippi setup with one click.

## What it does

- **Connects to your Patreon** — reads the `session_id` cookie from your normal browser (Firefox / Chrome / Brave / Edge / Safari) so any login method works, including Google.
- **Browses a community texture index** ([`texture-index/index.json`](texture-index/index.json)) — character skins, stages, effects, and (when creators publish them) animations / UI / texture packs. ~380 entries from 10 indexed creators today.
- **Routes installs by kind** — character skins go through the ISO patcher; stages/effects/UI inject at their HAL filename; texture packs copy into Slippi's `Load/Textures/GALE01/`. Zip-bundled entries unpack the named inner file at install time.
- **Uses your Patreon entitlements** — free posts install for anyone connected; paid-tier entries surface a "Subscribe" button that opens the creator's Patreon page in your default browser.
- **Reset to vanilla** — single click removes every install (ISO patches and texture-pack folders), reverts Slippi's `isoPath`, and clears all install records.

Nothing flows through any server we run. Patron's session, patron's machine, patron's file. We're a client.

## Quick start (dev)

```sh
# Toolchain (one-time):
. ~/.cargo/env                          # Rust
. ~/.nvm/nvm.sh && nvm use --lts        # Node + pnpm
pnpm install

pnpm tauri dev
```

First launch shows a setup modal — point it at your vanilla Melee ISO and confirm the auto-detected Slippi Launcher path. Then click **Connect Patreon** (it'll detect your existing browser session) and start browsing.

## Connection options (in order of UX quality)

1. **Auto-read from system browser** *(default)* — log into patreon.com normally in your usual browser, click Connect; we read the `session_id` cookie via [rookie](https://github.com/thewh1teagle/rookie). Works for any login method including Google.
2. **In-app webview login** *(advanced fallback)* — opens a Patreon login window inside the app. Works for email and Apple sign-in; **fails for Google** because Google blocks embedded webviews by policy.

## Texture index

The catalog of installable mods lives in [`texture-index/index.json`](texture-index/index.json). The app fetches it from this repo's `main` branch at runtime, with a 5-minute TTL and a compile-time bundled fallback if the network is down.

- See [`docs/texture-index.md`](docs/texture-index.md) for the schema reference and how to contribute entries.
- All install state is keyed by the entry's `id`; if you change an entry's id you'll orphan installed copies.
- Preview images are scraped from Patreon's CDN (signed URLs); they may eventually 404 — the app falls back to a per-character badge.

## Repo layout

```
src/                          React + Vite frontend
  routes/
    Connect.tsx               Patreon connect screen (browser-cookie + webview)
    Browse.tsx                creator rail + indexed-skins grid
    Library.tsx               local-import skin library
    Settings.tsx              ISO + Slippi paths
  lib/
    ipc.ts, types.ts          Tauri command bindings
    melee.ts                  HAL char/slot/stage code -> display name
src-tauri/                    Rust backend
  src/
    patreon.rs                login window, browser cookie reader, memberships
    skin_index.rs             GitHub fetch + cache + entitlement annotation
    patreon_download.rs       post fetch -> CDN download -> install dispatcher
    install.rs                install_pack (skins) + install_iso_asset (others)
    texture_pack.rs           folder-copy install for Dolphin texture packs
    zip_helper.rs             zip extract (named file + whole archive)
    paths.rs                  per-OS path resolution
    slippi_config.rs          read/write Slippi Launcher's settings JSON
    reset.rs                  reset-to-vanilla across all three install tables
    launch.rs                 spawn Slippi Launcher
  resources/
    hsd-tool/                 vendored HSDLib CLI (used by the local-import path)
texture-index/
  index.json                  the canonical texture catalog
docs/
  texture-index.md            schema reference + contribution flow
  dolphin-preview.md          (future) Dolphin headless preview pipeline notes
```

## Local data

App data (SQLite DB, patched ISO, imported skins, extracted zips) lives at `~/.local/share/the-shop/` on Linux, `~/Library/Application Support/the-shop/` on macOS, `%APPDATA%\the-shop\` on Windows.

## Status

- **v0.4 (current)** — Patreon-aggregator core: cookie-auth flow, browse-by-creator, install dispatch, ISO + texture-pack install paths, reset, ~380 indexed entries.
- **Known caveats** —
  - 51 character_skin entries (Marth, Roy, Mewtwo, Dr. Mario) install correctly via the Patreon path but break the local-import path because `slot_codes.rs` has internal codes that disagree with HAL's filesystem codes. Slot-codes audit pending.
  - 56 zip-bundled entries have *guessed* `inner_filename` — install will throw a clear "not found inside archive" error if the guess is wrong. PR a correction when that happens.
  - Per-skin preview images are post-level (one image per Patreon post, shared across all skins from that post).

## Tests

```sh
cd src-tauri && cargo test
```

Unit tests cover the filename parser. End-to-end install / uninstall / reset is a manual flow.
