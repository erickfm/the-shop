use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::iso;
use crate::iso_patch;
use crate::paths;
use crate::slippi_config;
use crate::slot_codes;
use rusqlite::params;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const ORIGINAL_ISO_KEY: &str = "original_slippi_iso_path";
const VANILLA_ISO_KEY: &str = "vanilla_iso_path";

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn working_iso(db: &Db) -> AppResult<PathBuf> {
    let s = db
        .get_setting(VANILLA_ISO_KEY)?
        .ok_or(AppError::IsoNotConfigured)?;
    let p = PathBuf::from(s);
    if !p.exists() {
        return Err(AppError::IsoMissing(p.display().to_string()));
    }
    Ok(p)
}

#[derive(Debug, serde::Serialize)]
pub struct SkippedSlot {
    pub slot_code: String,
    pub reason: String,
}

#[derive(Debug, serde::Serialize)]
pub struct InstalledSlot {
    pub requested_slot_code: String,
    pub actual_slot_code: String,
    pub routed: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct InstallResult {
    pub installed_slots: Vec<InstalledSlot>,
    pub skipped_slots: Vec<SkippedSlot>,
    pub patched_iso_path: String,
    pub previous_slippi_iso: Option<String>,
}

pub fn install_pack(db: &Db, character: &str, pack_name: &str) -> AppResult<InstallResult> {
    let working = working_iso(db)?;

    let pack_files: Vec<(i64, String, String)> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT id, slot_code, source_path
             FROM skin_files
             WHERE character_code = ?1 AND pack_name = ?2",
        )?;
        let mapped = stmt.query_map(params![character, pack_name], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    if pack_files.is_empty() {
        return Err(AppError::Other(format!(
            "no files for {character}/{pack_name}"
        )));
    }

    for (_id, slot_code, _src) in &pack_files {
        let conflict: Option<Option<String>> = db.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT pack_name FROM installed_pack
                 WHERE character_code = ?1 AND slot_code = ?2",
            )?;
            let mut rows = stmt.query(params![character, slot_code])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row.get::<_, Option<String>>(0)?))
            } else {
                Ok(None)
            }
        })?;
        if let Some(existing) = conflict {
            if existing.as_deref() != Some(pack_name) {
                return Err(AppError::SlotConflict {
                    character: character.into(),
                    slot: slot_code.clone(),
                    existing: existing.unwrap_or_else(|| "(unnamed)".into()),
                });
            }
        }
    }

    let working_fst = iso_patch::list_root_files(&working)?;
    let occupied: std::collections::HashSet<String> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT COALESCE(actual_slot_code, slot_code) FROM installed_pack
             WHERE character_code = ?1",
        )?;
        let mapped = stmt.query_map(params![character], |r| r.get::<_, String>(0))?;
        let mut out = std::collections::HashSet::new();
        for r in mapped {
            out.insert(r?);
        }
        Ok(out)
    })?;

    let mut to_apply: Vec<(i64, String, String, PathBuf)> = Vec::new();
    let mut skipped = Vec::new();
    let mut occupied_running = occupied.clone();
    for (id, requested_slot, source_path) in &pack_files {
        match find_target_slot(character, requested_slot, &working_fst, &occupied_running) {
            Ok(target) => {
                occupied_running.insert(target.actual_slot.clone());
                to_apply.push((
                    *id,
                    requested_slot.clone(),
                    target.actual_slot,
                    PathBuf::from(source_path),
                ));
            }
            Err(e) => skipped.push(SkippedSlot {
                slot_code: requested_slot.clone(),
                reason: e.to_string(),
            }),
        }
    }

    let mut ops_targets: Vec<(String, PathBuf)> = to_apply
        .iter()
        .map(|(_, _r, actual, src)| (format!("Pl{character}{actual}.dat"), src.clone()))
        .collect();

    let existing_installs: Vec<(String, String, String, String)> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT ip.character_code, COALESCE(ip.actual_slot_code, ip.slot_code), ip.pack_name, sf.source_path
             FROM installed_pack ip
             JOIN skin_files sf ON sf.id = ip.source_skin_file_id",
        )?;
        let mapped = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    let new_targets: std::collections::HashSet<String> = ops_targets
        .iter()
        .map(|(t, _)| t.clone())
        .collect();

    for (ch, actual, _pack, src) in &existing_installs {
        let target_filename = format!("Pl{ch}{actual}.dat");
        if new_targets.contains(&target_filename) {
            continue;
        }
        ops_targets.push((target_filename, PathBuf::from(src)));
    }

    let patched = iso::rebuild_patched_iso(&working)?;
    if !ops_targets.is_empty() {
        let ops: Vec<gc_fst::IsoOp> = ops_targets
            .iter()
            .map(|(t, s)| gc_fst::IsoOp::Insert {
                iso_path: Path::new(t.as_str()),
                input_path: s.as_path(),
            })
            .collect();
        gc_fst::operate_on_iso(&patched, &ops).map_err(|e| match e {
            gc_fst::OperateISOError::TOCTooLarge => AppError::IsoWrite(
                "The working ISO is too tightly packed for this many file changes. \
                 If you have m-ex applied, revert it (Settings → Revert m-ex) and try again. \
                 Vanilla ISOs have FST slack; the m-ex base does not."
                    .into(),
            ),
            other => AppError::IsoWrite(format!("operate_on_iso({} ops): {other:?}", ops_targets.len())),
        })?;
    }

    let mut installed = Vec::new();
    for (id, requested, actual, _src) in &to_apply {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO installed_pack
                   (character_code, slot_code, pack_name, source_skin_file_id, installed_at, actual_slot_code)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(character_code, slot_code) DO UPDATE SET
                   pack_name = excluded.pack_name,
                   source_skin_file_id = excluded.source_skin_file_id,
                   installed_at = excluded.installed_at,
                   actual_slot_code = excluded.actual_slot_code",
                params![character, requested, pack_name, id, now_secs(), actual],
            )?;
            Ok(())
        })?;
        installed.push(InstalledSlot {
            requested_slot_code: requested.clone(),
            actual_slot_code: actual.clone(),
            routed: requested != actual,
        });
    }

    let previous_slippi_iso = match slippi_config::read_iso_path()? {
        Some(prev) if prev != patched.display().to_string() => {
            db.set_setting(ORIGINAL_ISO_KEY, &prev)?;
            let _ = slippi_config::write_iso_path(&patched.display().to_string())?;
            Some(prev)
        }
        Some(prev) => Some(prev),
        None => None,
    };

    Ok(InstallResult {
        installed_slots: installed,
        skipped_slots: skipped,
        patched_iso_path: patched.display().to_string(),
        previous_slippi_iso,
    })
}

struct TargetSlot {
    actual_slot: String,
}

fn find_target_slot(
    character: &str,
    requested_slot: &str,
    working_fst: &std::collections::HashMap<String, iso_patch::FstEntry>,
    occupied: &std::collections::HashSet<String>,
) -> AppResult<TargetSlot> {
    let direct_filename = format!("Pl{character}{requested_slot}.dat");
    if working_fst.contains_key(&direct_filename) && !occupied.contains(requested_slot) {
        return Ok(TargetSlot {
            actual_slot: requested_slot.to_string(),
        });
    }

    let base = slot_codes::slot_base(requested_slot);
    for ext_slot in slot_codes::extended_slot_codes_for_base(base) {
        if occupied.contains(&ext_slot) {
            continue;
        }
        let fname = format!("Pl{character}{ext_slot}.dat");
        if working_fst.contains_key(&fname) {
            return Ok(TargetSlot {
                actual_slot: ext_slot,
            });
        }
    }

    if !working_fst.contains_key(&direct_filename) {
        return Err(AppError::Other(format!(
            "{direct_filename} not present in this ISO — apply m-ex template (Settings → Apply m-ex) for extended slot support"
        )));
    }
    Err(AppError::Other(format!(
        "{requested_slot}: vanilla slot is occupied and no free extended slot — uninstall something first or apply m-ex for more slots"
    )))
}

#[derive(Debug, serde::Serialize)]
pub struct UninstallResult {
    pub restored_slots: Vec<String>,
    pub patched_iso_remaining: bool,
    pub slippi_reverted_to: Option<String>,
}

pub fn uninstall_pack(db: &Db, character: &str, pack_name: &str) -> AppResult<UninstallResult> {
    let working = working_iso(db)?;

    let occupied: Vec<(String, String)> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT slot_code, COALESCE(actual_slot_code, slot_code)
             FROM installed_pack
             WHERE character_code = ?1 AND pack_name = ?2",
        )?;
        let mapped = stmt.query_map(params![character, pack_name], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    db.with_conn(|c| {
        c.execute(
            "DELETE FROM installed_pack WHERE character_code = ?1 AND pack_name = ?2",
            params![character, pack_name],
        )?;
        Ok(())
    })?;

    let remaining: Vec<(String, String, String)> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT ip.character_code, COALESCE(ip.actual_slot_code, ip.slot_code), sf.source_path
             FROM installed_pack ip
             JOIN skin_files sf ON sf.id = ip.source_skin_file_id",
        )?;
        let mapped = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;

    let mut slippi_reverted_to = None;
    let mut patched_remaining = false;

    if remaining.is_empty() {
        let patched = paths::patched_iso_path_for(&working)
            .ok_or_else(|| AppError::Io("working iso has no parent dir".into()))?;
        let _ = fs::remove_file(&patched);
        if let Some(orig) = db.get_setting(ORIGINAL_ISO_KEY)? {
            let _ = slippi_config::write_iso_path(&orig)?;
            db.clear_setting(ORIGINAL_ISO_KEY)?;
            slippi_reverted_to = Some(orig);
        }
    } else {
        let patched = iso::rebuild_patched_iso(&working)?;
        let ops_targets: Vec<(String, PathBuf)> = remaining
            .iter()
            .map(|(ch, actual, src)| (format!("Pl{ch}{actual}.dat"), PathBuf::from(src)))
            .collect();
        let ops: Vec<gc_fst::IsoOp> = ops_targets
            .iter()
            .map(|(t, s)| gc_fst::IsoOp::Insert {
                iso_path: Path::new(t.as_str()),
                input_path: s.as_path(),
            })
            .collect();
        gc_fst::operate_on_iso(&patched, &ops).map_err(|e| {
            AppError::IsoWrite(format!("operate_on_iso({} ops): {e:?}", ops.len()))
        })?;
        patched_remaining = true;
    }

    let restored: Vec<String> = occupied
        .iter()
        .map(|(req, act)| format!("{req}→{act}"))
        .collect();

    Ok(UninstallResult {
        restored_slots: restored,
        patched_iso_remaining: patched_remaining,
        slippi_reverted_to,
    })
}
