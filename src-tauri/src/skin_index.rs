use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::patreon::{self, BackedCreator};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

pub const DEFAULT_SKIN_INDEX_URL: &str =
    "https://raw.githubusercontent.com/erickfm/the-shop/main/texture-index/index.json";
pub const SKIN_INDEX_URL_KEY: &str = "skin_index_url";
const STARTUP_TTL_SECS: i64 = 3600;

/// The canonical texture index lives at `texture-index/index.json` in this
/// repo. We embed it at compile time so the app falls back to the same data
/// when the GitHub raw URL is unreachable (offline, repo not yet pushed,
/// transient 5xx). User-triggered `refresh_skin_index` still surfaces remote
/// errors so a missing upstream isn't silently masked.
const BUNDLED_INDEX_JSON: &str = include_str!("../../texture-index/index.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedCreator {
    pub id: String,
    pub display_name: String,
    /// Numeric Patreon campaign ID. Optional in the JSON so seed entries can
    /// be added before someone resolves the ID — without it, the entitlement
    /// join in `list_skin_index` won't match memberships, but the creator
    /// metadata still appears in the index. Defaults to empty string.
    #[serde(default)]
    pub patreon_campaign_id: String,
    pub patreon_url: String,
    #[serde(default)]
    pub tagline: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

fn default_kind() -> String {
    "character_skin".to_string()
}

/// Accept missing, null, or string-valued JSON for a `String` field. The
/// scrape pipeline emits explicit `null`s for character_code/slot_code on
/// non-character entries (stages, effects, etc.), and serde's default for
/// `String` only handles "missing" — not "present but null". This bridges
/// the gap so the index loads cleanly.
fn string_or_null<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = serde::Deserialize::deserialize(d)?;
    Ok(opt.unwrap_or_default())
}

fn kind_or_null<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = serde::Deserialize::deserialize(d)?;
    Ok(opt.unwrap_or_else(|| "character_skin".to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedSkinEntry {
    pub id: String,
    pub creator_id: String,
    pub display_name: String,
    /// One of: character_skin, stage, music, effect, animation, ui, item,
    /// texture_pack. Defaults to character_skin so existing entries with
    /// no `kind` continue to work; nulls are treated as the default too.
    #[serde(default = "default_kind", deserialize_with = "kind_or_null")]
    pub kind: String,
    /// The HAL filesystem name of the file once injected into the ISO
    /// (e.g. `PlFcNr.dat`, `GrFd.usd`, `ff_a01.hps`). For character_skin
    /// this can be omitted and is derived from `Pl{character_code}{slot_code}.dat`.
    /// Required for non-character_skin ISO-inject kinds. Ignored for
    /// `texture_pack` kind (folder install, no single ISO target).
    #[serde(default)]
    pub iso_target_filename: Option<String>,
    /// When `filename_in_post` is a `.zip`/`.rar`/`.7z`, this is the file
    /// inside the archive to extract for ISO inject. For texture packs the
    /// whole archive contents are extracted (not just one file).
    #[serde(default)]
    pub inner_filename: Option<String>,
    #[serde(default, deserialize_with = "string_or_null")]
    pub character_code: String,
    #[serde(default, deserialize_with = "string_or_null")]
    pub slot_code: String,
    pub patreon_post_id: String,
    pub filename_in_post: String,
    #[serde(default)]
    pub tier_required_cents: i64,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub preview_url: Option<String>,
    /// Additional preview images for posts with carousels / multi-image
    /// galleries. Empty when the post has only the single hero. Frontend
    /// concatenates `preview_url` with this when the entry is rendered.
    #[serde(default)]
    pub preview_urls: Vec<String>,
    /// Group key for slot variants of the same multi-slot pack. Entries
    /// sharing a `pack_id` are different color/slot options in the same
    /// pack and should render as a single Browse card with N installable
    /// slots. Empty / missing = treat the entry as its own 1-slot pack
    /// keyed on its `id`. Set by texture-index/index.json's grouping pass.
    #[serde(default)]
    pub pack_id: String,
    /// Optional pack-level display name (e.g. "B0XX Spacies" for a 4-slot
    /// pack whose individual entries are named "B0XX Spacies (Bu)" etc.).
    /// Falls back to the first slot's `display_name` when absent.
    #[serde(default)]
    pub pack_display_name: Option<String>,
    /// Format flavor: `"animelee"` / `"vanilla"` / `"1:1"` / null. Lets
    /// two packs of the same skin coexist when a creator publishes
    /// alternate styles (e.g. an Animelee Zuko + a Vanilla Zuko, both
    /// with the full color set). Set by the grouping pass in
    /// tools/build-index.py based on tokens in the source filenames.
    #[serde(default)]
    pub format: Option<String>,
    /// Slippi safety verdict from the validator (skeleton-compare for
    /// costumes, collision-compare for stages). Computed at scrape time
    /// against the vanilla NTSC 1.02 ISO. None = not validated yet.
    #[serde(default)]
    pub safety: Option<SafetyReport>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafetyReport {
    /// "safe" | "warn" | "unsafe" | "unknown"
    pub verdict: String,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl IndexedSkinEntry {
    /// Returns the canonical ISO target filename for this entry, deriving
    /// it from character_code/slot_code if the explicit field is absent and
    /// kind is character_skin. None for kinds that don't ISO-inject.
    pub fn resolved_iso_target(&self) -> Option<String> {
        if let Some(t) = self.iso_target_filename.as_ref() {
            if !t.is_empty() {
                return Some(t.clone());
            }
        }
        if self.kind == "character_skin"
            && !self.character_code.is_empty()
            && !self.slot_code.is_empty()
        {
            return Some(format!(
                "Pl{}{}.dat",
                self.character_code, self.slot_code
            ));
        }
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkinIndex {
    pub schema_version: i64,
    #[serde(default)]
    pub creators: Vec<IndexedCreator>,
    #[serde(default)]
    pub skins: Vec<IndexedSkinEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnnotatedSkin {
    #[serde(flatten)]
    pub entry: IndexedSkinEntry,
    pub creator: Option<IndexedCreator>,
    pub backed: bool,
    pub current_tier_cents: i64,
    pub tier_satisfied: bool,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnnotatedCreator {
    #[serde(flatten)]
    pub creator: IndexedCreator,
    pub backed: bool,
    pub current_tier_cents: i64,
    pub skin_count: i64,
}

/// A single pack as the user thinks about it: one Patreon post worth of slot
/// variants for one character. Built by collapsing entries that share a
/// `pack_id` (or, for legacy entries with no pack_id, a self-key on `id`).
/// Each `slots[]` entry is still individually installable — the pack is a
/// presentation grouping, not a backend install unit.
#[derive(Debug, Clone, Serialize)]
pub struct IndexedPack {
    pub pack_id: String,
    pub display_name: String,
    /// One of the kinds — for character_skin packs this is "character_skin".
    /// Non-skin entries (stage / effect / etc.) are always packs of 1 with
    /// the entry's own kind here.
    pub kind: String,
    pub creator: Option<IndexedCreator>,
    pub creator_id: String,
    /// Empty for non-character kinds (stages, generic UI, etc.).
    pub character_code: String,
    pub patreon_post_id: String,
    /// Highest tier required across all slots in this pack — i.e. what you'd
    /// need to install everything. Per-slot tiers may be lower; the per-slot
    /// `tier_satisfied` on each `AnnotatedSkin` is the source of truth for
    /// the install button state.
    pub tier_required_cents: i64,
    pub preview_url: Option<String>,
    pub preview_urls: Vec<String>,
    pub slots: Vec<AnnotatedSkin>,
    pub backed: bool,
    pub current_tier_cents: i64,
    /// True iff at least one slot in the pack meets its tier requirement.
    pub any_tier_satisfied: bool,
    pub installed_count: i64,
    pub slot_count: i64,
    /// Representative `filename_in_post` (first slot) — informational only,
    /// not an install key. Each slot still installs from its own attachment.
    pub filename_in_post: String,
    /// Format flavor (animelee / vanilla / 1:1 / null) carried up from
    /// the slots so the frontend can render a pill on the pack card.
    pub format: Option<String>,
    /// Worst safety verdict among the slots (unsafe > warn > unknown >
    /// safe > null). Surfaces a single ✓ / ⚠ / ✗ badge on the pack
    /// card that reflects the most-suspicious slot — defensive default.
    pub safety: Option<SafetyReport>,
}

fn pack_safety(members: &[AnnotatedSkin]) -> Option<SafetyReport> {
    // Returns the WORST verdict among slots that have one. Verdicts are
    // collapsed to a single rep — we don't aggregate the warnings list
    // across slots because it's purely informational at the pack level.
    fn rank(v: &str) -> u8 {
        match v {
            "unsafe" => 3,
            "warn" => 2,
            "unknown" => 1,
            "safe" => 0,
            _ => 0,
        }
    }
    let mut worst: Option<&SafetyReport> = None;
    for s in members {
        if let Some(rep) = &s.entry.safety {
            if worst
                .map(|w| rank(&rep.verdict) > rank(&w.verdict))
                .unwrap_or(true)
            {
                worst = Some(rep);
            }
        }
    }
    worst.cloned()
}

fn pack_grouping_key(s: &AnnotatedSkin) -> String {
    if !s.entry.pack_id.is_empty() {
        s.entry.pack_id.clone()
    } else {
        s.entry.id.clone()
    }
}

/// Group `AnnotatedSkin`s by their `pack_id` into pack-level cards. Order
/// within a pack is the index's natural order (slots[].entry.id is the
/// pre-grouping id, so we sort by that for stability). Packs themselves are
/// returned in the order their first slot appears in the input.
fn group_into_packs(skins: Vec<AnnotatedSkin>) -> Vec<IndexedPack> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<AnnotatedSkin>> =
        std::collections::HashMap::new();
    for s in skins {
        let k = pack_grouping_key(&s);
        if !groups.contains_key(&k) {
            order.push(k.clone());
        }
        groups.entry(k).or_default().push(s);
    }

    let mut packs = Vec::with_capacity(order.len());
    for key in order {
        let mut members = groups.remove(&key).unwrap_or_default();
        if members.is_empty() {
            continue;
        }
        members.sort_by(|a, b| a.entry.id.cmp(&b.entry.id));

        let first = &members[0];
        let display_name = first
            .entry
            .pack_display_name
            .clone()
            .unwrap_or_else(|| first.entry.display_name.clone());
        let kind = first.entry.kind.clone();
        let creator = first.creator.clone();
        let creator_id = first.entry.creator_id.clone();
        let character_code = first.entry.character_code.clone();
        let patreon_post_id = first.entry.patreon_post_id.clone();
        let filename_in_post = first.entry.filename_in_post.clone();
        let format = first.entry.format.clone();
        // Worst-case safety verdict: if any slot is unsafe, the pack is
        // unsafe; warn beats safe; unknown beats safe but loses to warn.
        let safety = pack_safety(&members);

        let mut tier_required_cents: i64 = 0;
        let mut preview_url: Option<String> = None;
        let mut all_previews: Vec<String> = Vec::new();
        let mut seen_preview: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut backed = false;
        let mut current_tier_cents: i64 = 0;
        let mut any_tier_satisfied = false;
        let mut installed_count: i64 = 0;

        for s in &members {
            if s.entry.tier_required_cents > tier_required_cents {
                tier_required_cents = s.entry.tier_required_cents;
            }
            if preview_url.is_none() {
                if let Some(u) = &s.entry.preview_url {
                    if !u.is_empty() {
                        preview_url = Some(u.clone());
                    }
                }
            }
            if let Some(u) = &s.entry.preview_url {
                if !u.is_empty() && seen_preview.insert(u.clone()) {
                    all_previews.push(u.clone());
                }
            }
            for u in &s.entry.preview_urls {
                if !u.is_empty() && seen_preview.insert(u.clone()) {
                    all_previews.push(u.clone());
                }
            }
            if s.backed {
                backed = true;
            }
            if s.current_tier_cents > current_tier_cents {
                current_tier_cents = s.current_tier_cents;
            }
            if s.tier_satisfied {
                any_tier_satisfied = true;
            }
            if s.installed {
                installed_count += 1;
            }
        }

        let slot_count = members.len() as i64;
        packs.push(IndexedPack {
            pack_id: key,
            display_name,
            kind,
            creator,
            creator_id,
            character_code,
            patreon_post_id,
            tier_required_cents,
            preview_url,
            preview_urls: all_previews,
            slots: members,
            backed,
            current_tier_cents,
            any_tier_satisfied,
            installed_count,
            slot_count,
            filename_in_post,
            format,
            safety,
        });
    }

    packs
}

#[tauri::command]
pub async fn list_indexed_packs(state: State<'_, AppState>) -> AppResult<Vec<IndexedPack>> {
    let skins = list_skin_index(state).await?;
    Ok(group_into_packs(skins))
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn read_cache(db: &Db) -> AppResult<Option<(String, i64, String)>> {
    db.with_conn(|c| {
        let mut stmt = c
            .prepare("SELECT json, fetched_at, source_url FROM skin_index_cache WHERE id = 1")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(Some((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            )))
        } else {
            Ok(None)
        }
    })
}

fn write_cache(db: &Db, json: &str, source_url: &str) -> AppResult<()> {
    let now = now_secs();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO skin_index_cache (id, json, fetched_at, source_url)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
               json = excluded.json,
               fetched_at = excluded.fetched_at,
               source_url = excluded.source_url",
            rusqlite::params![json, now, source_url],
        )?;
        Ok(())
    })
}

fn current_index_url(db: &Db) -> AppResult<String> {
    Ok(db
        .get_setting(SKIN_INDEX_URL_KEY)?
        .unwrap_or_else(|| DEFAULT_SKIN_INDEX_URL.to_string()))
}

async fn fetch_index_from_url(url: &str) -> AppResult<String> {
    let client = reqwest::Client::builder()
        .user_agent("the-shop/0.1")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Other(format!("reqwest: {e}")))?;
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::Other(format!("skin index http: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "skin index: HTTP {} from {url}",
            resp.status()
        )));
    }
    resp.text()
        .await
        .map_err(|e| AppError::Other(format!("skin index body: {e}")))
}

fn parse_index(body: &str) -> AppResult<SkinIndex> {
    let parsed: SkinIndex = serde_json::from_str(body)?;
    if parsed.schema_version != 1 {
        return Err(AppError::Other(format!(
            "unsupported skin index schema version: {}",
            parsed.schema_version
        )));
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn refresh_skin_index(state: State<'_, AppState>) -> AppResult<SkinIndex> {
    let url = current_index_url(&state.db)?;
    let body = fetch_index_from_url(&url).await?;
    let parsed = parse_index(&body)?;
    write_cache(&state.db, &body, &url)?;
    Ok(parsed)
}

pub async fn ensure_index_loaded(db: &std::sync::Arc<Db>) -> AppResult<SkinIndex> {
    let url = current_index_url(db)?;
    if let Some((cached_json, fetched_at, cached_url)) = read_cache(db)? {
        if cached_url == url && now_secs() - fetched_at < STARTUP_TTL_SECS {
            return parse_index(&cached_json);
        }
    }
    let body = fetch_index_from_url(&url).await?;
    let parsed = parse_index(&body)?;
    write_cache(db, &body, &url)?;
    Ok(parsed)
}

fn read_cached_index(db: &Db) -> AppResult<Option<SkinIndex>> {
    let cached = read_cache(db)?;
    let Some((body, _at, _url)) = cached else {
        return Ok(None);
    };
    Ok(Some(parse_index(&body)?))
}

/// Auto-refresh window for the cached index. Older than this and we go back
/// to the network on the next browse. Short enough that "click Refresh"
/// rarely needs to be the answer, long enough that we don't pummel GitHub
/// raw on every navigation.
const CACHE_TTL_SECS: i64 = 300;

/// Single source of truth for "give me the current index" with the bundled
/// fallback baked in. `list_skin_index` and `list_indexed_creators` both
/// route through this so they never blank out on a transient remote miss.
///
/// Cache is invalidated when:
///   1. It's older than CACHE_TTL_SECS, OR
///   2. The configured source_url changed (user pointed at a different repo), OR
///   3. The upstream is unreachable AND the cached body matches BUNDLED_INDEX_JSON
///      (treat that as a bundled-only state — try the network anyway in case
///      the URL is now live).
async fn load_index_with_fallback(db: &Db) -> AppResult<SkinIndex> {
    let url = current_index_url(db)?;
    let cached = read_cache(db)?;

    let cache_is_fresh_for_url = match cached.as_ref() {
        Some((_body, fetched_at, src)) => {
            src == &url && now_secs() - fetched_at < CACHE_TTL_SECS
        }
        None => false,
    };

    if cache_is_fresh_for_url {
        if let Some((body, _, _)) = cached.as_ref() {
            return parse_index(body);
        }
    }

    match fetch_index_from_url(&url).await {
        Ok(body) => {
            let parsed = parse_index(&body)?;
            write_cache(db, &body, &url)?;
            Ok(parsed)
        }
        Err(_) => {
            // Network miss — prefer any non-empty cached body (even if stale)
            // over the bundled stub, since a stale real index beats a bundled
            // empty one. Otherwise fall back to bundled.
            if let Some((body, _, _)) = cached {
                if !body.trim().is_empty() {
                    return parse_index(&body);
                }
            }
            let parsed = parse_index(BUNDLED_INDEX_JSON)?;
            write_cache(db, BUNDLED_INDEX_JSON, "bundled")?;
            Ok(parsed)
        }
    }
}

async fn backed_by_campaign_id(
    state: &State<'_, AppState>,
) -> std::collections::HashMap<String, BackedCreator> {
    if patreon::load_session_cookie(&state.db).ok().flatten().is_none() {
        return std::collections::HashMap::new();
    }
    let backed = patreon::list_backed_creators(state.clone(), Some(false))
        .await
        .unwrap_or_default();
    backed
        .into_iter()
        .map(|b| (b.campaign_id.clone(), b))
        .collect()
}

#[tauri::command]
pub async fn list_skin_index(state: State<'_, AppState>) -> AppResult<Vec<AnnotatedSkin>> {
    let index = load_index_with_fallback(&state.db).await?;
    let backed_by_campaign = backed_by_campaign_id(&state).await;
    let creators_by_id: std::collections::HashMap<String, IndexedCreator> = index
        .creators
        .iter()
        .map(|c| (c.id.clone(), c.clone()))
        .collect();
    let installed_set = read_installed_pack_names(&state.db)?;
    // Patreon's per-post `current_user_can_view: true` is the
    // authoritative gate — `tier_satisfied` from membership math
    // undercounts because /api/current_user?include=memberships hides
    // former patrons who still have through-end-of-period access. If
    // the post is in this set, we accept it as available regardless of
    // the computed tier.
    let viewable_posts = patreon::read_viewable_posts(&state.db).unwrap_or_default();

    let mut out = Vec::with_capacity(index.skins.len());
    for skin in index.skins {
        let creator = creators_by_id.get(&skin.creator_id).cloned();
        let (backed, current_tier_cents) = match creator
            .as_ref()
            .and_then(|c| backed_by_campaign.get(&c.patreon_campaign_id))
        {
            Some(b) => (true, b.currently_entitled_amount_cents),
            None => (false, 0),
        };
        let tier_satisfied = current_tier_cents >= skin.tier_required_cents
            || viewable_posts.contains(&skin.patreon_post_id);
        let installed = installed_set.contains(&skin.id);
        out.push(AnnotatedSkin {
            entry: skin,
            creator,
            backed,
            current_tier_cents,
            tier_satisfied,
            installed,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_indexed_creators(state: State<'_, AppState>) -> AppResult<Vec<AnnotatedCreator>> {
    let index = load_index_with_fallback(&state.db).await?;
    let backed_by_campaign = backed_by_campaign_id(&state).await;

    let mut skin_counts: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    for skin in &index.skins {
        *skin_counts.entry(skin.creator_id.clone()).or_insert(0) += 1;
    }

    Ok(index
        .creators
        .into_iter()
        .map(|c| {
            let (backed, cents) = match backed_by_campaign.get(&c.patreon_campaign_id) {
                Some(b) => (true, b.currently_entitled_amount_cents),
                None => (false, 0),
            };
            let skin_count = *skin_counts.get(&c.id).unwrap_or(&0);
            AnnotatedCreator {
                creator: c,
                backed,
                current_tier_cents: cents,
                skin_count,
            }
        })
        .collect())
}

/// "Is this index entry currently installed?" — the set of identifiers we
/// match against `IndexedSkinEntry::id`. For character skins, the same
/// `entry.id` is written as `installed_pack.pack_name`. For non-skin ISO
/// assets it's `installed_iso_asset.pack_name`. For texture packs it's
/// `installed_texture_pack.pack_name`. All three tables must be unioned;
/// otherwise non-skin entries display as "not installed" forever even after
/// a successful install.
fn read_installed_pack_names(db: &Db) -> AppResult<std::collections::HashSet<String>> {
    db.with_conn(|c| {
        let mut set = std::collections::HashSet::new();

        let mut stmt =
            c.prepare("SELECT pack_name FROM installed_pack WHERE pack_name IS NOT NULL")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            set.insert(row?);
        }

        let mut stmt = c.prepare(
            "SELECT pack_name FROM installed_iso_asset WHERE pack_name IS NOT NULL",
        )?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            set.insert(row?);
        }

        let mut stmt = c.prepare("SELECT pack_name FROM installed_texture_pack")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            set.insert(row?);
        }

        Ok(set)
    })
}
