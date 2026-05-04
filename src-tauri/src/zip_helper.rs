use crate::error::{AppError, AppResult};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

/// Extract every file in `archive_path` into `dest_dir`, preserving relative
/// directory structure. Skips directory entries (created via parent on file
/// extraction) and entries that escape `dest_dir` via `..`.
pub fn extract_all(archive_path: &Path, dest_dir: &Path) -> AppResult<u64> {
    fs::create_dir_all(dest_dir)?;
    let file = File::open(archive_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::Other(format!("zip: {e}")))?;
    let mut count: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(format!("zip entry {i}: {e}")))?;
        let outpath = match entry.enclosed_name() {
            Some(p) => dest_dir.join(p),
            None => continue,
        };
        if !outpath.starts_with(dest_dir) {
            continue;
        }
        if entry.is_dir() {
            fs::create_dir_all(&outpath)?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&outpath)?;
        io::copy(&mut entry, &mut out)?;
        count += 1;
    }
    Ok(count)
}

/// Find and extract a single named file from `archive_path`, writing it to
/// `dest_path`. Matches by basename, case-insensitive — useful when an index
/// entry says "this skin's .dat is named 'PlFcBu.dat'" without specifying
/// the full path inside a deep directory tree.
pub fn extract_named_file(
    archive_path: &Path,
    inner_filename: &str,
    dest_path: &Path,
) -> AppResult<()> {
    let file = File::open(archive_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::Other(format!("zip: {e}")))?;
    let needle = inner_filename.to_ascii_lowercase();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(format!("zip entry {i}: {e}")))?;
        let name = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let basename = name
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if basename == needle {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = File::create(dest_path)?;
            io::copy(&mut entry, &mut out)?;
            return Ok(());
        }
    }
    Err(AppError::Other(format!(
        "'{inner_filename}' not found inside archive {}",
        archive_path.display()
    )))
}

/// Heuristic: does this archive look like a Dolphin texture pack? True when
/// it contains any `tex1_<dim>_<hash>_<fmt>.png`-style file. Used by the
/// installer to auto-detect texture-pack zips even when the index entry's
/// kind is generic.
pub fn looks_like_texture_pack(archive_path: &Path) -> AppResult<bool> {
    let file = File::open(archive_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::Other(format!("zip: {e}")))?;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(format!("zip entry {i}: {e}")))?;
        if let Some(name) = entry.enclosed_name() {
            if let Some(b) = name.file_name().and_then(|s| s.to_str()) {
                let bl = b.to_ascii_lowercase();
                if bl.starts_with("tex1_") && bl.ends_with(".png") {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

/// List filenames (basenames only) in the archive — used when surfacing
/// what's inside a zip in error messages.
pub fn list_basenames(archive_path: &Path) -> AppResult<Vec<String>> {
    let file = File::open(archive_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::Other(format!("zip: {e}")))?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(format!("zip entry {i}: {e}")))?;
        if let Some(p) = entry.enclosed_name() {
            if let Some(b) = p.file_name().and_then(|s| s.to_str()) {
                out.push(b.to_string());
            }
        }
    }
    Ok(out)
}

#[allow(dead_code)]
pub fn is_zip_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".zip")
}

#[allow(dead_code)]
pub fn temp_extract_dir() -> AppResult<PathBuf> {
    let d = tempfile::tempdir()
        .map_err(|e| AppError::Other(format!("tempdir: {e}")))?;
    Ok(d.into_path())
}
