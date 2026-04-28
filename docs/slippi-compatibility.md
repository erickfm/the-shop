# Slippi Compatibility Reference for Melee Mods

Reference doc for "the-shop" — what we can host, what desyncs, what's risky-but-works. Audience: developers and modders. Last research pass: April 2026.

This is a living doc. Where claims are unverified or rely on community consensus only, that's called out explicitly. Where authoritative sources exist (Slippi devs, project README/CHANGELOG, Ishiiruka source), they're linked inline.

---

## 1. TL;DR safety matrix

| Mod category | Ranked | Unranked | Direct Connect | Offline / Training |
|---|---|---|---|---|
| Dolphin texture pack (`Load/Textures/GALE01/`) | ✅ safe [^1] | ✅ safe | ✅ safe | ✅ safe |
| `.dat` swap, vanilla skeleton, vanilla slot | ✅ safe [^2] | ✅ safe | ✅ safe | ✅ safe |
| `.dat` swap, modified vertices but vanilla skeleton | ✅ safe [^2] | ✅ safe | ✅ safe | ✅ safe |
| `.dat` swap, modified skeleton (extra/removed bones) | ❌ desyncs [^3] | ❌ desyncs | ❌ desyncs (if peer has different file) | ✅ safe |
| `.dat` swap touching physics bones with hurtboxes (Fox tail, etc.) | ❌ desyncs [^4] | ❌ desyncs | ❌ desyncs | ✅ safe |
| `.dat` swap touching hurtbox/hitbox data | ❌ desyncs | ❌ desyncs | ❌ desyncs | ✅ safe |
| m-ex extended-slot costume, vanilla skeleton, m-ex template build | ✅ safe [^5] | ✅ safe | ⚠️ both peers need m-ex build [^6] | ✅ safe |
| m-ex extended-slot costume, non-Neutral skeleton in EX slot | ❌ desyncs [^7] | ❌ desyncs | ❌ desyncs | ✅ safe |
| Akaneia Build (full overhaul, current versions) | ⚠️ via Lylat unranked only [^8] | ⚠️ via Lylat unranked [^8] | ✅ both peers must run Akaneia | ✅ safe |
| 20XX HACK PACK / Diet Melee / other gameplay mods | ⚠️ Diet Melee allowed; 20XX is offline-only [^9] | ⚠️ varies | ✅ if matched ISO | ✅ safe |
| UI/CSS/menu/music textures (Dolphin texture pack form) | ✅ safe | ✅ safe | ✅ safe | ✅ safe |
| Gecko / MCM code injections that change game logic | ❌ desyncs [^10] | ❌ desyncs | ⚠️ matched codes only | ✅ safe |
| Stages with modified collision/blastzones | ❌ desyncs | ❌ desyncs | ⚠️ matched only | ✅ safe |

Legend: ✅ safe, ⚠️ risky-with-caveat, ❌ desyncs, 🚫 will be banned. No mod category in the table is in the 🚫 bucket — Slippi has no public bannable-mod list (see §2).

[^1]: Dolphin texture replacement is purely client-side rendering. ([Smashboards thread](https://smashboards.com/threads/do-changes-to-the-iso-with-texture-hacks-cause-desync-in-slippi.506459/))
[^2]: Vanilla-skeleton `.dat` swaps don't change game state. Community consensus, see §3.1. ([Smashboards thread](https://smashboards.com/threads/do-changes-to-the-iso-with-texture-hacks-cause-desync-in-slippi.506459/))
[^3]: Skeleton mismatches are the canonical desync source. ([Costume Validator on SSBMTextures](https://ssbmtextures.com/other-mod-types/costume-validator-by-ploaj/))
[^4]: Slippi's rollback skips animation frames, so physics bones with hurtboxes drift between peers. ([SmashWiki](https://www.ssbwiki.com/Online_desynchronization))
[^5]: With the m-ex Slippi Template specifically — the template exists to make extended slots safe online. ([SSBMTextures m-ex Slippi Template](https://ssbmtextures.com/other-mod-types/m-ex-slippi-template-pack/))
[^6]: m-ex builds add file-level structure (extra `Pl??.dat` slots) so a vanilla peer has nothing to load — direct connect with a vanilla opponent fails when the EX slot is selected. ([Animelee Guide](https://davidvkimball.com/posts/the-ultimate-animelee-guide))
[^7]: Captain Falcon EX slots specifically known to require Neutral skeleton replacement. ([SSBMTextures m-ex template](https://ssbmtextures.com/other-mod-types/m-ex-slippi-template-pack/))
[^8]: Akaneia and other gameplay-modifying builds use [Lylat.gg](https://eddrit.com/r/SSBM/comments/rpxzg4/psa_use_lylatgg_to_play_unranked_akaneia) unranked queues, not Slippi's official ranked. ([Lylat / Akaneia](https://x.com/TeamAkaneia/status/1352044762753331200))
[^9]: Diet Melee is an officially-recognised Slippi-compatible build for low-end machines. ([SmashWiki Project Slippi](https://www.ssbwiki.com/Project_Slippi))
[^10]: Anything that changes game logic — frame data, hitboxes, RNG, physics — diverges deterministic state and desyncs.

---

## 2. Detection model

### 2.1 What Slippi actually checks

**Slippi does not hash your ISO and does not detect mods directly.** There is no client-side integrity check that gates ranked play. The launcher displays "Valid" or "Unknown" next to your ISO based on a known-hash list, but **"Unknown" is not blocking** — patched/modded ISOs simply show "Unknown" and play normally. This is documented in community guides ([Animelee Guide](https://davidvkimball.com/posts/the-ultimate-animelee-guide)) and is the accepted community understanding (no contradicting source found).

The Slippi Launcher [FAQ](https://github.com/project-slippi/slippi-launcher/blob/main/FAQ.md) states the launcher only "supports NTSC-U/J 1.02" but does not describe an enforcement mechanism beyond that, and explicitly does not address mod policy. There is no mention of cosmetic mods being banned in the FAQ, the launcher source, or any public Slippi rules document I could locate.

### 2.2 How desyncs actually happen

Slippi uses **deterministic-lockstep rollback netcode**. Each client simulates the game from inputs alone; both clients must produce identical state from identical inputs. Standard-issue lockstep theory applies: any divergence in determinism between the two simulations diverges state ([netcode primer](https://meseta.medium.com/netcode-concepts-part-3-lockstep-and-rollback-f70e9297271)).

What's specific to Slippi: rather than full state-rewind rollback, Slippi uses a faster but less-accurate rollback that **starts an animation at the correct intended frame instead of replaying it from the beginning**. This is documented on [SmashWiki](https://www.ssbwiki.com/Online_desynchronization):

> "Project Slippi uses a slightly less accurate version of rollback that, instead of undoing and fast-forwarding the game state, begins the correct animation and skips ahead to its intended frame ... this can cause desyncs if physics bones have hurtboxes in them, such as Fox's tail."

Fizzi (lead Slippi dev) explicitly fixed the Fox tail desync in the [Slippi 2.2.6 release](https://x.com/fizzi36/status/1377638362526322688?lang=en). The same architectural choice means **any new physics bones with hurtboxes a custom skin introduces are a latent desync risk**, even if the rest of the skeleton matches vanilla.

For replays specifically, Jas Laferriere's [Fighting Desyncs in Melee Replays](https://medium.com/project-slippi/fighting-desyncs-in-melee-replays-370a830bf88b) describes how Slippi stores per-frame character state (position, animation state, facing direction, RNG seed) so the playback engine can re-sync if simulation diverges. Live netplay does not have that luxury — when peers diverge, they stay diverged until the desync detector flags it.

### 2.3 The desync detector

[Slippi 2.5.0](https://www.berfila.com/posts/slippi-2.5.0-released/) shipped a desync detector that flags state divergence between peers during play. It is informational, not preventative — it does not stop the match, ban the player, or auto-disconnect. Issue [#364](https://github.com/project-slippi/Ishiiruka/issues/364) shows the detector triggering on every game without obvious gameplay effect for at least one user, suggesting it can produce false positives or trigger on minor state divergence that doesn't break play.

### 2.4 Practical consequences for the catalog

- We can host any cosmetic mod without worrying about Slippi's ranked policy banning it. There isn't one.
- The only real failure mode for cosmetic mods is **mid-match desync**, which is a UX disaster but not an account risk.
- If a desync happens, there is no automatic ban or report. Players just lose the game and probably ragequit your app.
- The desync detector telemetry is not public, so we have no way to query "is this skin desyncing for users?"

---

## 3. Per-category deep dives

### 3.1 Vanilla cosmetic `.dat` swaps

**What it is.** A character costume file (e.g. `PlFxNr.dat` for Fox neutral) replaced with a different `.dat` file that targets the same character and slot. Textures and vertex positions can change; the skeleton (bone count, bone order, parent chain, weights summing to 1.0 per vertex) is preserved.

**Why it doesn't desync.** The character file is loaded into memory and its data participates in collision/animation simulation. As long as no field that affects deterministic simulation differs between peers — bone topology, hurtbox/hitbox data, animation lengths, physics-bone behaviour — both peers compute the same state from the same inputs. Texture data is read by the GPU pipeline and never feeds back into game logic.

**Empirical evidence.** The [SmashBoards desync thread](https://smashboards.com/threads/do-changes-to-the-iso-with-texture-hacks-cause-desync-in-slippi.506459/) is the most-cited community reference. Posts there report most skins are fine, with specific known-bad ones (e.g. wolf skin for Fox) that break because they ship a non-vanilla skeleton.

**Tools that produce this.** DAT Texture Wizard ([DRGN-DRC/DAT-Texture-Wizard](https://github.com/DRGN-DRC/DAT-Texture-Wizard)) edits textures inside `.dat` files without touching skeleton structure. HSDRawViewer ([Ploaj/HSDLib](https://github.com/Ploaj/HSDLib)) is a more general HSD editor — it can modify skeletons too, so output safety depends on what the modder did.

**Recommended UI label.** "Slippi-safe (vanilla skeleton)" — green tag.

### 3.2 Texture-only mods (Dolphin texture packs)

**What it is.** PNG files dumped/loaded by Dolphin's texture-replacement system, placed under `<UserDir>/Load/Textures/GALE01/`. On Linux/macOS the user dir is `~/Slippi`; on Windows it's `Documents/Slippi`. Requires "Load Custom Textures" enabled in Dolphin Graphics settings; "Prefetch Custom Textures" recommended.

**Why it doesn't desync.** The replacement happens in Dolphin's GPU texture upload path, completely outside game-state simulation. The peer never sees and never receives anything about the local texture cache — they're rendering from their own copy of vanilla textures.

**Caveats.** No ISO modification, so "Reset to vanilla" is just deleting files. Higher VRAM cost, especially for large packs (the [Definitive Melee HD Pack](https://ssbmtextures.com/other-mod-types/definitive-melee-hd-dolphin-and-slippi-texture-pack/) and [papajefe/Slippi-HD](https://github.com/papajefe/Slippi-HD) are gigabytes).

**Recommended UI label.** "Texture pack (client-side only)" — green tag, no warnings needed.

### 3.3 Skeleton-modified skins

**What it is.** A `.dat` whose skeleton differs from vanilla — extra bones, removed bones, renamed bones (HAL's convention is `JOBJ_0`, `JOBJ_1`, ... and tools warn that "junk bones" outside that pattern cause errors per [shiggl/melee-tools](https://github.com/shiggl/melee-tools)), or changed parent/child relationships.

**Why it desyncs.** The character's bone matrices are part of game state for collision purposes. When peer A computes a hurtbox attached to bone N and peer B's bone N is in a different position (or doesn't exist), their per-frame state diverges. Slippi's faster-than-true rollback amplifies this — animation skipping requires consistent skeletal state to land on the same intended frame.

**The classic example.** Skins ported from other games (Brawl/PM rips) often arrive with their source-game skeleton intact. The Fox wolf skin is the recurring cautionary tale ([SmashBoards](https://smashboards.com/threads/do-changes-to-the-iso-with-texture-hacks-cause-desync-in-slippi.506459/)).

**Tools that detect.** [Costume Validator by Ploaj](https://ssbmtextures.com/other-mod-types/costume-validator-by-ploaj/) — drag a `.dat` onto the `.exe`, it checks the skeleton against vanilla per-character expectations and corrects mismatches when possible. The tool's tagline is literally "solves the DESYNC DETECTED error created by inaccurate skeletons." Requires .NET Core 3.1.

**Recommended UI label.** "Will desync online" — red tag. Either run Costume Validator and re-upload, or only enable offline.

### 3.4 Skins with modified hurtboxes/hitboxes

**What it is.** Even with a vanilla skeleton, the `.dat` can ship modified hurtbox sphere positions/sizes attached to bones, or modified attack hitbox data inside subaction scripts. This sometimes happens unintentionally when a tool round-trips a file imperfectly.

**Why it desyncs.** Hurtboxes and hitboxes drive collision detection. Different collision = different damage = different hitstun = different state.

**Detection.** Costume Validator focuses on skeleton, not hitbox/hurtbox data. **Unverified** whether any current public tool fully validates hitbox/hurtbox parity against vanilla — this is a gap in the modding tool ecosystem and a candidate area for us to address in the app's own validation pass.

**Recommended UI label.** "Will desync online" — red tag.

### 3.5 m-ex builds (Melee Extended)

**What it is.** [m-ex](https://github.com/akaneia/m-ex) is "a framework for v1.02 of SSBM that allows for the expansion of content" including extra costume slots, extra characters, extra stages, custom code per fighter/stage file. Distributed alongside [mexTool](https://github.com/akaneia/mexTool), a C# companion app that installs m-ex into a vanilla ISO.

**Mechanism for extra costumes.** Vanilla Melee has 4–6 costume slots per character keyed by file name (`PlFxNr.dat`, `PlFxRe.dat`, `PlFxBu.dat`, `PlFxGr.dat`, etc.). m-ex extends the table so additional slots like `PlFxNr2.dat` resolve. From a Slippi-state perspective, when both peers run an m-ex ISO and player picks slot N, both load the same file from their own ISO and the simulation matches.

**The m-ex Slippi Template.** A specific template ([SSBMTextures m-ex Slippi Template](https://ssbmtextures.com/other-mod-types/m-ex-slippi-template-pack/)) of an m-ex build prepared with extra costume slots whose skeletons are forced to vanilla per-character. This exists because **EX slots commonly inherit a Brawl/PM skeleton from the source skin and would desync** — the template explicitly replaces those skeletons with vanilla (e.g. Captain Falcon's Neutral skeleton for all his EX slots), making the entire build Slippi-safe.

**Compatibility caveat.** [Recent Slippi versions broke many m-ex builds](https://davidvkimball.com/posts/the-ultimate-animelee-guide): "For m-ex based builds to work, you must use the Slippi code [patch] as of 2025. Otherwise your build will crash on the stage selection screen." This is a moving target — m-ex builds need maintenance against Slippi releases.

**Direct-connect behaviour.** If two m-ex peers both have the same costume in slot N, it's fine. If one peer is on vanilla and the other on m-ex, the vanilla peer has no `PlFxNr2.dat` to load — selecting that slot on the m-ex side is a guaranteed mismatch. The Akaneia approach (see §3.6) is for the m-ex peer's "extra" costume to render as the default for the vanilla peer.

**Recommended UI label.** "m-ex extended slot — requires m-ex ISO" — yellow tag with explainer about the build requirement.

### 3.6 Akaneia / Project+ / 20XX-style overhauls

**What it is.** Full-game mods that change stages, characters, gameplay logic. [Akaneia Build](https://github.com/akaneia/akaneia-build/releases) is the headline example, including new characters (Diddy Kong, Charizard) and new modes.

**Slippi compatibility.** Team Akaneia [explicitly states](https://x.com/TeamAkaneia/status/1352044762753331200) "The Akaneia Build is compatible with Slippi! If you're against an opponent not using The Akaneia Build, new alternate costumes will appear as the fighter's default costume." The [v0.8 release notes](https://github.com/akaneia/akaneia-build/releases/tag/0.8) say "(re)achieved compatibility with Slippi Online. All known desyncs have been fixed and is compatible with vanilla Melee."

**Ranked vs. unranked.** Big gameplay-modifying builds use [Lylat.gg](https://eddrit.com/r/SSBM/comments/rpxzg4/psa_use_lylatgg_to_play_unranked_akaneia), which provides Slippi-API matchmaking for "compatible gameplay modifications" (Akaneia Build, Beyond Melee, Melee 1.03). They are **not playable on Slippi's official ranked queue** — that queue assumes vanilla gameplay.

**Diet Melee** is the exception: it strips content but doesn't change gameplay, so it works on Slippi's normal queues ([SmashWiki](https://www.ssbwiki.com/Project_Slippi)).

**20XX HACK PACK** ([DRGN-DRC](https://github.com/DRGN-DRC/20XX-HACK-PACK)) is a training/practice mod with non-vanilla gameplay; offline use primarily.

**Recommended UI label.** "Full game overhaul — Lylat unranked only / direct connect with matched ISOs." Yellow tag, with a clear callout that this is not for ranked.

### 3.7 UI / CSS / menu / music

**What it is.** Replaced character select screen layout, menu textures, music files (`.hps` in vanilla; replaceable via Dolphin texture pack for visuals or via ISO swap for audio).

**Why it doesn't desync.** Menu and CSS state is not part of in-match simulation. Music playback is driven by the local audio engine and not synchronised between peers.

**Caveat.** CSP (character select portrait) regeneration is needed when m-ex adds extra costume slots, otherwise the new slots show broken/missing portraits. This is a UX problem, not a desync problem. Auto-generating CSPs from a model is doable but technically involved (open question in the project's main spec).

**Recommended UI label.** "Cosmetic UI/menu" — green tag.

---

## 4. Tool reference

### 4.1 DAT Texture Wizard (DTW)

- **Repo:** [DRGN-DRC/DAT-Texture-Wizard](https://github.com/DRGN-DRC/DAT-Texture-Wizard)
- **What it does.** Disc (ISO/GCM) management — add/replace/delete files, build discs from root, edit metadata. Texture import/export from `.dat`/`.usd` files.
- **Slippi-safety profile.** DTW's texture-only operations preserve skeleton and hurtbox data and produce Slippi-safe output. DTW also exposes "Analyze and edit HAL DAT file structures" which can reach beyond textures and is **not** automatically Slippi-safe — depends on what the user changes.
- **Platform.** Python, Windows-first. macOS/Linux via Wine, "haven't tested them myself" per the README. Cross-platform shelling out is rough — this is the explicit reason the project spec recommends evaluating HSDLib instead.
- **License.** Not stated in the README excerpt. Treat as restricted until confirmed.

### 4.2 Costume Validator (Ploaj)

- **Repo:** Tool distribution at [SSBMTextures](https://ssbmtextures.com/other-mod-types/costume-validator-by-ploaj/) (the site that's closing 2026-09-07). Source likely lives in [Ploaj's GitHub](https://github.com/Ploaj) repos.
- **What it checks.** Per the tool's published description: "checks and corrects the skeletons of the fighters." Drag-and-drop .exe; iterates skeletons against vanilla expectations and corrects mismatches in place.
- **What "valid" means.** Skeleton-shaped-correctly-for-Slippi, **not** "won't crash" and **not** "all hurtbox/hitbox data is vanilla." A passing Costume Validator result substantially reduces but does not eliminate desync risk.
- **Platform.** Windows .exe, requires .NET Core 3.1. No native cross-platform build.
- **For our app.** The validation logic is the right thing to wrap, ideally by porting to Rust against HSDLib's file format definitions or by wrapping the binary as a subprocess on Windows (with a graceful "validation unavailable" path on Mac/Linux until we port it).

### 4.3 m-ex Tool (mexTool)

- **Repo:** [akaneia/mexTool](https://github.com/akaneia/mexTool)
- **What it does.** Installs and manages the m-ex framework on a vanilla ISO. C# (.NET) tool; uses CSCore, VGAudio, YamlDotNet.
- **Slippi-safety profile.** The output ISO is m-ex format, which is Slippi-compatible **only** when both peers run m-ex (or when the m-ex peer plays vanilla-default slots against a vanilla peer). The m-ex Slippi Template product is the "preconfigured to be safe online" variant.
- **Platform.** C#, AppVeyor CI suggests Windows builds; cross-platform via .NET 6+ runtime is plausible but **unverified** with current source.
- **License.** Not stated on the repo overview page.

### 4.4 Melee Code Manager (MCM)

- **Repo:** [DRGN-DRC/Melee-Code-Manager](https://github.com/DRGN-DRC/Melee-Code-Manager)
- **What it does.** Manages installation of code mods (Gecko codes, static overwrites, C2 injection mods) into the DOL. Dynamically allocates DOL codespace for Achilles-style injections.
- **Slippi-safety profile.** **Anything that changes game logic desyncs.** MCM is for installing things like alternate music handlers, training mode overlays, gameplay tweaks — most of which are emphatically *not* Slippi-ranked-safe. Some MCM-installed codes (UCF 0.84) are baked into Slippi already and don't count as user mods. The "is this code Slippi-safe?" question requires per-code analysis. There is no general-purpose detector. [Slippi 3.5.2 specifically](https://github.com/project-slippi/Ishiiruka/releases) added a "fix to prevent possible desync when using different gecko codes" — code mismatch between peers is a known, tracked desync source.
- **For our app.** Out of scope for v1. If we ever support code mods, they need a separate review pipeline from cosmetic mods.

### 4.5 HSDLib / HSDRawViewer (Ploaj)

- **Repo:** [Ploaj/HSDLib](https://github.com/Ploaj/HSDLib)
- **What it is.** ".NET library for parsing HSD (.dat) file structures based on relocation table." HSDRawViewer is a GUI for browsing and editing HSD files.
- **Slippi-safety profile.** Pure file-format library. Has no opinions about Slippi safety; a user can produce safe or unsafe output. Suitable as the **integration target** for our app's `.dat` patching layer because it's MIT-licensed, .NET, cross-platform via .NET Core/6+, and battle-tested by the modding community.
- **License.** MIT.

### 4.6 MeleeModdingLibrary

- **Repo:** [sherman5/MeleeModdingLibrary](https://github.com/sherman5/MeleeModdingLibrary)
- **What it is.** A C library for modding Melee — function calls, struct definitions, helper utilities for code mods.
- **Slippi-safety profile.** Lower-level than what we need. Not relevant to our skin-management v1.

---

## 5. The boundaries that matter for our catalog

These are concrete recommendations, not the spec. They follow from §1–§4.

### Day 1: host without warning labels

- Vanilla-skeleton `.dat` swaps that pass Costume Validator (or our equivalent re-implementation against HSDLib).
- Dolphin texture packs targeting `Load/Textures/GALE01/`.
- Cosmetic UI/CSS/menu mods in either form.

These are unconditionally safe across ranked, unranked, and direct connect. They are also the long-tail majority of skins on SSBMTextures and GameBanana's [Melee section](https://gamebanana.com/mods/games/5706).

### Day 1: host with prominent warning label

- m-ex extended-slot costumes (require m-ex Slippi Template ISO; unsafe with vanilla peers in direct connect).
- Anything labeled "EX skeleton" by the modder — even with the m-ex template, the skeleton substitution must be verified.

The warning template should explain: "This mod requires an m-ex build. It works on Slippi unranked and ranked **if and only if** you build it on top of an m-ex Slippi Template ISO. Plays as default costume to vanilla opponents in direct connect."

### Day 1: host but mark "offline / Lylat unranked only"

- Akaneia Build, Beyond Melee, Melee 1.03 cosmetic add-ons that are strapped to those gameplay overhauls.
- Skins that are part of larger gameplay-mod packages.

UI should make it visually obvious these are not for vanilla Slippi ranked.

### Day 1: exclude

- Anything that fails Costume Validator and the modder hasn't fixed.
- Anything advertising "modified hitboxes/hurtboxes" or "tweaked frame data" — these are gameplay mods masquerading as skins.
- Stage mods that change collision (out of scope anyway per the project spec — no stages in v1).
- Code mods (out of scope for v1).

### Validation pipeline we need

At ingest, we should run (or replicate) Costume Validator against the `.dat`. If the skin passes, tag it Slippi-safe. If it fails, either auto-correct (if the modder has uploaded an explicitly raw artefact and we have permission to repackage) or reject the upload with a clear error.

Even after Costume Validator passes, we have **no current way to validate hurtbox/hitbox parity with vanilla** for arbitrary `.dat` files. This is a gap. For the catalog, we should treat Costume Validator as necessary-but-not-sufficient and rely on community vetting (uploader reputation, download reports) for the residual hitbox/hurtbox risk in the short term.

---

## 6. Open questions / things I couldn't pin down

1. **Exact contents of Slippi's ranked TOS / rules document.** Players have to accept rules on first ranked queue ([Fizzi tweet](https://x.com/fizzi36/status/1602362794321612822?lang=en)), but the text of those rules is gated behind the launcher and I couldn't find a public-mirror copy. **Unverified** whether the ranked TOS even mentions cosmetic mods.

2. **Whether Slippi staff have ever banned anyone for cosmetic mods.** No public report found. The desync detector is informational, not punitive, as far as public sources show.

3. **Authoritative hurtbox/hitbox validation.** Costume Validator covers skeletons. **Unverified** whether any public tool validates that arbitrary `.dat` files preserve vanilla hurtbox sphere positions/sizes and subaction hitbox parameters. If not, this is a tool we may need to build for the catalog.

4. **Desync detector telemetry.** [Slippi 2.5.0](https://www.berfila.com/posts/slippi-2.5.0-released/) added desync detection. **Unverified** whether Slippi staff collect or surface aggregate desync data per ISO hash. Useful for us if so.

5. **m-ex Slippi compatibility going forward.** [Recent Slippi updates broke m-ex builds](https://davidvkimball.com/posts/the-ultimate-animelee-guide). The community fix as of 2025 is a Gecko patch. **Unverified** whether m-ex will be maintained against future Slippi releases or whether the relationship needs to be more formal.

6. **Costume Validator source code location and license.** Tool is distributed on SSBMTextures (closing September 2026). Source not obviously located on [Ploaj's GitHub](https://github.com/Ploaj) under that name. **Unverified** whether we can re-implement against HSDLib without legal/attribution issues, though Ploaj being the author of both HSDLib (MIT) and Costume Validator suggests a permissive disposition.

7. **Whether the "desyncs from physics bones with hurtboxes" issue is fully fixed in current Slippi.** Fixed for vanilla Fox tail in 2.2.6, but the underlying architectural choice (animation-skipping rollback) remains. **Unverified** whether new physics-bone hurtboxes a custom skin introduces would still desync today.

---

## 7. Sources

- [Slippi Launcher FAQ](https://github.com/project-slippi/slippi-launcher/blob/main/FAQ.md)
- [Slippi/Ishiiruka releases](https://github.com/project-slippi/Ishiiruka/releases)
- [Slippi Ishiiruka source: EXI_DeviceSlippi.cpp](https://github.com/project-slippi/Ishiiruka/blob/slippi/Source/Core/Core/HW/EXI_DeviceSlippi.cpp)
- [Ishiiruka issue #364: Desync Triggers Every Game](https://github.com/project-slippi/Ishiiruka/issues/364)
- [Jas Laferriere: Fighting Desyncs in Melee Replays](https://medium.com/project-slippi/fighting-desyncs-in-melee-replays-370a830bf88b)
- [Fizzi tweet: Fox tail desync fix in 2.2.6](https://x.com/fizzi36/status/1377638362526322688?lang=en)
- [Fizzi tweet: frozen-animation Dolphin bug as remaining known desync](https://x.com/Fizzi36/status/1386423343629279236)
- [Fizzi tweet: ranked queue requires accepting rules and policies](https://x.com/fizzi36/status/1602362794321612822?lang=en)
- [Slippi 2.5.0 release notes (mirror)](https://www.berfila.com/posts/slippi-2.5.0-released/)
- [SmashWiki: Online desynchronization](https://www.ssbwiki.com/Online_desynchronization)
- [SmashWiki: Project Slippi](https://www.ssbwiki.com/Project_Slippi)
- [SmashBoards: Do changes to the ISO with texture hacks cause desync in Slippi?](https://smashboards.com/threads/do-changes-to-the-iso-with-texture-hacks-cause-desync-in-slippi.506459/)
- [Yuan Gao: Netcode Concepts Part 3 — Lockstep and Rollback](https://meseta.medium.com/netcode-concepts-part-3-lockstep-and-rollback-f70e9297271)
- [Costume Validator by Ploaj on SSBMTextures](https://ssbmtextures.com/other-mod-types/costume-validator-by-ploaj/)
- [m-ex Slippi Template Pack on SSBMTextures](https://ssbmtextures.com/other-mod-types/m-ex-slippi-template-pack/)
- [Animelee m-ex Template on SSBMTextures](https://ssbmtextures.com/other-mod-types/animelee-m-ex-template/)
- [Definitive Melee HD Dolphin and Slippi Texture Pack on SSBMTextures](https://ssbmtextures.com/other-mod-types/definitive-melee-hd-dolphin-and-slippi-texture-pack/)
- [David V. Kimball: The Ultimate Animelee Guide for Slippi](https://davidvkimball.com/posts/the-ultimate-animelee-guide)
- [Team Akaneia tweet: Akaneia Slippi compatibility](https://x.com/TeamAkaneia/status/1352044762753331200)
- [Akaneia Build v0.8 release](https://github.com/akaneia/akaneia-build/releases/tag/0.8)
- [Akaneia Build releases (general)](https://github.com/akaneia/akaneia-build/releases)
- [PSA: Use Lylat.gg to Play Unranked Akaneia (r/SSBM)](https://eddrit.com/r/SSBM/comments/rpxzg4/psa_use_lylatgg_to_play_unranked_akaneia)
- [akaneia/m-ex GitHub repo](https://github.com/akaneia/m-ex)
- [akaneia/mexTool GitHub repo](https://github.com/akaneia/mexTool)
- [Ploaj/HSDLib GitHub repo](https://github.com/Ploaj/HSDLib)
- [Ploaj GitHub profile](https://github.com/Ploaj)
- [DRGN-DRC/DAT-Texture-Wizard GitHub repo](https://github.com/DRGN-DRC/DAT-Texture-Wizard)
- [DRGN-DRC/Melee-Code-Manager GitHub repo](https://github.com/DRGN-DRC/Melee-Code-Manager)
- [DRGN-DRC/20XX-HACK-PACK GitHub repo](https://github.com/DRGN-DRC/20XX-HACK-PACK)
- [sherman5/MeleeModdingLibrary GitHub repo](https://github.com/sherman5/MeleeModdingLibrary)
- [shiggl/melee-tools GitHub repo](https://github.com/shiggl/melee-tools)
- [papajefe/Slippi-HD GitHub repo](https://github.com/papajefe/Slippi-HD)
- [GameBanana: Melee mods](https://gamebanana.com/mods/games/5706)
- [SSBMTextures (closing 2026-09-07)](https://ssbmtextures.com/)
