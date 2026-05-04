use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::paths;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, serde::Serialize)]
pub struct TexturePackInstallResult {
    pub install_dir: String,
    pub bytes_copied: u64,
    pub file_count: u64,
}

/// Resolve the destination dir for a texture-pack install, honoring the
/// user's configured Slippi user dir override if present in the settings DB.
pub fn install_root(db: &Db) -> AppResult<PathBuf> {
    let user_dir_override = db
        .get_setting("slippi_user_dir")?
        .map(PathBuf::from);
    paths::slippi_textures_dir(user_dir_override.as_deref()).ok_or_else(|| {
        AppError::Other(
            "Slippi user directory could not be resolved — set it in Settings first".into(),
        )
    })
}

/// Copy `src_dir` (a directory tree, typically the unpacked contents of a
/// texture-pack zip) into `<slippi_textures_dir>/<install_id>/`. Idempotent
/// when called twice with the same install_id (overwrites). Returns the
/// install directory path, total bytes copied, and file count.
pub fn install_pack_from_dir(
    db: &Db,
    install_id: &str,
    src_dir: &Path,
    skin_file_id: Option<i64>,
    creator_id: Option<&str>,
    display_name: Option<&str>,
) -> AppResult<TexturePackInstallResult> {
    let root = install_root(db)?;
    fs::create_dir_all(&root)?;
    let dest = root.join(install_id);
    if dest.exists() {
        fs::remove_dir_all(&dest)?;
    }
    fs::create_dir_all(&dest)?;

    let (bytes_copied, file_count) = copy_dir_recursive(src_dir, &dest)?;

    db.with_conn(|c| {
        c.execute(
            "INSERT INTO installed_texture_pack
               (pack_name, install_dir, source_skin_file_id, creator_id, display_name, installed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(pack_name) DO UPDATE SET
               install_dir = excluded.install_dir,
               source_skin_file_id = excluded.source_skin_file_id,
               creator_id = excluded.creator_id,
               display_name = excluded.display_name,
               installed_at = excluded.installed_at",
            rusqlite::params![
                install_id,
                dest.display().to_string(),
                skin_file_id,
                creator_id,
                display_name,
                now_secs()
            ],
        )?;
        Ok(())
    })?;

    Ok(TexturePackInstallResult {
        install_dir: dest.display().to_string(),
        bytes_copied,
        file_count,
    })
}

/// Remove the on-disk directory and the DB row.
pub fn uninstall_pack(db: &Db, install_id: &str) -> AppResult<()> {
    let dir: Option<String> = db.with_conn(|c| {
        let mut stmt =
            c.prepare("SELECT install_dir FROM installed_texture_pack WHERE pack_name = ?1")?;
        let mut rows = stmt.query(rusqlite::params![install_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get::<_, String>(0)?))
        } else {
            Ok(None)
        }
    })?;
    if let Some(d) = dir {
        let _ = fs::remove_dir_all(d);
    }
    db.with_conn(|c| {
        c.execute(
            "DELETE FROM installed_texture_pack WHERE pack_name = ?1",
            rusqlite::params![install_id],
        )?;
        Ok(())
    })?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> AppResult<(u64, u64)> {
    let mut total_bytes: u64 = 0;
    let mut total_files: u64 = 0;
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let entry_src = entry.path();
        let entry_dst = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            let (b, f) = copy_dir_recursive(&entry_src, &entry_dst)?;
            total_bytes += b;
            total_files += f;
        } else if ft.is_file() {
            let bytes = fs::copy(&entry_src, &entry_dst)?;
            total_bytes += bytes;
            total_files += 1;
        }
        // skip symlinks/etc.
    }
    Ok((total_bytes, total_files))
}
