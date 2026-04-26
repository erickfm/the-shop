use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::paths;
use std::path::PathBuf;
use std::process::Command;

const LAUNCHER_KEY: &str = "slippi_launcher_executable";

pub fn launch(db: &Db) -> AppResult<()> {
    let exe = match db.get_setting(LAUNCHER_KEY)? {
        Some(p) => PathBuf::from(p),
        None => paths::default_slippi_launcher_executable().ok_or(AppError::SlippiNotLocated)?,
    };

    if !exe.exists() {
        return Err(AppError::Other(format!(
            "Slippi Launcher binary not found at {}",
            exe.display()
        )));
    }

    Command::new(&exe)
        .spawn()
        .map_err(|e| AppError::Other(format!("spawn slippi-launcher: {e}")))?;

    Ok(())
}
