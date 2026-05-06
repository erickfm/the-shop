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


# ─── HAL filename parser (port of manifest::identify + parse_iso_asset) ──────

# Slot code regex: 2 letters + optional digit suffix (Or, Or11, Bu2, etc.).
SLOT_RE = re.compile(r"^([A-Z][a-z])(\d{0,2})$")


def parse_filename(filename: str) -> dict | None:
    """Returns a dict describing what this HAL file is, or None.

    Keys: kind, character_code, slot_code, iso_target_filename,
    pack_name (the modder's suffix after `-`), inner_filename (set when the
    file IS an archive and we're guessing what's inside).
    """
    name = filename
    ext = None
    for e in (".dat", ".usd", ".hps"):
        if name.lower().endswith(e):
            ext = e
            name = name[: -len(e)]
            break
    if ext is None:
        # archives — flag for the caller; we'll guess from the inner pattern
        for e in (".zip", ".rar", ".7z"):
            if name.lower().endswith(e):
                # try to parse the stem before the extension as if it were
                # itself a HAL filename ("PlFcBu (B0XX).zip" → guess Fc/Bu).
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

    # `core - suffix` split
    core, _, suffix = name.partition("-")
    pack_name = suffix.strip() or None

    # Pl{Char}AJ → animation
    if core.startswith("Pl") and core.endswith("AJ") and len(core) >= 6:
        return {
            "kind": "animation",
            "character_code": core[2:4],
            "slot_code": "",
            "iso_target_filename": f"{core}{ext}",
            "pack_name": pack_name,
            "inner_filename": None,
        }
    # Pl{Char}{Slot} → character_skin
    if core.startswith("Pl") and len(core) >= 6:
        ch = core[2:4]
        slot = core[4:]
        if SLOT_RE.match(slot):
            return {
                "kind": "character_skin",
                "character_code": ch,
                "slot_code": slot,
                "iso_target_filename": f"Pl{ch}{slot}.dat",
                "pack_name": pack_name,
                "inner_filename": None,
            }
    # Ef{Char}Data → effect
    if core.startswith("Ef") and core.endswith("Data") and len(core) >= 8:
        return {
            "kind": "effect",
            "character_code": core[2:4],
            "slot_code": "",
            "iso_target_filename": f"{core}{ext}",
            "pack_name": pack_name,
            "inner_filename": None,
        }
    # Gr* → stage
    if core.startswith("Gr") and len(core) >= 4:
        return {
            "kind": "stage",
            "character_code": "",
            "slot_code": "",
            "iso_target_filename": f"{core}{ext}",
            "pack_name": pack_name,
            "inner_filename": None,
        }
    # Mn* / If* / Ty* → ui
    if core.startswith(("Mn", "If", "Ty")):
        return {
            "kind": "ui",
            "character_code": "",
            "slot_code": "",
            "iso_target_filename": f"{core}{ext}",
            "pack_name": pack_name,
            "inner_filename": None,
        }
    # It* / Pk* → item
    if core.startswith(("It", "Pk")):
        return {
            "kind": "item",
            "character_code": "",
            "slot_code": "",
            "iso_target_filename": f"{core}{ext}",
            "pack_name": pack_name,
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
    if re.search(r"\bvanilla\b", b):
        return "vanilla"
    if re.search(r"\b1[:_-]?1\b", b) or "1to1" in b:
        return "1:1"
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

    cid = re.findall(r'"campaign":\s*\{\s*"data":\s*\{\s*"id":\s*"(\d+)"', html)
    if not cid:
        cid = re.findall(r'"campaign_id":"(\d+)"', html)
    if not cid:
        raise SystemExit(f"could not find campaign id in {page_url}")
    campaign_id = cid[0]

    title_m = re.search(r"<title[^>]*>([^<]+)</title>", html)
    name = title_m.group(1).split("|")[0].strip() if title_m else f"creator-{campaign_id}"

    summary_m = re.findall(r'"summary":"([^"]+)"', html)
    tagline = (
        summary_m[0]
        .encode().decode("unicode_escape")
        .replace("\\u003cbr\\u003e", " · ")
        .replace("<br>", " · ")
        .strip()[:160]
        if summary_m
        else None
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
        "&include=attachments,attachments_media,access_rules"
        "&fields[post]=title,published_at,min_cents_pledged_to_view,current_user_can_view,image"
        "&fields[media]=name,download_url,file_name,image_urls"
        "&fields[attachment]=name,url"
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
) -> list[tuple[str, str | None]]:
    """For an archive attachment, return [(inner_filename, parent_archive_name)]
    for every inner file matching a HAL pattern. Falls back to the
    outer-name guess when download / extract fails (so we still produce
    SOMETHING, just less accurately)."""
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:120]
    local = cache_dir / safe_name
    if not local.exists():
        ok = download_to(url, local, cookie)
        if not ok:
            return []
    inner = list_archive_contents(local)
    matches: list[tuple[str, str | None]] = []
    for path in inner:
        base = path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        if not base.lower().endswith((".dat", ".usd", ".hps")):
            continue
        if parse_filename(base) is None:
            continue
        matches.append((base, name))
    return matches


def slug(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def post_preview_url(post: dict) -> str | None:
    img = post.get("attributes", {}).get("image") or {}
    return img.get("large_url") or img.get("url") or None


def build_entries(
    creator_id: str,
    posts: list[dict],
    cookie: str,
    cache_dir: Path,
) -> list[dict]:
    out: list[dict] = []
    seen_ids: set[str] = set()
    archives_seen = 0
    archives_expanded = 0

    for bundle in posts:
        post = bundle["post"]
        pid = post["id"]
        attrs = post["attributes"]
        tier_cents = int(attrs.get("min_cents_pledged_to_view") or 0)
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
        # name lives in `inner_filename`.
        expanded: list[tuple[str, str | None]] = []  # (entry_filename, archive_name|None)
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
                    # Fall back to guessing from the outer archive name (the
                    # original parse_filename does this for archives whose
                    # stem itself looks HAL).
                    expanded.append((fname, None))
            else:
                expanded.append((fname, None))

        for fname, archive_outer in expanded:
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
                "notes": None,
            }
            out.append(entry)
    if archives_seen:
        print(
            f"  archives: {archives_expanded}/{archives_seen} expanded "
            f"(rest fell back to outer-name guess or were skipped)"
        )
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
    args = p.parse_args()

    if not args.target and not args.regroup_all:
        p.error("provide a target (URL / id) or pass --regroup-all")

    index = json.loads(INDEX_PATH.read_text())

    if args.target:
        cookie = load_session_cookie()
        creator_id, creator = resolve_input(args.target, index, cookie)
        print(f"creator: {creator_id} (campaign {creator['patreon_campaign_id']})")

        posts = fetch_posts(creator["patreon_campaign_id"], cookie)
        print(f"  posts seen: {len(posts)}")

        cache_dir = Path(
            tempfile.mkdtemp(prefix=f"the-shop-scrape-{creator_id}-")
        )
        try:
            new_entries = build_entries(creator_id, posts, cookie, cache_dir)
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
