use crate::error::{AppError, AppResult};
use crate::iso;
use crate::paths;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Once;

/// Extract the Pl<CharCode>AJ.dat animation file from the vanilla ISO once,
/// cache it under the app data dir. Returns the cached path or None if the
/// extraction fails or there's no vanilla ISO configured.
pub fn ensure_anim_file(vanilla_iso: Option<&Path>, char_code: &str) -> Option<PathBuf> {
    let iso_path = vanilla_iso?;
    if !iso_path.exists() { return None; }
    let cache_dir = paths::app_data_dir().ok()?.join("anims");
    fs::create_dir_all(&cache_dir).ok()?;
    let cached = cache_dir.join(format!("Pl{char_code}AJ.dat"));
    if cached.exists() {
        return Some(cached);
    }
    let target = format!("Pl{char_code}AJ.dat");
    if iso::extract_from_iso(iso_path, &target, &cached).is_ok() && cached.exists() {
        Some(cached)
    } else {
        None
    }
}

/// Extract the Pl<CharCode>.dat fighter-data file from the vanilla ISO once.
/// This file holds the LowPoly visibility lookup that tells us which DObj
/// indices are low-poly variants of higher-poly meshes — without filtering
/// these out, every model renders both LOD levels overlapped (e.g. TAILS shows
/// 6 hair tufts instead of 3, eyes look flat from z-fighting, etc.).
pub fn ensure_fighter_file(vanilla_iso: Option<&Path>, char_code: &str) -> Option<PathBuf> {
    let iso_path = vanilla_iso?;
    if !iso_path.exists() { return None; }
    let cache_dir = paths::app_data_dir().ok()?.join("fighters");
    fs::create_dir_all(&cache_dir).ok()?;
    let cached = cache_dir.join(format!("Pl{char_code}.dat"));
    if cached.exists() {
        return Some(cached);
    }
    let target = format!("Pl{char_code}.dat");
    if iso::extract_from_iso(iso_path, &target, &cached).is_ok() && cached.exists() {
        Some(cached)
    } else {
        None
    }
}

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

fn cache_key_for(
    skin_path: &Path,
    anim_path: Option<&Path>,
    fighter_path: Option<&Path>,
    with_textures: bool,
) -> AppResult<String> {
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
    if let Some(p) = anim_path {
        if let Ok(am) = fs::metadata(p) {
            h.update(b"|anim:");
            h.update(p.to_string_lossy().as_bytes());
            h.update(am.len().to_le_bytes());
        }
    }
    if let Some(p) = fighter_path {
        if let Ok(fm) = fs::metadata(p) {
            h.update(b"|fighter:");
            h.update(p.to_string_lossy().as_bytes());
            h.update(fm.len().to_le_bytes());
        }
    }
    h.update(if with_textures { b"|tex:1" } else { b"|tex:0" });
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

fn ensure_glb(
    resource_dir: &Path,
    skin_path: &Path,
    anim_path: Option<&Path>,
    fighter_path: Option<&Path>,
    with_textures: bool,
) -> AppResult<PathBuf> {
    sweep_legacy_cache();
    let key = cache_key_for(skin_path, anim_path, fighter_path, with_textures)?;
    let root = previews_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let dir = root.join(&key);
    let glb_path = dir.join("model.glb");
    if glb_path.exists() {
        return Ok(glb_path);
    }
    fs::create_dir_all(&dir).map_err(|e| AppError::Io(e.to_string()))?;
    let bin = hsd_tool_binary(resource_dir)
        .ok_or_else(|| AppError::Other("the-shop-hsd binary not found".into()))?;
    let mut cmd = Command::new(&bin);
    cmd.arg("to-gltf").arg(skin_path).arg(&glb_path);
    if let Some(p) = anim_path {
        cmd.arg("--pose").arg(p);
    }
    if let Some(p) = fighter_path {
        cmd.arg("--fighter").arg(p);
    }
    if !with_textures {
        cmd.arg("--no-textures");
    }
    let status = cmd
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

pub fn ensure_preview(
    resource_dir: &Path,
    skin_path: &Path,
    char_code: &str,
    vanilla_iso: Option<&Path>,
    with_textures: bool,
) -> AppResult<SkinPreview> {
    let anim = ensure_anim_file(vanilla_iso, char_code);
    let fighter = ensure_fighter_file(vanilla_iso, char_code);
    let glb_path = ensure_glb(
        resource_dir,
        skin_path,
        anim.as_deref(),
        fighter.as_deref(),
        with_textures,
    )?;
    let bytes = fs::read(&glb_path).map_err(|e| AppError::Io(format!("read model.glb: {e}")))?;
    let glb = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(SkinPreview { glb })
}
