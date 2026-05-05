// HAL filesystem character codes — the 2-letter codes inside file names
// like `PlFcBu.dat`, `EfFxData.dat`. These are what the texture-index uses.
// Note: these differ from HSDLib's UI codes (Marth=Mt, Roy=Cl, etc.) because
// HSDLib's codes don't match the actual ISO file names. The texture-index is
// authoritative; HSDLib's mapping is only used for thumbnail/badge lookups.
const CHARACTER_LABELS_HAL: Record<string, string> = {
  Mr: "Mario",
  Lg: "Luigi",
  Pe: "Peach",
  Ys: "Yoshi",
  Dk: "Donkey Kong",
  Kp: "Bowser",
  Pk: "Pikachu",
  Pc: "Pichu",
  Fx: "Fox",
  Fc: "Falco",
  Ca: "Captain Falcon",
  Gn: "Ganondorf",
  Sk: "Sheik",
  Zd: "Zelda",
  Lk: "Link",
  Cl: "Young Link",
  Ss: "Samus",
  Pr: "Jigglypuff",
  Mt: "Mewtwo",
  Pp: "Popo",
  Nn: "Nana",
  Ms: "Marth",
  Fe: "Roy",
  Ne: "Ness",
  Kb: "Kirby",
  Gw: "Mr. Game & Watch",
  Dr: "Dr. Mario",
};

export function characterDisplay(code: string | null | undefined): string {
  if (!code) return "";
  return CHARACTER_LABELS_HAL[code] ?? code;
}

const SLOT_LABELS: Record<string, string> = {
  Nr: "Default",
  Re: "Red",
  Bu: "Blue",
  Gr: "Green",
  Or: "Orange",
  Ye: "Yellow",
  Aq: "Aqua",
  Wh: "White",
  Bk: "Black",
  La: "Lavender",
  Pi: "Pink",
  Gy: "Grey",
};

export function slotDisplay(code: string | null | undefined): string {
  if (!code) return "";
  return SLOT_LABELS[code] ?? code;
}

// Stage codes pulled from `iso_target_filename` — the part between `Gr` and
// `.dat`/`.usd`. We only label codes we've verified; unknown codes fall
// through to the raw filename so the UI degrades gracefully.
const STAGE_LABELS: Record<string, string> = {
  Iz: "Icicle Mountain",
  Ps: "Pokémon Stadium",
  St: "Yoshi's Story",
  Op: "Onett",
  Ba: "Battlefield",
  Bf: "Battlefield",
  Fn: "Final Destination",
  Fs: "Final Destination",
  Fz: "Fountain of Dreams",
  Mc: "Mute City",
  Te: "Temple",
  Cs: "Corneria",
  Ve: "Venom",
  Rc: "Rainbow Cruise",
  Yj: "Yoshi's Island (N64)",
  Kg: "Kongo Jungle (N64)",
  Kr: "Kongo Jungle",
  Gb: "Great Bay",
  Gd: "Green Greens",
  Gr: "Green Greens",
  Px: "Princess Peach's Castle",
  Im: "Icicle Mountain",
  Hr: "Home-Run Contest",
  // N-prefixed codes are commonly Animelee / training-mode / new variants
  // of standard stages — we keep them but label as "(variant)" until verified.
  NBa: "Battlefield (variant)",
  NFn: "Final Destination (variant)",
  NLa: "Stage (NLa variant)",
  NZr: "Stage (NZr variant)",
};

/// Returns a human-readable stage name given the iso_target_filename
/// (e.g. "GrFs.usd" -> "Final Destination") or the raw filename if we don't
/// recognize the code yet.
export function stageDisplay(isoTargetFilename: string | null | undefined): string {
  if (!isoTargetFilename) return "";
  // Strip "Gr" prefix and ".dat"/".usd" suffix.
  const m = isoTargetFilename.match(/^Gr(.+?)\.(?:dat|usd)$/i);
  if (!m) return isoTargetFilename;
  const code = m[1];
  return STAGE_LABELS[code] ?? isoTargetFilename;
}

/// True iff the entry's `filename_in_post` is an archive that needs unpacking
/// before install. Used as a UI hint and matches the backend's
/// is_zip_archive logic.
export function requiresUnzip(filenameInPost: string): boolean {
  const l = filenameInPost.toLowerCase();
  return l.endsWith(".zip") || l.endsWith(".rar") || l.endsWith(".7z");
}

/// Combined preview URLs for a skin entry, deduped, hero first. The index
/// schema has both a singular `preview_url` (legacy / hero) and a `preview_urls`
/// array (gallery). Either may be empty; this returns the union.
export function previewList(skin: {
  preview_url: string | null;
  preview_urls?: string[] | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (skin.preview_url) {
    seen.add(skin.preview_url);
    out.push(skin.preview_url);
  }
  for (const u of skin.preview_urls ?? []) {
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
