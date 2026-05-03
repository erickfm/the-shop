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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedSkinEntry {
    pub id: String,
    pub creator_id: String,
    pub display_name: String,
    pub character_code: String,
    pub slot_code: String,
    pub patreon_post_id: String,
    pub filename_in_post: String,
    #[serde(default)]
    pub tier_required_cents: i64,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
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

#[tauri::command]
pub async fn list_skin_index(state: State<'_, AppState>) -> AppResult<Vec<AnnotatedSkin>> {
    let index = match read_cached_index(&state.db)? {
        Some(i) => i,
        None => {
            let url = current_index_url(&state.db)?;
            match fetch_index_from_url(&url).await {
                Ok(body) => {
                    let parsed = parse_index(&body)?;
                    write_cache(&state.db, &body, &url)?;
                    parsed
                }
                Err(_) => {
                    // Remote unreachable / not yet created — fall back to the
                    // bundled stub so the rest of the app stays usable.
                    let parsed = parse_index(BUNDLED_INDEX_JSON)?;
                    write_cache(&state.db, BUNDLED_INDEX_JSON, "bundled")?;
                    parsed
                }
            }
        }
    };

    let backed = if patreon::load_session_cookie(&state.db)?.is_some() {
        match patreon::list_backed_creators(state.clone(), Some(false)).await {
            Ok(v) => v,
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };
    let backed_by_campaign: std::collections::HashMap<String, &BackedCreator> = backed
        .iter()
        .map(|b| (b.campaign_id.clone(), b))
        .collect();

    let creators_by_id: std::collections::HashMap<String, IndexedCreator> = index
        .creators
        .iter()
        .map(|c| (c.id.clone(), c.clone()))
        .collect();

    let installed_set = read_installed_keys(&state.db)?;

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
        let tier_satisfied = current_tier_cents >= skin.tier_required_cents;
        let installed = installed_set.contains(&pack_key(&skin.character_code, &skin.id));
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

fn pack_key(character_code: &str, pack_name: &str) -> String {
    format!("{character_code}/{pack_name}")
}

fn read_installed_keys(db: &Db) -> AppResult<std::collections::HashSet<String>> {
    db.with_conn(|c| {
        let mut stmt =
            c.prepare("SELECT character_code, pack_name FROM installed_pack")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        let mut set = std::collections::HashSet::new();
        for row in rows {
            let (ch, pn) = row?;
            if let Some(p) = pn {
                set.insert(pack_key(&ch, &p));
            }
        }
        Ok(set)
    })
}
