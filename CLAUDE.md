# Slippi Skin Manager — Project Handoff

## Background

Custom skins for Super Smash Bros. Melee on Slippi work, but installing them is a nightmare. The current process requires learning a half-dozen separate tools (DAT Texture Wizard, m-ex Tool, Costume Validator, Melee Code Manager, Melee Quick Mod), understanding HAL Laboratory's .dat file naming conventions, manually managing files, rebuilding ISOs, and accepting real risk of desyncs or corrupted discs. The mental model the user wants — "browse skins, click install, hit play" — does not exist in the ecosystem today.

Several pieces exist that could plausibly be composed into a solution: DAT Texture Wizard handles the .dat patching, Costume Validator catches skeleton mismatches that cause desyncs, the m-ex Slippi Template provides a workflow for adding costume slots without overwriting vanilla data, and Slippi Launcher itself is open source. But no one has put a player-facing GUI on top of all of it.

## The Product

A desktop application that manages Melee skins for Slippi players. The user browses installed skins in a library, assigns them to character/color slots, and hits "Launch." The app handles every detail of the underlying modding workflow invisibly — file naming, ISO patching or texture pack management, skeleton validation, character select portrait generation, Slippi launcher coordination.

Users should feel like they're using a normal piece of software, not modding a 25-year-old GameCube game.

## Target User

A Slippi player. Plays ranked, unranked, or direct-connect with friends. Has installed Slippi Launcher and pointed it at their ISO. Is not a modder and has no interest in becoming one. Wants their character to look cool.

## Core Requirements

**Cross-platform.** Windows, macOS, and Linux, at feature parity, from v1. This is not negotiable. A meaningful share of Slippi's player base is on Mac and Linux, and shipping Windows-only would cut off the audience most likely to want this tool. Cross-platform also forces architectural decisions early (toward Tauri/Rust over Electron, away from Wine-bundling shortcuts) that will be much more painful to retrofit.

**Two install modes.** The user picks one in settings:

- *Texture mode* writes Dolphin-format texture overrides to Slippi's `Load/Textures/GALE01/` folder. Safe for ranked play, cosmetic-only, no ISO modification. This is the safer default and the right answer for most users.
- *ISO mode* rebuilds the user's ISO with .dat replacements. Required for adding new costume slots and for direct-connect play with friends running matching ISOs. Higher capability, higher risk.

**Skin library.** A local view of installed skins organized by character, with thumbnail previews and per-skin metadata: which color slot it occupies, where it came from, and whether it's been validated as online-safe (skeleton-compatible).

**Per-character slot assignment.** For each character, the user can pick which skin occupies the default, red, blue, green, etc. slots.

**Drag-and-drop import.** The user drags a .dat file or texture pack folder onto the app and it figures out which character and slot the skin belongs to from the filename and contents.

**Launch button.** Applies the user's current skin configuration and opens Slippi Launcher.

**Enable / disable.** Any installed skin can be toggled without uninstalling, so users can experiment without losing their library.

**Reset to vanilla.** A single, reliable button that returns the user to a clean Slippi setup with no orphan files, no broken ISOs, no leftover state. This is a critical safety valve — without it, every other feature is scarier than it needs to be.

## Out of Scope for v1

These are deliberate non-goals, not deferred ambitions:

- Creating skins from scratch (DAT Texture Wizard and HSDraw already do this; we are not replacing them, we are managing their output)
- Stage textures, custom music, gameplay code mods
- Sharing loadouts between users
- Built-in marketplace or storefront browsing — users bring their own skin files
- Mobile or web versions
- Anything that touches the Slippi matchmaking servers
- Auto-pulling skins from a remote source

Anything in this list is a v2 conversation.

## Hard Problems and Open Questions

These are the decisions where an implementation will succeed or fail. They need explicit answers before serious development starts.

**ISO patching.** The .dat file format is HAL's proprietary binary structure, and getting it wrong corrupts the ISO. Three options: shell out to DAT Texture Wizard as a subprocess, port DTW's logic into the app, or write our own from scratch. Cross-platform requirements complicate this — DTW is Windows-first and shelling out cleanly to it on Mac/Linux is rough. HSDLib (.NET, cross-platform) may be a better integration target than DTW. The recommendation in this scope: lean as hard as possible on existing battle-tested tools (HSDLib, GameCube disc parsing crates) rather than reimplementing the binary format. Identifying the right integration target is the most important early decision in the project.

**Skin format heterogeneity.** Multiple formats exist in the wild: raw .dat files, m-ex packages, Dolphin-format texture pack folders, DTW import bundles. v1 should pick the smallest set that covers the common case — probably .dat files for ISO mode and Dolphin texture pack folders for texture mode — and clearly communicate what's supported.

**Skeleton validation.** Skins built on a different skeleton than vanilla will desync online. Costume Validator (by Ploaj) handles this. The app must integrate equivalent validation, because a desync mid-match is the worst possible UX failure for this product. Trusting the user to validate manually is not acceptable.

**Character select portrait generation.** When a skin is installed in ISO mode, the CSP needs to update or menus look broken. Auto-generating CSPs from the model is doable but technically involved. Requiring the user to provide one is simpler but worse UX. Decision needed: which?

**Slippi launcher coordination.** Spawning the launcher process is straightforward on all three platforms, but Slippi auto-updates and can change its expectations. The app needs to fail gracefully when the launcher updates and breaks our assumptions, and ideally detect this proactively rather than crashing.

**Where do skins come from?** ssbmtextures.com is closing September 2026. v1 is "users bring their own files," but the longer-term answer to where skins come from will affect product strategy.

**Code signing and notarization.** macOS is hostile to unsigned apps. Without an Apple developer certificate ($99/year) users have to right-click → Open every time. Windows shows SmartScreen warnings but apps still run. Linux is easy. Decision needed: do we sign at v1 or accept the worse Mac experience initially?

**Path resolution.** Slippi Launcher's data directory is at a different location on each OS, as is the Dolphin Load/Textures folder. First-run setup needs to auto-detect on all three platforms with sensible defaults and a graceful fallback when detection fails.

## Success Criteria

The app is v1-complete when:

- A user who has never modded Melee can go from zero to "custom skin in their next Slippi game" in under five minutes
- Switching between skins in texture mode takes seconds, not minutes
- "Reset to vanilla" reliably returns the user to a clean state with no orphan files
- The app survives a Slippi Launcher update without breaking
- Zero desyncs are caused by the app's defaults — meaning we either validate skeletons or only enable skeleton-safe skins by default
- Identical core feature set on Windows, macOS, and Linux
- A user installing on a fresh Mac completes the zero-to-custom-skin flow in the same time as a Windows user

## Architectural Direction (Recommendation, Not Prescription)

Two paths are reasonable: a standalone app, or a fork/PR into Slippi Launcher itself. The recommendation here is **standalone**, for three reasons. First, getting a feature like this merged upstream is a long road, and the Slippi team has historically been cautious about anything that could be perceived as affecting competitive integrity. Second, a standalone app can iterate on its own schedule without coordinating releases. Third, if it turns out well, it can always be proposed for upstream integration later — the reverse is much harder.

For tech stack: **Tauri with a Rust backend and a web frontend** is the recommended starting point over Electron. Smaller binaries, faster startup, and — most importantly — Rust gives us native cross-platform compilation for the file-format work that has to happen in the backend. The Rust ecosystem also has emerging Melee tooling (slippi-rust-extensions, GameCube disc parsing crates) that can be leaned on. Electron is a viable fallback if Tauri turns out to be friction.

This is a recommendation, not a mandate. If the implementer has strong reasons to go a different direction, those reasons should be heard.

## Notes for Agentic Implementation

The UI scaffolding (Tauri or Electron app, library view, settings, drag-and-drop, file management, launching subprocesses) is well within current agent capability. These are well-trodden patterns with abundant reference implementations.

The risky part is the ISO patching layer. An agent producing code that *looks* correct but silently corrupts ISOs is the failure mode to prevent — that's the kind of bug that doesn't surface until a user's Slippi crashes mid-tournament. The mitigation is to push the agent hard toward "wrap existing battle-tested tools as black boxes" rather than "reimplement HAL's binary format from training data." Cross-platform requirements complicate that escape hatch (DTW being Windows-first), so identifying the right cross-platform integration target — likely HSDLib or a similar .NET-based tool — should be one of the first concrete tasks before any UI work begins.

Skeleton validation should similarly wrap Costume Validator's logic rather than reimplementing it.

A reasonable v0.1 milestone — proving the core thesis is viable before investing in polish — would be: texture mode only, Windows only, single character, hardcoded skin library, manual file paths. If that round-trips successfully (skin installed, Slippi launches, skin appears in-game, reset returns to vanilla), the rest of the project is scaling and polish on a known-good foundation. If it doesn't, the assumptions in this document need revisiting before going further.


