use crate::error::{AppError, AppResult};
use crate::iso_patch;
use std::fs;
use std::path::{Path, PathBuf};

pub const GECKO_CODE_NAME: &str = "Skip Slippi SSS [KELLZ]";

const GECKO_CODE_BODY: &str = "\
$Skip Slippi SSS [KELLZ]
C20166B4 00000016
3D808001 618C6204
7D8903A6 4E800421
7C7E1B78 7C0802A6
90010004 9421FF00
BE810008 3C60801A
60635014 80630000
3C804082 60840010
7C032000 4182005C
80610000 80630000
80630000 82830004
3C608025 6063A9DC
7C141800 41820018
3C608025 6063A9EC
7C141800 41820008
48000028 BA810008
80010104 38210100
7C0803A6 7FC3F378
3D808001 618C66BC
7D8903A6 4E800420
BA810008 80010104
38210100 7C0803A6
7FC3F378 00000000
C20163F8 00000016
3D808001 618C6204
7D8903A6 4E800421
7C7E1B78 7C0802A6
90010004 9421FF00
BE810008 3C60801A
60635014 80630000
3C804082 60840010
7C032000 4182005C
80610000 80630000
80630000 82830004
3C608025 6063A9DC
7C141800 41820018
3C608025 6063A9EC
7C141800 41820008
48000028 BA810008
80010104 38210100
7C0803A6 7FC3F378
3D808001 618C6400
7D8903A6 4E800420
BA810008 80010104
38210100 7C0803A6
7FC3F378 00000000";

const TEMPLATE_RESOURCE_RELPATH: &str = "resources/mex/M-EX-SLIPPI-TEMPLATE.xdelta";

pub fn template_xdelta_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("mex").join("M-EX-SLIPPI-TEMPLATE.xdelta")
}

pub fn fallback_dev_xdelta_path() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let candidates = [
        cwd.join(TEMPLATE_RESOURCE_RELPATH),
        cwd.join("..").join(TEMPLATE_RESOURCE_RELPATH),
        cwd.join("src-tauri").join(TEMPLATE_RESOURCE_RELPATH),
    ];
    for c in candidates {
        if c.exists() {
            return Some(c);
        }
    }
    None
}

pub fn apply_bundled_template(
    vanilla_iso: &Path,
    xdelta: &Path,
    out_iso: &Path,
) -> AppResult<()> {
    if !vanilla_iso.exists() {
        return Err(AppError::IsoMissing(vanilla_iso.display().to_string()));
    }
    if !xdelta.exists() {
        return Err(AppError::Other(format!(
            "m-ex template file missing: {}",
            xdelta.display()
        )));
    }
    let src = fs::read(vanilla_iso).map_err(|e| AppError::IsoRead(e.to_string()))?;
    let patch = fs::read(xdelta).map_err(|e| AppError::Io(e.to_string()))?;
    let out = xdelta3::decode(&patch, &src).ok_or_else(|| {
        AppError::IsoWrite(
            "xdelta decode failed — check that vanilla ISO is genuine NTSC-U 1.02".into(),
        )
    })?;
    if let Some(parent) = out_iso.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }
    fs::write(out_iso, &out).map_err(|e| AppError::IsoWrite(e.to_string()))?;
    Ok(())
}

pub fn detect_mex_base(iso: &Path) -> AppResult<bool> {
    let entries = iso_patch::list_root_files(iso)?;
    let probes = ["PlFxNr2.dat", "PlMrNr2.dat", "PlCaNr2.dat"];
    Ok(probes.iter().any(|p| entries.contains_key(*p)))
}

pub fn user_gecko_ini_path() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        Some(
            dirs::config_dir()?
                .join("SlippiOnline")
                .join("GameSettings")
                .join("GALE01.ini"),
        )
    }
    #[cfg(target_os = "macos")]
    {
        Some(
            dirs::data_dir()?
                .join("SlippiOnline")
                .join("GameSettings")
                .join("GALE01.ini"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        Some(
            dirs::data_dir()?
                .join("SlippiOnline")
                .join("GameSettings")
                .join("GALE01.ini"),
        )
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

pub fn install_required_gecko_code() -> AppResult<()> {
    let path = user_gecko_ini_path().ok_or_else(|| {
        AppError::Other("could not locate Slippi user GALE01.ini path".into())
    })?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Io(e.to_string()))?;
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let merged = merge_gecko_ini(&existing, GECKO_CODE_NAME, GECKO_CODE_BODY);
    write_atomic(&path, &merged)
}

pub fn uninstall_required_gecko_code() -> AppResult<()> {
    let path = match user_gecko_ini_path() {
        Some(p) => p,
        None => return Ok(()),
    };
    if !path.exists() {
        return Ok(());
    }
    let existing = fs::read_to_string(&path).map_err(|e| AppError::Io(e.to_string()))?;
    let pruned = prune_gecko_ini(&existing, GECKO_CODE_NAME);
    write_atomic(&path, &pruned)
}

fn write_atomic(path: &Path, contents: &str) -> AppResult<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp.the-shop");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| AppError::Io(e.to_string()))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| AppError::Io(e.to_string()))?;
        f.sync_all().map_err(|e| AppError::Io(e.to_string()))?;
    }
    fs::rename(&tmp, path).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

fn merge_gecko_ini(existing: &str, code_name: &str, code_body: &str) -> String {
    let mut sections = parse_ini_sections(existing);

    let gecko = sections
        .entry("Gecko".to_string())
        .or_insert_with(Vec::new);
    let already_declared = gecko_block_present(gecko, code_name);
    if !already_declared {
        if !gecko.is_empty() && !gecko.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
            gecko.push(String::new());
        }
        for line in code_body.lines() {
            gecko.push(line.to_string());
        }
    }

    let enabled = sections
        .entry("Gecko_Enabled".to_string())
        .or_insert_with(Vec::new);
    let marker = format!("${}", code_name);
    if !enabled.iter().any(|l| l.trim() == marker) {
        enabled.push(marker);
    }

    serialize_ini_sections(&sections)
}

fn prune_gecko_ini(existing: &str, code_name: &str) -> String {
    let mut sections = parse_ini_sections(existing);

    if let Some(gecko) = sections.get_mut("Gecko") {
        remove_gecko_block(gecko, code_name);
    }
    if let Some(enabled) = sections.get_mut("Gecko_Enabled") {
        let marker = format!("${}", code_name);
        enabled.retain(|l| l.trim() != marker);
    }
    serialize_ini_sections(&sections)
}

fn parse_ini_sections(text: &str) -> indexmap::IndexMap<String, Vec<String>> {
    let mut out: indexmap::IndexMap<String, Vec<String>> = indexmap::IndexMap::new();
    let mut preamble: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            current = Some(trimmed[1..trimmed.len() - 1].to_string());
            out.entry(current.clone().unwrap()).or_insert_with(Vec::new);
            continue;
        }
        match &current {
            Some(name) => out.entry(name.clone()).or_insert_with(Vec::new).push(trimmed.to_string()),
            None => preamble.push(trimmed.to_string()),
        }
    }
    if !preamble.is_empty() {
        out.entry("__preamble".to_string()).or_insert(preamble);
    }
    out
}

fn serialize_ini_sections(sections: &indexmap::IndexMap<String, Vec<String>>) -> String {
    let mut out = String::new();
    if let Some(pre) = sections.get("__preamble") {
        for line in pre {
            out.push_str(line);
            out.push('\n');
        }
    }
    for (name, lines) in sections {
        if name == "__preamble" {
            continue;
        }
        if !out.is_empty() && !out.ends_with("\n\n") {
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
        out.push('[');
        out.push_str(name);
        out.push_str("]\n");
        for line in lines {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn gecko_block_present(lines: &[String], code_name: &str) -> bool {
    let marker = format!("${}", code_name);
    lines
        .iter()
        .any(|l| l.trim_end_matches(|c: char| c.is_whitespace()) == marker.as_str()
            || l.trim_start().starts_with(&marker))
}

fn remove_gecko_block(lines: &mut Vec<String>, code_name: &str) {
    let marker_prefix = format!("${}", code_name);
    let mut start: Option<usize> = None;
    let mut end: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.starts_with('$') {
            if t.starts_with(&marker_prefix) {
                start = Some(i);
            } else if start.is_some() && end.is_none() {
                end = Some(i);
                break;
            }
        }
    }
    if let Some(s) = start {
        let e = end.unwrap_or(lines.len());
        let drain_end = if e > s && lines.get(e - 1).map(|l| l.trim().is_empty()).unwrap_or(false) {
            e - 1
        } else {
            e
        };
        lines.drain(s..drain_end);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_into_empty_creates_sections() {
        let merged = merge_gecko_ini("", GECKO_CODE_NAME, GECKO_CODE_BODY);
        assert!(merged.contains("[Gecko]"));
        assert!(merged.contains("[Gecko_Enabled]"));
        assert!(merged.contains("$Skip Slippi SSS [KELLZ]"));
        assert!(merged.contains("C20166B4 00000016"));
    }

    #[test]
    fn merge_preserves_existing_codes() {
        let existing = "[Gecko]\n$Boot to CSS [Dan Salvato, Achilles]\n041BFA20 38600002\n";
        let merged = merge_gecko_ini(existing, GECKO_CODE_NAME, GECKO_CODE_BODY);
        assert!(merged.contains("$Boot to CSS"));
        assert!(merged.contains("$Skip Slippi SSS [KELLZ]"));
        assert!(merged.contains("[Gecko_Enabled]"));
    }

    #[test]
    fn merge_idempotent() {
        let once = merge_gecko_ini("", GECKO_CODE_NAME, GECKO_CODE_BODY);
        let twice = merge_gecko_ini(&once, GECKO_CODE_NAME, GECKO_CODE_BODY);
        assert_eq!(once.matches("C20166B4 00000016").count(), 1);
        assert_eq!(twice.matches("C20166B4 00000016").count(), 1);
    }

    #[test]
    fn prune_removes_only_named_block() {
        let merged = merge_gecko_ini(
            "[Gecko]\n$Boot to CSS [Dan Salvato, Achilles]\n041BFA20 38600002\n",
            GECKO_CODE_NAME,
            GECKO_CODE_BODY,
        );
        let pruned = prune_gecko_ini(&merged, GECKO_CODE_NAME);
        assert!(!pruned.contains("Skip Slippi SSS"));
        assert!(pruned.contains("$Boot to CSS"));
    }
}
