use crate::error::{AppError, AppResult};
use crate::slot_codes;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParsedSkinFilename {
    pub character_code: String,
    pub character_display: String,
    pub slot_code: String,
    pub slot_display: String,
    pub pack_name: Option<String>,
    pub iso_target_filename: String,
}

pub fn parse(filename: &str) -> AppResult<ParsedSkinFilename> {
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

    let slot_letters = &after_char[..2];
    let mut slot_end = 2;
    for ch in after_char[2..].chars() {
        if ch.is_ascii_digit() {
            slot_end += 1;
        } else {
            break;
        }
    }
    let slot_code = &after_char[..slot_end];
    let _ = slot_letters;

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
}
