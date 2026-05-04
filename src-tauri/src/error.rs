use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("vanilla ISO is not configured")]
    IsoNotConfigured,
    #[error("vanilla ISO not found at {0}")]
    IsoMissing(String),
    #[error("ISO read error: {0}")]
    IsoRead(String),
    #[error("ISO write error: {0}")]
    IsoWrite(String),
    #[error("Slippi Launcher install was not located")]
    SlippiNotLocated,
    #[error("Slippi Launcher settings file not found at {0}")]
    SlippiConfigNotFound(String),
    #[error("Slippi Launcher settings parse failure: {0}")]
    SlippiConfigParse(String),
    #[error("filename '{0}' does not match Pl{{Char}}{{Slot}}[-{{Name}}].dat")]
    BadSkinFilename(String),
    #[error("unknown character code '{0}' (parsed from filename)")]
    UnknownCharacter(String),
    #[error("unknown slot code '{slot}' for character '{character}'")]
    UnknownSlot { character: String, slot: String },
    #[error("file kind '{kind}' is not yet supported (skin imports only)")]
    UnsupportedFileKind { kind: String },
    #[error("file's internal character ('{file_says}') disagrees with filename ('{filename_says}')")]
    CharacterMismatch {
        file_says: String,
        filename_says: String,
    },
    #[error("slot conflict: {character}/{slot} is already occupied by {existing}")]
    SlotConflict {
        character: String,
        slot: String,
        existing: String,
    },
    #[error("database error: {0}")]
    Db(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("json parse error: {0}")]
    Json(String),
    #[error("{0}")]
    Other(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        // Generic serde_json failures are NOT slippi-config failures — that
        // mapping was wrong and made every JSON glitch in the app report as
        // a Slippi Launcher settings error. Slippi-config-specific call sites
        // construct AppError::SlippiConfigParse directly.
        AppError::Json(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Wire<'a> {
            kind: &'a str,
            message: String,
        }
        let kind = match self {
            AppError::IsoNotConfigured => "IsoNotConfigured",
            AppError::IsoMissing(_) => "IsoMissing",
            AppError::IsoRead(_) => "IsoRead",
            AppError::IsoWrite(_) => "IsoWrite",
            AppError::SlippiNotLocated => "SlippiNotLocated",
            AppError::SlippiConfigNotFound(_) => "SlippiConfigNotFound",
            AppError::SlippiConfigParse(_) => "SlippiConfigParse",
            AppError::BadSkinFilename(_) => "BadSkinFilename",
            AppError::UnknownCharacter(_) => "UnknownCharacter",
            AppError::UnknownSlot { .. } => "UnknownSlot",
            AppError::UnsupportedFileKind { .. } => "UnsupportedFileKind",
            AppError::CharacterMismatch { .. } => "CharacterMismatch",
            AppError::SlotConflict { .. } => "SlotConflict",
            AppError::Db(_) => "Db",
            AppError::Io(_) => "Io",
            AppError::Json(_) => "Json",
            AppError::Other(_) => "Other",
        };
        Wire {
            kind,
            message: self.to_string(),
        }
        .serialize(s)
    }
}

pub type AppResult<T> = Result<T, AppError>;
