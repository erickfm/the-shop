use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::manifest;
use crate::paths;
use crate::slot_codes;
use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub struct SkinFileRow {
    pub id: i64,
    pub filename: String,
    pub character_code: String,
    pub slot_code: String,
    pub pack_name: Option<String>,
    pub source_path: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub source: String,
    pub source_creator_id: Option<String>,
    pub source_creator_display: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PackSlot {
    pub slot_code: String,
    pub slot_display: String,
    pub skin_file_id: i64,
    pub source_path: String,
    pub installed: bool,
    pub actual_slot_code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SkinPack {
    pub character_code: String,
    pub character_display: String,
    pub pack_name: String,
    pub slots: Vec<PackSlot>,
    pub fully_installed: bool,
    pub partially_installed: bool,
    /// "manual" or "patreon" — derived from the underlying skin_files rows.
    /// If a pack somehow mixes sources (shouldn't happen in practice), we
    /// report "patreon" if any slot was sourced from Patreon.
    pub source: String,
    pub source_creator_id: Option<String>,
    pub source_creator_display: Option<String>,
    /// Preview image url, looked up in the cached skin index by
    /// matching one of the pack's slot pack_names against
    /// IndexedSkinEntry.id. Lets the cog menu's "my stuff" cards
    /// render the same hero image users see on the storefront. None
    /// for manually-imported packs (no index entry to look up) and
    /// for patreon entries the user installed before we knew about
    /// the source post.
    #[serde(default)]
    pub preview_url: Option<String>,
    /// Format flavor (animelee / vanilla / null) — also pulled from
    /// the index entry. Surfaces the same blue "animelee" pill the
    /// storefront uses so a user can tell at a glance which version
    /// of a creator's skin they have installed.
    #[serde(default)]
    pub format: Option<String>,
    /// Pack-level display name from the index — e.g. "Frieza Mewtwo"
    /// rather than the per-slot variant title. Falls back to the
    /// individual entry's display_name (which is what skin_files
    /// stores) when missing. Empty for manual imports.
    #[serde(default)]
    pub pack_display_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportReport {
    pub imported: usize,
    pub skipped_duplicates: usize,
    pub failed: Vec<ImportFailure>,
}

#[derive(Debug, Serialize)]
pub struct ImportFailure {
    pub filename: String,
    pub error: String,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hash_file(path: &Path) -> AppResult<(String, u64)> {
    let bytes = fs::read(path)?;
    let len = bytes.len() as u64;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok((hex::encode(h.finalize()), len))
}

pub fn import_files(
    db: &Db,
    paths_in: &[PathBuf],
    hsd_binary: Option<&Path>,
) -> AppResult<ImportReport> {
    let dest_dir = paths::skins_dir()?;
    let mut imported = 0;
    let mut skipped_duplicates = 0;
    let mut failed = Vec::new();

    for src in paths_in {
        let filename = match src.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => {
                failed.push(ImportFailure {
                    filename: src.display().to_string(),
                    error: "could not read filename".into(),
                });
                continue;
            }
        };

        // Identify against the file itself (authoritative) before doing any
        // filesystem work, so we reject stages/effects/common/items files with
        // a useful error instead of "could not parse filename".
        let parsed = match manifest::identify(hsd_binary, src) {
            Ok(p) => p,
            Err(_e) => {
                // Character-skin parse failed — try the ISO-asset filename
                // pattern (effects, stages, UI, items, animations) before
                // giving up.
                if let Some(iso) = manifest::parse_iso_asset_filename(&filename) {
                    match import_iso_asset_file(db, src, &filename, &iso) {
                        Ok(true) => imported += 1,
                        Ok(false) => skipped_duplicates += 1,
                        Err(e) => failed.push(ImportFailure {
                            filename: filename.clone(),
                            error: format!("ISO asset import: {e}"),
                        }),
                    }
                    continue;
                }
                failed.push(ImportFailure {
                    filename,
                    error: _e.to_string(),
                });
                continue;
            }
        };

        // Re-derive the destination filename from the *identified* character
        // code so we self-correct mislabeled files (e.g. one named PlFoo that
        // identifies as Falco lands as PlFc...).
        let canonical_filename = canonical_filename(&filename, &parsed);
        let dest = dest_dir.join(&canonical_filename);

        if dest != *src {
            if let Err(e) = fs::copy(src, &dest) {
                failed.push(ImportFailure {
                    filename,
                    error: format!("copy failed: {e}"),
                });
                continue;
            }
        }

        let (sha, size) = match hash_file(&dest) {
            Ok(v) => v,
            Err(e) => {
                failed.push(ImportFailure {
                    filename,
                    error: format!("hash failed: {e}"),
                });
                continue;
            }
        };

        let filename = canonical_filename;
        let dest_str = dest.to_string_lossy().to_string();

        let inserted = db.with_conn(|c| {
            let n = c.execute(
                "INSERT INTO skin_files
                   (filename, character_code, slot_code, pack_name, source_path, size_bytes, sha256, imported_at, source, source_creator_id, source_creator_display)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'manual', NULL, NULL)
                 ON CONFLICT(source_path) DO UPDATE SET
                   sha256 = excluded.sha256,
                   size_bytes = excluded.size_bytes",
                params![
                    filename,
                    parsed.character_code,
                    parsed.slot_code,
                    parsed.pack_name,
                    dest_str,
                    size as i64,
                    sha,
                    now_secs(),
                ],
            )?;
            Ok(n)
        })?;

        if inserted > 0 {
            imported += 1;
        } else {
            skipped_duplicates += 1;
        }
    }

    Ok(ImportReport {
        imported,
        skipped_duplicates,
        failed,
    })
}

#[derive(Debug, Serialize)]
pub struct DeletePackReport {
    pub character_code: String,
    pub pack_name: String,
    pub files_removed: usize,
    pub uninstalled: bool,
}

#[derive(Debug, Serialize)]
pub struct BulkDeleteReport {
    pub packs_removed: usize,
    pub files_removed: usize,
    pub uninstalled_any: bool,
}

/// Fully remove a pack: uninstalls it from the ISO if installed, deletes its
/// rows from skin_files, and removes the underlying on-disk files. The
/// inverse of "+ Import .dat files" for manual entries; for Patreon entries
/// it's a "you can re-download from Browse anytime" remove.
pub fn delete_pack(
    db: &Db,
    character_code: &str,
    pack_name: &str,
) -> AppResult<DeletePackReport> {
    // First uninstall if installed — this rewrites the patched ISO without
    // the pack's slots, so the on-disk skins_dir files become safe to remove.
    let was_installed = db.with_conn(|c| {
        let n: i64 = c.query_row(
            "SELECT COUNT(*) FROM installed_pack WHERE character_code = ?1 AND pack_name = ?2",
            params![character_code, pack_name],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    })?;
    if was_installed {
        crate::install::uninstall_pack(db, character_code, pack_name)?;
    }

    let source_paths: Vec<String> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT source_path FROM skin_files WHERE character_code = ?1 AND pack_name = ?2",
        )?;
        let mapped =
            stmt.query_map(params![character_code, pack_name], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    let mut removed = 0usize;
    for p in &source_paths {
        if fs::remove_file(p).is_ok() {
            removed += 1;
        }
        // Best-effort: a sibling -extracted/ directory may exist for
        // zip-bundled imports; we don't track it explicitly, but if it sits
        // next to the file we extracted, leave it — it'll get GC'd by reset.
    }

    db.with_conn(|c| {
        c.execute(
            "DELETE FROM skin_files WHERE character_code = ?1 AND pack_name = ?2",
            params![character_code, pack_name],
        )?;
        Ok(())
    })?;

    Ok(DeletePackReport {
        character_code: character_code.to_string(),
        pack_name: pack_name.to_string(),
        files_removed: removed,
        uninstalled: was_installed,
    })
}

/// Import a single non-character_skin file (effect / stage / UI / item /
/// animation) into the library. Copies to skins_dir under its canonical HAL
/// name (preserving the modder's `-Variant` suffix so distinct uploads
/// don't overwrite each other), inserts a skin_files row tagged with the
/// detected `kind` and `iso_target_filename`. Returns true on insert,
/// false if the row already existed (duplicate source_path).
fn import_iso_asset_file(
    db: &Db,
    src: &Path,
    filename: &str,
    parsed: &manifest::ParsedIsoAsset,
) -> AppResult<bool> {
    let dest_dir = paths::skins_dir()?;
    let dest = dest_dir.join(filename);

    if dest != src {
        fs::copy(src, &dest).map_err(|e| AppError::Io(format!("copy: {e}")))?;
    }

    let (sha, size) = hash_file(&dest)?;
    let dest_str = dest.to_string_lossy().to_string();

    // pack_name uniquely identifies this *imported* asset within a kind.
    // Use the variant name from the filename if present, else the canonical
    // HAL name. Two manual imports of differently-suffixed `EfFxData-X.dat`
    // / `EfFxData-Y.dat` get distinct rows; reimporting the same file is a
    // no-op (source_path is UNIQUE).
    let pack = parsed
        .pack_name
        .clone()
        .unwrap_or_else(|| parsed.iso_target_filename.clone());

    let inserted = db.with_conn(|c| {
        let n = c.execute(
            "INSERT INTO skin_files
               (filename, character_code, slot_code, pack_name, source_path, size_bytes, sha256, imported_at, kind, iso_target_filename, source, source_creator_id, source_creator_display)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'manual', NULL, NULL)
             ON CONFLICT(source_path) DO UPDATE SET
               sha256 = excluded.sha256,
               size_bytes = excluded.size_bytes",
            params![
                filename,
                parsed.character_code,
                "",
                pack,
                dest_str,
                size as i64,
                sha,
                now_secs(),
                parsed.kind,
                parsed.iso_target_filename,
            ],
        )?;
        Ok(n > 0)
    })?;
    Ok(inserted)
}

#[derive(Debug, Serialize)]
pub struct IsoAssetRow {
    pub id: i64,
    pub filename: String,
    pub kind: String,
    pub iso_target_filename: String,
    pub character_code: String,
    pub pack_name: String,
    pub source: String,
    pub source_creator_display: Option<String>,
    pub installed: bool,
    pub source_path: String,
    pub size_bytes: i64,
}

/// All ISO-asset rows in skin_files (kind != 'character_skin'), with their
/// install state derived from installed_iso_asset.
pub fn list_iso_assets(db: &Db) -> AppResult<Vec<IsoAssetRow>> {
    db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT sf.id, sf.filename, sf.kind, sf.iso_target_filename,
                    sf.character_code, sf.pack_name, sf.source,
                    sf.source_creator_display, sf.source_path, sf.size_bytes,
                    iia.iso_target_filename IS NOT NULL AS installed
             FROM skin_files sf
             LEFT JOIN installed_iso_asset iia
               ON iia.iso_target_filename = sf.iso_target_filename
              AND iia.source_skin_file_id = sf.id
             WHERE sf.kind != 'character_skin'
               AND sf.iso_target_filename IS NOT NULL
             ORDER BY sf.kind, sf.filename",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(IsoAssetRow {
                id: r.get(0)?,
                filename: r.get(1)?,
                kind: r.get(2)?,
                iso_target_filename: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                character_code: r.get::<_, String>(4)?,
                pack_name: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                source: r.get(6)?,
                source_creator_display: r.get::<_, Option<String>>(7)?,
                source_path: r.get(8)?,
                size_bytes: r.get(9)?,
                installed: r.get::<_, i64>(10)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

/// Delete an ISO asset from the library: uninstalls if installed, removes
/// the skin_files row, and deletes the on-disk file.
pub fn delete_iso_asset(db: &Db, skin_file_id: i64) -> AppResult<()> {
    let row: Option<(String, Option<String>)> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT source_path, iso_target_filename FROM skin_files WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![skin_file_id])?;
        if let Some(r) = rows.next()? {
            Ok(Some((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
        } else {
            Ok(None)
        }
    })?;

    let Some((source_path, iso_target)) = row else {
        return Ok(());
    };

    if let Some(target) = iso_target.as_deref() {
        let installed: bool = db.with_conn(|c| {
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM installed_iso_asset
                 WHERE iso_target_filename = ?1 AND source_skin_file_id = ?2",
                params![target, skin_file_id],
                |r| r.get(0),
            )?;
            Ok(n > 0)
        })?;
        if installed {
            crate::install::uninstall_iso_asset(db, target)?;
        }
    }

    let _ = fs::remove_file(&source_path);
    db.with_conn(|c| {
        c.execute("DELETE FROM skin_files WHERE id = ?1", params![skin_file_id])?;
        Ok(())
    })?;
    Ok(())
}

/// Bulk variant of `delete_pack` — removes every pack matching the source
/// filter ("manual", "patreon", or None for all) in one shot, then rebuilds
/// the patched ISO exactly once at the end. Avoids the N-rebuilds problem
/// you'd hit by looping `delete_pack` from the frontend.
pub fn delete_packs_bulk(db: &Db, source_filter: Option<&str>) -> AppResult<BulkDeleteReport> {
    let rows: Vec<(String, String, String, Option<String>)> = db.with_conn(|c| {
        let (sql, params_vec): (&str, Vec<String>) = match source_filter {
            Some(s) => (
                "SELECT id, character_code, source_path, pack_name FROM skin_files
                 WHERE pack_name IS NOT NULL AND source = ?1",
                vec![s.to_string()],
            ),
            None => (
                "SELECT id, character_code, source_path, pack_name FROM skin_files
                 WHERE pack_name IS NOT NULL",
                vec![],
            ),
        };
        let mut stmt = c.prepare(sql)?;
        let mapped = stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?.to_string(),
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    if rows.is_empty() {
        return Ok(BulkDeleteReport {
            packs_removed: 0,
            files_removed: 0,
            uninstalled_any: false,
        });
    }

    let pack_keys: std::collections::HashSet<(String, String)> = rows
        .iter()
        .filter_map(|(_, ch, _, pn)| pn.as_ref().map(|p| (ch.clone(), p.clone())))
        .collect();

    let uninstalled_any = db.with_conn(|c| {
        let mut any = false;
        for (ch, pn) in &pack_keys {
            let n = c.execute(
                "DELETE FROM installed_pack WHERE character_code = ?1 AND pack_name = ?2",
                params![ch, pn],
            )?;
            if n > 0 {
                any = true;
            }
        }
        Ok(any)
    })?;

    let mut files_removed = 0usize;
    for (_, _, source_path, _) in &rows {
        if fs::remove_file(source_path).is_ok() {
            files_removed += 1;
        }
    }

    db.with_conn(|c| {
        for (ch, pn) in &pack_keys {
            c.execute(
                "DELETE FROM skin_files WHERE character_code = ?1 AND pack_name = ?2",
                params![ch, pn],
            )?;
        }
        Ok(())
    })?;

    if uninstalled_any {
        crate::install::refresh_patched_iso(db)?;
    }

    Ok(BulkDeleteReport {
        packs_removed: pack_keys.len(),
        files_removed,
        uninstalled_any,
    })
}

/// Bulk-uninstall variant of `delete_packs_bulk` that does NOT touch
/// the on-disk file or the skin_files row — only clears installed_pack
/// rows and rebuilds the patched iso once. Used by the "uninstall all"
/// section button so a user can roll back a section without losing
/// the underlying files (those still reinstall instantly via the
/// local-cache install path). For the destructive
/// "delete-from-disk" path, callers should use `delete_packs_bulk`.
pub fn uninstall_packs_bulk(
    db: &Db,
    source_filter: Option<&str>,
) -> AppResult<BulkDeleteReport> {
    let rows: Vec<(String, String, Option<String>)> = db.with_conn(|c| {
        let (sql, params_vec): (&str, Vec<String>) = match source_filter {
            Some(s) => (
                "SELECT id, character_code, pack_name FROM skin_files
                 WHERE pack_name IS NOT NULL AND source = ?1",
                vec![s.to_string()],
            ),
            None => (
                "SELECT id, character_code, pack_name FROM skin_files
                 WHERE pack_name IS NOT NULL",
                vec![],
            ),
        };
        let mut stmt = c.prepare(sql)?;
        let mapped = stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?.to_string(),
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    if rows.is_empty() {
        return Ok(BulkDeleteReport {
            packs_removed: 0,
            files_removed: 0,
            uninstalled_any: false,
        });
    }

    let pack_keys: std::collections::HashSet<(String, String)> = rows
        .iter()
        .filter_map(|(_, ch, pn)| pn.as_ref().map(|p| (ch.clone(), p.clone())))
        .collect();

    let uninstalled_any = db.with_conn(|c| {
        let mut any = false;
        for (ch, pn) in &pack_keys {
            let n = c.execute(
                "DELETE FROM installed_pack WHERE character_code = ?1 AND pack_name = ?2",
                params![ch, pn],
            )?;
            if n > 0 {
                any = true;
            }
        }
        Ok(any)
    })?;

    if uninstalled_any {
        crate::install::refresh_patched_iso(db)?;
    }

    Ok(BulkDeleteReport {
        packs_removed: pack_keys.len(),
        files_removed: 0,
        uninstalled_any,
    })
}

/// If the file's identified character disagrees with what its filename
/// implies, rewrite the filename to match the identified character. This makes
/// the on-disk name + DB row a faithful reflection of the file's contents.
fn canonical_filename(original: &str, parsed: &manifest::ParsedSkinFilename) -> String {
    let canonical_prefix = format!("Pl{}{}", parsed.character_code, parsed.slot_code);
    if original.starts_with(&canonical_prefix) {
        return original.to_string();
    }
    if let Some(stem) = original.strip_suffix(".dat").or_else(|| original.strip_suffix(".usd")) {
        if let Some(rest) = stem.strip_prefix("Pl") {
            // skip 2 chars of (wrong) char code and the slot+digits
            let suffix_start = 2 + parsed.slot_code.len();
            if rest.len() >= suffix_start {
                let trailing = &rest[suffix_start..];
                return format!("{canonical_prefix}{trailing}.dat");
            }
        }
    }
    format!("{canonical_prefix}.dat")
}

pub fn list_packs(db: &Db) -> AppResult<Vec<SkinPack>> {
    // Scope to character_skin rows only — non-character ISO assets
    // (stages, effects, ui, items) live in the same skin_files table
    // but have empty character_code, which slot_codes::lookup rejects.
    // Including them used to surface as `UnknownCharacter("")` and
    // erase the entire pack list every time a user installed a stage.
    // Those non-character rows are surfaced separately via
    // list_iso_assets and rendered as AssetRows in the cog menu.
    let rows: Vec<SkinFileRow> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, filename, character_code, slot_code, pack_name, source_path, size_bytes, sha256,
                    source, source_creator_id, source_creator_display
             FROM skin_files
             WHERE pack_name IS NOT NULL
               AND kind = 'character_skin'
               AND character_code != ''
             ORDER BY character_code, pack_name, slot_code",
        )?;
        let mapped = stmt.query_map([], |r| {
            Ok(SkinFileRow {
                id: r.get(0)?,
                filename: r.get(1)?,
                character_code: r.get(2)?,
                slot_code: r.get(3)?,
                pack_name: r.get::<_, Option<String>>(4)?,
                source_path: r.get(5)?,
                size_bytes: r.get(6)?,
                sha256: r.get(7)?,
                source: r.get(8)?,
                source_creator_id: r.get::<_, Option<String>>(9)?,
                source_creator_display: r.get::<_, Option<String>>(10)?,
            })
        })?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    let installed: Vec<(String, String, Option<String>, Option<String>)> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT character_code, slot_code, pack_name, actual_slot_code FROM installed_pack",
        )?;
        let mapped = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    let installed_lookup = |character: &str, slot: &str, pack: &str| -> Option<Option<String>> {
        installed
            .iter()
            .find(|(c, s, p, _)| c == character && s == slot && p.as_deref() == Some(pack))
            .map(|(_, _, _, actual)| actual.clone())
    };

    // One-time read of the cached skin index so we can enrich each
    // patreon-installed pack with its preview image, format, and
    // pack-level display name. The cog-menu cards otherwise look
    // nothing like the storefront cards (just a CharacterBadge
    // placeholder), and users get confused that they "lost" the
    // visual on install.
    let index_by_entry_id: std::collections::HashMap<String, IndexedEntryMeta> = db
        .with_conn(|c| {
            let json: Option<String> = c
                .query_row(
                    "SELECT json FROM skin_index_cache WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .ok();
            let mut map = std::collections::HashMap::new();
            if let Some(s) = json {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    if let Some(arr) = v.get("skins").and_then(|s| s.as_array()) {
                        for skin in arr {
                            let id = skin
                                .get("id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            if let Some(id) = id {
                                map.insert(
                                    id,
                                    IndexedEntryMeta {
                                        preview_url: skin
                                            .get("preview_url")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string()),
                                        format: skin
                                            .get("format")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string()),
                                        pack_display_name: skin
                                            .get("pack_display_name")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string()),
                                    },
                                );
                            }
                        }
                    }
                }
            }
            Ok(map)
        })
        .unwrap_or_default();

    let mut grouped: std::collections::BTreeMap<(String, String), Vec<SkinFileRow>> =
        std::collections::BTreeMap::new();

    for r in rows {
        let pack = r.pack_name.clone().unwrap_or_default();
        grouped
            .entry((r.character_code.clone(), pack))
            .or_default()
            .push(r);
    }

    let mut packs = Vec::new();
    for ((char_code, pack_name), files) in grouped {
        let char_def = slot_codes::lookup(&char_code)
            .ok_or_else(|| AppError::UnknownCharacter(char_code.clone()))?;

        let any_patreon = files.iter().any(|f| f.source == "patreon");
        let pack_source = if any_patreon { "patreon" } else { "manual" }.to_string();
        let pack_creator_id = files
            .iter()
            .find(|f| f.source == "patreon")
            .and_then(|f| f.source_creator_id.clone());
        let pack_creator_display = files
            .iter()
            .find(|f| f.source == "patreon")
            .and_then(|f| f.source_creator_display.clone());

        let mut slots: Vec<PackSlot> = files
            .into_iter()
            .map(|f| {
                let slot_disp = slot_codes::slot_display(&char_code, slot_codes::slot_base(&f.slot_code))
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| "?".to_string());
                let lookup = installed_lookup(&char_code, &f.slot_code, &pack_name);
                let installed = lookup.is_some();
                let actual_slot_code = lookup.flatten();
                PackSlot {
                    slot_code: f.slot_code,
                    slot_display: slot_disp,
                    skin_file_id: f.id,
                    source_path: f.source_path,
                    installed,
                    actual_slot_code,
                }
            })
            .collect();
        slots.sort_by(|a, b| a.slot_code.cmp(&b.slot_code));
        let total = slots.len();
        let installed_count = slots.iter().filter(|s| s.installed).count();
        // Look up the matching IndexedSkinEntry via pack_name (which
        // equals entry.id for patreon installs). Any of the pack's
        // slot-level pack_names points back into the index — they all
        // share preview_url / format / pack_display_name at the
        // index's pack_id level. We use `pack_name` directly here:
        // for patreon character_skin packs, install_pack registers
        // skin_files.pack_name as entry.id.
        let meta = index_by_entry_id.get(&pack_name).cloned();
        packs.push(SkinPack {
            character_code: char_code,
            character_display: char_def.display.to_string(),
            pack_name,
            slots,
            fully_installed: installed_count == total && total > 0,
            partially_installed: installed_count > 0 && installed_count < total,
            source: pack_source,
            source_creator_id: pack_creator_id,
            source_creator_display: pack_creator_display,
            preview_url: meta.as_ref().and_then(|m| m.preview_url.clone()),
            format: meta.as_ref().and_then(|m| m.format.clone()),
            pack_display_name: meta.as_ref().and_then(|m| m.pack_display_name.clone()),
        });
    }

    Ok(packs)
}

#[derive(Debug, Clone)]
struct IndexedEntryMeta {
    preview_url: Option<String>,
    format: Option<String>,
    pack_display_name: Option<String>,
}
