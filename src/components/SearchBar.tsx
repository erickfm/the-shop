import React, { useEffect, useMemo, useRef, useState } from "react";
import Fuse, { FuseResult, FuseResultMatch } from "fuse.js";
import type { IndexedPack } from "../lib/types";
import {
  characterDisplay,
  slotDisplay,
  stripColorSuffix,
} from "../lib/melee";
import { CharacterBadge } from "./CharacterBadge";
import { SafeImage } from "./SafeImage";

const KIND_LABELS_LITE: Record<string, string> = {
  character_skin: "character",
  stage: "stage",
  music: "music",
  effect: "effect",
  animation: "animation",
  ui: "ui",
  item: "item",
  texture_pack: "texture pack",
};

/// Map a pack into the flat shape Fuse.js searches against. Pre-computing
/// the searchable view lets Fuse score against pretty character names
/// ("Falco", not "Fc") and human slot colors ("Blue", not "Bu") — what the
/// user actually types.
type SearchablePack = {
  pack: IndexedPack;
  display_name: string;
  display_name_clean: string;
  creator: string;
  character: string;
  slot_words: string;
  kind_label: string;
  notes: string;
};

function buildSearchable(packs: IndexedPack[]): SearchablePack[] {
  return packs.map((p) => {
    const slotWords = Array.from(
      new Set(
        p.slots
          .map((s) => slotDisplay(s.slot_code))
          .filter((s) => s && s !== "?"),
      ),
    ).join(" ");
    const notes = p.slots
      .map((s) => s.notes)
      .filter((n): n is string => !!n)
      .join(" · ");
    return {
      pack: p,
      display_name: p.display_name,
      display_name_clean: stripColorSuffix(p.display_name),
      creator: p.creator?.display_name ?? p.creator_id,
      character: p.character_code ? characterDisplay(p.character_code) : "",
      slot_words: slotWords,
      kind_label: KIND_LABELS_LITE[p.kind] ?? p.kind,
      notes,
    };
  });
}

export function SearchBar({
  packs,
  onSelectPack,
  onCreatorClick,
}: {
  packs: IndexedPack[];
  onSelectPack: (id: string) => void;
  onCreatorClick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const searchable = useMemo(() => buildSearchable(packs), [packs]);

  const fuse = useMemo(
    () =>
      new Fuse(searchable, {
        keys: [
          { name: "display_name_clean", weight: 2 },
          { name: "display_name", weight: 1.5 },
          { name: "creator", weight: 1 },
          { name: "character", weight: 1.5 },
          { name: "slot_words", weight: 0.6 },
          { name: "kind_label", weight: 0.3 },
          { name: "notes", weight: 0.5 },
        ],
        threshold: 0.35,
        includeMatches: true,
        minMatchCharLength: 2,
        ignoreLocation: true,
        useExtendedSearch: false,
      }),
    [searchable],
  );

  const trimmed = query.trim();
  const results: FuseResult<SearchablePack>[] = useMemo(() => {
    if (trimmed.length < 2) return [];
    return fuse.search(trimmed, { limit: 30 });
  }, [fuse, trimmed]);

  // Global '/' to focus, and click-outside to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (e.key === "/" && !inEditable) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  useEffect(() => {
    setFocusedIdx(0);
  }, [trimmed]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (query) {
        setQuery("");
      } else {
        inputRef.current?.blur();
        setOpen(false);
      }
      return;
    }
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[focusedIdx];
      if (r) {
        commitSelect(r.item.pack.pack_id);
      }
    }
  };

  const commitSelect = (packId: string) => {
    onSelectPack(packId);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const showDropdown = open && trimmed.length >= 2;

  return (
    <div ref={containerRef} className="relative w-full max-w-2xl">
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">
          ⌕
        </span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleInputKeyDown}
          placeholder="search packs, creators, characters, colors…"
          className="w-full pl-9 pr-12 py-2.5 bg-surface border border-border rounded-lg text-sm focus:border-accent focus:outline-none placeholder:text-muted"
          aria-label="search the texture index"
        />
        <kbd
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded border border-border text-muted bg-bg pointer-events-none"
          title="press / to focus"
        >
          /
        </kbd>
      </div>

      {showDropdown && (
        <div
          className="absolute z-30 left-0 right-0 mt-2 bg-surface border border-border rounded-lg shadow-2xl max-h-[28rem] overflow-y-auto"
          role="listbox"
        >
          {results.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted">
              no matches for <span className="text-white">"{trimmed}"</span>.
              try a creator or character name.
            </div>
          ) : (
            <>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted border-b border-border bg-bg/60 sticky top-0">
                {results.length} match{results.length === 1 ? "" : "es"}
                {" · "}↑↓ navigate{" · "}↵ open{" · "}esc clear
              </div>
              {results.map((r, i) => (
                <SearchResultRow
                  key={r.item.pack.pack_id}
                  result={r}
                  focused={i === focusedIdx}
                  onMouseEnter={() => setFocusedIdx(i)}
                  onClick={() => commitSelect(r.item.pack.pack_id)}
                  onCreatorClick={(id) => {
                    onCreatorClick(id);
                    setQuery("");
                    setOpen(false);
                  }}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SearchResultRow({
  result,
  focused,
  onMouseEnter,
  onClick,
  onCreatorClick,
}: {
  result: FuseResult<SearchablePack>;
  focused: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  onCreatorClick: (id: string) => void;
}) {
  const pack = result.item.pack;
  const matches = result.matches ?? [];
  const titleMatch = matches.find(
    (m) =>
      m.key === "display_name_clean" || m.key === "display_name",
  );
  const creatorMatch = matches.find((m) => m.key === "creator");
  const characterMatch = matches.find((m) => m.key === "character");
  const previews = pack.preview_urls.length
    ? pack.preview_urls
    : pack.preview_url
      ? [pack.preview_url]
      : [];
  const cleanTitle = result.item.display_name_clean;
  return (
    <div
      role="option"
      aria-selected={focused}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={`flex items-center gap-3 p-3 cursor-pointer ${
        focused ? "bg-bg" : "hover:bg-bg/60"
      }`}
    >
      <div className="w-12 h-12 rounded bg-bg shrink-0 overflow-hidden flex items-center justify-center">
        {previews[0] ? (
          <SafeImage
            src={previews[0]}
            alt={pack.display_name}
            className="w-full h-full object-cover"
            fallback={<CharacterBadge code={pack.character_code} size={48} />}
          />
        ) : (
          <CharacterBadge code={pack.character_code} size={48} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          {titleMatch
            ? renderHighlighted(cleanTitle, titleMatch)
            : cleanTitle}
        </div>
        <div className="text-xs text-muted truncate">
          <span
            className="hover:text-white hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              if (pack.creator?.id) onCreatorClick(pack.creator.id);
            }}
          >
            {creatorMatch
              ? renderHighlighted(result.item.creator, creatorMatch)
              : result.item.creator}
          </span>
          {result.item.character && (
            <>
              <span> · </span>
              <span>
                {characterMatch
                  ? renderHighlighted(result.item.character, characterMatch)
                  : result.item.character}
              </span>
            </>
          )}
          <span> · {result.item.kind_label}</span>
          {pack.slot_count > 1 && <span> · {pack.slot_count} slots</span>}
        </div>
      </div>
      {pack.installed_count > 0 && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded bg-ok/30 border border-ok text-ok shrink-0"
          title={`${pack.installed_count}/${pack.slot_count} installed`}
        >
          {pack.installed_count === pack.slot_count
            ? "installed"
            : `${pack.installed_count}/${pack.slot_count}`}
        </span>
      )}
    </div>
  );
}

/// Wrap matched substrings in a highlight span using Fuse's index ranges.
/// Indices are inclusive on both ends per Fuse's API.
function renderHighlighted(
  text: string,
  match: FuseResultMatch,
): React.ReactElement {
  const indices = match.indices ?? [];
  if (indices.length === 0) return <>{text}</>;
  const sorted = [...indices].sort((a, b) => a[0] - b[0]);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const [start, end] of sorted) {
    if (start > cursor) {
      parts.push(<span key={key++}>{text.slice(cursor, start)}</span>);
    }
    parts.push(
      <mark
        key={key++}
        className="bg-accent/40 text-white rounded px-0.5"
      >
        {text.slice(start, end + 1)}
      </mark>,
    );
    cursor = end + 1;
  }
  if (cursor < text.length) {
    parts.push(<span key={key++}>{text.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}
