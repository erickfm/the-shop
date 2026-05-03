use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::install;
use crate::patreon;
use crate::paths;
use crate::skin_index::{self, IndexedSkinEntry};
use crate::AppState;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Debug, serde::Serialize)]
pub struct PatreonInstallResult {
    pub skin_id: String,
    pub bytes: i64,
    pub install: install::InstallResult,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn read_index_entry(db: &Db, skin_id: &str) -> AppResult<IndexedSkinEntry> {
    let cached = db.with_conn(|c| {
        let mut stmt = c.prepare("SELECT json FROM skin_index_cache WHERE id = 1")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get::<_, String>(0)?))
        } else {
            Ok(None)
        }
    })?;
    let body = cached.ok_or_else(|| {
        AppError::Other("skin index not loaded — refresh required".into())
    })?;
    let parsed: skin_index::SkinIndex = serde_json::from_str(&body)?;
    parsed
        .skins
        .into_iter()
        .find(|s| s.id == skin_id)
        .ok_or_else(|| AppError::Other(format!("skin '{skin_id}' not found in index")))
}

fn pick_attachment_url(json: &serde_json::Value, filename: &str) -> Option<(String, String)> {
    let included = json.get("included")?.as_array()?;
    for item in included {
        let kind = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind != "attachment" && kind != "media" && kind != "attachments_media" {
            continue;
        }
        let attrs = match item.get("attributes") {
            Some(a) => a,
            None => continue,
        };
        let name = attrs
            .get("name")
            .or_else(|| attrs.get("file_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !name.eq_ignore_ascii_case(filename) {
            continue;
        }
        let url = attrs
            .get("download_url")
            .or_else(|| attrs.get("url"))
            .or_else(|| {
                attrs
                    .get("download_urls")
                    .and_then(|d| d.get("original"))
            })
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(u) = url {
            return Some((name.to_string(), u));
        }
    }
    None
}

async fn fetch_post_metadata(
    client: &reqwest::Client,
    session_cookie: &str,
    post_id: &str,
) -> AppResult<serde_json::Value> {
    let url = format!(
        "https://www.patreon.com/api/posts/{post_id}?include=attachments,attachments_media,access_rules&fields[post]=title,published_at"
    );
    let resp = client
        .get(&url)
        .header("Cookie", format!("session_id={session_cookie}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| AppError::Other(format!("patreon post http: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::Other(format!(
            "tier-required or unauthorized for post {post_id}"
        )));
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(AppError::Other(format!("patreon post {post_id} not found")));
    }
    if !status.is_success() {
        return Err(AppError::Other(format!(
            "patreon post {post_id}: HTTP {status}"
        )));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| AppError::Other(format!("patreon post body: {e}")))
}

async fn download_to_path(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
) -> AppResult<(u64, String)> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("cdn http: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "cdn fetch: HTTP {} for {url}",
            resp.status()
        )));
    }
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let parent = dest
        .parent()
        .ok_or_else(|| AppError::Other(format!("no parent for {}", dest.display())))?;
    std::fs::create_dir_all(parent)?;
    let mut file = std::fs::File::create(dest)?;
    let mut stream = resp.bytes_stream();
    use std::io::Write;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| AppError::Other(format!("cdn stream: {e}")))?;
        hasher.update(&chunk);
        file.write_all(&chunk)?;
        total += chunk.len() as u64;
    }
    file.flush()?;
    Ok((total, hex::encode(hasher.finalize())))
}

fn register_skin_file(
    db: &Db,
    entry: &IndexedSkinEntry,
    dest: &PathBuf,
    sha256: &str,
    bytes: u64,
) -> AppResult<()> {
    // Use the index-stable skin id as pack_name in the DB to avoid collisions
    // between two creators who happen to name a skin the same thing. The
    // display name is what users see in the UI; the id is the install key.
    let pack_name = entry.id.clone();
    let dest_str = dest.to_string_lossy().to_string();
    let filename = dest
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Other("dest filename".into()))?
        .to_string();
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO skin_files
               (filename, character_code, slot_code, pack_name, source_path, size_bytes, sha256, imported_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(source_path) DO UPDATE SET
               sha256 = excluded.sha256,
               size_bytes = excluded.size_bytes,
               pack_name = excluded.pack_name,
               character_code = excluded.character_code,
               slot_code = excluded.slot_code",
            rusqlite::params![
                filename,
                entry.character_code,
                entry.slot_code,
                pack_name,
                dest_str,
                bytes as i64,
                sha256,
                now_secs(),
            ],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub async fn install_patreon_skin(
    state: State<'_, AppState>,
    skin_id: String,
) -> AppResult<PatreonInstallResult> {
    let entry = read_index_entry(&state.db, &skin_id)?;

    let session_cookie = patreon::load_session_cookie(&state.db)?
        .ok_or_else(|| AppError::Other("not connected to Patreon".into()))?;

    let client = reqwest::Client::builder()
        .user_agent("the-shop/0.1")
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::Other(format!("reqwest: {e}")))?;

    let metadata = fetch_post_metadata(&client, &session_cookie, &entry.patreon_post_id).await?;
    let (matched_filename, signed_url) =
        pick_attachment_url(&metadata, &entry.filename_in_post).ok_or_else(|| {
            AppError::Other(format!(
                "attachment '{}' not found on post {}",
                entry.filename_in_post, entry.patreon_post_id
            ))
        })?;

    let dest = paths::skins_dir()?.join(&matched_filename);
    let (bytes, downloaded_sha) = download_to_path(&client, &signed_url, &dest).await?;

    if let Some(expected) = entry.sha256.as_ref() {
        if !expected.is_empty() && !downloaded_sha.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&dest);
            return Err(AppError::Other(format!(
                "integrity check failed for {}: expected {expected}, got {downloaded_sha}",
                matched_filename
            )));
        }
    }

    register_skin_file(&state.db, &entry, &dest, &downloaded_sha, bytes)?;

    let install_result =
        install::install_pack(&state.db, &entry.character_code, &entry.id)?;

    Ok(PatreonInstallResult {
        skin_id,
        bytes: bytes as i64,
        install: install_result,
    })
}
