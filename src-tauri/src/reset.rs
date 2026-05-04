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
        let n_skins = c.execute("DELETE FROM installed_pack", [])?;
        let n_assets = c.execute("DELETE FROM installed_iso_asset", [])?;
        Ok((n_skins + n_assets) as i64)
    })?;

    // Texture packs are folder copies in Slippi's Load/Textures dir; remove
    // each one we tracked, then drop the rows. If the user manually deleted
    // the folder we just skip silently.
    let texture_pack_dirs: Vec<String> = db.with_conn(|c| {
        let mut stmt = c.prepare("SELECT install_dir FROM installed_texture_pack")?;
        let mapped = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in mapped {
            out.push(r?);
        }
        Ok(out)
    })?;
    for dir in &texture_pack_dirs {
        let _ = fs::remove_dir_all(dir);
    }
    db.with_conn(|c| {
        c.execute("DELETE FROM installed_texture_pack", [])?;
        Ok(())
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
