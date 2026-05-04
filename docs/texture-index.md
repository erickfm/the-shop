# Texture index

Schema reference and contribution flow for [`texture-index/index.json`](../texture-index/index.json) — the catalog of installable mods that the-shop browses.

## Where it lives

The canonical file is committed to this repo at `texture-index/index.json` on `main`. The app fetches the same file from `https://raw.githubusercontent.com/erickfm/the-shop/main/texture-index/index.json` at runtime (configurable per-install via the `skin_index_url` setting), with a 5-minute TTL and a compile-time bundled fallback (`include_str!`) if the network is unreachable.

Both copies stay in sync because the build script bundles whatever's on disk at `texture-index/index.json` at compile time.

## Top-level shape

```jsonc
{
  "schema_version": 1,
  "creators": [ ...IndexedCreator... ],
  "skins": [ ...IndexedSkinEntry... ]
}
```

The schema version is currently `1`. Bump only when introducing a breaking change; new optional fields can be added under v1 with `serde(default)`.

## IndexedCreator

```jsonc
{
  "id": "vancity_primal",                          // stable slug, joins to skin.creator_id
  "display_name": "Primal",                         // shown in Browse
  "patreon_campaign_id": "7051449",                 // numeric; from Patreon's API. Empty string when unknown.
  "patreon_url": "https://www.patreon.com/vancity_primal",
  "tagline": "Animelee project lead — cell-shaded character mods",  // optional one-liner
  "avatar_url": null                                // optional
}
```

`patreon_campaign_id` is what enables the "you back this creator at $X" join against the user's live Patreon memberships. Without it, every entry from that creator displays as "not subscribed" regardless of the user's actual subs. **Filling these in is the highest-value contribution after adding new skin entries.**

## IndexedSkinEntry

```jsonc
{
  "id": "gonko-b0xx-spacies-bu",                    // unique across the whole index. Used as install PK.
  "creator_id": "gonko",                            // must match a creators[].id
  "display_name": "B0XX Spacies (Bu)",              // shown in Browse cards
  "kind": "character_skin",                         // see kinds below
  "iso_target_filename": null,                      // see "ISO target" below
  "inner_filename": null,                           // see "Zip bundles" below
  "character_code": "Fc",                           // HAL 2-char (only meaningful for character_skin / effect / animation)
  "slot_code": "Bu",                                // HAL 2-char (only meaningful for character_skin)
  "patreon_post_id": "46624557",                    // numeric, end of the post URL
  "filename_in_post": "PlFcBu (B0XX).dat",          // EXACT attachment filename on Patreon
  "tier_required_cents": 0,                         // 0 = free; 500 = $5 tier; etc.
  "sha256": null,                                   // optional integrity check (currently unused)
  "preview_url": "https://c10.patreonusercontent.com/.../image.png",
  "notes": null                                     // optional human note
}
```

### Kinds

| Kind | Install path | Required fields beyond the basics |
|---|---|---|
| `character_skin` | `install::install_pack` (with slot routing via `find_target_slot`) | `character_code`, `slot_code` |
| `stage` | `install::install_iso_asset` (direct ISO inject at `iso_target_filename`) | `iso_target_filename` (e.g. `GrFd.usd`) |
| `effect` | `install::install_iso_asset` | `iso_target_filename` (e.g. `EfFxData.dat`); `character_code` optional for browse filtering |
| `animation` | `install::install_iso_asset` | `iso_target_filename` (e.g. `PlFxAJ.dat`); `character_code` optional |
| `ui` | `install::install_iso_asset` | `iso_target_filename` (e.g. `MnSlChr.usd`, `IfAll.usd`) |
| `item` | `install::install_iso_asset` | `iso_target_filename` (e.g. `It....dat`) |
| `texture_pack` | `texture_pack::install_pack_from_dir` (folder copy to Slippi's `Load/Textures/GALE01/`) | none beyond the basics — entire archive is extracted |

`kind` defaults to `"character_skin"` for backwards compatibility — entries without a `kind` field are treated as character skins.

### ISO target

For character skins, `iso_target_filename` can be omitted; the install path computes `Pl{character_code}{slot_code}.dat` automatically.

For everything else (`stage`, `effect`, `animation`, `ui`, `item`), this is **required** — it's the exact HAL filesystem name we replace inside the ISO. Naming follows HAL conventions:

- `Pl<Char><Slot>.dat` — character costume (only used as a fallback for character_skin)
- `Pl<Char>AJ.dat` — character animation bank
- `Ef<Char>Data.dat` — character effect bank (lasers, fire, shines, etc.)
- `Gr<Stage>.dat` / `.usd` — stage geometry/textures
- `MnSl<Screen>.usd` — menu / character-select / stage-select screens
- `IfAll.usd`, `MnExtAll.usd` — global UI assets
- `It<Item>.dat`, `Pk<Pokemon>.dat` — items, Pokemon

For texture packs, `iso_target_filename` is ignored.

### Zip bundles

When `filename_in_post` ends in `.zip` / `.rar` / `.7z`, the app downloads the archive, extracts a single named file (for ISO inject kinds) or the whole tree (for texture packs).

For ISO-inject kinds, set `inner_filename` to the file inside the archive to extract. Match is case-insensitive on the basename — the archive can have nested folders. If `inner_filename` is missing, the app falls back to whatever `iso_target_filename` resolves to.

A multi-skin pack (e.g. one zip with `PlCaNr.dat` + `PlCaRe.dat` + ... ) should land in the index as **one entry per inner file**, all sharing the same `patreon_post_id` and `filename_in_post` (the zip name) but with different `id`/`character_code`/`slot_code`/`inner_filename`. Each install pulls its specific file out of the (re-downloaded) zip; downloads aren't dedupe'd yet.

### Tier gating

`tier_required_cents` is what the user's `currently_entitled_amount_cents` from the Patreon memberships API has to be ≥ for the entry to install. Free posts use `0`. Paid-tier entries display a "Subscribe on Patreon" button instead of "Install" until the tier is met. The check is informational only — Patreon's own backend is the actual gate (it returns 401/403 on the post fetch if you're not entitled), and we surface that error if the index is wrong.

## Contributing

Open a PR against `texture-index/index.json`. CI doesn't validate yet (TODO), so check locally:

```sh
jq '.schema_version, (.creators | length), (.skins | length)' texture-index/index.json
# expect: 1, N (creators), M (skins)

# Spot-check no duplicate IDs:
jq '[.skins[].id] | group_by(.) | map(select(length > 1))' texture-index/index.json
# expect: []

# Spot-check no orphan creator_ids:
jq '
  ([.skins[].creator_id] | unique) -
  ([.creators[].id])
' texture-index/index.json
# expect: []
```

When adding a new creator, fill in `patreon_campaign_id` if you can (look it up in the page HTML or Patreon's API; the URL pattern `/api/campaigns?filter[vanity]=<vanity>` works for public campaigns). Without the numeric campaign ID, entitlement matching fails for that creator's entries.

When adding a new skin entry, the most error-prone fields are:
- `character_code` and `slot_code` — must match HAL's filesystem codes (Marth = `Ms`, Roy = `Fe`, Mewtwo = `Mt`, Dr. Mario = `Dr`; everything else is the obvious 2-letter code).
- `inner_filename` for zip bundles — best-effort guesses are OK as long as a `notes` field flags it.
- `tier_required_cents` — Patreon's API exposes `min_cents_pledged_to_view` on locked posts; for free posts use `0`.

## Caveats

- **Signed CDN URLs expire.** `preview_url` values from `c10.patreonusercontent.com` carry a `?token-time=` query param. Some have far-future expiries, some don't. When they 404, the app silently falls back to a character badge. A periodic re-scrape refreshes them.
- **Per-post preview images, not per-skin.** A 5-slot pack zip results in 5 entries that all share the post's hero image. Per-attachment images would need a different scrape pass.
- **`slot_codes.rs` mismatch (Marth/Roy/Mewtwo/Dr. Mario).** The Rust backend's local-import filename parser uses HSDLib-style internal codes (Mt/Cl/Pp/Mh) that don't match HAL's filesystem codes (Ms/Fe/Mt/Dr) the index uses. Patreon-side installs work correctly because the index codes match real ISO file names; local imports of those characters' files will fail until `slot_codes.rs` is corrected. Roughly 51 entries are affected.
