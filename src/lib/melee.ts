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

// HAL filesystem stage codes derived from the part between "Gr" and the
// extension. The mapping is grounded in the actual asset-name fingerprints
// inside each vanilla file (e.g. GrSt's roots all start with "GrdStory*";
// GrIz's roots start with "GrdIzumi*", Izumi = "spring/fountain" → FoD)
// plus Smashboards' stage-hacking documentation for the N-prefixed
// adventure-mode arenas.
const STAGE_LABELS: Record<string, string> = {
  // Versus stages
  St: "yoshi's story",
  Iz: "fountain of dreams",
  Ps: "pokémon stadium",
  Op: "dream land 64",
  Mc: "mute city",
  Bb: "big blue",
  Te: "hyrule temple",
  Cn: "corneria",
  Ve: "venom",
  Rc: "rainbow cruise",
  Im: "icicle mountain",
  Kg: "kongo jungle 64",
  Kr: "kongo jungle",
  Gb: "great bay",
  Gd: "mushroom kingdom ii",
  Gr: "green greens",
  Hr: "home-run contest",
  Cs: "princess peach's castle",
  Ze: "brinstar",
  Sh: "mushroom kingdom",
  Pu: "pokémon floats",
  Yt: "yoshi's island (past)",
  Oy: "yoshi's island 64",
  Fs: "fourside",
  Fz: "flat zone",
  // Fighter-specific intro/trophy stages: GrT* — handled with prefix below
  // N-prefixed adventure-mode arenas. GrNBa is the actual Battlefield file
  // and GrNLa is the actual Final Destination file — they're not "variants",
  // those are their canonical filenames in vanilla Melee.
  NBa: "battlefield",
  NLa: "final destination",
  NZr: "brinstar (adventure)",
  NKr: "mushroom kingdom (adventure)",
  NPo: "pokémon stadium (adventure)",
  NSr: "underground maze (adventure)",
  NFg: "all-star rest area",
  NBr: "big blue (adventure)",
  // Adventure-only / single-player
  Ok: "kongo jungle (adventure)",
  Ot: "onett",
  He: "all-star heal",
  // Pokémon Stadium transformations (Ps1-4); same name when shown.
  Ps1: "pokémon stadium",
  Ps2: "pokémon stadium",
  Ps3: "pokémon stadium",
  Ps4: "pokémon stadium",
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

// HAL codes for the six legal Slippi ranked stages. These are the
// CANONICAL filenames Melee uses — `NBa` is the actual Battlefield file
// in the ISO (its asset-name fingerprint is "GrdBattle*"), and `NLa` is
// the actual Final Destination ("GrdLast*", literally "Last
// Destination" in Japanese). Common myth that battlefield is `Ba` is
// wrong — that code doesn't exist in the vanilla ISO.
const LEGAL_RANKED_STAGE_CODES = new Set([
  "NBa",  // Battlefield
  "NLa",  // Final Destination
  "St",   // Yoshi's Story
  "Ps",   // Pokémon Stadium (also Ps1-Ps4 transformations)
  "Op",   // Dream Land 64
  "Iz",   // Fountain of Dreams (Izumi = spring)
]);

/// True iff the given iso_target_filename targets a legal Slippi ranked
/// stage. Useful for surfacing "this WILL desync ranked" rather than the
/// weaker unranked-only risk.
export function isLegalRankedStage(
  isoTargetFilename: string | null | undefined,
): boolean {
  if (!isoTargetFilename) return false;
  const m = isoTargetFilename.match(/^Gr(.+?)\.(?:dat|usd)$/i);
  if (!m) return false;
  return LEGAL_RANKED_STAGE_CODES.has(m[1]);
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
