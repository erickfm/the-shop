# the shop

A desktop app that manages custom skins for Super Smash Bros. Melee on Slippi.

> **v0.1** — Linux-first, ISO-mode (HAL `.dat` file swaps). Texture mode and cross-platform polish come in v0.2+. See `CLAUDE.md` for the full vision.

## What v0.1 does

- Imports HAL `.dat` skin files (`Pl{Char}{Slot}-{Name}.dat`) and groups them into "skin packs"
- Patches a copy of your vanilla Melee ISO with the chosen skin's `.dat` files
- Points Slippi Launcher at the patched ISO (and remembers the original to revert)
- Launches Slippi when you click ▶ Launch
- "Reset to vanilla" deletes the patched ISO and reverts Slippi's config in one click

## Run it (dev)

```sh
# Toolchain (one-time):
. ~/.cargo/env                          # Rust
. ~/.nvm/nvm.sh && nvm use --lts        # Node + pnpm
pnpm install

pnpm tauri dev
```

The first launch shows a setup modal — point it at your vanilla Melee ISO and confirm the auto-detected Slippi Launcher path.

## Layout

```
src/                  React + Vite frontend
src-tauri/            Rust backend
  src/
    paths.rs          per-OS path resolution
    slot_codes.rs     character + costume slot tables
    manifest.rs       parse Pl{Char}{Slot}[-{Name}].dat
    library.rs        scan + DB sync
    iso.rs            gc_fst wrappers
    slippi_config.rs  read/write Slippi Launcher's settings JSON
    install.rs        install/uninstall transactions
    reset.rs          reset-to-vanilla
    launch.rs         spawn Slippi Launcher
```

App data (DB, patched ISO, imported skins) lives at `~/.local/share/the-shop/`.

## Tests

```sh
cd src-tauri && cargo test
```

Unit tests currently cover the filename parser. The end-to-end install round-trip is a manual checklist (see `/home/erick/.claude/plans/yep-go-ahead-and-adaptive-valiant.md`).
