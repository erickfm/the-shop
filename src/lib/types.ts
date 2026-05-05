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
  source: "manual" | "patreon";
  source_creator_id: string | null;
  source_creator_display: string | null;
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

export type DeletePackReport = {
  character_code: string;
  pack_name: string;
  files_removed: number;
  uninstalled: boolean;
};

export type BulkDeleteReport = {
  packs_removed: number;
  files_removed: number;
  uninstalled_any: boolean;
};

export type IsoAssetRow = {
  id: number;
  filename: string;
  kind: string;
  iso_target_filename: string;
  character_code: string;
  pack_name: string;
  source: "manual" | "patreon";
  source_creator_display: string | null;
  installed: boolean;
  source_path: string;
  size_bytes: number;
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

export type PatreonUser = {
  id: string;
  name: string;
  avatar_url: string | null;
};

export type PatreonStatus = {
  connected: boolean;
  user: PatreonUser | null;
  last_verified_at: number | null;
};

export type BackedCreator = {
  campaign_id: string;
  campaign_name: string;
  campaign_url: string | null;
  creator_avatar_url: string | null;
  patron_status: string | null;
  currently_entitled_amount_cents: number;
  is_follower: boolean;
  tier_titles: string[];
};

export type IndexedCreator = {
  id: string;
  display_name: string;
  patreon_campaign_id: string;
  patreon_url: string;
  tagline: string | null;
  avatar_url: string | null;
};

export type SkinKind =
  | "character_skin"
  | "stage"
  | "music"
  | "effect"
  | "animation"
  | "ui"
  | "item"
  | "texture_pack";

export type IndexedSkinEntry = {
  id: string;
  creator_id: string;
  display_name: string;
  kind: SkinKind;
  iso_target_filename: string | null;
  inner_filename: string | null;
  character_code: string;
  slot_code: string;
  patreon_post_id: string;
  filename_in_post: string;
  tier_required_cents: number;
  sha256: string | null;
  preview_url: string | null;
  preview_urls: string[];
  pack_id: string;
  pack_display_name: string | null;
  notes: string | null;
};

export type AnnotatedSkin = IndexedSkinEntry & {
  creator: IndexedCreator | null;
  backed: boolean;
  current_tier_cents: number;
  tier_satisfied: boolean;
  installed: boolean;
};

export type AnnotatedCreator = IndexedCreator & {
  backed: boolean;
  current_tier_cents: number;
  skin_count: number;
};

export type IndexedPack = {
  pack_id: string;
  display_name: string;
  kind: SkinKind;
  creator: IndexedCreator | null;
  creator_id: string;
  character_code: string;
  patreon_post_id: string;
  tier_required_cents: number;
  preview_url: string | null;
  preview_urls: string[];
  slots: AnnotatedSkin[];
  backed: boolean;
  current_tier_cents: number;
  any_tier_satisfied: boolean;
  installed_count: number;
  slot_count: number;
  filename_in_post: string;
};

export type SkinIndex = {
  schema_version: number;
  creators: IndexedCreator[];
  skins: IndexedSkinEntry[];
};

export type AssetInstallResult = {
  iso_target_filename: string;
  patched_iso_path: string;
  previous_slippi_iso: string | null;
};

export type TexturePackInstallResult = {
  install_dir: string;
  bytes_copied: number;
  file_count: number;
};

export type PatreonInstallOutcome =
  | ({ kind: "character_skin" } & InstallResult)
  | ({ kind: "iso_asset" } & AssetInstallResult)
  | ({ kind: "texture_pack" } & TexturePackInstallResult);

export type PatreonInstallResult = {
  skin_id: string;
  bytes: number;
  outcome: PatreonInstallOutcome;
};

export type BulkInstallFailure = {
  skin_id: string;
  error: string;
};

export type PatreonBulkInstallResult = {
  installed: PatreonInstallResult[];
  failed: BulkInstallFailure[];
  iso_rebuilt: boolean;
};

export type BrowserConnectResult = {
  user: PatreonUser;
  browser: string;
};

export type BrowserProbe = {
  browser: string;
  has_session_cookie: boolean;
  error: string | null;
};
