# Handoff for the next agent

Read `CLAUDE.md` first for the product vision. This file is a snapshot of
where the code stands and where the genuine uncertainty lives. Companion docs
in `docs/`:

- `docs/preview-rendering.md` — full spec of the GLB preview pipeline (GX
  semantics, MOBJ/TOBJ gating rules, the toggle, the TEV emulation gap).
- `docs/slippi-compatibility.md` — research-grade reference on which mod
  categories are ranked-safe / desync-prone / ban-risk on Slippi.

## Where things are right now

### v0.1 (working, shipped)
- Vanilla Melee ISO + `gc_fst::operate_on_iso` batched single-call install.
  Round-trips end-to-end: install skin, launch Slippi, slots show in-game,
  no freezes.
- Slippi Launcher's `Dolphin.ini` `isoPath` swap with remembered "original"
  for clean reset.
- DB at `~/.local/share/the-shop/the-shop.sqlite3` tracks `skin_files` and
  `installed_pack`. Startup reconciliation clears stale rows.
- Linux-first; `paths.rs` has stubbed Windows/macOS branches.

### v0.2 (shipped this and prior sessions)
- **3D preview viewer in Library cards.** GLB pipeline (was OBJ, pivoted
  mid-development). `tools/hsd-tool/the-shop-hsd` (C# / .NET 8 / HSDLib MIT)
  emits self-contained GLBs via SharpGLTF; `src-tauri/src/preview.rs` shells
  out and caches; `src/components/SkinPreview3D.tsx` renders via three.js
  GLTFLoader with auto-rotate + explicit camera target.
- **Embedded textures + UV transforms** with content-hashed dedupe.
- **Wait1 static pose** extracted from `PlXXAJ.dat` (auto-fetched from the
  vanilla ISO once, cached). Multi-bone weighted envelope blend skinning.
- **LowPoly filter** via `PlXX.dat` (fighter data file). Without this, models
  render with both LOD versions overlapped (TAILS would show 6 hair tufts
  instead of 3). Heavily-modded skins that repurpose LowPoly slots for unique
  content — TAILS-ANIMELEE eyes — show that content as missing. Documented
  tradeoff; `THE_SHOP_HSD_DISABLE_LOD=1` opts out.
- **GX-aware material gating.** TOBJ.ColorOperation drives whether MOBJ
  diffuse is multiplied with the texture (MODULATE → multiply; REPLACE →
  texture-only). MOBJ.RenderFlags drives whether ambient is emitted as
  emissive. See `docs/preview-rendering.md` for the full table.
- **Per-card "tex: on / off" toggle** in the Library. Off side runs
  `to-gltf --no-textures` and renders flat MOBJ-diffuse + ambient. Useful
  escape hatch for skins where TEV-stage rendering matters and we can't
  reproduce it (CONSTANT-mode skins like SPOOKY-FALCO, A.CE-LINK).

### v0.2 file-authoritative import (shipped this session)
- `the-shop-hsd identify <file>` emits JSON with `kind` (costume /
  fighter_data / common_data / effect / stage / unknown), `character_internal`
  (HAL's name like `Falco`/`Fox`/`Gamewatch`), and root names.
- `src-tauri/src/manifest.rs::identify` runs the binary, reconciles file vs
  filename: file is authoritative for character + kind; filename is the only
  source for slot. Mislabeled files get auto-corrected to canonical filenames.
- Non-costume files are rejected at import with the new
  `UnsupportedFileKind { kind }` error instead of "could not parse filename."
- `slot_codes::CharacterDef` gained an `internal_symbol` field mapping HAL's
  internal names ("Falco", "Fox", "Mars" for Marth, "Seak" for Sheik, etc.) to
  our 2-char codes. Filename fallback covers any I got wrong.

### v0.2 explicitly removed
- m-ex Slippi Template integration. Vanilla install works fine for the user's
  mods via `gc_fst::operate_on_iso`. m-ex base ISOs hit `TOCTooLarge` (their
  FST has zero slack) and the `read_iso`/`write_iso` rebuild workaround
  produced runtime "invalid read" errors. Code removed, see commit `4ec5da8`.

## Known limitations / honest about what doesn't work

1. **Animation playback is static-pose only.** We bake Wait1 frame 0 into the
   GLB. Picking other clips (Walk/Run/attacks) and playing them would require
   refactoring to emit JOBJs as glTF Nodes + a Skin + AnimationChannels.
   Roughly one focused session; data is already parsed.
2. **TEV-mode skins look different from in-game.** Mods authored with
   `MOBJ.RenderFlags = CONSTANT` (SPOOKY-FALCO, A.CE family, PAPER-MARIO G&W,
   TAILS-ANIMELEE) use a TEV stage program we don't parse. Their textures are
   often small toon-shading swatches sampled in non-trivial ways. The `tex:
   off` toggle is the workaround. Real fix would be a CPU-side TEV combiner —
   big lift.
3. **Heavy-mod skin filename categories rejected.** Stages (`Gr*`), effects
   (`Ef*`), common-pool (`PlCo*`), per-character items (`PlGw-*-ITEMS.dat`),
   and m-ex packs are correctly identified by `identify` but rejected at
   import as unsupported. Adding install-time routing for those is its own
   workstream.
4. **`internal_symbol` mappings are educated guesses for chars not seen in
   user's library.** Falco/Fox/Gamewatch confirmed from real files; the rest
   (Marth's "Mars", Sheik's "Seak", Bowser's "Koopa", etc.) follow standard
   Melee modding nomenclature but haven't been verified against actual files.
   When wrong, the importer falls back to filename parsing — no harm, just a
   missed opportunity for file-authoritative routing.

## Likely next sessions, in rough priority

### Catalog / hosted mod browser (in flight)
The user is building toward a hosted catalog on Railway + Backblaze B2 so
mods can be browsed and installed in-app, not dropped into Downloads
manually. Current state: scoping, no code yet. See chat history for the
three-question outline (personal-vs-public, B2-vs-Railway-volumes, API
shape). Next concrete step is account setup on B2/Railway, then a small Rust
catalog API that the frontend can hit.

### Real keyframe animation
~1 session, big visual payoff. See `docs/preview-rendering.md` "Open work"
for the implementation sketch.

### Cross-platform binaries
v0.1 deferred Windows/macOS. The C# tool is portable; `paths.rs` has stubs
for both. Real blocker is binary publish + Tauri bundle config.

### TEV stage program parsing
Would close the preview-parity gap on CONSTANT-mode skins. Substantial work —
read HSDRawViewer's GX shader reference, write a CPU-side combiner. Probably
v0.4+.

## Operational notes for the next agent

- **Republishing the C# binary**: `cd
  tools/hsd-tool/the-shop-hsd && dotnet publish -c Release -r linux-x64
  --self-contained -o /tmp/hsd-publish` then mv-then-cp into
  `src-tauri/resources/hsd-tool/the-shop-hsd`. The mv-then-cp dance avoids
  "text file busy" when the dev app is running. Always `md5sum` to verify
  the deploy. **Always clear the preview cache** (`rm -rf
  ~/.local/share/the-shop/previews/*/`) after rebuilding the binary;
  otherwise users see stale renders from the prior code.
- **The bundled binary is ~67MB self-contained linux-x64.** GitHub warns at
  50MB but pushes work. Consider `git lfs` if this becomes a problem.
- **Diagnostic subcommands**: `inspect`, `dump-materials`, `dump-textures`
  exist on the C# tool and are invaluable for debugging. Use them before
  guessing.
- **The user pushes back hard on visual hand-waving.** Get programmatic
  ground truth (dump-materials, hex of a PNG, RenderFlags bits) before
  changing the rendering pipeline. Several rounds of regression in this
  session came from theorizing without checking.

