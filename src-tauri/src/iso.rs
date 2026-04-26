use crate::error::{AppError, AppResult};
use crate::paths;
use std::fs;
use std::path::{Path, PathBuf};

pub fn ensure_patched_iso_from_vanilla(vanilla: &Path) -> AppResult<PathBuf> {
    let dest = paths::patched_iso_path_for(vanilla)
        .ok_or_else(|| AppError::Io("vanilla ISO has no parent directory".into()))?;
    if !dest.exists() {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
        }
        fs::copy(vanilla, &dest).map_err(|e| AppError::IsoWrite(e.to_string()))?;
    }
    Ok(dest)
}

pub fn rebuild_patched_iso(vanilla: &Path) -> AppResult<PathBuf> {
    let dest = paths::patched_iso_path_for(vanilla)
        .ok_or_else(|| AppError::Io("vanilla ISO has no parent directory".into()))?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }
    if dest.exists() {
        fs::remove_file(&dest).map_err(|e| AppError::IsoWrite(e.to_string()))?;
    }
    fs::copy(vanilla, &dest).map_err(|e| AppError::IsoWrite(e.to_string()))?;
    Ok(dest)
}

pub fn rebuild_iso_with_replacements(
    working: &Path,
    replacements: &[(String, std::path::PathBuf)],
) -> AppResult<PathBuf> {
    let dest = paths::patched_iso_path_for(working)
        .ok_or_else(|| AppError::Io("working ISO has no parent directory".into()))?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }

    let scratch = paths::iso_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join("rebuild-scratch");
    if scratch.exists() {
        fs::remove_dir_all(&scratch).map_err(|e| AppError::Io(e.to_string()))?;
    }
    fs::create_dir_all(&scratch).map_err(|e| AppError::Io(e.to_string()))?;

    let original_cwd = std::env::current_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let cwd_guard = CwdGuard::new(&original_cwd);
    std::env::set_current_dir(&scratch).map_err(|e| AppError::Io(e.to_string()))?;

    let bytes = fs::read(working).map_err(|e| AppError::IsoRead(e.to_string()))?;
    let read_result = gc_fst::read_iso(&bytes);
    drop(cwd_guard);
    let _ = std::env::set_current_dir(&original_cwd);
    read_result.map_err(|e| AppError::IsoRead(format!("read_iso: {e:?}")))?;
    drop(bytes);

    let root = scratch.join("root");
    for (target_filename, src) in replacements {
        let target = root.join(target_filename);
        fs::copy(src, &target).map_err(|e| AppError::IsoWrite(e.to_string()))?;
    }

    let new_bytes = gc_fst::write_iso(&root)
        .map_err(|e| AppError::IsoWrite(format!("write_iso: {e:?}")))?;
    if dest.exists() {
        fs::remove_file(&dest).map_err(|e| AppError::IsoWrite(e.to_string()))?;
    }
    fs::write(&dest, &new_bytes).map_err(|e| AppError::IsoWrite(e.to_string()))?;
    drop(new_bytes);

    let _ = fs::remove_dir_all(&scratch);
    Ok(dest)
}

struct CwdGuard {
    prev: std::path::PathBuf,
}

impl CwdGuard {
    fn new(prev: &Path) -> Self {
        Self { prev: prev.to_path_buf() }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.prev);
    }
}

pub fn replace_many_in_iso(iso: &Path, pairs: &[(String, PathBuf)]) -> AppResult<()> {
    if pairs.is_empty() {
        return Ok(());
    }
    let ops: Vec<gc_fst::IsoOp> = pairs
        .iter()
        .map(|(target, src)| gc_fst::IsoOp::Insert {
            iso_path: Path::new(target.as_str()),
            input_path: src.as_path(),
        })
        .collect();
    gc_fst::operate_on_iso(iso, &ops)
        .map_err(|e| AppError::IsoWrite(format!("operate_on_iso({} ops): {e:?}", ops.len())))
}

pub fn extract_from_iso(iso: &Path, target_filename: &str, dest: &Path) -> AppResult<()> {
    paths::ensure_parent(dest).map_err(|e| AppError::Io(e.to_string()))?;
    let target = Path::new(target_filename);
    let pairs = [(target, dest)];
    gc_fst::read_iso_files(iso, &pairs)
        .map_err(|e| AppError::IsoRead(format!("read_iso_files({target_filename}): {e:?}")))
}

pub fn file_exists_in_iso(iso: &Path, target_filename: &str) -> bool {
    let probe_dir = match paths::iso_dir() {
        Ok(p) => p.join("probe"),
        Err(_) => return false,
    };
    let _ = fs::create_dir_all(&probe_dir);
    let probe_dest = probe_dir.join(target_filename);
    let target = Path::new(target_filename);
    let pairs = [(target, probe_dest.as_path())];
    let ok = gc_fst::read_iso_files(iso, &pairs).is_ok();
    let _ = fs::remove_file(&probe_dest);
    ok
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct IsoInfo {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub recognized: Option<String>,
}

pub fn inspect(path: &Path) -> AppResult<IsoInfo> {
    if !path.exists() {
        return Err(AppError::IsoMissing(path.display().to_string()));
    }
    let meta = fs::metadata(path).map_err(|e| AppError::IsoRead(e.to_string()))?;
    let size_bytes = meta.len();
    let recognized = match size_bytes {
        1_459_978_240 => Some("SSBM full GameCube image".to_string()),
        s if s > 1_300_000_000 && s < 1_500_000_000 => {
            Some("Plausible Melee ISO (size in expected range)".to_string())
        }
        _ => None,
    };
    Ok(IsoInfo {
        path: path.display().to_string(),
        size_bytes,
        sha256: String::new(),
        recognized,
    })
}
