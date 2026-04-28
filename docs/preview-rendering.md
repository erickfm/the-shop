# 3D Preview Rendering

How `the-shop` renders Melee skin `.dat` files in the Library cards, and the
specific GX/MOBJ/TOBJ semantics that drive each design decision. Read this
before changing the texture/material pipeline — the obvious-looking changes
have non-obvious failure modes.

## Pipeline overview

```
.dat file
  └─→ tools/hsd-tool/the-shop-hsd  (C# / .NET 8 / HSDLib)
        ├─ identify <file>     →  JSON (kind, character, root names)
        ├─ inspect <file>      →  human-readable structure
        ├─ dump-materials      →  per-MOBJ TOBJ flags + render flags + alpha
        ├─ dump-textures       →  decoded PNGs of every TOBJ
        └─ to-gltf <in> <out>  →  embedded-binary GLB
              [--pose <PlXXAJ.dat>]      Wait1 keyframe applied as static pose
              [--fighter <PlXX.dat>]     LowPoly DObj filter
              [--no-textures]            Skip image emission, render flat
  └─→ src-tauri/src/preview.rs      (Rust, caches GLB by content hash)
        └─ ensure_preview() shells out, base64-encodes the GLB, returns to UI
  └─→ src/components/SkinPreview3D.tsx  (React + three.js)
        └─ GLTFLoader.parse → MeshStandardMaterial → Canvas
```

## What the C# tool emits in the GLB

Per-vertex attributes:
- `POSITION` — bone-skinned position (multi-bone weighted envelope blend)
- `NORMAL` — corresponding normal
- `TEXCOORD_0` — UV passed through `TransformUV` (TOBJ scale/rotate/translate)
- `COLOR_0` — see vertex-color rules below

Per-material:
- `baseColorTexture` — first TOBJ with `LIGHTMAP_DIFFUSE` flag set
- `baseColorFactor` — see diffuse-factor rules below
- `emissive` — MOBJ ambient (untextured materials only, scaled 0.5)

## The two semantic gates that matter most

### Gate 1: Vertex color emission (`COLOR_0`)

Per-vertex GX_VA_CLR0 is part of GX's TEV combine. Emitting it naïvely tints
or darkens textures because we lack the corresponding TEV stage program.

| Material has texture | POBJ has CLR0 attribute | What we emit per vertex |
|---|---|---|
| Yes | Yes | **`(1,1,1)` white** (no-op multiplier; CLR0 is for TEV) |
| Yes | No | `(1,1,1)` white |
| No | Yes | **Real `gv.CLR0`** (it IS the surface color when no texture) |
| No | No | `(1,1,1)` white (falls back to MOBJ.diffuse base color) |

### Gate 2: Diffuse-factor multiply (`baseColorFactor`)

GX combines the texture sample with previous TEV stage output via the TOBJ's
`COLORMAP` (ColorOperation). The right glTF analog depends on which mode:

| TOBJ ColorOperation | What GX does | What we emit |
|---|---|---|
| `MODULATE` | `result = texture × previous` | `WithBaseColor(img, MOBJ.diffuse)` |
| `REPLACE` | `result = texture` | `WithBaseColor(img)` (no factor) |
| `BLEND`/`ADD`/`SUB`/etc. | various TEV combines | Approximated as `WithBaseColor(img)` |

**Edge case:** when the diffuse is `(255,255,255,1.0)` we use `WithBaseColor(img)`
even for `MODULATE` — emitting an explicit `baseColorFactor` of `(1,1,1,1)` can
flip three.js's alpha-mode autodetection in ways that darken the rendering.

## The TEV emulation gap (this is why CONSTANT-mode skins look different)

`MOBJ.RenderFlags` has bits like `DIFFUSE`, `CONSTANT`, `VERTEX`, `SPECULAR`,
`TOON` that tell GX which color sources to feed into the TEV stage program.
**The TEV stage program itself is a separate binary blob** that wires those
sources into the final pixel color via specific arithmetic combines (multiply,
add, subtract, lerp, conditional, etc.). HSDLib parses the TOBJ structure
fields but does **not** parse or execute the TEV program.

Practical consequences:

- **DIFFUSE-mode skins** (TAILS, EVA-UNIT, all vanilla-style retextures):
  TEV uses MOBJ.diffuse as a per-pixel modulator. `WithBaseColor(img, factor)`
  with `factor = MOBJ.diffuse` reproduces this faithfully.
- **CONSTANT-mode skins** (SPOOKY-FALCO, A.CE-LINK/LUIGI, PAPER-MARIO G&W,
  TAILS-ANIMELEE): TEV uses a constant register that HAL wires from a source
  we can't read without parsing the TEV blob. The texture itself is often a
  small toon-shading swatch (mostly white or mostly black with a thin color
  strip in one corner) intended to be sampled in a non-trivial way — so our
  preview shows mostly the swatch's background color.

Without TEV emulation, CONSTANT-mode previews will not match in-game. The
toggle below is the escape hatch.

## The per-card texture toggle

Each Library card has a `tex: on` / `tex: off` button (top-right of the
preview). When off, `to-gltf --no-textures` is invoked: image emission is
skipped, every material renders as flat MOBJ.diffuse with ambient as emissive.
Use this for CONSTANT-mode skins where the "with textures" rendering shows the
TOON swatch instead of the actual surface — flat material colors reveal the
authored per-material color decisions (white body + black accents for SPOOKY,
etc.) without the TEV gap mucking things up.

The toggle state is per-card and session-only. Cache key includes the toggle
state, so flipping doesn't return the stale GLB.

## Subprocess identification (`identify` subcommand)

The C# tool also exposes `identify <file>` which emits one-line JSON:

```json
{"kind":"costume","character_internal":"Falco","root_names":["PlyFalco5K_Share_joint",...]}
```

Used by the Rust importer (`src-tauri/src/manifest.rs::identify`) to determine
the **character + file kind** authoritatively from the file rather than the
filename. Slot still comes from the filename because HAL doesn't store it
inside the file. Recognized kinds: `costume`, `fighter_data`, `common_data`,
`effect`, `stage`, `unknown`. Non-`costume` files are rejected at import with
`UnsupportedFileKind { kind }` instead of the old "could not parse filename"
error.

## LowPoly filter (`--fighter` option)

Each costume `.dat` ships both high-poly and low-poly variants of certain
meshes (head, hands, feet). In-game, the engine hides the low-poly version at
close range. Without filtering, both versions render overlapped (e.g. TAILS
shows 6 hair tufts instead of 3). The fighter data file (`PlXX.dat`,
extracted from the vanilla ISO once and cached in
`~/.local/share/the-shop/fighters/`) contains
`SBM_FighterData.ModelLookupTables.CostumeVisibilityLookups[i].LowPoly` — a
per-JOBJ list of DObj indices to hide. We always apply the filter
unconditionally; heavily-modded skins like TAILS-ANIMELEE that repurpose
LowPoly slots for unique geometry will show that geometry as missing
(documented tradeoff). `THE_SHOP_HSD_DISABLE_LOD=1` opts out for diagnostic
purposes.

## Wait-pose animation (`--pose` option)

Costume `.dat` files have JOBJ skeletons but no animation. Animations live in
`PlXXAJ.dat` (extracted once, cached in `~/.local/share/the-shop/anims/`).
For preview, we apply frame 0 of the FigaTree at index 0 (typically Wait1) as
a static pose by replacing each JOBJ's TX/RX/SX with values from
`FOBJ_Player.GetValue(0)`. Bones then hold their wait positions at render
time. Real keyframe-driven animation would require emitting the file as a
skinned mesh + glTF animation channels — see "open work" below.

## Cache layout

```
~/.local/share/the-shop/
  ├─ skins/        Imported .dat files (canonical filenames)
  ├─ anims/        PlXXAJ.dat extracted from vanilla ISO
  ├─ fighters/     PlXX.dat extracted from vanilla ISO
  └─ previews/
       └─ <sha256>/model.glb     (sha key includes skin mtime+size, anim+fighter
                                  metadata, and the with_textures flag)
```

`cache_key_for` in `preview.rs` builds the key. Any new flag that affects GLB
output must contribute to the hash, or stale renders leak through.

## Diagnostic environment variables

Set on the `the-shop-hsd` process (e.g. `pnpm tauri dev` will inherit them).

- `THE_SHOP_HSD_LOG_LOWPOLY=1` — print the LowPoly DObj filter stats
- `THE_SHOP_HSD_LOG_SPIKES=1` — print envelope-skinning fallback counters
- `THE_SHOP_HSD_DISABLE_LOD=1` — skip LowPoly filter entirely
- `THE_SHOP_HSD_SKIP_ENVELOPE=1` — skip envelope-skinned POBJs (geometry test)
- `THE_SHOP_HSD_SKIP_UVXFORM=1` — skip per-TOBJ UV transform
- `THE_SHOP_HSD_TRANSFORM_NORMALS=1` — apply per-bone normal matrix in skinning

## Open work (preview-related)

1. **Real keyframe animation playback.** The Wait1 keyframes are already
   parsed; the missing piece is emitting JOBJs as glTF Nodes + a Skin + per-
   track AnimationChannels. ~1 focused session. Big payoff: pick from the
   character's full anim set (Wait/Walk/Run/attacks).
2. **TEV stage program parsing.** Would unlock proper preview parity for
   CONSTANT-mode skins. Big lift — needs reading HSDRawViewer's GX shader
   reference and writing a CPU-side TEV combiner. Probably not v0.x scope.
3. **Per-skin "render mode" memory.** Today the texture toggle is per-card
   session-only. Could persist to DB so users only have to flip CONSTANT-mode
   skins once.
