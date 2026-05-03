# Dolphin headless preview pipeline

Replaces the WebGL/three.js rendering path with screenshots captured from a
real Dolphin instance. Pixel-accurate for every skin, including CONSTANT-mode
toon skins (A.CE, SPOOKY-FALCO, TAILS-ANIMELEE) the static-renderer path
can't handle. Same engine the modding community uses as their source of
truth.

## What we use, what we don't

- **Mainline `dolphin-emu-nogui`** (apt: `dolphin-emu-nogui` on Ubuntu, or
  Flatpak). Required because Slippi's bundled Dolphin is an Ishiiruka fork
  that lacks `--save_state` and `--config=` flags. Verified by running
  `Slippi_Online-x86_64.AppImage --help` against mainline source.
- **Xvfb** for an X surface so the OGL video backend has something to render
  into. Works on Wayland systems too via Xwayland (default on Ubuntu 24.04).
- **NOT the Null backend** — has no framebuffer, can't dump frames.
- **NOT the Software backend** — unmaintained, miscompiles Melee CSS.

## Capture recipe

For one skin → one PNG:

```
xvfb-run -a -s "-screen 0 640x528x24" \
  dolphin-emu-nogui \
    --user=/tmp/the-shop/dolphin_<run_id> \
    --platform=headless \
    --video_backend=OGL \
    --config=Main.Movie.DumpFrames=True \
    --config=Main.Movie.DumpFramesSilent=True \
    --batch \
    --save_state=<state_file_per_character>.sav \
    --movie=<short_advance_movie>.dtm \
    --exec=<patched_iso>
```

`--movie` runs to completion → Dolphin exits cleanly (no SIGTERM dance
needed). `Movie.DumpFrames` writes `framedump0.avi` to the user dir. Pull
one frame with `ffmpeg -i framedump0.avi -frames:v 1 thumb.png`.

Cache key: SHA1(skin .dat). First-run cost ~5-15s; cache hits 0ms.

## Per-character save states

For each playable character (26 total in vanilla Melee), once:

1. Boot vanilla ISO normally in mainline Dolphin.
2. Navigate to a fixed-camera scene where the character is centered and
   well-lit. Two viable options:
   - **CSS portrait**: cursor parked on character slot 1, no menu animation.
     Captures the rendered model at CSS lighting.
   - **Training mode neutral pose**: pick character + Battlefield, idle
     position, fixed camera. Captures the in-game lit model.
3. Save state → `csp_<character_code>.sav` (Fx, Fc, Pr, etc.).
4. Ship the .sav files inside `src-tauri/resources/dolphin-states/`.

Save states are **Dolphin-version-pinned** — break across mainline releases.
Mitigation: pin a specific Dolphin version in setup docs, OR fall back to a
boot-from-zero `.dtm` movie that navigates from the title screen (slower,
~10-15s instead of 1-2s, but version-stable).

## Slot color handling

Slot colors (Nr/Or/Re/Bu/Gr/etc.) need a CSS cursor color cycle. Two
approaches:

- One save state per (character, slot) pair: 26 × 4-6 colors = ~150 states.
  More disk, instant capture per slot.
- One save state per character + a short `.dtm` movie that presses the
  color-cycle button N times. Fewer states, slightly more capture latency.

Go with per-(character,slot) states for speed; the .sav files are tiny
(~50KB).

## Implementation phases

1. **Spike**: get one skin → one PNG end-to-end on Linux dev box.
2. **Author states**: 26 characters × CSS portrait at default slot.
3. **Slot colors**: extend states to all (char, slot) pairs.
4. **Tauri integration**: Rust `preview.rs` invokes Dolphin, caches PNG,
   serves to frontend. Replace the GLB pipeline.
5. **Hardening**: stale Xvfb cleanup, save-state-version check, error
   placeholders, install path detection.

## Open questions

- **Which Dolphin version to pin?** Latest stable (5.0-22000-something) vs.
  a specific LTS-ish revision. Need to test save-state portability.
- **Wayland-only systems**: Xvfb is X11. Verify Xwayland works on Ubuntu
  25.10 (assumed yes; should test).
- **Dolphin install path**: Tauri app needs to detect `dolphin-emu-nogui`
  in PATH or prompt user to install. UX similar to existing Slippi launcher
  detection.
- **Headless on systems without Dolphin installed at all**: error message
  + setup instructions; don't try to bundle Dolphin (way too big).

## Effort estimate

- Spike (one-skin one-PNG): ~1 day
- Per-character save states (26 chars): ~1 day, mostly mechanical
- Slot colors: ~1 day
- Tauri integration + caching: ~0.5 day
- Hardening: ~1 day

**Total: ~4-5 days** to ship.

## Sources

- Dolphin source `Source/Core/UICommon/CommandLineParse.cpp` and
  `Source/Core/DolphinNoGUI/MainNoGUI.cpp` — authoritative CLI inventory
- Dolphin source `Source/Core/VideoBackends/{Null,Software}/`,
  `Core.cpp:772-784`, `VideoCommon/FrameDumper.h` — frame-dump API
- [Mintlify Dolphin CLI config docs](https://mintlify.wiki/dolphin-emu/dolphin/cli/configuration)
- [forums.dolphin-emu.org: --save-state --exec --batch
  ](https://forums.dolphin-emu.org/Thread-command-line-for-loading-save-states-help)
- [TASVideos Dolphin video dumping
  guide](https://tasvideos.org/EncodingGuide/VideoDumping/Dolphin)
- [ArchWiki: Dolphin emulator](https://wiki.archlinux.org/title/Dolphin_emulator)
- [Batocera Dolphin wiki](https://wiki.batocera.org/emulators:dolphin)
