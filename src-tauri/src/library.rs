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

pub fn import_files(db: &Db, paths_in: &[PathBuf]) -> AppResult<ImportReport> {
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

        if let Err(e) = manifest::parse(&filename) {
            failed.push(ImportFailure {
                filename,
                error: e.to_string(),
            });
            continue;
        }

        let dest = dest_dir.join(&filename);

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

        let parsed = manifest::parse(&filename)?;
        let dest_str = dest.to_string_lossy().to_string();

        let inserted = db.with_conn(|c| {
            let n = c.execute(
                "INSERT INTO skin_files
                   (filename, character_code, slot_code, pack_name, source_path, size_bytes, sha256, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
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

pub fn list_packs(db: &Db) -> AppResult<Vec<SkinPack>> {
    let rows: Vec<SkinFileRow> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, filename, character_code, slot_code, pack_name, source_path, size_bytes, sha256
             FROM skin_files
             WHERE pack_name IS NOT NULL
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
        packs.push(SkinPack {
            character_code: char_code,
            character_display: char_def.display.to_string(),
            pack_name,
            slots,
            fully_installed: installed_count == total && total > 0,
            partially_installed: installed_count > 0 && installed_count < total,
        });
    }

    Ok(packs)
}
