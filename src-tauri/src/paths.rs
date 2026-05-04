use std::path::{Path, PathBuf};

pub fn default_slippi_user_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let p = dirs::config_dir()?.join("Slippi Launcher").join("netplay").join("User");
        if p.exists() {
            return Some(p);
        }
        let alt = dirs::config_dir()?.join("Slippi Launcher").join("netplay");
        if alt.exists() {
            return Some(alt.join("User"));
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        let p = dirs::data_dir()?
            .join("Slippi Launcher")
            .join("netplay")
            .join("User");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = dirs::data_dir()?;
        let p = appdata.join("Slippi Launcher").join("netplay").join("User");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

pub fn default_slippi_launcher_executable() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        if let Some(p) = parse_desktop_exec() {
            if p.exists() {
                return Some(p);
            }
        }
        if let Some(home) = dirs::home_dir() {
            for cand in [
                home.join(".local").join("bin").join("slippi"),
                home.join(".local").join("bin").join("slippi-launcher"),
                home.join("Applications").join("slippi-launcher"),
            ] {
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
        for cand in [
            "/usr/bin/slippi",
            "/usr/bin/slippi-launcher",
            "/usr/local/bin/slippi",
            "/usr/local/bin/slippi-launcher",
        ] {
            let p = PathBuf::from(cand);
            if p.exists() {
                return Some(p);
            }
        }
        which("slippi-launcher").or_else(|| which("slippi"))
    }
    #[cfg(target_os = "macos")]
    {
        let p = PathBuf::from("/Applications/Slippi Launcher.app/Contents/MacOS/Slippi Launcher");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir()?;
        let p = local
            .join("Programs")
            .join("slippi-launcher")
            .join("Slippi Launcher.exe");
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn parse_desktop_exec() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".local")
            .join("share")
            .join("applications")
            .join("slippi-launcher.desktop"),
        PathBuf::from("/usr/share/applications/slippi-launcher.desktop"),
        PathBuf::from("/usr/local/share/applications/slippi-launcher.desktop"),
    ];
    for d in candidates {
        if let Ok(s) = std::fs::read_to_string(&d) {
            for line in s.lines() {
                if let Some(rest) = line.strip_prefix("Exec=") {
                    let exe = rest.split_whitespace().next().unwrap_or("");
                    if !exe.is_empty() {
                        return Some(PathBuf::from(exe));
                    }
                }
            }
        }
    }
    None
}

pub fn default_slippi_launcher_settings_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        Some(dirs::config_dir()?.join("Slippi Launcher"))
    }
    #[cfg(target_os = "macos")]
    {
        Some(dirs::data_dir()?.join("Slippi Launcher"))
    }
    #[cfg(target_os = "windows")]
    {
        Some(dirs::data_dir()?.join("Slippi Launcher"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

pub fn app_data_dir() -> std::io::Result<PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no platform data dir")
    })?;
    let dir = base.join("the-shop");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The Dolphin/Slippi runtime texture override directory for Melee. Texture
/// packs land in here as subfolders. Resolved relative to the user's Slippi
/// Launcher netplay user dir, which already varies cross-platform.
///
/// Returns None when we can't resolve the Slippi user dir at all (first-run,
/// no install, etc.) — caller should surface a clear error in that case.
pub fn slippi_textures_dir(user_dir_override: Option<&Path>) -> Option<PathBuf> {
    let base = user_dir_override
        .map(|p| p.to_path_buf())
        .or_else(default_slippi_user_dir)?;
    // The Slippi Dolphin user-dir layout is `<user>/Load/Textures/GALE01/`.
    // Slippi Launcher's "User" dir we resolve above is one level deeper than
    // Dolphin's user root in some installs; on Linux it's the netplay user
    // root directly. Check both.
    let direct = base.join("Load").join("Textures").join("GALE01");
    if direct.exists() {
        return Some(direct);
    }
    let parent_load = base
        .parent()
        .map(|p| p.join("Load").join("Textures").join("GALE01"));
    if let Some(p) = parent_load {
        if p.exists() {
            return Some(p);
        }
    }
    // Default to the direct path even if it doesn't exist yet — we'll
    // create it on first install.
    Some(direct)
}

pub fn skins_dir() -> std::io::Result<PathBuf> {
    let p = app_data_dir()?.join("skins");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn iso_dir() -> std::io::Result<PathBuf> {
    let p = app_data_dir()?.join("iso");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub const PATCHED_ISO_FILENAME: &str = "the-shop-patched.iso";

pub fn patched_iso_path_for(vanilla: &Path) -> Option<PathBuf> {
    vanilla.parent().map(|d| d.join(PATCHED_ISO_FILENAME))
}

pub fn db_path() -> std::io::Result<PathBuf> {
    Ok(app_data_dir()?.join("the-shop.sqlite3"))
}

pub fn project_root_for_imports() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    if cwd.exists() {
        Some(cwd)
    } else {
        None
    }
}

pub fn ensure_parent(p: &Path) -> std::io::Result<()> {
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}
