// HAL filesystem character codes — the 2-letter codes inside file names
// like `PlFcBu.dat`, `EfFxData.dat`. These are what the texture-index uses.
// Note: these differ from HSDLib's UI codes (Marth=Mt, Roy=Cl, etc.) because
// HSDLib's codes don't match the actual ISO file names. The texture-index is
// authoritative; HSDLib's mapping is only used for thumbnail/badge lookups.
const CHARACTER_LABELS_HAL: Record<string, string> = {
  Mr: "mario",
  Lg: "luigi",
  Pe: "peach",
  Ys: "yoshi",
  Dk: "donkey kong",
  Kp: "bowser",
  Pk: "pikachu",
  Pc: "pichu",
  Fx: "fox",
  Fc: "falco",
  Ca: "captain falcon",
  Gn: "ganondorf",
  Sk: "sheik",
  Zd: "zelda",
  Lk: "link",
  Cl: "young link",
  Ss: "samus",
  Pr: "jigglypuff",
  Mt: "mewtwo",
  Pp: "popo",
  Nn: "nana",
  Ms: "marth",
  Fe: "roy",
  Ne: "ness",
  Kb: "kirby",
  Gw: "mr. game & watch",
  Dr: "dr. mario",
};

export function characterDisplay(code: string | null | undefined): string {
  if (!code) return "";
  return CHARACTER_LABELS_HAL[code] ?? code;
}

const SLOT_LABELS: Record<string, string> = {
  Nr: "default",
  Re: "red",
  Bu: "blue",
  Gr: "green",
  Or: "orange",
  Ye: "yellow",
  Aq: "aqua",
  Wh: "white",
  Bk: "black",
  La: "lavender",
  Pi: "pink",
  Gy: "grey",
};

export function slotDisplay(code: string | null | undefined): string {
  if (!code) return "";
  return SLOT_LABELS[code] ?? code;
}

// Stage codes pulled from `iso_target_filename` — the part between `Gr` and
// `.dat`/`.usd`. We only label codes we've verified; unknown codes fall
// through to the raw filename so the UI degrades gracefully.
const STAGE_LABELS: Record<string, string> = {
  Iz: "icicle mountain",
  Ps: "pokémon stadium",
  St: "yoshi's story",
  Op: "onett",
  Ba: "battlefield",
  Bf: "battlefield",
  Fn: "final destination",
  Fs: "final destination",
  Fz: "fountain of dreams",
  Mc: "mute city",
  Te: "temple",
  Cs: "corneria",
  Ve: "venom",
  Rc: "rainbow cruise",
  Yj: "yoshi's island (n64)",
  Kg: "kongo jungle (n64)",
  Kr: "kongo jungle",
  Gb: "great bay",
  Gd: "green greens",
  Gr: "green greens",
  Px: "princess peach's castle",
  Im: "icicle mountain",
  Hr: "home-run contest",
  // N-prefixed codes are commonly Animelee / training-mode / new variants
  // of standard stages — we keep them but label as "(variant)" until verified.
  NBa: "battlefield (variant)",
  NFn: "final destination (variant)",
  NLa: "stage (nla variant)",
  NZr: "stage (nzr variant)",
};

/// Returns a human-readable stage name given the iso_target_filename
/// (e.g. "grfs.usd" -> "final destination") or the raw filename if we don't
/// recognize the code yet.
export function stageDisplay(isoTargetFilename: string | null | undefined): string {
  if (!isoTargetFilename) return "";
  // Strip "gr" prefix and ".dat"/".usd" suffix.
  const m = isoTargetFilename.match(/^Gr(.+?)\.(?:dat|usd)$/i);
  if (!m) return isoTargetFilename;
  const code = m[1];
  return STAGE_LABELS[code] ?? isoTargetFilename;
}

/// All the slot/color tokens we recognize as "this is just naming the slot,
/// not part of the skin's identity." Used by `stripColorSuffix` so titles
/// don't repeat the info that already lives in the slot pill.
const COLOR_SUFFIX_TOKENS = new Set([
  // HAL slot codes
  "nr", "re", "bu", "gr", "or", "ye", "aq", "wh", "bk", "la", "pi", "gy",
  // Color words
  "default", "red", "blue", "green", "orange", "yellow", "aqua", "white",
  "black", "lavender", "pink", "grey", "gray", "purple", "neutral",
  // Melee-specific slot colors used by some character roster expansions
  "brown", "indigo", "cyan", "teal", "tan", "magenta",
  // Player slot phrasings
  "player 1", "player 2", "p1", "p2", "1p", "2p",
]);

/// Remove trailing color/slot suffix from a pack title so it doesn't repeat
/// what the slot pill already says. Handles parens-wrapped tokens
/// ("falco (bu)"), separator-prefixed tokens ("falco - red", "falco · blue",
/// "falco | bu"), and a couple of common version tokens that often trail
/// re-uploads. Iterates so compound suffixes ("falco (bu) - v2") fully strip.
/// Defensive — the index *should* already populate `pack_display_name`
/// without these, but the frontend doesn't trust that.
export function stripColorSuffix(name: string): string {
  let s = name.trim();
  for (let i = 0; i < 5; i++) {
    const before = s;
    // Parens-wrapped color/slot at end: "falco (bu)" / "falco (default)"
    s = s.replace(/\s*\(\s*([^()]+)\s*\)\s*$/i, (full, inner) => {
      return COLOR_SUFFIX_TOKENS.has(String(inner).toLowerCase().trim())
        ? ""
        : full;
    });
    // Separator-prefixed color/slot at end: " - Red", " · Default", " | Bu"
    s = s.replace(
      /\s*[-·|,]\s*([A-Za-z][A-Za-z ]*)\s*$/,
      (full, inner) => {
        return COLOR_SUFFIX_TOKENS.has(String(inner).toLowerCase().trim())
          ? ""
          : full;
      },
    );
    // Version tokens: " v2", " (v3)", " - updated"
    s = s.replace(/\s*(\(v\d+\)|v\d+|\(updated\)|- updated)\s*$/i, "");
    s = s.trim().replace(/\s*[-·|,]\s*$/, "").trim();
    if (s === before) break;
  }
  return s.length > 0 ? s : name;
}

/// True iff the entry's `filename_in_post` is an archive that needs unpacking
/// before install. Used as a UI hint and matches the backend's
/// is_zip_archive logic.
export function requiresUnzip(filenameInPost: string): boolean {
  const l = filenameInPost.toLowerCase();
  return l.endsWith(".zip") || l.endsWith(".rar") || l.endsWith(".7z");
}

/// Stable string-hash used to derive per-card random tilts that don't
/// re-roll on every render. Tiny djb2 variant — good enough for evenly
/// distributing rotation values across pack ids.
export function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/// Per-pack rotation driven by pack_id. Returns CSS vars for rest and
/// hover angles. Rest is always 0° (cards sit flat at rest); hover gives
/// each card its own modest tilt (±2–4°) keyed off the id hash, so the
/// only motion is on interaction. Stable per-id so a given card always
/// tilts the same way when hovered.
export function packTilt(id: string): {
  "--tilt-rest": string;
  "--tilt-hover": string;
} {
  const h = hash32(id || "x");
  const hoverMag = 2 + ((h % 1000) / 1000) * 2; // 2.0–4.0°
  const hoverSign = (h & 1) === 0 ? -1 : 1;
  const hover = hoverSign * hoverMag;
  return {
    "--tilt-rest": "0deg",
    "--tilt-hover": `${hover.toFixed(2)}deg`,
  };
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
