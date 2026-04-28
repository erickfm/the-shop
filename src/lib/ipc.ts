import { invoke } from "@tauri-apps/api/core";
import type {
  CharacterDef,
  DetectedPaths,
  ImportReport,
  InstallResult,
  IsoInfo,
  ResetReport,
  Settings,
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
  getSkinPreview: (skinFileId: number, withTextures: boolean = true) =>
    invoke<SkinPreviewBundle>("get_skin_preview", { skinFileId, withTextures }),
};

export type SkinPreviewBundle = {
  glb: string;
};
