#!/usr/bin/env python3
"""build-index.py — generic Patreon → texture-index/index.json builder.

Reads your `session_id` cookie from the-shop's local SQLite DB
(`~/.local/share/the-shop/the-shop.sqlite3`), enumerates a creator's
Patreon posts, builds `IndexedSkinEntry` rows from any attachments
matching HAL filename patterns (`Pl{Char}{Slot}.dat`, `EfXxData.dat`,
`Gr*.dat`, `Mn*.usd`, etc.), groups slot-variants into packs, and
merges the result into `texture-index/index.json`.

Usage:
    ./tools/build-index.py <patreon-url-or-campaign-id-or-creator-id> [--dry-run]

Examples:
    ./tools/build-index.py https://www.patreon.com/c/u75468522/home
    ./tools/build-index.py 9896888
    ./tools/build-index.py gay_lord_erika

Idempotent — re-running for the same creator replaces that creator's
skin entries; other creators are untouched.

Stdlib only — no pip install.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

# ─── paths ───────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_PATH = REPO_ROOT / "texture-index" / "index.json"
DB_CANDIDATES = [
    Path.home() / ".local/share/the-shop/the-shop.sqlite3",  # Linux
    Path.home() / "Library/Application Support/the-shop/the-shop.sqlite3",  # macOS
    Path(os.environ.get("APPDATA", "")) / "the-shop/the-shop.sqlite3",  # Windows
]
HSD_TOOL = REPO_ROOT / "src-tauri" / "resources" / "hsd-tool" / "the-shop-hsd"
VANILLA_CACHE_DIR = REPO_ROOT / ".vanilla-cache"  # gitignored; holds extracted reference .dats


def load_session_cookie() -> str:
    for p in DB_CANDIDATES:
        if p.exists():
            con = sqlite3.connect(str(p))
            row = con.execute(
                "SELECT session_cookie FROM patreon_session WHERE id = 1"
            ).fetchone()
            con.close()
            if row and row[0]:
                return row[0]
    raise SystemExit(
        "no session cookie found — connect to patreon in the app first."
    )


def load_vanilla_iso_path() -> str | None:
    for p in DB_CANDIDATES:
        if p.exists():
            con = sqlite3.connect(str(p))
            row = con.execute(
                "SELECT value FROM settings WHERE key = 'vanilla_iso_path'"
            ).fetchone()
            con.close()
            if row and row[0]:
                return row[0]
    return None


# ─── HAL ISO FST reader (minimal) ────────────────────────────────────────────
# Pulls a single named root-level file out of a GameCube ISO. Same parsing
# pattern the Rust code uses; reimplemented here so the tool is self-contained.

def _iso_extract(iso_path: Path, target_filenames: list[str], dest_dir: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    dest_dir.mkdir(parents=True, exist_ok=True)
    with open(iso_path, "rb") as f:
        f.seek(0x424)
        fst_off = int.from_bytes(f.read(4), "big")
        f.seek(fst_off + 8)
        entry_count = int.from_bytes(f.read(4), "big")
        str_off = fst_off + entry_count * 12
        # Build name → (data_off, size) for root-level files
        idx: dict[str, tuple[int, int]] = {}
        for i in range(1, entry_count):
            f.seek(fst_off + i * 12)
            h = f.read(12)
            if h[0] != 0:  # directory
                continue
            no = int.from_bytes(b"\x00" + h[1:4], "big")
            do = int.from_bytes(h[4:8], "big")
            dz = int.from_bytes(h[8:12], "big")
            f.seek(str_off + no)
            name_bytes = bytearray()
            while True:
                b = f.read(1)
                if not b or b == b"\x00":
                    break
                name_bytes += b
            idx[name_bytes.decode("utf-8", errors="replace")] = (do, dz)
        for w in target_filenames:
            if w in idx:
                do, dz = idx[w]
                f.seek(do)
                data = f.read(dz)
                out_path = dest_dir / w
                out_path.write_bytes(data)
                out[w] = out_path
    return out


def vanilla_costume_path(character_code: str, iso_path: str) -> Path | None:
    """Returns a path to the vanilla `Pl{Char}Nr.dat` (default costume) for
    the given HAL character code, extracting from the user's ISO on first
    use and caching under .vanilla-cache/."""
    target = f"Pl{character_code}Nr.dat"
    cached = VANILLA_CACHE_DIR / target
    if cached.exists():
        return cached
    extracted = _iso_extract(Path(iso_path), [target], VANILLA_CACHE_DIR)
    return extracted.get(target)


def vanilla_stage_path(iso_target_filename: str, iso_path: str) -> Path | None:
    cached = VANILLA_CACHE_DIR / iso_target_filename
    if cached.exists():
        return cached
    extracted = _iso_extract(Path(iso_path), [iso_target_filename], VANILLA_CACHE_DIR)
    return extracted.get(iso_target_filename)


# ─── HAL .dat safety validator (shells out to the-shop-hsd) ─────────────────

def validate_dat(
    candidate_path: Path,
    vanilla_path: Path,
    *,
    kind: str,  # "costume" or "stage"
) -> dict | None:
    """Run the-shop-hsd's validate-{costume,stage} subcommand. Returns the
    parsed JSON ({verdict, reasons, warnings}) or None on failure."""
    if not HSD_TOOL.exists():
        return None
    sub = "validate-costume" if kind == "costume" else "validate-stage"
    try:
        r = subprocess.run(
            [str(HSD_TOOL), sub, str(candidate_path), str(vanilla_path)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if r.returncode != 0:
            return {
                "verdict": "unknown",
                "reasons": [],
                "warnings": [
                    f"hsd-tool exit {r.returncode}: {r.stderr.strip()[:200]}"
                ],
            }
        line = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
        return json.loads(line)
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as e:
        return {
            "verdict": "unknown",
            "reasons": [],
            "warnings": [f"hsd-tool error: {e}"],
        }


# ─── HAL filename parser (port of manifest::identify + parse_iso_asset) ──────

# HAL costume filename: starts with `Pl`, then a 2-letter char code,
# then a 2-letter slot code + optional digits. Anything after (a paren
# suffix like " (Blue)" or a "-Name" annotation) is the modder's label.
_PL_RE = re.compile(r"^Pl([A-Z][a-z])([A-Z][a-z]\d{0,2})(.*)$")
# Per-character animation bank: PlXxAJ
_PLAJ_RE = re.compile(r"^Pl([A-Z][a-z])AJ(.*)$")
# Per-character effect bank: EfXxData
_EF_RE = re.compile(r"^Ef([A-Z][a-z])Data(.*)$")
# Stage: Gr<...>
_GR_RE = re.compile(r"^(Gr[A-Za-z0-9]+)(.*)$")
# UI: Mn<...> / If<...> / Ty<...>
_UI_RE = re.compile(r"^((?:Mn|If|Ty)[A-Za-z0-9]+)(.*)$")
# Items / Pokemon: It<...> / Pk<...>
_ITEM_RE = re.compile(r"^((?:It|Pk)[A-Za-z0-9]+)(.*)$")


def parse_filename(filename: str) -> dict | None:
    """Returns a dict describing what this HAL file is, or None.

    Tolerates either of the two annotation conventions creators use:
      `PlFcBu-Animelee.dat`   ← dash-separated
      `PlFcBu (Blue).dat`      ← space + paren-wrapped
    """
    name = filename
    ext = None
    for e in (".dat", ".usd", ".hps"):
        if name.lower().endswith(e):
            ext = e
            name = name[: -len(e)]
            break
    if ext is None:
        for e in (".zip", ".rar", ".7z"):
            if name.lower().endswith(e):
                inner = name[: -len(e)]
                guess = parse_filename(inner + ".dat")
                if guess:
                    guess["pack_name"] = (guess.get("pack_name") or inner).strip()
                    guess["inner_filename"] = (
                        f"Pl{guess['character_code']}{guess['slot_code']}.dat"
                        if guess["kind"] == "character_skin"
                        else guess["iso_target_filename"]
                    )
                    return guess
                return None
        return None

    def _label(rest: str) -> str | None:
        # Trim leading separator characters (-_ space + paren) so the
        # captured "rest" reads like a clean annotation.
        s = rest.strip(" -_()").strip()
        return s or None

    # Pl{Char}AJ — animation bank
    m = _PLAJ_RE.match(name)
    if m:
        ch = m.group(1)
        return {
            "kind": "animation",
            "character_code": ch,
            "slot_code": "",
            "iso_target_filename": f"Pl{ch}AJ{ext}",
            "pack_name": _label(m.group(2)),
            "inner_filename": None,
        }
    # Pl{Char}{Slot} — character_skin
    m = _PL_RE.match(name)
    if m:
        ch, slot = m.group(1), m.group(2)
        return {
            "kind": "character_skin",
            "character_code": ch,
            "slot_code": slot,
            "iso_target_filename": f"Pl{ch}{slot}.dat",
            "pack_name": _label(m.group(3)),
            "inner_filename": None,
        }
    # Ef{Char}Data — effect
    m = _EF_RE.match(name)
    if m:
        ch = m.group(1)
        return {
            "kind": "effect",
            "character_code": ch,
            "slot_code": "",
            "iso_target_filename": f"Ef{ch}Data{ext}",
            "pack_name": _label(m.group(2)),
            "inner_filename": None,
        }
    # Gr* — stage
    m = _GR_RE.match(name)
    if m:
        return {
            "kind": "stage",
            "character_code": "",
            "slot_code": "",
            "iso_target_filename": f"{m.group(1)}{ext}",
            "pack_name": _label(m.group(2)),
            "inner_filename": None,
        }
    # Mn* / If* / Ty* — ui
    m = _UI_RE.match(name)
    if m:
        return {
            "kind": "ui",
            "character_code": "",
            "slot_code": "",
            "iso_target_filename": f"{m.group(1)}{ext}",
            "pack_name": _label(m.group(2)),
            "inner_filename": None,
        }
    # It* / Pk* — item / pokemon
    m = _ITEM_RE.match(name)
    if m:
        return {
            "kind": "item",
            "character_code": "",
            "slot_code": "",
            "iso_target_filename": f"{m.group(1)}{ext}",
            "pack_name": _label(m.group(2)),
            "inner_filename": None,
        }
    return None


# ─── pack grouping (port of the agent's rule) ────────────────────────────────

COLOR_TOKENS = {
    "nr", "re", "bu", "gr", "or", "ye", "aq", "wh", "bk", "la", "pi", "gy",
    "default", "red", "blue", "green", "orange", "yellow", "aqua", "white",
    "black", "lavender", "pink", "grey", "gray", "purple", "neutral",
    "brown", "indigo", "cyan", "teal", "tan", "magenta",
    "player 1", "player 2", "p1", "p2", "1p", "2p",
}


def strip_color_suffix(name: str) -> str:
    s = name.strip()
    for _ in range(5):
        before = s
        # Parens-wrapped: "Foo (Bu)"
        m = re.match(r"^(.*)\s*\(\s*([^()]+)\s*\)\s*$", s)
        if m and m.group(2).lower().strip() in COLOR_TOKENS:
            s = m.group(1).strip()
            continue
        # Separator-prefixed: " - Red", " · Blue", " | Bu"
        m = re.match(r"^(.*?)\s*[-·|,]\s*([A-Za-z][A-Za-z ]*)\s*$", s)
        if m and m.group(2).lower().strip() in COLOR_TOKENS:
            s = m.group(1).strip()
            continue
        # Version tokens
        m = re.match(r"^(.*?)\s*(\(v\d+\)|v\d+|\(updated\)|- updated)\s*$", s, re.I)
        if m:
            s = m.group(1).strip()
            continue
        if s == before:
            break
    s = re.sub(r"\s*[-·|,]\s*$", "", s).strip()
    return s if s else name


def normalize_pack_name(display_name: str, slot_code: str) -> str:
    s = strip_color_suffix(display_name).lower().strip()
    return s if s else slot_code.lower()


# Format detection — animelee / vanilla / null. The token is searched
# across display_name, inner_filename, and filename_in_post (lowercased).
# Vanilla is mostly inferred relatively: when a sibling entry has an
# "animelee" marker and this one doesn't, we mark the unmarked one
# "vanilla" so the pill appears on both faces of the alternate.
def _format_marker(blob: str) -> str | None:
    b = blob.lower()
    if "animelee" in b:
        return "animelee"
    # `vanilla` and `1:1` collapse to the same label — both mean
    # "faithful to Melee's original art style," as opposed to the
    # animelee cel-shade variant. Splitting them was confusing on
    # cards (users asked why 1:1 wasn't vanilla).
    if re.search(r"\bvanilla\b", b) or re.search(r"\b1[:_-]?1\b", b) or "1to1" in b:
        return "vanilla"
    return None


def detect_explicit_format(entry: dict) -> str | None:
    return _format_marker(
        " ".join(
            filter(
                None,
                [
                    entry.get("display_name") or "",
                    entry.get("inner_filename") or "",
                    entry.get("filename_in_post") or "",
                ],
            )
        )
    )


def group_into_packs(entries: list[dict]) -> list[dict]:
    """Group entries into packs and split by format (animelee / vanilla).

    The rule: same skin (creator + character + normalized name) AND same
    format = same pack. Inside a pack each slot_code appears at most once;
    if multiple entries share both group + slot, the lowest-sorting id
    wins (last-line-of-defense dedupe).

    "Format" is detected from animelee / vanilla / 1:1 tokens in the
    display_name or filenames. When a candidate group contains explicit
    "animelee" entries alongside unmarked ones, the unmarked ones get
    labeled "vanilla" so the pill renders on both sides of the alternate.

    Returns a new list. Mutates kept entries in place to set `pack_id`,
    `pack_display_name`, and `format`.
    """
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for e in entries:
        by_kind[e["kind"]].append(e)

    out: list[dict] = []

    # Non-character_skin → packs of 1, format inferred from explicit tokens.
    for e in [
        x for k, lst in by_kind.items() if k != "character_skin" for x in lst
    ]:
        e["pack_id"] = e["id"]
        e["pack_display_name"] = (
            strip_color_suffix(e["display_name"]) or e["display_name"]
        )
        e["format"] = detect_explicit_format(e)
        out.append(e)

    # character_skin → first-pass group on (creator, character, name).
    base_groups: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for e in by_kind.get("character_skin", []):
        key = (
            e["creator_id"],
            e["character_code"],
            normalize_pack_name(e["display_name"], e["slot_code"]),
        )
        base_groups[key].append(e)

    for members in base_groups.values():
        # Detect format on each entry, then promote unmarked → "vanilla"
        # iff at least one sibling is explicitly "animelee".
        any_animelee = False
        for m in members:
            f = detect_explicit_format(m)
            m["format"] = f
            if f == "animelee":
                any_animelee = True
        if any_animelee:
            for m in members:
                if m["format"] is None:
                    m["format"] = "vanilla"

        # Second-pass: split by format. Each (group, format) becomes its
        # own pack. Within a pack we dedupe by slot_code with id-sort.
        by_format: dict[str | None, list[dict]] = defaultdict(list)
        for m in members:
            by_format[m["format"]].append(m)

        for fmembers in by_format.values():
            fmembers.sort(key=lambda m: m["id"])
            seen_slots: set[str] = set()
            kept: list[dict] = []
            for m in fmembers:
                if m["slot_code"] in seen_slots:
                    continue
                seen_slots.add(m["slot_code"])
                kept.append(m)
            if not kept:
                continue
            pack_id = kept[0]["id"]
            pdn = strip_color_suffix(kept[0]["display_name"])
            if len(kept) > 1:
                common = kept[0]["display_name"]
                for m in kept[1:]:
                    while m["display_name"][: len(common)] != common and common:
                        common = common[:-1]
                common = strip_color_suffix(common.strip())
                if len(common) >= 5:
                    pdn = common
            for m in kept:
                m["pack_id"] = pack_id
                m["pack_display_name"] = pdn or m["display_name"]
            out.extend(kept)

    return out


# ─── patreon api ─────────────────────────────────────────────────────────────

PATREON_BASE = "https://www.patreon.com"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0"
)


def patreon_get(path: str, cookie: str) -> dict:
    url = path if path.startswith("http") else f"{PATREON_BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Cookie": f"session_id={cookie}",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise SystemExit(
                f"patreon api {e.code} for {url} — cookie may be expired. "
                "reconnect in the app and try again."
            )
        raise


def resolve_input(arg: str, index: dict, cookie: str) -> tuple[str, dict]:
    """Returns (creator_id, full_creator_dict) — fetches/creates as needed."""
    # Existing creator id?
    for c in index["creators"]:
        if c["id"] == arg:
            return c["id"], c
    # Numeric → campaign_id
    if arg.isdigit():
        campaign_id = arg
        return discover_creator(campaign_id, None, index, cookie)
    # URL → scrape page for campaign_id + name
    if arg.startswith("http"):
        return discover_creator(None, arg, index, cookie)
    raise SystemExit(f"unrecognized input: {arg!r}")


def discover_creator(
    campaign_id: str | None,
    url: str | None,
    index: dict,
    cookie: str,
) -> tuple[str, dict]:
    """Fetch creator metadata from the page, upsert into index."""
    if url:
        page_url = url
    else:
        # No clean way to land on a campaign page from id alone; the
        # /api/campaigns/<id> endpoint works:
        return _from_campaign_api(campaign_id, index, cookie)

    req = urllib.request.Request(
        page_url, headers={"User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8", errors="replace")

    # Try multiple patterns Patreon's page emits — a creator URL may not
    # include any of them depending on which experiment / locale is live.
    patterns = [
        r'"campaign":\s*\{\s*"data":\s*\{\s*"id":\s*"(\d+)"',
        r'"campaign_id":"(\d+)"',
        r'/api/campaigns/(\d+)',           # appears in preload links + JSON-LD
        r'patreon-media/p/campaign/(\d+)',  # appears in CDN avatar URLs
    ]
    campaign_id = None
    for pat in patterns:
        m = re.findall(pat, html)
        if m:
            campaign_id = m[0]
            break
    if campaign_id is None:
        raise SystemExit(f"could not find campaign id in {page_url}")

    title_m = re.search(r"<title[^>]*>([^<]+)</title>", html)
    name = title_m.group(1).split("|")[0].strip() if title_m else f"creator-{campaign_id}"

    summary_m = re.findall(r'"summary":"([^"]+)"', html)
    tagline = None
    if summary_m:
        # Decode JSON-style backslash escapes safely. The previous
        # `unicode_escape` codec choked on trailing backslashes; using
        # json.loads on the quoted string handles edge cases cleanly.
        raw = summary_m[0]
        try:
            decoded = json.loads(f'"{raw}"')
        except json.JSONDecodeError:
            decoded = raw  # fall back to the raw string with \u escapes intact
        tagline = (
            decoded.replace("<br>", " · ").strip()[:160] or None
        )

    creator_id = re.sub(r"\W+", "_", name.lower()).strip("_") or f"creator_{campaign_id}"

    creator = upsert_creator(
        index,
        creator_id=creator_id,
        display_name=name,
        patreon_url=page_url,
        tagline=tagline,
        campaign_id=campaign_id,
    )
    return creator["id"], creator


def _from_campaign_api(
    campaign_id: str, index: dict, cookie: str
) -> tuple[str, dict]:
    data = patreon_get(f"/api/campaigns/{campaign_id}", cookie)
    attrs = data["data"]["attributes"]
    name = attrs.get("creation_name") or attrs.get("name") or f"creator-{campaign_id}"
    vanity = attrs.get("vanity") or campaign_id
    creator_id = re.sub(r"\W+", "_", name.lower()).strip("_") or vanity
    creator = upsert_creator(
        index,
        creator_id=creator_id,
        display_name=name,
        patreon_url=f"https://www.patreon.com/{vanity}",
        tagline=attrs.get("summary"),
        campaign_id=campaign_id,
    )
    return creator["id"], creator


def upsert_creator(
    index: dict,
    *,
    creator_id: str,
    display_name: str,
    patreon_url: str,
    tagline: str | None,
    campaign_id: str,
) -> dict:
    for c in index["creators"]:
        if c["id"] == creator_id or c.get("patreon_campaign_id") == campaign_id:
            c["display_name"] = display_name
            c["patreon_url"] = patreon_url
            if tagline:
                c["tagline"] = tagline
            c["patreon_campaign_id"] = campaign_id
            return c
    creator = {
        "id": creator_id,
        "display_name": display_name,
        "patreon_url": patreon_url,
        "tagline": tagline,
        "patreon_campaign_id": campaign_id,
    }
    index["creators"].append(creator)
    return creator


def fetch_posts(campaign_id: str, cookie: str) -> list[dict]:
    """Returns merged list of {data: post, included: [attachments+media]}."""
    out: list[dict] = []
    cursor = (
        f"/api/posts?filter[campaign_id]={campaign_id}"
        "&include=attachments,attachments_media,access_rules,access_rules.tier"
        "&fields[post]=title,published_at,min_cents_pledged_to_view,current_user_can_view,image"
        "&fields[media]=name,download_url,file_name,image_urls"
        "&fields[attachment]=name,url"
        "&fields[access-rule]=access_rule_type"
        "&fields[tier]=amount_cents,title"
        "&page[size]=20&sort=-published_at"
    )
    while cursor:
        body = patreon_get(cursor, cookie)
        for p in body.get("data", []):
            out.append({"post": p, "included": body.get("included", [])})
        nxt = body.get("links", {}).get("next") or body.get("meta", {}).get(
            "pagination", {}
        ).get("cursors", {}).get("next")
        if isinstance(nxt, str) and nxt:
            cursor = nxt if nxt.startswith("http") else nxt
        else:
            cursor = None
        time.sleep(0.4)  # polite pause
    return out


# ─── attachment → entry ──────────────────────────────────────────────────────

ARCHIVE_EXTS = (".zip", ".rar", ".7z")
HAL_EXTS = (".dat", ".usd", ".hps") + ARCHIVE_EXTS


def is_archive(name: str) -> bool:
    return name.lower().endswith(ARCHIVE_EXTS)


def download_to(url: str, dest: Path, cookie: str) -> bool:
    """Download to dest. Returns True on success. Sends the session cookie
    defensively so attachments served from cookie-protected paths work."""
    try:
        req = urllib.request.Request(
            url,
            headers={
                "Cookie": f"session_id={cookie}",
                "User-Agent": USER_AGENT,
            },
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            ctype = r.headers.get("content-type", "")
            if ctype.startswith(("text/html", "application/json")):
                return False
            with open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
        return dest.stat().st_size > 0
    except Exception:
        return False


def list_archive_contents(local: Path) -> list[str]:
    """Return list of file names (with subpaths) inside the archive."""
    name = str(local).lower()
    if name.endswith(".zip"):
        try:
            with zipfile.ZipFile(local) as z:
                return [
                    info.filename
                    for info in z.infolist()
                    if not info.is_dir() and not info.filename.endswith("/")
                ]
        except Exception:
            return []
    if name.endswith(".rar"):
        try:
            r = subprocess.run(
                ["unrar", "lb", str(local)],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            return [l.strip() for l in r.stdout.splitlines() if l.strip()]
        except (FileNotFoundError, subprocess.CalledProcessError):
            return []
    if name.endswith(".7z"):
        try:
            r = subprocess.run(
                ["7z", "l", "-slt", str(local)],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            paths = [
                line[7:].strip()
                for line in r.stdout.splitlines()
                if line.startswith("Path = ")
            ]
            # First "Path = " is the archive itself; skip it.
            return paths[1:] if paths else []
        except (FileNotFoundError, subprocess.CalledProcessError):
            return []
    return []


def expand_archive_attachment(
    name: str,
    url: str,
    cookie: str,
    cache_dir: Path,
) -> list[tuple[str, str | None, Path | None]]:
    """For an archive attachment, return [(inner_filename, parent_archive_name,
    local_extracted_path)] for every inner file matching a HAL pattern. The
    local path is the EXTRACTED inner file (.dat) if extraction succeeded,
    so callers can validate it. Falls back to the outer-name guess (with
    no local path) if download / extract fails."""
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:120]
    local = cache_dir / safe_name
    if not local.exists():
        ok = download_to(url, local, cookie)
        if not ok:
            return []
    inner = list_archive_contents(local)
    matches: list[tuple[str, str | None, Path | None]] = []
    for path in inner:
        base = path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        if not base.lower().endswith((".dat", ".usd", ".hps")):
            continue
        if parse_filename(base) is None:
            continue
        # Extract this inner file so the validator can read it.
        extracted_path = _extract_inner(local, path, cache_dir)
        matches.append((base, name, extracted_path))
    return matches


def _extract_inner(archive: Path, inner_path: str, dest_dir: Path) -> Path | None:
    """Extract one named entry from an archive into dest_dir; returns the
    path or None on failure. `inner_path` is matched case-insensitively
    on basename — the index stores just the basename of the file inside
    the archive even if the actual archive entry is at a subpath like
    `B0XX Spacies/PlFcBu.dat`. Works with zip / 7z / rar."""
    name = str(archive).lower()
    target_basename = inner_path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].lower()
    safe_inner = re.sub(r"[^A-Za-z0-9._-]+", "_", target_basename)[:120]
    out = dest_dir / f"{archive.stem}__{safe_inner}"
    if out.exists():
        return out

    if name.endswith(".zip"):
        try:
            with zipfile.ZipFile(archive) as z:
                # Resolve full path inside the archive by basename match.
                entry = None
                for n in z.namelist():
                    if n.endswith("/"):
                        continue
                    base = n.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].lower()
                    if base == target_basename:
                        entry = n
                        break
                if entry is None:
                    return None
                with z.open(entry) as src, open(out, "wb") as dst:
                    shutil.copyfileobj(src, dst)
            return out
        except Exception:
            return None

    if name.endswith(".rar"):
        try:
            # List archive contents to find the full path of the inner file.
            list_r = subprocess.run(
                ["unrar", "lb", str(archive)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if list_r.returncode != 0:
                return None
            entry = None
            for ln in list_r.stdout.splitlines():
                ln = ln.strip()
                if not ln:
                    continue
                base = ln.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].lower()
                if base == target_basename:
                    entry = ln
                    break
            if entry is None:
                return None
            r = subprocess.run(
                ["unrar", "p", "-inul", str(archive), entry],
                capture_output=True,
                timeout=30,
            )
            if r.returncode == 0 and r.stdout:
                out.write_bytes(r.stdout)
                return out
        except (FileNotFoundError, subprocess.CalledProcessError):
            pass
        return None

    if name.endswith(".7z"):
        try:
            list_r = subprocess.run(
                ["7z", "l", "-slt", str(archive)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if list_r.returncode != 0:
                return None
            paths = [
                line[7:].strip()
                for line in list_r.stdout.splitlines()
                if line.startswith("Path = ")
            ][1:]
            entry = None
            for ent in paths:
                base = ent.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].lower()
                if base == target_basename:
                    entry = ent
                    break
            if entry is None:
                return None
            # 7z e flattens paths into dest_dir; we then rename to our
            # canonical out filename.
            subprocess.run(
                ["7z", "e", "-y", f"-o{dest_dir}", str(archive), entry],
                capture_output=True,
                timeout=30,
                check=True,
            )
            extracted = dest_dir / entry.rsplit("/", 1)[-1]
            if extracted.exists():
                if extracted != out:
                    extracted.rename(out)
                return out
        except (FileNotFoundError, subprocess.CalledProcessError):
            pass
        return None

    return None


def slug(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def post_preview_url(post: dict) -> str | None:
    img = post.get("attributes", {}).get("image") or {}
    return img.get("large_url") or img.get("url") or None


def run_validation(
    parsed: dict,
    local_path: Path | None,
    vanilla_iso: str | None,
    cache: dict[str, Path | None],
) -> dict | None:
    """Validate a candidate dat against the matching vanilla reference.
    Returns the safety report dict, or None when we couldn't validate
    (no local file, no vanilla iso configured, unsupported kind, etc.).
    Cache is keyed by vanilla filename so we extract each ref once."""
    if local_path is None or not local_path.exists() or vanilla_iso is None:
        return None
    kind = parsed.get("kind")
    if kind == "character_skin":
        char = parsed.get("character_code") or ""
        if not char:
            return None
        key = f"Pl{char}Nr.dat"
        if key not in cache:
            cache[key] = vanilla_costume_path(char, vanilla_iso)
        ref = cache[key]
        if ref is None:
            return None
        return validate_dat(local_path, ref, kind="costume")
    if kind == "stage":
        target = parsed.get("iso_target_filename") or ""
        if not target:
            return None
        if target not in cache:
            cache[target] = vanilla_stage_path(target, vanilla_iso)
        ref = cache[target]
        if ref is None:
            return None
        return validate_dat(local_path, ref, kind="stage")
    return None


def fetch_campaign_min_paid_cents(campaign_id: str, cookie: str) -> int:
    """Lowest non-zero reward tier on a creator's campaign, in cents. Used
    to price posts gated as "any paid pledge" (Patreon's `access_rule_type:
    "patrons"`) where the post itself doesn't carry a specific tier price.
    Returns 0 if the campaign has no paid tiers (free-only) or the request
    fails — caller treats 0 as "unknown / treat as free."
    """
    try:
        body = patreon_get(f"/api/campaigns/{campaign_id}?include=rewards", cookie)
    except SystemExit:
        raise
    except Exception:
        return 0
    paid: list[int] = []
    for inc in body.get("included", []):
        if inc.get("type") != "reward":
            continue
        amt = int(inc.get("attributes", {}).get("amount_cents") or 0)
        if amt > 0:
            paid.append(amt)
    return min(paid) if paid else 0


def resolve_tier_cents(
    post: dict,
    included: list[dict],
    campaign_min_paid_cents: int = 0,
) -> int:
    """Return the actual minimum tier price (in cents) required to view the
    post. The honest answer lives in the post's `access_rules`, not in
    `min_cents_pledged_to_view` — that field returns a sentinel `1` for
    "any paid pledge" posts, which used to render in the UI as "$0.01".

      1) Build a tier-id → amount_cents map from `included[]` (type=tier).
      2) Walk this post's access_rules:
         - "tier" rule → use the linked tier's amount_cents
         - "patrons" rule → use the campaign's lowest paid reward (passed in
           as `campaign_min_paid_cents`, fetched once per creator upstream)
         - "public" rule → contributes 0
      3) Return the minimum collected. If access_rules give us nothing
         actionable, fall back to min_cents_pledged_to_view but only if it
         looks real (≥ 100); the `1` sentinel becomes 0.
    """
    tiers_by_id: dict[str, int] = {}
    rules_by_id: dict[str, dict] = {}
    for inc in included:
        t = inc.get("type")
        if t == "tier":
            amt = int(inc.get("attributes", {}).get("amount_cents") or 0)
            tiers_by_id[inc.get("id", "")] = amt
        elif t == "access-rule":
            rules_by_id[inc.get("id", "")] = inc

    rels = post.get("relationships", {})
    rule_refs = (rels.get("access_rules", {}).get("data") or [])

    candidates: list[int] = []
    for ref in rule_refs:
        rid = ref.get("id")
        rule = rules_by_id.get(rid) if rid else None
        if not rule:
            continue
        rtype = rule.get("attributes", {}).get("access_rule_type")
        if rtype == "tier":
            tier_ref = rule.get("relationships", {}).get("tier", {}).get("data")
            if tier_ref:
                amt = tiers_by_id.get(tier_ref.get("id", ""))
                if amt and amt > 0:
                    candidates.append(amt)
        elif rtype == "patrons":
            if campaign_min_paid_cents > 0:
                candidates.append(campaign_min_paid_cents)

    if candidates:
        return min(candidates)

    fallback = int(post.get("attributes", {}).get("min_cents_pledged_to_view") or 0)
    # `1` is Patreon's "any paid pledge" sentinel — not a real price.
    if fallback < 100:
        return 0
    return fallback


def build_entries(
    creator_id: str,
    posts: list[dict],
    cookie: str,
    cache_dir: Path,
    vanilla_iso: str | None = None,
    campaign_min_paid_cents: int = 0,
) -> list[dict]:
    out: list[dict] = []
    seen_ids: set[str] = set()
    archives_seen = 0
    archives_expanded = 0
    # Vanilla reference cache (shared across the whole run): vanilla
    # `PlFcNr.dat` etc. extracted from the user's ISO, kept on disk in
    # .vanilla-cache/ so subsequent scrapes don't re-extract.
    vanilla_cache: dict[str, Path | None] = {}

    for bundle in posts:
        post = bundle["post"]
        pid = post["id"]
        attrs = post["attributes"]
        tier_cents = resolve_tier_cents(
            post, bundle["included"], campaign_min_paid_cents
        )
        post_title = (attrs.get("title") or "").strip()
        preview = post_preview_url(post)

        # JSON:API `included[]` is shared across every post in the page —
        # so we MUST filter to only the attachments referenced by THIS
        # post's relationships, otherwise unrelated files cross-contaminate.
        my_ids: set[tuple[str, str]] = set()
        rels = post.get("relationships", {})
        for rel_name in ("attachments", "attachments_media", "media"):
            rel = rels.get(rel_name, {})
            data = rel.get("data") or []
            for d in data:
                t, i = d.get("type"), d.get("id")
                if t and i:
                    my_ids.add((t, i))

        attachments: list[tuple[str, str]] = []  # (name, url)
        for inc in bundle["included"]:
            t = inc.get("type", "")
            i = inc.get("id", "")
            if t not in ("attachment", "media"):
                continue
            if (t, i) not in my_ids:
                continue
            a = inc.get("attributes", {})
            name = (a.get("name") or a.get("file_name") or "").strip()
            if not name:
                continue
            if not name.lower().endswith(HAL_EXTS):
                continue
            url = a.get("download_url") or a.get("url") or ""
            attachments.append((name, url))

        # Expand archives: for any .zip/.rar/.7z attachment, download +
        # crack open, then emit one entry per inner HAL file. Outer name
        # remains `filename_in_post` so the install path matches; inner
        # name lives in `inner_filename`. Each entry in `expanded` carries
        # an optional local Path to the extracted (or directly downloaded)
        # candidate file — consumed by the validation pass below.
        expanded: list[tuple[str, str | None, Path | None]] = []
        for fname, url in attachments:
            if is_archive(fname):
                archives_seen += 1
                inner_matches = expand_archive_attachment(
                    fname, url, cookie, cache_dir
                )
                if inner_matches:
                    archives_expanded += 1
                    expanded.extend(inner_matches)
                else:
                    expanded.append((fname, None, None))
            else:
                # Direct .dat / .usd / .hps — download for validation.
                local = None
                if parse_filename(fname) is not None:
                    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", fname)[:120]
                    candidate_path = cache_dir / safe
                    if not candidate_path.exists():
                        if download_to(url, candidate_path, cookie):
                            local = candidate_path
                    else:
                        local = candidate_path
                expanded.append((fname, None, local))

        for fname, archive_outer, local_path in expanded:
            parsed = parse_filename(fname)
            if not parsed:
                continue
            base_slug = slug(post_title or fname)
            slot_part = parsed["slot_code"] or parsed["kind"]
            entry_id = f"{creator_id}-{base_slug}-{slot_part.lower()}"
            # disambiguate collisions across different attachments
            n = 0
            unique = entry_id
            while unique in seen_ids:
                n += 1
                unique = f"{entry_id}-{n}"
            seen_ids.add(unique)

            display_name = post_title or fname
            # If we cracked open an archive: filename_in_post is the
            # archive's outer name (what Patreon serves), inner_filename
            # is the file inside the install path needs to extract.
            outer_name = archive_outer or fname
            inner_name = (
                fname if archive_outer else parsed.get("inner_filename")
            )
            entry = {
                "id": unique,
                "creator_id": creator_id,
                "display_name": display_name,
                "kind": parsed["kind"],
                "iso_target_filename": parsed["iso_target_filename"],
                "inner_filename": inner_name,
                "character_code": parsed["character_code"],
                "slot_code": parsed["slot_code"],
                "patreon_post_id": pid,
                "filename_in_post": outer_name,
                "tier_required_cents": tier_cents,
                "sha256": None,
                "preview_url": preview,
                "preview_urls": [],
                "pack_id": "",
                "pack_display_name": None,
                "format": None,
                "safety": run_validation(parsed, local_path, vanilla_iso, vanilla_cache),
                "notes": None,
            }
            out.append(entry)
    if archives_seen:
        print(
            f"  archives: {archives_expanded}/{archives_seen} expanded "
            f"(rest fell back to outer-name guess or were skipped)"
        )
    safety_seen = sum(1 for e in out if e.get("safety"))
    if safety_seen:
        verdicts: dict[str, int] = defaultdict(int)
        for e in out:
            v = (e.get("safety") or {}).get("verdict")
            if v:
                verdicts[v] += 1
        summary = " ".join(f"{k}:{v}" for k, v in sorted(verdicts.items()))
        print(f"  safety: {safety_seen} validated · {summary}")
    return out


# ─── main ────────────────────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "target",
        nargs="?",
        help="patreon URL, campaign id, or existing creator id",
    )
    p.add_argument(
        "--dry-run", action="store_true", help="print summary, don't write"
    )
    p.add_argument(
        "--regroup-all",
        action="store_true",
        help="re-apply pack grouping to every entry in the index "
             "(dedupes duplicate slot_codes within a group). use to "
             "migrate existing data after a grouping rule change.",
    )
    p.add_argument(
        "--revalidate-all",
        action="store_true",
        help="re-download every existing entry's attachment and run the "
             "safety validator against the user's vanilla iso. slow.",
    )
    p.add_argument(
        "--reprice-all",
        action="store_true",
        help="re-fetch every post's metadata and recompute tier_required_cents "
             "from access_rules.tier (fixes the Patreon `min_cents_pledged_to_view: 1` "
             "sentinel that rendered as $0.01).",
    )
    args = p.parse_args()

    if (
        not args.target
        and not args.regroup_all
        and not args.revalidate_all
        and not args.reprice_all
    ):
        p.error(
            "provide a target (URL / id) or pass "
            "--regroup-all / --revalidate-all / --reprice-all"
        )

    index = json.loads(INDEX_PATH.read_text())
    vanilla_iso = load_vanilla_iso_path()
    if vanilla_iso:
        print(f"vanilla iso: {vanilla_iso}")
    else:
        print("vanilla iso: NOT CONFIGURED — safety validation will be skipped")

    if args.target:
        cookie = load_session_cookie()
        creator_id, creator = resolve_input(args.target, index, cookie)
        print(f"creator: {creator_id} (campaign {creator['patreon_campaign_id']})")

        posts = fetch_posts(creator["patreon_campaign_id"], cookie)
        print(f"  posts seen: {len(posts)}")

        campaign_min = fetch_campaign_min_paid_cents(
            creator["patreon_campaign_id"], cookie
        )
        if campaign_min > 0:
            print(f"  campaign min paid tier: ${campaign_min/100:.2f}")
        else:
            print("  campaign min paid tier: free / unknown")

        cache_dir = Path(
            tempfile.mkdtemp(prefix=f"the-shop-scrape-{creator_id}-")
        )
        try:
            new_entries = build_entries(
                creator_id, posts, cookie, cache_dir,
                vanilla_iso=vanilla_iso,
                campaign_min_paid_cents=campaign_min,
            )
        finally:
            shutil.rmtree(cache_dir, ignore_errors=True)
        print(f"  HAL-pattern attachments: {len(new_entries)}")

        if new_entries:
            before = len(new_entries)
            new_entries = group_into_packs(new_entries)
            after = len(new_entries)
            pack_ids = {
                e["pack_id"]
                for e in new_entries
                if e["kind"] == "character_skin"
            }
            print(
                f"  character_skin packs: {len(pack_ids)} "
                f"({before - after} alternate-slot variants deduped)"
            )

            # Replace this creator's skins in-place (idempotent re-runs).
            kept = [s for s in index["skins"] if s["creator_id"] != creator_id]
            index["skins"] = kept + new_entries

    if args.regroup_all:
        before = len(index["skins"])
        index["skins"] = group_into_packs(index["skins"])
        after = len(index["skins"])
        dropped = before - after
        n_packs = len(
            {
                s["pack_id"]
                for s in index["skins"]
                if s["kind"] == "character_skin"
            }
        )
        print(
            f"regrouped: {before} → {after} skins ({dropped} alternate-slot "
            f"variants dropped); {n_packs} character_skin packs"
        )

    if args.revalidate_all:
        if vanilla_iso is None:
            p.error("--revalidate-all needs a vanilla iso configured in the app")
        cookie = load_session_cookie()
        cache_dir = Path(tempfile.mkdtemp(prefix="the-shop-revalidate-"))
        vanilla_cache: dict[str, Path | None] = {}
        verdicts: dict[str, int] = defaultdict(int)
        attempted = 0
        skipped = 0
        try:
            for e in index["skins"]:
                if e.get("kind") not in ("character_skin", "stage"):
                    continue
                pid = e.get("patreon_post_id")
                fname = e.get("filename_in_post")
                inner = e.get("inner_filename")
                if not pid or not fname:
                    skipped += 1
                    continue
                # Re-fetch the post to get a fresh signed url for this attachment.
                try:
                    metadata = patreon_get(
                        f"/api/posts/{pid}?include=attachments,attachments_media",
                        cookie,
                    )
                except SystemExit:
                    raise
                except Exception:
                    skipped += 1
                    continue
                # Find the attachment whose name matches filename_in_post.
                signed_url = None
                for inc in metadata.get("included", []):
                    a = inc.get("attributes", {})
                    n = (a.get("name") or a.get("file_name") or "").strip()
                    if n.lower() == fname.lower():
                        signed_url = (
                            a.get("download_url")
                            or a.get("url")
                            or (a.get("download_urls") or {}).get("original")
                        )
                        break
                if not signed_url:
                    skipped += 1
                    continue
                # Download outer file to cache.
                safe = re.sub(r"[^A-Za-z0-9._-]+", "_", fname)[:120]
                outer = cache_dir / safe
                if not outer.exists() and not download_to(signed_url, outer, cookie):
                    skipped += 1
                    continue
                # Resolve candidate path (extract inner if archive).
                if is_archive(fname) and inner:
                    candidate = _extract_inner(outer, inner, cache_dir)
                elif is_archive(fname):
                    candidate = None
                else:
                    candidate = outer
                if candidate is None or not candidate.exists():
                    skipped += 1
                    continue
                report = run_validation(
                    {
                        "kind": e["kind"],
                        "character_code": e.get("character_code"),
                        "iso_target_filename": e.get("iso_target_filename"),
                    },
                    candidate,
                    vanilla_iso,
                    vanilla_cache,
                )
                if report:
                    e["safety"] = report
                    verdicts[report.get("verdict", "unknown")] += 1
                    attempted += 1
        finally:
            shutil.rmtree(cache_dir, ignore_errors=True)
        summary = " ".join(f"{k}:{v}" for k, v in sorted(verdicts.items()))
        print(
            f"revalidated: {attempted} attempted, {skipped} skipped · {summary}"
        )

    if args.reprice_all:
        cookie = load_session_cookie()
        # Build creator → campaign-min-paid-cents lookup once per creator
        # so we don't hit /api/campaigns/{id} for every post.
        campaign_min_by_creator: dict[str, int] = {}
        creator_by_id = {c["id"]: c for c in index["creators"]}
        for cid, c in creator_by_id.items():
            cmp_id = c.get("patreon_campaign_id")
            if not cmp_id:
                continue
            cents = fetch_campaign_min_paid_cents(cmp_id, cookie)
            campaign_min_by_creator[cid] = cents
            print(
                f"  {cid:30s} campaign min paid: "
                f"${cents/100:.2f}" if cents else
                f"  {cid:30s} campaign min paid: free / unknown"
            )
            time.sleep(0.3)
        # Group entries by post_id so we fetch each post once. Track creator
        # alongside the post so we know which campaign-min to apply.
        post_to_creator: dict[str, str] = {}
        for e in index["skins"]:
            pid = e.get("patreon_post_id")
            cid = e.get("creator_id")
            if pid and cid:
                post_to_creator[pid] = cid
        new_prices: dict[str, int] = {}
        skipped = 0
        post_query = (
            "?include=access_rules,access_rules.tier"
            "&fields[post]=min_cents_pledged_to_view"
            "&fields[access-rule]=access_rule_type"
            "&fields[tier]=amount_cents,title"
        )
        for pid, cid in sorted(post_to_creator.items()):
            try:
                body = patreon_get(f"/api/posts/{pid}{post_query}", cookie)
            except SystemExit:
                raise
            except Exception:
                skipped += 1
                continue
            post = body.get("data") or {}
            if not post:
                skipped += 1
                continue
            new_prices[pid] = resolve_tier_cents(
                post,
                body.get("included", []),
                campaign_min_by_creator.get(cid, 0),
            )
            time.sleep(0.3)  # polite pause
        # Apply prices.
        changed = 0
        for e in index["skins"]:
            pid = e.get("patreon_post_id")
            if not pid or pid not in new_prices:
                continue
            old = int(e.get("tier_required_cents") or 0)
            new = new_prices[pid]
            if old != new:
                e["tier_required_cents"] = new
                changed += 1
        print(
            f"repriced: {len(new_prices)} posts checked, "
            f"{skipped} skipped · {changed} skin entries updated"
        )

    print(
        f"index now: {len(index['creators'])} creators · "
        f"{len(index['skins'])} skins"
    )

    if args.dry_run:
        print("(dry-run) not writing index.")
        return

    INDEX_PATH.write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n"
    )
    print(f"wrote {INDEX_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
