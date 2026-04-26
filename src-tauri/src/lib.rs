mod db;
mod error;
mod install;
mod iso;
mod iso_patch;
mod launch;
mod library;
mod manifest;
mod mex;
mod paths;
mod reset;
mod slippi_config;
mod slot_codes;

use db::Db;
use error::AppResult;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

const VANILLA_ISO_KEY: &str = "vanilla_iso_path";
const LAUNCHER_KEY: &str = "slippi_launcher_executable";
const SLIPPI_USER_DIR_KEY: &str = "slippi_user_dir";
const MEX_BASE_KEY: &str = "mex_base_iso_path";

struct AppState {
    db: Arc<Db>,
}

#[derive(serde::Serialize)]
struct DetectedPaths {
    slippi_user_dir: Option<String>,
    slippi_launcher_executable: Option<String>,
    project_root: Option<String>,
    project_root_dat_files: Vec<String>,
}

#[derive(serde::Serialize)]
struct Settings {
    vanilla_iso_path: Option<String>,
    vanilla_iso: Option<iso::IsoInfo>,
    slippi_launcher_executable: Option<String>,
    slippi_user_dir: Option<String>,
    current_slippi_iso_path: Option<String>,
    patched_iso_path: String,
    skins_dir: String,
    mex_base_iso_path: Option<String>,
    mex_base_active: bool,
    gecko_ini_path: Option<String>,
}

#[tauri::command]
fn detect_paths() -> DetectedPaths {
    let project_root = paths::project_root_for_imports();
    let project_root_dat_files = project_root
        .as_ref()
        .map(|p| {
            std::fs::read_dir(p)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|x| x == "dat" || x == "usd")
                        .unwrap_or(false)
                })
                .filter_map(|e| e.path().to_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    DetectedPaths {
        slippi_user_dir: paths::default_slippi_user_dir().map(|p| p.display().to_string()),
        slippi_launcher_executable: paths::default_slippi_launcher_executable()
            .map(|p| p.display().to_string()),
        project_root: project_root.map(|p| p.display().to_string()),
        project_root_dat_files,
    }
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    let vanilla_iso_path = state.db.get_setting(VANILLA_ISO_KEY)?;
    let vanilla_iso = match vanilla_iso_path.as_ref() {
        Some(p) => iso::inspect(std::path::Path::new(p)).ok(),
        None => None,
    };
    let mex_base_iso_path = state.db.get_setting(MEX_BASE_KEY)?;
    let mex_base_active = mex_base_iso_path
        .as_ref()
        .map(|p| std::path::Path::new(p).exists())
        .unwrap_or(false);
    let working_for_patched = if mex_base_active {
        mex_base_iso_path.clone()
    } else {
        vanilla_iso_path.clone()
    };
    let patched_iso_path = working_for_patched
        .as_ref()
        .and_then(|p| paths::patched_iso_path_for(std::path::Path::new(p)))
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "(set vanilla ISO to determine)".into());
    Ok(Settings {
        vanilla_iso_path,
        vanilla_iso,
        slippi_launcher_executable: state.db.get_setting(LAUNCHER_KEY)?.or_else(|| {
            paths::default_slippi_launcher_executable().map(|p| p.display().to_string())
        }),
        slippi_user_dir: state.db.get_setting(SLIPPI_USER_DIR_KEY)?.or_else(|| {
            paths::default_slippi_user_dir().map(|p| p.display().to_string())
        }),
        current_slippi_iso_path: slippi_config::read_iso_path().unwrap_or(None),
        patched_iso_path,
        skins_dir: paths::skins_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        mex_base_iso_path,
        mex_base_active,
        gecko_ini_path: mex::user_gecko_ini_path().map(|p| p.display().to_string()),
    })
}

#[tauri::command]
fn set_vanilla_iso_path(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<iso::IsoInfo> {
    let p = std::path::Path::new(&path);
    let info = iso::inspect(p)?;
    state.db.set_setting(VANILLA_ISO_KEY, &path)?;
    Ok(info)
}

#[tauri::command]
fn set_slippi_launcher_executable(state: State<'_, AppState>, path: String) -> AppResult<()> {
    state.db.set_setting(LAUNCHER_KEY, &path)?;
    Ok(())
}

#[tauri::command]
fn set_slippi_user_dir(state: State<'_, AppState>, path: String) -> AppResult<()> {
    state.db.set_setting(SLIPPI_USER_DIR_KEY, &path)?;
    Ok(())
}

#[tauri::command]
fn list_skin_packs(state: State<'_, AppState>) -> AppResult<Vec<library::SkinPack>> {
    library::list_packs(&state.db)
}

#[tauri::command]
fn list_characters() -> Vec<serde_json::Value> {
    slot_codes::all()
        .iter()
        .map(|c| {
            let vanilla_slots: Vec<_> = c
                .slots
                .iter()
                .map(|(k, d)| {
                    serde_json::json!({
                        "code": k,
                        "display": d,
                        "kind": "vanilla",
                    })
                })
                .collect();
            let extended_slots: Vec<_> = c
                .slots
                .iter()
                .flat_map(|(k, d)| {
                    slot_codes::extended_slot_codes_for_base(k)
                        .into_iter()
                        .enumerate()
                        .map(move |(idx, code)| {
                            serde_json::json!({
                                "code": code,
                                "display": format!("{d} ext {}", idx + 2),
                                "kind": "extended",
                            })
                        })
                })
                .collect();
            serde_json::json!({
                "code": c.code,
                "display": c.display,
                "slots": vanilla_slots,
                "extended_slots": extended_slots,
            })
        })
        .collect()
}

#[tauri::command]
fn apply_mex_template(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> AppResult<install::InstallResult> {
    use error::AppError;
    let vanilla_path = state
        .db
        .get_setting(VANILLA_ISO_KEY)?
        .ok_or(AppError::IsoNotConfigured)?;
    let vanilla = std::path::PathBuf::from(&vanilla_path);
    if !vanilla.exists() {
        return Err(AppError::IsoMissing(vanilla_path));
    }
    let resource_dir = app.path().resource_dir().map_err(|e| {
        AppError::Other(format!("resource_dir: {e}"))
    })?;
    let xdelta = mex::template_xdelta_path(&resource_dir);
    let xdelta = if xdelta.exists() {
        xdelta
    } else {
        mex::fallback_dev_xdelta_path()
            .ok_or_else(|| AppError::Other("bundled m-ex .xdelta not found".into()))?
    };
    let out = vanilla
        .parent()
        .ok_or_else(|| AppError::Other("vanilla has no parent".into()))?
        .join("the-shop-mex-base.iso");
    mex::apply_bundled_template(&vanilla, &xdelta, &out)?;
    state.db.set_setting(MEX_BASE_KEY, &out.display().to_string())?;
    if let Err(e) = mex::install_required_gecko_code() {
        eprintln!("[the-shop] gecko code install warning: {e:?}");
    }
    Ok(install::InstallResult {
        installed_slots: vec![],
        skipped_slots: vec![],
        patched_iso_path: out.display().to_string(),
        previous_slippi_iso: None,
    })
}

#[tauri::command]
fn revert_mex_base(state: State<'_, AppState>) -> AppResult<()> {
    if let Some(p) = state.db.get_setting(MEX_BASE_KEY)? {
        let _ = std::fs::remove_file(&p);
    }
    state.db.clear_setting(MEX_BASE_KEY)?;
    let _ = mex::uninstall_required_gecko_code();
    Ok(())
}

#[tauri::command]
fn import_skin_files(
    state: State<'_, AppState>,
    paths_in: Vec<String>,
) -> AppResult<library::ImportReport> {
    let pbs: Vec<PathBuf> = paths_in.into_iter().map(PathBuf::from).collect();
    library::import_files(&state.db, &pbs)
}

#[tauri::command]
fn install_pack(
    state: State<'_, AppState>,
    character: String,
    pack_name: String,
) -> AppResult<install::InstallResult> {
    install::install_pack(&state.db, &character, &pack_name)
}

#[tauri::command]
fn uninstall_pack(
    state: State<'_, AppState>,
    character: String,
    pack_name: String,
) -> AppResult<install::UninstallResult> {
    install::uninstall_pack(&state.db, &character, &pack_name)
}

#[tauri::command]
fn reset_to_vanilla(state: State<'_, AppState>) -> AppResult<reset::ResetReport> {
    reset::reset_to_vanilla(&state.db)
}

#[tauri::command]
fn launch_slippi(state: State<'_, AppState>) -> AppResult<()> {
    launch::launch(&state.db)
}

fn reconcile_on_startup(db: &Db) {
    let vanilla = match db.get_setting(VANILLA_ISO_KEY) {
        Ok(Some(v)) => v,
        _ => return,
    };
    let patched = match paths::patched_iso_path_for(std::path::Path::new(&vanilla)) {
        Some(p) => p,
        None => return,
    };
    if patched.exists() {
        return;
    }
    let _ = db.with_conn(|c| {
        c.execute("DELETE FROM installed_pack", [])?;
        Ok(())
    });
    let _ = db.clear_setting("original_slippi_iso_path");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let db_path = paths::db_path()?;
            let db = Db::open(&db_path).map_err(|e| Box::<dyn std::error::Error>::from(format!("{e}")))?;
            reconcile_on_startup(&db);
            app.manage(AppState { db: Arc::new(db) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_paths,
            get_settings,
            set_vanilla_iso_path,
            set_slippi_launcher_executable,
            set_slippi_user_dir,
            list_skin_packs,
            list_characters,
            import_skin_files,
            install_pack,
            uninstall_pack,
            reset_to_vanilla,
            launch_slippi,
            apply_mex_template,
            revert_mex_base,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
