use crate::error::{AppError, AppResult};
use crate::paths;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Once;

#[derive(serde::Serialize, Clone)]
pub struct SkinPreview {
    pub glb: String,
}

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

static SWEEP_ONCE: Once = Once::new();

fn sweep_legacy_cache() {
    SWEEP_ONCE.call_once(|| {
        let dir = match previews_dir() {
            Ok(p) => p,
            Err(_) => return,
        };
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // legacy single-file OBJ cache
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("obj") {
                let _ = fs::remove_file(&path);
            }
            // legacy per-skin dir with OBJ+MTL+PNGs (no glb yet)
            if path.is_dir() {
                let glb = path.join("model.glb");
                if !glb.exists() {
                    let _ = fs::remove_dir_all(&path);
                }
            }
        }
    });
}

fn ensure_glb(resource_dir: &Path, skin_path: &Path) -> AppResult<PathBuf> {
    sweep_legacy_cache();
    let key = cache_key_for(skin_path)?;
    let root = previews_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let dir = root.join(&key);
    let glb_path = dir.join("model.glb");
    if glb_path.exists() {
        return Ok(glb_path);
    }
    fs::create_dir_all(&dir).map_err(|e| AppError::Io(e.to_string()))?;
    let bin = hsd_tool_binary(resource_dir)
        .ok_or_else(|| AppError::Other("the-shop-hsd binary not found".into()))?;
    let status = Command::new(&bin)
        .arg("to-gltf")
        .arg(skin_path)
        .arg(&glb_path)
        .status()
        .map_err(|e| AppError::Other(format!("spawn the-shop-hsd: {e}")))?;
    if !status.success() {
        return Err(AppError::Other(format!(
            "the-shop-hsd to-gltf failed (exit {})",
            status.code().unwrap_or(-1)
        )));
    }
    if !glb_path.exists() {
        return Err(AppError::Other(
            "GLB not produced even though tool exited 0".into(),
        ));
    }
    Ok(glb_path)
}

pub fn ensure_preview(resource_dir: &Path, skin_path: &Path) -> AppResult<SkinPreview> {
    let glb_path = ensure_glb(resource_dir, skin_path)?;
    let bytes = fs::read(&glb_path).map_err(|e| AppError::Io(format!("read model.glb: {e}")))?;
    let glb = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(SkinPreview { glb })
}
