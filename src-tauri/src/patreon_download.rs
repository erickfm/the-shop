use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::install;
use crate::patreon;
use crate::paths;
use crate::skin_index::{self, IndexedSkinEntry};
use crate::texture_pack;
use crate::zip_helper;
use crate::AppState;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PatreonInstallOutcome {
    CharacterSkin(install::InstallResult),
    IsoAsset(install::AssetInstallResult),
    TexturePack(texture_pack::TexturePackInstallResult),
}

#[derive(Debug, serde::Serialize)]
pub struct PatreonInstallResult {
    pub skin_id: String,
    pub bytes: i64,
    pub outcome: PatreonInstallOutcome,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn read_index(db: &Db) -> AppResult<skin_index::SkinIndex> {
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
    Ok(serde_json::from_str(&body)?)
}

fn read_index_entry(db: &Db, skin_id: &str) -> AppResult<IndexedSkinEntry> {
    let parsed = read_index(db)?;
    parsed
        .skins
        .into_iter()
        .find(|s| s.id == skin_id)
        .ok_or_else(|| AppError::Other(format!("skin '{skin_id}' not found in index")))
}

fn resolve_creator_display(db: &Db, creator_id: &str) -> Option<String> {
    let parsed = read_index(db).ok()?;
    parsed
        .creators
        .into_iter()
        .find(|c| c.id == creator_id)
        .map(|c| c.display_name)
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
    session_cookie: &str,
    dest: &std::path::Path,
) -> AppResult<(u64, String)> {
    // Most c10.patreonusercontent.com URLs are self-authenticating via the
    // ?token-time / ?token-hash query string. But Patreon also serves some
    // attachments through cookie-protected paths — sending the session cookie
    // defensively here means a request that would otherwise come back as an
    // HTML "log in" stub returns the real binary instead.
    let resp = client
        .get(url)
        .header("Cookie", format!("session_id={session_cookie}"))
        .send()
        .await
        .map_err(|e| AppError::Other(format!("cdn http: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "cdn fetch: HTTP {} for {url}",
            resp.status()
        )));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_default();
    // Patreon's CDN serves real attachments as application/octet-stream or
    // type-specific binary mimes. If we get text/html or application/json
    // back, the URL didn't deliver the file we asked for — fail here with a
    // useful message instead of writing an HTML page to disk and tripping the
    // zip parser later.
    if content_type.starts_with("text/html")
        || content_type.starts_with("application/json")
    {
        return Err(AppError::Other(format!(
            "cdn returned non-binary content ({content_type}) for {url} — \
             the signed URL may be expired, or the post may be locked behind \
             a tier you don't currently entitle. Try refreshing the index."
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

fn is_zip_archive(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".zip") || l.ends_with(".rar") || l.ends_with(".7z")
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
        .timeout(Duration::from_secs(120))
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
    let (bytes, downloaded_sha) =
        download_to_path(&client, &signed_url, &session_cookie, &dest).await?;

    if let Some(expected) = entry.sha256.as_ref() {
        if !expected.is_empty() && !downloaded_sha.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&dest);
            return Err(AppError::Other(format!(
                "integrity check failed for {}: expected {expected}, got {downloaded_sha}",
                matched_filename
            )));
        }
    }

    let outcome = dispatch_install(&state.db, &entry, &dest, &downloaded_sha, bytes).await?;

    Ok(PatreonInstallResult {
        skin_id,
        bytes: bytes as i64,
        outcome,
    })
}

/// Bulk install report — one outcome per requested slot, plus an optional
/// global error if the post-install ISO finalize step fails.
#[derive(Debug, serde::Serialize)]
pub struct PatreonBulkInstallResult {
    pub installed: Vec<PatreonInstallResult>,
    pub failed: Vec<BulkInstallFailure>,
    /// Net per-slot ISO ops applied during the single rebuild at the end.
    pub iso_rebuilt: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct BulkInstallFailure {
    pub skin_id: String,
    pub error: String,
}

/// Bulk variant of install_patreon_skin: downloads N attachments and writes
/// their skin_files rows, reserves slots for character_skin entries in the
/// DB, then rebuilds the patched ISO ONCE at the end. Avoids the N-rebuilds
/// the loop-through-single-installs path would do.
///
/// Non-character_skin entries (stages, effects, texture packs, etc.) in the
/// list are handled via the per-entry path because they each touch a unique
/// HAL filename / install table and don't benefit from the same batching.
#[tauri::command]
pub async fn install_patreon_skins_bulk(
    state: State<'_, AppState>,
    skin_ids: Vec<String>,
) -> AppResult<PatreonBulkInstallResult> {
    if skin_ids.is_empty() {
        return Ok(PatreonBulkInstallResult {
            installed: Vec::new(),
            failed: Vec::new(),
            iso_rebuilt: false,
        });
    }

    let session_cookie = patreon::load_session_cookie(&state.db)?
        .ok_or_else(|| AppError::Other("not connected to Patreon".into()))?;
    let client = reqwest::Client::builder()
        .user_agent("the-shop/0.1")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Other(format!("reqwest: {e}")))?;

    let mut installed = Vec::new();
    let mut failed = Vec::new();
    let mut character_skin_keys: Vec<(String, String, String, u64)> = Vec::new(); // (skin_id, character_code, pack_name, bytes)

    for skin_id in &skin_ids {
        let entry = match read_index_entry(&state.db, skin_id) {
            Ok(e) => e,
            Err(e) => {
                failed.push(BulkInstallFailure {
                    skin_id: skin_id.clone(),
                    error: e.to_string(),
                });
                continue;
            }
        };

        // Non-character_skin → fall through to the per-entry dispatcher,
        // which handles texture_pack folder copies and stage/effect ISO
        // injects on its own (they each rebuild the ISO once each, but
        // they're rarely batched).
        if entry.kind != "character_skin" {
            match install_one_via_dispatch(&state.db, &client, &session_cookie, &entry).await {
                Ok(r) => installed.push(r),
                Err(e) => failed.push(BulkInstallFailure {
                    skin_id: skin_id.clone(),
                    error: e.to_string(),
                }),
            }
            continue;
        }

        // character_skin: download + register the skin_file, but DEFER the
        // ISO rebuild. We'll rebuild once at the end after all reservations.
        match download_and_register_character_skin(
            &state.db,
            &client,
            &session_cookie,
            &entry,
        )
        .await
        {
            Ok(bytes) => {
                character_skin_keys.push((
                    entry.id.clone(),
                    entry.character_code.clone(),
                    entry.id.clone(),
                    bytes,
                ));
            }
            Err(e) => failed.push(BulkInstallFailure {
                skin_id: skin_id.clone(),
                error: e.to_string(),
            }),
        }
    }

    // Reserve all character_skin slots in the DB (no ISO writes).
    let mut reservation_results: Vec<(String, u64, install::InstallResult)> = Vec::new();
    for (skin_id, character, pack_name, bytes) in &character_skin_keys {
        match install::reserve_pack_install_slots(&state.db, character, pack_name) {
            Ok((slots_installed, slots_skipped)) => {
                reservation_results.push((
                    skin_id.clone(),
                    *bytes,
                    install::InstallResult {
                        installed_slots: slots_installed,
                        skipped_slots: slots_skipped,
                        // patched path + previous slippi iso filled in
                        // after finalize, since the rebuild hasn't happened
                        // yet.
                        patched_iso_path: String::new(),
                        previous_slippi_iso: None,
                    },
                ));
            }
            Err(e) => failed.push(BulkInstallFailure {
                skin_id: skin_id.clone(),
                error: e.to_string(),
            }),
        }
    }

    // Single ISO rebuild for everything we just reserved.
    let mut iso_rebuilt = false;
    if !reservation_results.is_empty() {
        match install::finalize_iso_state(&state.db) {
            Ok((patched_path, previous)) => {
                iso_rebuilt = true;
                for (skin_id, bytes, mut r) in reservation_results.drain(..) {
                    r.patched_iso_path = patched_path.clone();
                    r.previous_slippi_iso = previous.clone();
                    installed.push(PatreonInstallResult {
                        skin_id,
                        bytes: bytes as i64,
                        outcome: PatreonInstallOutcome::CharacterSkin(r),
                    });
                }
            }
            Err(e) => {
                // ISO rebuild failed after reservations — surface as a
                // single failure so the caller knows the DB has rows that
                // aren't reflected on disk yet.
                for (skin_id, _, _) in reservation_results {
                    failed.push(BulkInstallFailure {
                        skin_id,
                        error: format!("iso rebuild failed: {e}"),
                    });
                }
            }
        }
    }

    Ok(PatreonBulkInstallResult {
        installed,
        failed,
        iso_rebuilt,
    })
}

async fn install_one_via_dispatch(
    db: &Db,
    client: &reqwest::Client,
    session_cookie: &str,
    entry: &IndexedSkinEntry,
) -> AppResult<PatreonInstallResult> {
    let metadata = fetch_post_metadata(client, session_cookie, &entry.patreon_post_id).await?;
    let (matched_filename, signed_url) =
        pick_attachment_url(&metadata, &entry.filename_in_post).ok_or_else(|| {
            AppError::Other(format!(
                "attachment '{}' not found on post {}",
                entry.filename_in_post, entry.patreon_post_id
            ))
        })?;
    let dest = paths::skins_dir()?.join(&matched_filename);
    let (bytes, downloaded_sha) =
        download_to_path(client, &signed_url, session_cookie, &dest).await?;
    if let Some(expected) = entry.sha256.as_ref() {
        if !expected.is_empty() && !downloaded_sha.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&dest);
            return Err(AppError::Other(format!(
                "integrity check failed for {}: expected {expected}, got {downloaded_sha}",
                matched_filename
            )));
        }
    }
    let outcome = dispatch_install(db, entry, &dest, &downloaded_sha, bytes).await?;
    Ok(PatreonInstallResult {
        skin_id: entry.id.clone(),
        bytes: bytes as i64,
        outcome,
    })
}

/// Download a character_skin entry's attachment, extract from zip if needed,
/// register the skin_files row, and return the byte count. Doesn't touch
/// installed_pack or the ISO — caller does those in a batch.
async fn download_and_register_character_skin(
    db: &Db,
    client: &reqwest::Client,
    session_cookie: &str,
    entry: &IndexedSkinEntry,
) -> AppResult<u64> {
    let metadata = fetch_post_metadata(client, session_cookie, &entry.patreon_post_id).await?;
    let (matched_filename, signed_url) =
        pick_attachment_url(&metadata, &entry.filename_in_post).ok_or_else(|| {
            AppError::Other(format!(
                "attachment '{}' not found on post {}",
                entry.filename_in_post, entry.patreon_post_id
            ))
        })?;
    let dest = paths::skins_dir()?.join(&matched_filename);
    let (bytes, downloaded_sha) =
        download_to_path(client, &signed_url, session_cookie, &dest).await?;
    if let Some(expected) = entry.sha256.as_ref() {
        if !expected.is_empty() && !downloaded_sha.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&dest);
            return Err(AppError::Other(format!(
                "integrity check failed for {}: expected {expected}, got {downloaded_sha}",
                matched_filename
            )));
        }
    }

    let attachment_is_zip = is_zip_archive(&entry.filename_in_post);
    let real_file: PathBuf = if attachment_is_zip {
        let extracted = paths::skins_dir()?.join(format!("{}-extracted", entry.id));
        std::fs::create_dir_all(&extracted)?;
        let inner_name = match entry.inner_filename.as_deref() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => entry.resolved_iso_target().ok_or_else(|| {
                AppError::Other(
                    "zip archive entry has no inner_filename and kind has no canonical target"
                        .into(),
                )
            })?,
        };
        let dest_inner = extracted.join(&inner_name);
        zip_helper::extract_named_file(&dest, &inner_name, &dest_inner)?;
        let _ = std::fs::remove_file(&dest);
        dest_inner
    } else {
        dest
    };

    register_skin_file_from(db, entry, &real_file, &downloaded_sha, bytes)?;
    Ok(bytes)
}

/// Routes the downloaded artifact based on entry.kind. Handles:
/// - direct character_skin -> install_pack (slot routing)
/// - direct stage/music/effect/animation/ui/item -> install_iso_asset
/// - direct texture_pack -> texture_pack::install_pack_from_dir
/// - zip-bundled variants of any of the above
async fn dispatch_install(
    db: &Db,
    entry: &IndexedSkinEntry,
    downloaded: &Path,
    sha256: &str,
    bytes: u64,
) -> AppResult<PatreonInstallOutcome> {
    let kind = entry.kind.as_str();
    let attachment_is_zip = is_zip_archive(&entry.filename_in_post);

    if kind == "texture_pack" {
        // Texture packs are always folder installs. Either the attachment is
        // a zip we extract, or it's a single file we wrap in a folder.
        let temp =
            tempfile::tempdir().map_err(|e| AppError::Other(format!("tempdir: {e}")))?;
        if attachment_is_zip {
            zip_helper::extract_all(downloaded, temp.path())?;
        } else {
            let target = temp
                .path()
                .join(downloaded.file_name().unwrap_or_else(|| std::ffi::OsStr::new("file")));
            std::fs::copy(downloaded, &target)?;
        }
        let skin_file_id =
            register_skin_file_from(db, entry, downloaded, sha256, bytes)?;
        let result = texture_pack::install_pack_from_dir(
            db,
            &entry.id,
            temp.path(),
            Some(skin_file_id),
            Some(&entry.creator_id),
            Some(&entry.display_name),
        )?;
        // texture_pack::install_pack_from_dir copied the contents into
        // Slippi's textures dir; the original zip in skins_dir is no longer
        // needed (the skin_files row points at it but won't be re-read by
        // any flow). Remove it to stop the disk-leak on repeated installs.
        let _ = std::fs::remove_file(downloaded);
        return Ok(PatreonInstallOutcome::TexturePack(result));
    }

    // ISO-inject kinds. If the attachment is a zip, extract the named inner
    // file. The extracted file lands in skins_dir/<entry.id>-extracted/ and
    // becomes the canonical source_path on the skin_files row. The downloaded
    // zip itself is then redundant — delete it after successful extraction.
    let real_file: PathBuf = if attachment_is_zip {
        let extracted = paths::skins_dir()?.join(format!("{}-extracted", entry.id));
        std::fs::create_dir_all(&extracted)?;
        let inner_name = match entry.inner_filename.as_deref() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => entry
                .resolved_iso_target()
                .ok_or_else(|| AppError::Other(
                    "zip archive entry has no inner_filename and kind has no canonical target"
                        .into(),
                ))?,
        };
        let dest = extracted.join(&inner_name);
        zip_helper::extract_named_file(downloaded, &inner_name, &dest)?;
        let _ = std::fs::remove_file(downloaded);
        dest
    } else {
        downloaded.to_path_buf()
    };

    let skin_file_id = register_skin_file_from(db, entry, &real_file, sha256, bytes)?;

    if kind == "character_skin" {
        let install_result =
            install::install_pack(db, &entry.character_code, &entry.id)?;
        return Ok(PatreonInstallOutcome::CharacterSkin(install_result));
    }

    // stage / music / effect / animation / ui / item — direct ISO inject.
    let target = entry
        .resolved_iso_target()
        .ok_or_else(|| AppError::Other(format!(
            "no iso_target_filename resolvable for kind '{kind}' entry '{}'",
            entry.id
        )))?;
    let result = install::install_iso_asset(
        db,
        skin_file_id,
        kind,
        &target,
        Some(&entry.id),
    )?;
    Ok(PatreonInstallOutcome::IsoAsset(result))
}

/// Variant of register_skin_file that accepts an arbitrary on-disk file
/// (e.g. extracted from a zip), independently of entry.filename_in_post.
fn register_skin_file_from(
    db: &Db,
    entry: &IndexedSkinEntry,
    path: &Path,
    sha256: &str,
    bytes: u64,
) -> AppResult<i64> {
    let pack_name = entry.id.clone();
    let dest_str = path.to_string_lossy().to_string();
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Other("path filename".into()))?
        .to_string();
    let creator_display = resolve_creator_display(db, &entry.creator_id);
    db.with_conn(|c| {
        c.execute(
            "INSERT INTO skin_files
               (filename, character_code, slot_code, pack_name, source_path, size_bytes, sha256, imported_at, kind, iso_target_filename, source, source_creator_id, source_creator_display)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'patreon', ?11, ?12)
             ON CONFLICT(source_path) DO UPDATE SET
               sha256 = excluded.sha256,
               size_bytes = excluded.size_bytes,
               pack_name = excluded.pack_name,
               character_code = excluded.character_code,
               slot_code = excluded.slot_code,
               kind = excluded.kind,
               iso_target_filename = excluded.iso_target_filename,
               source = excluded.source,
               source_creator_id = excluded.source_creator_id,
               source_creator_display = excluded.source_creator_display",
            rusqlite::params![
                filename,
                entry.character_code,
                entry.slot_code,
                pack_name,
                dest_str,
                bytes as i64,
                sha256,
                now_secs(),
                entry.kind,
                entry.resolved_iso_target(),
                entry.creator_id,
                creator_display,
            ],
        )?;
        let id: i64 = c.query_row(
            "SELECT id FROM skin_files WHERE source_path = ?1",
            rusqlite::params![dest_str],
            |r| r.get(0),
        )?;
        Ok(id)
    })
}

#[derive(Debug, serde::Serialize)]
pub struct CreatorStashResult {
    pub creator_id: String,
    pub creator_display: Option<String>,
    /// Total skins eligible to download (viewable + entitled, deduped by
    /// (creator, filename_in_post) — same dedup the count in
    /// AnnotatedCreator.viewable_count uses).
    pub total_eligible: usize,
    pub downloaded: usize,
    pub skipped_existing: usize,
    pub failed: Vec<BulkInstallFailure>,
}

/// Mirror of `dispatch_install` minus the install_pack / install_iso_asset
/// step. Downloads + extracts (if zip) + registers the skin_files row, but
/// does NOT mutate the patched ISO or installed_pack tables. The user gets
/// the bytes on disk so they can install later — handy for "I'm cancelling
/// my Patreon sub but want to keep these files."
async fn stash_one(
    db: &Db,
    client: &reqwest::Client,
    session_cookie: &str,
    entry: &IndexedSkinEntry,
) -> AppResult<u64> {
    let metadata = fetch_post_metadata(client, session_cookie, &entry.patreon_post_id).await?;
    let (matched_filename, signed_url) =
        pick_attachment_url(&metadata, &entry.filename_in_post).ok_or_else(|| {
            AppError::Other(format!(
                "attachment '{}' not found on post {}",
                entry.filename_in_post, entry.patreon_post_id
            ))
        })?;

    let dest = paths::skins_dir()?.join(&matched_filename);
    let (bytes, downloaded_sha) =
        download_to_path(client, &signed_url, session_cookie, &dest).await?;
    if let Some(expected) = entry.sha256.as_ref() {
        if !expected.is_empty() && !downloaded_sha.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&dest);
            return Err(AppError::Other(format!(
                "integrity check failed for {}: expected {expected}, got {downloaded_sha}",
                matched_filename
            )));
        }
    }

    // Match dispatch_install's on-disk shape: zips get extracted into
    // `skins_dir/<entry.id>-extracted/<inner>` and the original archive
    // is removed. That way a later install attempt finds the file
    // exactly where the install path expects it (via skin_files.source_path).
    let attachment_is_zip = is_zip_archive(&entry.filename_in_post);
    let real_file: PathBuf = if attachment_is_zip {
        let extracted = paths::skins_dir()?.join(format!("{}-extracted", entry.id));
        std::fs::create_dir_all(&extracted)?;
        let inner_name = match entry.inner_filename.as_deref() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => entry
                .resolved_iso_target()
                .ok_or_else(|| AppError::Other(
                    "zip archive entry has no inner_filename and kind has no canonical target"
                        .into(),
                ))?,
        };
        let dest_inner = extracted.join(&inner_name);
        zip_helper::extract_named_file(&dest, &inner_name, &dest_inner)?;
        let _ = std::fs::remove_file(&dest);
        dest_inner
    } else {
        dest
    };

    register_skin_file_from(db, entry, &real_file, &downloaded_sha, bytes)?;
    Ok(bytes)
}

/// Bulk-download every skin from a single creator that the user can
/// view+install but doesn't already have cached locally. Files land in
/// `paths::skins_dir()` exactly where install would put them, so a
/// subsequent install attempt is just the install_pack / install_iso_asset
/// step — no re-download. Use case: "I'm not going to be subbed forever,
/// pull everything I have access to now."
#[tauri::command]
pub async fn download_all_from_creator(
    state: State<'_, AppState>,
    creator_id: String,
) -> AppResult<CreatorStashResult> {
    let session_cookie = patreon::load_session_cookie(&state.db)?
        .ok_or_else(|| AppError::Other("not connected to Patreon".into()))?;

    let index = read_index(&state.db)?;
    let creator = index
        .creators
        .iter()
        .find(|c| c.id == creator_id);
    let creator_display = creator.map(|c| c.display_name.clone());

    // Build the eligible set: this creator's skins where the post is
    // viewable (per Patreon's current_user_can_view, surfaced via
    // viewable_posts). Dedup by filename_in_post — a 4-color pack
    // shares one archive, no point downloading it 4 times.
    let viewable = patreon::read_viewable_posts(&state.db).unwrap_or_default();
    let already_stashed = skin_index::read_stashed_skin_ids(&state.db).unwrap_or_default();
    let mut seen_files: std::collections::HashSet<String> = Default::default();
    let mut eligible: Vec<IndexedSkinEntry> = Vec::new();
    for skin in &index.skins {
        if skin.creator_id != creator_id {
            continue;
        }
        if !viewable.contains(&skin.patreon_post_id) {
            continue;
        }
        if !seen_files.insert(skin.filename_in_post.clone()) {
            continue;
        }
        eligible.push(skin.clone());
    }

    let total_eligible = eligible.len();
    let mut downloaded = 0;
    let mut skipped_existing = 0;
    let mut failed: Vec<BulkInstallFailure> = Vec::new();

    let client = reqwest::Client::builder()
        .user_agent("the-shop/0.1")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Other(format!("reqwest: {e}")))?;

    for entry in &eligible {
        if already_stashed.contains(&entry.id) {
            skipped_existing += 1;
            continue;
        }
        match stash_one(&state.db, &client, &session_cookie, entry).await {
            Ok(_) => downloaded += 1,
            Err(e) => failed.push(BulkInstallFailure {
                skin_id: entry.id.clone(),
                error: e.to_string(),
            }),
        }
    }

    Ok(CreatorStashResult {
        creator_id,
        creator_display,
        total_eligible,
        downloaded,
        skipped_existing,
        failed,
    })
}
