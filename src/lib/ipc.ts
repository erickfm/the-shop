import { invoke } from "@tauri-apps/api/core";
import type {
  AnnotatedCreator,
  AnnotatedSkin,
  IndexedPack,
  BackedCreator,
  BrowserConnectResult,
  BrowserProbe,
  BulkDeleteReport,
  CharacterDef,
  CreatorStashResult,
  DeletePackReport,
  DetectedPaths,
  ImportReport,
  InstallResult,
  IsoAssetRow,
  IsoInfo,
  AssetInstallResult,
  PatreonBulkInstallResult,
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
  deleteSkinPack: (characterCode: string, packName: string) =>
    invoke<DeletePackReport>("delete_skin_pack", { characterCode, packName }),
  deleteSkinPacksBulk: (source?: "manual" | "patreon") =>
    invoke<BulkDeleteReport>("delete_skin_packs_bulk", { source: source ?? null }),
  uninstallSkinPacksBulk: (source?: "manual" | "patreon") =>
    invoke<BulkDeleteReport>("uninstall_skin_packs_bulk", { source: source ?? null }),
  listIsoAssets: () => invoke<IsoAssetRow[]>("list_iso_assets"),
  installIsoAssetFromFile: (skinFileId: number) =>
    invoke<AssetInstallResult>("install_iso_asset_from_file", { skinFileId }),
  uninstallIsoAsset: (isoTargetFilename: string) =>
    invoke<void>("uninstall_iso_asset_cmd", { isoTargetFilename }),
  deleteIsoAsset: (skinFileId: number) =>
    invoke<void>("delete_iso_asset_cmd", { skinFileId }),
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
  refreshViewablePosts: () => invoke<number>("refresh_viewable_posts"),
  refreshSkinIndex: () => invoke<SkinIndex>("refresh_skin_index"),
  listSkinIndex: () => invoke<AnnotatedSkin[]>("list_skin_index"),
  listIndexedPacks: () => invoke<IndexedPack[]>("list_indexed_packs"),
  listIndexedCreators: () =>
    invoke<AnnotatedCreator[]>("list_indexed_creators"),
  downloadAllFromCreator: (creatorId: string) =>
    invoke<CreatorStashResult>("download_all_from_creator", { creatorId }),
  installPatreonSkin: (skinId: string) =>
    invoke<PatreonInstallResult>("install_patreon_skin", { skinId }),
  installPatreonSkinsBulk: (skinIds: string[]) =>
    invoke<PatreonBulkInstallResult>("install_patreon_skins_bulk", { skinIds }),
};
