export type AppErrorWire = { kind: string; message: string };

export type IsoInfo = {
  path: string;
  size_bytes: number;
  sha256: string;
  recognized: string | null;
};

export type DetectedPaths = {
  slippi_user_dir: string | null;
  slippi_launcher_executable: string | null;
  project_root: string | null;
  project_root_dat_files: string[];
};

export type Settings = {
  vanilla_iso_path: string | null;
  vanilla_iso: IsoInfo | null;
  slippi_launcher_executable: string | null;
  slippi_user_dir: string | null;
  current_slippi_iso_path: string | null;
  patched_iso_path: string;
  skins_dir: string;
};

export type SlotEntry = {
  code: string;
  display: string;
  kind: "vanilla" | "extended";
};

export type CharacterDef = {
  code: string;
  display: string;
  slots: SlotEntry[];
  extended_slots: SlotEntry[];
};

export type PackSlot = {
  slot_code: string;
  slot_display: string;
  skin_file_id: number;
  source_path: string;
  installed: boolean;
  actual_slot_code: string | null;
};

export type SkinPack = {
  character_code: string;
  character_display: string;
  pack_name: string;
  slots: PackSlot[];
  fully_installed: boolean;
  partially_installed: boolean;
};

export type ImportFailure = {
  filename: string;
  error: string;
};

export type ImportReport = {
  imported: number;
  skipped_duplicates: number;
  failed: ImportFailure[];
};

export type SkippedSlot = {
  slot_code: string;
  reason: string;
};

export type InstalledSlot = {
  requested_slot_code: string;
  actual_slot_code: string;
  routed: boolean;
};

export type InstallResult = {
  installed_slots: InstalledSlot[];
  skipped_slots: SkippedSlot[];
  patched_iso_path: string;
  previous_slippi_iso: string | null;
};

export type UninstallResult = {
  restored_slots: string[];
  patched_iso_remaining: boolean;
  slippi_reverted_to: string | null;
};

export type ResetReport = {
  patched_iso_removed: boolean;
  slippi_reverted_to: string | null;
  packs_uninstalled: number;
};
