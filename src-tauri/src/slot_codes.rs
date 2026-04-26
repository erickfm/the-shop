use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy)]
pub struct CharacterDef {
    pub code: &'static str,
    pub display: &'static str,
    pub slots: &'static [(&'static str, &'static str)],
}

const CHARACTERS: &[CharacterDef] = &[
    CharacterDef {
        code: "Mr",
        display: "Mario",
        slots: &[
            ("Nr", "Default"),
            ("Ye", "Yellow"),
            ("Bk", "Black"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Fx",
        display: "Fox",
        slots: &[
            ("Nr", "Default"),
            ("Or", "Orange"),
            ("La", "Lavender"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Ca",
        display: "Captain Falcon",
        slots: &[
            ("Nr", "Default"),
            ("Bk", "Black"),
            ("Re", "Red"),
            ("Wh", "White"),
            ("Gr", "Green"),
            ("Bu", "Blue"),
        ],
    },
    CharacterDef {
        code: "Dk",
        display: "Donkey Kong",
        slots: &[
            ("Nr", "Default"),
            ("Bk", "Black"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Kb",
        display: "Kirby",
        slots: &[
            ("Nr", "Default"),
            ("Ye", "Yellow"),
            ("Bu", "Blue"),
            ("Re", "Red"),
            ("Gr", "Green"),
            ("Wh", "White"),
        ],
    },
    CharacterDef {
        code: "Kp",
        display: "Bowser",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Bk", "Black"),
        ],
    },
    CharacterDef {
        code: "Lk",
        display: "Link",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Bk", "Black"),
            ("Wh", "White"),
        ],
    },
    CharacterDef {
        code: "Ss",
        display: "Samus",
        slots: &[
            ("Nr", "Default"),
            ("Pi", "Pink"),
            ("Bk", "Black"),
            ("Gr", "Green"),
            ("La", "Lavender"),
        ],
    },
    CharacterDef {
        code: "Ys",
        display: "Yoshi",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Ye", "Yellow"),
            ("Pi", "Pink"),
            ("Aq", "Cyan"),
        ],
    },
    CharacterDef {
        code: "Pk",
        display: "Pikachu",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Lg",
        display: "Luigi",
        slots: &[
            ("Nr", "Default"),
            ("Wh", "White"),
            ("Aq", "Cyan"),
            ("Pi", "Pink"),
        ],
    },
    CharacterDef {
        code: "Nn",
        display: "Ness",
        slots: &[
            ("Nr", "Default"),
            ("Ye", "Yellow"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Gw",
        display: "Mr. Game & Watch",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Pe",
        display: "Peach",
        slots: &[
            ("Nr", "Default"),
            ("Ye", "Yellow"),
            ("Wh", "White"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Pr",
        display: "Jigglypuff",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
            ("Ye", "Yellow"),
        ],
    },
    CharacterDef {
        code: "Pp",
        display: "Mewtwo",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Mt",
        display: "Marth",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Gr", "Green"),
            ("Bk", "Black"),
            ("Wh", "White"),
        ],
    },
    CharacterDef {
        code: "Cl",
        display: "Roy",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
            ("Ye", "Yellow"),
        ],
    },
    CharacterDef {
        code: "Fc",
        display: "Falco",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Sk",
        display: "Sheik",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
            ("Wh", "White"),
        ],
    },
    CharacterDef {
        code: "Zd",
        display: "Zelda",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
            ("Wh", "White"),
        ],
    },
    CharacterDef {
        code: "Pc",
        display: "Pichu",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
        ],
    },
    CharacterDef {
        code: "Gn",
        display: "Ganondorf",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
            ("La", "Lavender"),
        ],
    },
    CharacterDef {
        code: "Ic",
        display: "Ice Climbers",
        slots: &[
            ("Nr", "Default"),
            ("Gr", "Green"),
            ("Or", "Orange"),
            ("Re", "Red"),
        ],
    },
    CharacterDef {
        code: "Ne",
        display: "Young Link",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Wh", "White"),
            ("Bk", "Black"),
        ],
    },
    CharacterDef {
        code: "Mh",
        display: "Dr. Mario",
        slots: &[
            ("Nr", "Default"),
            ("Re", "Red"),
            ("Bu", "Blue"),
            ("Gr", "Green"),
            ("Bk", "Black"),
        ],
    },
];

static INDEX: OnceLock<HashMap<&'static str, &'static CharacterDef>> = OnceLock::new();

fn index() -> &'static HashMap<&'static str, &'static CharacterDef> {
    INDEX.get_or_init(|| CHARACTERS.iter().map(|c| (c.code, c)).collect())
}

pub fn lookup(code: &str) -> Option<&'static CharacterDef> {
    index().get(code).copied()
}

pub fn slot_display(character_code: &str, slot_code: &str) -> Option<&'static str> {
    let c = lookup(character_code)?;
    if let Some(disp) = c.slots.iter().find(|(s, _)| *s == slot_code).map(|(_, d)| *d) {
        return Some(disp);
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum SlotKind {
    Vanilla,
    Extended,
}

pub fn slot_kind(slot_code: &str) -> SlotKind {
    if slot_code.chars().any(|c| c.is_ascii_digit()) {
        SlotKind::Extended
    } else {
        SlotKind::Vanilla
    }
}

pub fn slot_base(slot_code: &str) -> &str {
    let end = slot_code
        .chars()
        .position(|c| c.is_ascii_digit())
        .unwrap_or(slot_code.len());
    &slot_code[..end]
}

pub const MAX_EXTENDED_INDEX: u32 = 11;

pub fn extended_slot_codes_for_base(base: &str) -> Vec<String> {
    (2..=MAX_EXTENDED_INDEX)
        .map(|n| format!("{base}{n}"))
        .collect()
}

pub fn all() -> &'static [CharacterDef] {
    CHARACTERS
}
