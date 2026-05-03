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

export type IndexedSkinEntry = {
  id: string;
  creator_id: string;
  display_name: string;
  character_code: string;
  slot_code: string;
  patreon_post_id: string;
  filename_in_post: string;
  tier_required_cents: number;
  sha256: string | null;
  preview_url: string | null;
  notes: string | null;
};

export type AnnotatedSkin = IndexedSkinEntry & {
  creator: IndexedCreator | null;
  backed: boolean;
  current_tier_cents: number;
  tier_satisfied: boolean;
  installed: boolean;
};

export type SkinIndex = {
  schema_version: number;
  creators: IndexedCreator[];
  skins: IndexedSkinEntry[];
};

export type PatreonInstallResult = {
  skin_id: string;
  bytes: number;
  install: InstallResult;
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
