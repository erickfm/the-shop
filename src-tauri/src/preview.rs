use crate::error::{AppError, AppResult};
use crate::paths;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Once;

#[derive(serde::Serialize, Clone)]
pub struct SkinPreview {
    pub obj: String,
    pub mtl: String,
    pub textures: HashMap<String, String>,
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
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("obj") {
                let _ = fs::remove_file(&path);
            }
        }
    });
}

fn ensure_preview_dir(resource_dir: &Path, skin_path: &Path) -> AppResult<PathBuf> {
    sweep_legacy_cache();
    let key = cache_key_for(skin_path)?;
    let root = previews_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let dir = root.join(&key);
    let obj_path = dir.join("model.obj");
    if obj_path.exists() {
        return Ok(dir);
    }
    fs::create_dir_all(&dir).map_err(|e| AppError::Io(e.to_string()))?;
    let bin = hsd_tool_binary(resource_dir)
        .ok_or_else(|| AppError::Other("the-shop-hsd binary not found".into()))?;
    let status = Command::new(&bin)
        .arg("to-obj")
        .arg(skin_path)
        .arg(&obj_path)
        .status()
        .map_err(|e| AppError::Other(format!("spawn the-shop-hsd: {e}")))?;
    if !status.success() {
        return Err(AppError::Other(format!(
            "the-shop-hsd to-obj failed (exit {})",
            status.code().unwrap_or(-1)
        )));
    }
    if !obj_path.exists() {
        return Err(AppError::Other(
            "OBJ not produced even though tool exited 0".into(),
        ));
    }
    Ok(dir)
}

pub fn ensure_preview(resource_dir: &Path, skin_path: &Path) -> AppResult<SkinPreview> {
    let dir = ensure_preview_dir(resource_dir, skin_path)?;
    let obj = fs::read_to_string(dir.join("model.obj"))
        .map_err(|e| AppError::Io(format!("read model.obj: {e}")))?;
    let mtl = fs::read_to_string(dir.join("model.mtl")).unwrap_or_default();

    let mut textures = HashMap::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) if n.starts_with("tex_") && n.ends_with(".png") => n.to_string(),
                _ => continue,
            };
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            textures.insert(name, encoded);
        }
    }

    Ok(SkinPreview { obj, mtl, textures })
}
