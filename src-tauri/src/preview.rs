use crate::error::{AppError, AppResult};
use crate::paths;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn hsd_tool_binary(resource_dir: &Path) -> Option<PathBuf> {
    let p = resource_dir.join("hsd-tool").join("the-shop-hsd");
    if p.exists() {
        return Some(p);
    }
    if let Ok(cwd) = std::env::current_dir() {
        for cand in [
            cwd.join("src-tauri/resources/hsd-tool/the-shop-hsd"),
            cwd.join("../src-tauri/resources/hsd-tool/the-shop-hsd"),
            cwd.join("resources/hsd-tool/the-shop-hsd"),
        ] {
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    None
}

pub fn previews_dir() -> std::io::Result<PathBuf> {
    let p = paths::app_data_dir()?.join("previews");
    fs::create_dir_all(&p)?;
    Ok(p)
}

fn cache_key_for(skin_path: &Path) -> AppResult<String> {
    let meta = fs::metadata(skin_path).map_err(|e| AppError::Io(e.to_string()))?;
    let mtime = meta
        .modified()
        .map_err(|e| AppError::Io(e.to_string()))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut h = Sha256::new();
    h.update(skin_path.to_string_lossy().as_bytes());
    h.update(mtime.to_le_bytes());
    h.update(meta.len().to_le_bytes());
    Ok(hex::encode(h.finalize()))
}

pub fn ensure_obj(resource_dir: &Path, skin_path: &Path) -> AppResult<PathBuf> {
    let key = cache_key_for(skin_path)?;
    let dir = previews_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let dest = dir.join(format!("{key}.obj"));
    if dest.exists() {
        return Ok(dest);
    }
    let bin = hsd_tool_binary(resource_dir).ok_or_else(|| {
        AppError::Other("the-shop-hsd binary not found".into())
    })?;
    let status = Command::new(&bin)
        .arg("to-obj")
        .arg(skin_path)
        .arg(&dest)
        .status()
        .map_err(|e| AppError::Other(format!("spawn the-shop-hsd: {e}")))?;
    if !status.success() {
        return Err(AppError::Other(format!(
            "the-shop-hsd to-obj failed (exit {})",
            status.code().unwrap_or(-1)
        )));
    }
    if !dest.exists() {
        return Err(AppError::Other(
            "OBJ not produced even though tool exited 0".into(),
        ));
    }
    Ok(dest)
}
