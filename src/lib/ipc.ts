import { invoke } from "@tauri-apps/api/core";
import type {
  AnnotatedCreator,
  AnnotatedSkin,
  BackedCreator,
  BrowserConnectResult,
  BrowserProbe,
  CharacterDef,
  DetectedPaths,
  ImportReport,
  InstallResult,
  IsoInfo,
  PatreonInstallResult,
  PatreonStatus,
  ResetReport,
  Settings,
  SkinIndex,
  SkinPack,
  UninstallResult,
} from "./types";

export const ipc = {
  detectPaths: () => invoke<DetectedPaths>("detect_paths"),
  getSettings: () => invoke<Settings>("get_settings"),
  setVanillaIsoPath: (path: string) =>
    invoke<IsoInfo>("set_vanilla_iso_path", { path }),
  setSlippiLauncherExecutable: (path: string) =>
    invoke<void>("set_slippi_launcher_executable", { path }),
  setSlippiUserDir: (path: string) =>
    invoke<void>("set_slippi_user_dir", { path }),
  listSkinPacks: () => invoke<SkinPack[]>("list_skin_packs"),
  listCharacters: () => invoke<CharacterDef[]>("list_characters"),
  importSkinFiles: (paths: string[]) =>
    invoke<ImportReport>("import_skin_files", { pathsIn: paths }),
  installPack: (character: string, packName: string) =>
    invoke<InstallResult>("install_pack", { character, packName }),
  uninstallPack: (character: string, packName: string) =>
    invoke<UninstallResult>("uninstall_pack", { character, packName }),
  resetToVanilla: () => invoke<ResetReport>("reset_to_vanilla"),
  launchSlippi: () => invoke<void>("launch_slippi"),

  patreonConnect: () => invoke<void>("patreon_connect"),
  patreonConnectViaBrowser: (preferBrowser?: string) =>
    invoke<BrowserConnectResult>("patreon_connect_via_browser", {
      preferBrowser: preferBrowser ?? null,
    }),
  detectBrowsersWithPatreon: () =>
    invoke<BrowserProbe[]>("detect_browsers_with_patreon"),
  patreonStatus: () => invoke<PatreonStatus>("patreon_status"),
  patreonDisconnect: () => invoke<void>("patreon_disconnect"),
  listBackedCreators: (forceRefresh = false) =>
    invoke<BackedCreator[]>("list_backed_creators", { forceRefresh }),
  refreshSkinIndex: () => invoke<SkinIndex>("refresh_skin_index"),
  listSkinIndex: () => invoke<AnnotatedSkin[]>("list_skin_index"),
  listIndexedCreators: () =>
    invoke<AnnotatedCreator[]>("list_indexed_creators"),
  installPatreonSkin: (skinId: string) =>
    invoke<PatreonInstallResult>("install_patreon_skin", { skinId }),
};
