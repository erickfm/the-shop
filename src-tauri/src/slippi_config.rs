use crate::error::{AppError, AppResult};
use crate::paths;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

const SETTINGS_FILE_CANDIDATES: &[&str] = &["Settings", "settings.json"];
const ISO_PATH_KEYS: &[&str] = &["isoPath", "isoFilePath", "isoFile"];

pub fn locate_settings_file() -> AppResult<PathBuf> {
    let dir = paths::default_slippi_launcher_settings_dir()
        .ok_or(AppError::SlippiNotLocated)?;
    for name in SETTINGS_FILE_CANDIDATES {
        let p = dir.join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    Err(AppError::SlippiConfigNotFound(dir.display().to_string()))
}

pub fn read_iso_path() -> AppResult<Option<String>> {
    let path = match locate_settings_file() {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let raw = fs::read_to_string(&path).map_err(|e| AppError::Io(e.to_string()))?;
    let json: Value = serde_json::from_str(&raw)?;
    Ok(find_iso_path(&json))
}

fn find_iso_path(v: &Value) -> Option<String> {
    if let Value::Object(map) = v {
        for k in ISO_PATH_KEYS {
            if let Some(Value::String(s)) = map.get(*k) {
                if !s.is_empty() {
                    return Some(s.clone());
                }
            }
        }
        for (_, child) in map {
            if let Some(found) = find_iso_path(child) {
                return Some(found);
            }
        }
    }
    None
}

pub fn write_iso_path(new_iso: &str) -> AppResult<String> {
    let path = locate_settings_file()?;
    let raw = fs::read_to_string(&path).map_err(|e| AppError::Io(e.to_string()))?;
    let mut json: Value = serde_json::from_str(&raw)?;
    let previous = set_iso_path(&mut json, new_iso)
        .ok_or_else(|| AppError::SlippiConfigParse("could not locate isoPath key".into()))?;
    let new_text = serde_json::to_string_pretty(&json)?;
    write_atomic(&path, &new_text)?;
    Ok(previous)
}

fn set_iso_path(v: &mut Value, new_iso: &str) -> Option<String> {
    if let Value::Object(map) = v {
        for k in ISO_PATH_KEYS {
            if map.contains_key(*k) {
                let old = match map.get(*k) {
                    Some(Value::String(s)) => s.clone(),
                    _ => String::new(),
                };
                map.insert(k.to_string(), Value::String(new_iso.to_string()));
                return Some(old);
            }
        }
        for (_, child) in map.iter_mut() {
            if let Some(prev) = set_iso_path(child, new_iso) {
                return Some(prev);
            }
        }
    }
    None
}

fn write_atomic(target: &std::path::Path, contents: &str) -> AppResult<()> {
    let tmp = target.with_extension("tmp.the-shop");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| AppError::Io(e.to_string()))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| AppError::Io(e.to_string()))?;
        f.sync_all().map_err(|e| AppError::Io(e.to_string()))?;
    }
    fs::rename(&tmp, target).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}
