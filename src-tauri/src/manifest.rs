use crate::error::{AppError, AppResult};
use crate::slot_codes;
use serde::Deserialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParsedSkinFilename {
    pub character_code: String,
    pub character_display: String,
    pub slot_code: String,
    pub slot_display: String,
    pub pack_name: Option<String>,
    pub iso_target_filename: String,
}

/// What `the-shop-hsd identify` emits on stdout. Slot is intentionally absent —
/// HAL doesn't store the slot inside the file, only as a disk filename.
#[derive(Debug, Deserialize)]
pub struct FileIdentity {
    pub kind: String,
    pub character_internal: Option<String>,
    #[serde(default)]
    pub root_names: Vec<String>,
}

#[derive(Debug, Clone)]
struct FilenameParts {
    character_code: String,
    slot_code: String,
    pack_name: Option<String>,
}

/// Pure-filename parser. Returns the structural pieces without validating
/// against the character table — that happens in `identify`.
fn parse_filename_parts(filename: &str) -> AppResult<FilenameParts> {
    let stem = filename
        .strip_suffix(".dat")
        .or_else(|| filename.strip_suffix(".usd"))
        .ok_or_else(|| AppError::BadSkinFilename(filename.to_string()))?;

    let core = stem
        .strip_prefix("Pl")
        .ok_or_else(|| AppError::BadSkinFilename(filename.to_string()))?;

    if core.len() < 4 {
        return Err(AppError::BadSkinFilename(filename.to_string()));
    }

    let character_code = &core[0..2];
    let after_char = &core[2..];

    let mut slot_end = 2;
    for ch in after_char[2..].chars() {
        if ch.is_ascii_digit() {
            slot_end += 1;
        } else {
            break;
        }
    }
    let slot_code = &after_char[..slot_end];

    let pack_name = if after_char.len() == slot_end {
        None
    } else {
        let rest = &after_char[slot_end..];
        let trimmed = rest.strip_prefix('-').unwrap_or(rest);
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };

    Ok(FilenameParts {
        character_code: character_code.to_string(),
        slot_code: slot_code.to_string(),
        pack_name,
    })
}

/// Filename-only fallback for when we can't run the identify tool. Validates
/// the character + slot against our table.
pub fn parse(filename: &str) -> AppResult<ParsedSkinFilename> {
    let parts = parse_filename_parts(filename)?;
    finalize_from_parts(&parts.character_code, &parts.slot_code, parts.pack_name)
}

fn finalize_from_parts(
    character_code: &str,
    slot_code: &str,
    pack_name: Option<String>,
) -> AppResult<ParsedSkinFilename> {
    let char_def = slot_codes::lookup(character_code)
        .ok_or_else(|| AppError::UnknownCharacter(character_code.to_string()))?;

    let base_slot = slot_codes::slot_base(slot_code);
    let slot_display = match slot_codes::slot_display(character_code, base_slot) {
        Some(disp) if base_slot == slot_code => disp.to_string(),
        Some(disp) => format!("{disp} (ext. {})", &slot_code[base_slot.len()..]),
        None => {
            return Err(AppError::UnknownSlot {
                character: character_code.to_string(),
                slot: slot_code.to_string(),
            });
        }
    };

    let iso_target_filename = format!("Pl{}{}.dat", character_code, slot_code);

    Ok(ParsedSkinFilename {
        character_code: character_code.to_string(),
        character_display: char_def.display.to_string(),
        slot_code: slot_code.to_string(),
        slot_display,
        pack_name,
        iso_target_filename,
    })
}

/// Filename-only parser for non-character_skin ISO assets (effects, stages,
/// UI screens, items, animations). Recognizes the HAL filename conventions
/// used inside Melee's filesystem and returns enough info to register the
/// file as an ISO inject target.
///
/// Filename convention is `<canonical>[-<custom-name>].<dat|usd>` where
/// `<canonical>` is the HAL name (e.g. `EfFxData`, `GrFs`, `MnSlChr`,
/// `IfAll`, `ItStandard`, `PlFxAJ`) and the optional `-...` suffix is the
/// modder's variant name. Examples:
/// - `EfFxData-EVA-AT-FIELD-SHINE.dat` → effect, Fox, target `EfFxData.dat`
/// - `GrFs-NewFD.usd` → stage, target `GrFs.usd`
/// - `MnSlChr-AnimatedCSS.usd` → ui, target `MnSlChr.usd`
/// - `PlFxAJ-Walk.dat` → animation, Fox, target `PlFxAJ.dat`
#[derive(Debug, Clone)]
pub struct ParsedIsoAsset {
    pub kind: String,
    /// Empty for global assets (stages, generic UI, items).
    pub character_code: String,
    pub iso_target_filename: String,
    pub pack_name: Option<String>,
}

pub fn parse_iso_asset_filename(filename: &str) -> Option<ParsedIsoAsset> {
    let (stem, ext) = if let Some(s) = filename.strip_suffix(".dat") {
        (s, "dat")
    } else if let Some(s) = filename.strip_suffix(".usd") {
        (s, "usd")
    } else {
        return None;
    };

    let (core, pack_name) = match stem.split_once('-') {
        Some((c, n)) if !n.is_empty() => (c, Some(n.to_string())),
        _ => (stem, None),
    };
    let canonical = format!("{core}.{ext}");

    // Per-character animation banks: PlXxAJ
    if core.starts_with("Pl") && core.ends_with("AJ") && core.len() >= 6 {
        return Some(ParsedIsoAsset {
            kind: "animation".into(),
            character_code: core[2..4].to_string(),
            iso_target_filename: canonical,
            pack_name,
        });
    }

    // Per-character effect banks: EfXxData
    if core.starts_with("Ef") && core.ends_with("Data") && core.len() >= 8 {
        return Some(ParsedIsoAsset {
            kind: "effect".into(),
            character_code: core[2..4].to_string(),
            iso_target_filename: canonical,
            pack_name,
        });
    }

    // Stages: Gr*
    if core.starts_with("Gr") && core.len() >= 4 {
        return Some(ParsedIsoAsset {
            kind: "stage".into(),
            character_code: String::new(),
            iso_target_filename: canonical,
            pack_name,
        });
    }

    // UI / menus
    if core.starts_with("Mn") || core.starts_with("If") || core.starts_with("Ty") {
        return Some(ParsedIsoAsset {
            kind: "ui".into(),
            character_code: String::new(),
            iso_target_filename: canonical,
            pack_name,
        });
    }

    // Items / Pokemon
    if core.starts_with("It") || core.starts_with("Pk") {
        return Some(ParsedIsoAsset {
            kind: "item".into(),
            character_code: String::new(),
            iso_target_filename: canonical,
            pack_name,
        });
    }

    None
}

/// Run `the-shop-hsd identify` and parse its JSON. Returns `None` on any
/// failure (binary missing, bad exit, malformed JSON) — the caller falls back
/// to filename-only parsing.
pub fn identify_via_tool(binary: &Path, file_path: &Path) -> Option<FileIdentity> {
    let out = Command::new(binary)
        .arg("identify")
        .arg(file_path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice::<FileIdentity>(&out.stdout).ok()
}

/// Top-level identifier: combines file inspection (authoritative for
/// character + kind) with filename parsing (only source for slot + pack name).
///
/// `binary` may be `None` if the resource isn't available (tests, etc.) — we
/// then degrade to pure-filename parsing.
pub fn identify(binary: Option<&Path>, file_path: &Path) -> AppResult<ParsedSkinFilename> {
    let filename = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::BadSkinFilename(file_path.display().to_string()))?
        .to_string();

    let from_file = binary.and_then(|b| identify_via_tool(b, file_path));

    if let Some(id) = &from_file {
        if id.kind != "costume" {
            return Err(AppError::UnsupportedFileKind {
                kind: id.kind.clone(),
            });
        }
    }

    let fn_parts = parse_filename_parts(&filename)?;

    let character_code = if let Some(id) = &from_file {
        if let Some(internal) = &id.character_internal {
            if let Some(def) = slot_codes::lookup_by_internal(internal) {
                if def.code != fn_parts.character_code {
                    if slot_codes::lookup(&fn_parts.character_code).is_some() {
                        return Err(AppError::CharacterMismatch {
                            file_says: def.display.to_string(),
                            filename_says: slot_codes::lookup(&fn_parts.character_code)
                                .map(|d| d.display.to_string())
                                .unwrap_or_else(|| fn_parts.character_code.clone()),
                        });
                    }
                }
                def.code.to_string()
            } else {
                fn_parts.character_code.clone()
            }
        } else {
            fn_parts.character_code.clone()
        }
    } else {
        fn_parts.character_code.clone()
    };

    finalize_from_parts(&character_code, &fn_parts.slot_code, fn_parts.pack_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_named_pack() {
        let p = parse("PlFxNr-TAILS.dat").unwrap();
        assert_eq!(p.character_code, "Fx");
        assert_eq!(p.slot_code, "Nr");
        assert_eq!(p.pack_name.as_deref(), Some("TAILS"));
        assert_eq!(p.iso_target_filename, "PlFxNr.dat");
    }

    #[test]
    fn parses_vanilla_replacement() {
        let p = parse("PlFxNr.dat").unwrap();
        assert_eq!(p.pack_name, None);
        assert_eq!(p.iso_target_filename, "PlFxNr.dat");
    }

    #[test]
    fn rejects_unknown_character() {
        assert!(matches!(
            parse("PlZzNr.dat"),
            Err(AppError::UnknownCharacter(_))
        ));
    }

    #[test]
    fn rejects_unknown_slot_for_character() {
        assert!(matches!(
            parse("PlFxXx.dat"),
            Err(AppError::UnknownSlot { .. })
        ));
    }

    #[test]
    fn rejects_bad_prefix() {
        assert!(matches!(
            parse("FxNr.dat"),
            Err(AppError::BadSkinFilename(_))
        ));
    }

    #[test]
    fn parses_extended_slot() {
        let p = parse("PlFxNr2-COOL.dat").unwrap();
        assert_eq!(p.slot_code, "Nr2");
        assert_eq!(p.iso_target_filename, "PlFxNr2.dat");
        assert_eq!(p.pack_name.as_deref(), Some("COOL"));
    }

    #[test]
    fn parses_extended_slot_two_digits() {
        let p = parse("PlFxOr11-MEGA.dat").unwrap();
        assert_eq!(p.slot_code, "Or11");
        assert_eq!(p.iso_target_filename, "PlFxOr11.dat");
    }

    #[test]
    fn identify_falls_back_to_filename_when_no_tool() {
        let path = std::path::PathBuf::from("PlFcNr-TEST.dat");
        let p = identify(None, &path).unwrap();
        assert_eq!(p.character_code, "Fc");
        assert_eq!(p.character_display, "Falco");
    }
}
