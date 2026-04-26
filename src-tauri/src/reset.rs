use crate::db::Db;
use crate::error::AppResult;
use crate::paths;
use crate::slippi_config;
use std::fs;
use std::path::PathBuf;

const ORIGINAL_ISO_KEY: &str = "original_slippi_iso_path";
const VANILLA_ISO_KEY: &str = "vanilla_iso_path";

#[derive(Debug, serde::Serialize)]
pub struct ResetReport {
    pub patched_iso_removed: bool,
    pub slippi_reverted_to: Option<String>,
    pub packs_uninstalled: i64,
}

pub fn reset_to_vanilla(db: &Db) -> AppResult<ResetReport> {
    let mut patched_removed = false;

    if let Some(s) = db.get_setting(VANILLA_ISO_KEY)? {
        let vanilla = PathBuf::from(s);
        if let Some(patched) = paths::patched_iso_path_for(&vanilla) {
            if patched.exists() {
                fs::remove_file(&patched)
                    .map_err(|e| crate::error::AppError::Io(e.to_string()))?;
                patched_removed = true;
            }
        }
    }

    let packs_uninstalled = db.with_conn(|c| {
        let n = c.execute("DELETE FROM installed_pack", [])?;
        Ok(n as i64)
    })?;

    let mut slippi_reverted_to = None;
    if let Some(orig) = db.get_setting(ORIGINAL_ISO_KEY)? {
        if let Ok(_prev) = slippi_config::write_iso_path(&orig) {
            slippi_reverted_to = Some(orig);
        }
        db.clear_setting(ORIGINAL_ISO_KEY)?;
    }

    Ok(ResetReport {
        patched_iso_removed: patched_removed,
        slippi_reverted_to,
        packs_uninstalled,
    })
}
