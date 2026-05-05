import { useEffect, useMemo, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ipc } from "../lib/ipc";
import { toast } from "../components/Toaster";
import { busy as withBusy } from "../components/BusyOverlay";
import { CharacterBadge } from "../components/CharacterBadge";
import { SafeImage } from "../components/SafeImage";
import type {
  AnnotatedCreator,
  AnnotatedSkin,
  BackedCreator,
  IndexedPack,
  SkinKind,
} from "../lib/types";
import {
  characterDisplay,
  previewList,
  requiresUnzip,
  slotDisplay,
  stageDisplay,
} from "../lib/melee";

function dollars(cents: number): string {
  if (cents <= 0) return "free";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

const KIND_LABELS: Record<SkinKind, string> = {
  character_skin: "Character",
  stage: "Stage",
  music: "Music",
  effect: "Effect",
  animation: "Animation",
  ui: "UI",
  item: "Item",
  texture_pack: "Texture pack",
};

const KIND_FILTER_ORDER: (SkinKind | "all")[] = [
  "all",
  "character_skin",
  "stage",
  "texture_pack",
  "music",
  "ui",
  "effect",
  "animation",
  "item",
];

type View =
  | { tag: "discover" }
  | { tag: "creator"; id: string }
  | { tag: "creators-index" };

export function Browse({ onAfterAction }: { onAfterAction?: () => void }) {
  const [creators, setCreators] = useState<BackedCreator[]>([]);
  const [indexedCreators, setIndexedCreators] = useState<AnnotatedCreator[]>([]);
  const [packs, setPacks] = useState<IndexedPack[]>([]);
  const [view, setView] = useState<View>({ tag: "discover" });
  const [filterKind, setFilterKind] = useState<SkinKind | "all">("all");
  const [filterCharacter, setFilterCharacter] = useState<string | null>(null);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = async () => {
    const [c, ic, p] = await Promise.all([
      ipc.listBackedCreators(false),
      ipc.listIndexedCreators(),
      ipc.listIndexedPacks(),
    ]);
    setCreators(c);
    setIndexedCreators(ic);
    setPacks(p);
  };

  const refresh = async (forceIndex = false) => {
    try {
      await loadList();
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
    if (forceIndex) {
      try {
        await ipc.refreshSkinIndex();
        await loadList();
        toast({ kind: "ok", text: "Index refreshed" });
      } catch (e: any) {
        toast({
          kind: "danger",
          text: `Couldn't refresh from upstream (using bundled): ${e?.message || e}`,
        });
      }
    }
  };

  useEffect(() => {
    refresh(false);
  }, []);

  const creatorScopedPacks = useMemo(() => {
    if (view.tag === "creator") {
      return packs.filter((p) => p.creator?.id === view.id);
    }
    return packs;
  }, [packs, view]);

  const filteredPacks = useMemo(() => {
    return creatorScopedPacks.filter((p) => {
      if (filterKind !== "all" && (p.kind ?? "character_skin") !== filterKind)
        return false;
      if (filterCharacter && p.character_code !== filterCharacter) return false;
      return true;
    });
  }, [creatorScopedPacks, filterKind, filterCharacter]);

  const kindCounts = useMemo(() => {
    const counts = new Map<SkinKind, number>();
    for (const p of creatorScopedPacks) {
      const k = (p.kind ?? "character_skin") as SkinKind;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [creatorScopedPacks]);

  const characterCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const kindFiltered = creatorScopedPacks.filter((p) => {
      const k = (p.kind ?? "character_skin") as SkinKind;
      return filterKind === "all" || k === filterKind;
    });
    for (const p of kindFiltered) {
      if (!p.character_code) continue;
      counts.set(p.character_code, (counts.get(p.character_code) ?? 0) + 1);
    }
    return counts;
  }, [creatorScopedPacks, filterKind]);

  const sortedCharacters = useMemo(() => {
    return Array.from(characterCounts.entries()).sort((a, b) =>
      characterDisplay(a[0]).localeCompare(characterDisplay(b[0])),
    );
  }, [characterCounts]);

  useEffect(() => {
    if (filterCharacter && !characterCounts.has(filterCharacter)) {
      setFilterCharacter(null);
    }
  }, [characterCounts, filterCharacter]);

  useEffect(() => {
    if (filterKind !== "all" && (kindCounts.get(filterKind) ?? 0) === 0) {
      setFilterKind("all");
    }
  }, [kindCounts, filterKind]);

  const installSlot = async (slot: AnnotatedSkin) => {
    setBusyKey(`slot:${slot.id}`);
    try {
      await withBusy(`Installing ${slot.display_name}…`, () =>
        ipc.installPatreonSkin(slot.id),
      );
      toast({ kind: "ok", text: `Installed ${slot.display_name}` });
      await refresh(false);
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `Install failed: ${e?.message || e}` });
    } finally {
      setBusyKey(null);
    }
  };

  const installPackAll = async (pack: IndexedPack) => {
    const installable = pack.slots.filter((s) => !s.installed && s.tier_satisfied);
    if (installable.length === 0) return;
    setBusyKey(`pack:${pack.pack_id}`);
    try {
      const result = await withBusy(
        `Installing ${installable.length} slot${
          installable.length === 1 ? "" : "s"
        } from ${pack.display_name}…`,
        () => ipc.installPatreonSkinsBulk(installable.map((s) => s.id)),
      );
      const okCount = result.installed.length;
      const failCount = result.failed.length;
      if (failCount > 0) {
        const detail = result.failed
          .slice(0, 2)
          .map((f) => f.error)
          .join(" · ");
        toast({
          kind: okCount > 0 ? "info" : "danger",
          text: `Installed ${okCount}/${okCount + failCount} from ${pack.display_name}. Failed: ${detail}`,
        });
      } else {
        toast({
          kind: "ok",
          text: `Installed ${okCount} slot${okCount === 1 ? "" : "s"} from ${pack.display_name}`,
        });
      }
      await refresh(false);
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `Install failed: ${e?.message || e}` });
    } finally {
      setBusyKey(null);
    }
  };

  const subscribeOnPatreon = async (url: string) => {
    try {
      await openExternal(url);
    } catch (e: any) {
      toast({ kind: "danger", text: `Could not open browser: ${e?.message || e}` });
    }
  };

  const openPatreonPost = async (postId: string) => {
    try {
      await openExternal(`https://www.patreon.com/posts/${postId}`);
    } catch (e: any) {
      toast({ kind: "danger", text: `Could not open browser: ${e?.message || e}` });
    }
  };

  const goToCreator = (id: string) => {
    setView({ tag: "creator", id });
    setFilterKind("all");
    setFilterCharacter(null);
  };

  const currentCreator =
    view.tag === "creator"
      ? (indexedCreators.find((c) => c.id === view.id) ?? null)
      : null;

  const selectedPack = selectedPackId
    ? (packs.find((p) => p.pack_id === selectedPackId) ?? null)
    : null;

  return (
    <div className="flex h-full">
      <aside className="w-60 border-r border-border bg-surface p-4 overflow-y-auto space-y-4 shrink-0">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-muted px-2 pb-1">
            Browse
          </div>
          <SidebarLink
            active={view.tag === "discover"}
            label="All mods"
            count={packs.length}
            onClick={() => setView({ tag: "discover" })}
          />
          <SidebarLink
            active={view.tag === "creators-index"}
            label="All creators"
            count={indexedCreators.length}
            onClick={() => setView({ tag: "creators-index" })}
          />
        </div>

        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-muted px-2 pb-1">
            You back on Patreon
          </div>
          {creators.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted">
              No Patreon subscriptions yet.
            </div>
          )}
          {creators.map((c) => {
            const matched = indexedCreators.find(
              (ic) => ic.patreon_campaign_id === c.campaign_id,
            );
            const id = matched?.id ?? null;
            const active = view.tag === "creator" && id === view.id;
            return (
              <button
                key={c.campaign_id}
                className={`w-full text-left px-3 py-2 rounded text-sm ${
                  active ? "bg-bg text-white" : "text-muted hover:text-white"
                }`}
                onClick={() => id && goToCreator(id)}
                disabled={!id}
                title={!id ? "Not in the texture index yet" : undefined}
              >
                <div className="truncate font-medium text-white">
                  {c.campaign_name}
                </div>
                <div className="text-xs text-muted">
                  {dollars(c.currently_entitled_amount_cents)}
                  {c.tier_titles[0] ? ` · ${c.tier_titles[0]}` : ""}
                </div>
              </button>
            );
          })}
        </div>

        <div className="pt-2">
          <button
            className="btn w-full text-xs"
            onClick={() => refresh(true)}
            title="Pull the latest texture index from GitHub"
          >
            Refresh index
          </button>
        </div>
      </aside>

      <section className="flex-1 overflow-y-auto p-8 space-y-6">
        {error && (
          <div className="card p-4 text-sm text-danger">
            Could not load: {error}
          </div>
        )}

        {view.tag === "creators-index" && (
          <CreatorsIndex
            creators={indexedCreators}
            onPick={(id) => goToCreator(id)}
            onSubscribe={(url) => subscribeOnPatreon(url)}
          />
        )}

        {view.tag === "creator" && currentCreator && (
          <CreatorHeader
            creator={currentCreator}
            onClear={() => setView({ tag: "discover" })}
            onSubscribe={() => subscribeOnPatreon(currentCreator.patreon_url)}
          />
        )}

        {(view.tag === "discover" || view.tag === "creator") && (
          <div>
            <div className="flex items-center justify-between pb-3">
              <h3 className="text-base font-semibold">
                {view.tag === "creator" ? "Mods from this creator" : "All mods"}
              </h3>
              <div className="text-xs text-muted">
                {filteredPacks.length} pack
                {filteredPacks.length === 1 ? "" : "s"}
                {filterKind !== "all" || filterCharacter ? " · filtered" : ""}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 pb-2">
              {KIND_FILTER_ORDER.map((k) => {
                const count =
                  k === "all"
                    ? creatorScopedPacks.length
                    : (kindCounts.get(k as SkinKind) ?? 0);
                const active = filterKind === k;
                if (k !== "all" && count === 0 && !active) return null;
                return (
                  <button
                    key={k}
                    className={`text-xs px-2 py-1 rounded border ${
                      active
                        ? "bg-accent text-white border-accent"
                        : "bg-surface text-muted border-border hover:text-white"
                    }`}
                    onClick={() => setFilterKind(k)}
                  >
                    {k === "all" ? "All" : KIND_LABELS[k as SkinKind]}{" "}
                    <span className="opacity-60">{count}</span>
                  </button>
                );
              })}
            </div>

            {sortedCharacters.length > 1 && (
              <div className="flex flex-wrap gap-1.5 pb-4">
                <button
                  className={`text-xs px-2 py-1 rounded border ${
                    filterCharacter === null
                      ? "bg-bg text-white border-border"
                      : "bg-surface text-muted border-border hover:text-white"
                  }`}
                  onClick={() => setFilterCharacter(null)}
                >
                  All characters
                </button>
                {sortedCharacters.map(([code, count]) => {
                  const active = filterCharacter === code;
                  return (
                    <button
                      key={code}
                      className={`text-xs px-2 py-1 rounded border ${
                        active
                          ? "bg-bg text-white border-border"
                          : "bg-surface text-muted border-border hover:text-white"
                      }`}
                      onClick={() => setFilterCharacter(code)}
                    >
                      {characterDisplay(code)}{" "}
                      <span className="opacity-60">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {filteredPacks.length === 0 && !error && (
              <div className="card p-10 text-center text-sm text-muted">
                No mods match this filter.
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredPacks.map((p) => (
                <PackCard
                  key={p.pack_id}
                  pack={p}
                  busyKey={busyKey}
                  onSelect={() => setSelectedPackId(p.pack_id)}
                  onInstallAll={() => installPackAll(p)}
                  onInstallSingle={() => p.slots[0] && installSlot(p.slots[0])}
                  onSubscribe={() =>
                    subscribeOnPatreon(
                      p.creator?.patreon_url || "https://www.patreon.com",
                    )
                  }
                  onCreatorClick={() =>
                    p.creator?.id && goToCreator(p.creator.id)
                  }
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {selectedPack && (
        <PackDetailDrawer
          pack={selectedPack}
          busyKey={busyKey}
          onClose={() => setSelectedPackId(null)}
          onInstallSlot={installSlot}
          onInstallAll={() => installPackAll(selectedPack)}
          onSubscribe={() =>
            subscribeOnPatreon(
              selectedPack.creator?.patreon_url || "https://www.patreon.com",
            )
          }
          onOpenPost={() => openPatreonPost(selectedPack.patreon_post_id)}
          onCreatorClick={() => {
            if (selectedPack.creator?.id) {
              goToCreator(selectedPack.creator.id);
              setSelectedPackId(null);
            }
          }}
        />
      )}
    </div>
  );
}

function SidebarLink({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm ${
        active ? "bg-bg text-white" : "text-muted hover:text-white"
      }`}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="text-xs opacity-60">{count}</span>
    </button>
  );
}

function PackCard({
  pack,
  busyKey,
  onSelect,
  onInstallAll,
  onInstallSingle,
  onSubscribe,
  onCreatorClick,
}: {
  pack: IndexedPack;
  busyKey: string | null;
  onSelect: () => void;
  onInstallAll: () => void;
  onInstallSingle: () => void;
  onSubscribe: () => void;
  onCreatorClick: () => void;
}) {
  const previews = previewList(pack);
  const extra = previews.length - 1;
  const isMulti = pack.slot_count > 1;
  const allInstalled = pack.installed_count === pack.slot_count;
  const someInstalled = pack.installed_count > 0;
  const installable = pack.slots.filter(
    (s) => !s.installed && s.tier_satisfied,
  ).length;
  const myPackBusy = busyKey === `pack:${pack.pack_id}`;
  const mySoloBusy = pack.slots[0] && busyKey === `slot:${pack.slots[0].id}`;

  return (
    <div className="card overflow-hidden flex flex-col">
      <button
        type="button"
        onClick={onSelect}
        className="relative aspect-square bg-bg flex items-center justify-center w-full cursor-pointer group overflow-hidden"
      >
        {previews[0] ? (
          <SafeImage
            src={previews[0]}
            alt={pack.display_name}
            className="max-w-full max-h-full object-contain transition-transform group-hover:scale-[1.02]"
            fallback={<CharacterBadge code={pack.character_code} size={120} />}
          />
        ) : (
          <CharacterBadge code={pack.character_code} size={120} />
        )}
        {extra > 0 && (
          <span
            className="absolute bottom-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-bg/80 border border-border text-white"
            title={`${previews.length} images in this post`}
          >
            +{extra}
          </span>
        )}
        {isMulti && (
          <span
            className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-bg/80 border border-border text-white"
            title={`${pack.slot_count} color slots`}
          >
            {pack.slot_count} slots
          </span>
        )}
        <span className="absolute inset-0 ring-0 group-hover:ring-2 ring-accent/40 transition-all pointer-events-none" />
      </button>

      <div className="p-4 space-y-3 flex-1 flex flex-col">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSelect}
              className="text-base font-semibold truncate flex-1 text-left hover:underline"
            >
              {pack.display_name}
            </button>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg border border-border text-muted shrink-0">
              {KIND_LABELS[(pack.kind ?? "character_skin") as SkinKind]}
            </span>
          </div>
          <div className="text-xs text-muted truncate">
            <button
              type="button"
              onClick={onCreatorClick}
              className="hover:text-white hover:underline disabled:opacity-100 disabled:no-underline"
              disabled={!pack.creator?.id}
            >
              {pack.creator?.display_name || pack.creator_id}
            </button>
            {pack.kind === "stage" && pack.slots[0]?.iso_target_filename &&
              ` · ${stageDisplay(pack.slots[0].iso_target_filename)}`}
            {(pack.kind === "character_skin" ||
              pack.kind === "effect" ||
              pack.kind === "animation") &&
              pack.character_code &&
              ` · ${characterDisplay(pack.character_code)}`}
            {pack.slots[0] && requiresUnzip(pack.slots[0].filename_in_post) && (
              <span title="Bundled inside an archive">{" · zip"}</span>
            )}
          </div>
        </div>

        {isMulti && (
          <div className="flex flex-wrap gap-1">
            {pack.slots.map((s) => (
              <span
                key={s.id}
                className={`text-[10px] px-1.5 py-0.5 rounded border ${
                  s.installed
                    ? "bg-ok/20 border-ok text-ok"
                    : s.tier_satisfied
                      ? "bg-bg border-border text-muted"
                      : "bg-bg border-border text-muted opacity-50"
                }`}
                title={
                  s.installed
                    ? `Installed: ${s.display_name}`
                    : s.tier_satisfied
                      ? `Available: ${s.display_name}`
                      : `Locked (${dollars(s.tier_required_cents)}): ${s.display_name}`
                }
              >
                {slotDisplay(s.slot_code) || s.slot_code || "?"}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 text-xs">
          {allInstalled ? (
            <span className="pill-ok">
              {isMulti ? "all installed" : "installed"}
            </span>
          ) : someInstalled ? (
            <span className="pill-ok">
              {pack.installed_count}/{pack.slot_count} installed
            </span>
          ) : pack.any_tier_satisfied ? (
            <span className="pill-ok">available</span>
          ) : pack.backed ? (
            <span className="pill-muted text-accent">
              needs {dollars(pack.tier_required_cents)} tier
            </span>
          ) : (
            <span className="pill-muted">
              subscribe ({dollars(pack.tier_required_cents)})
            </span>
          )}
        </div>

        <div className="mt-auto pt-2">
          {allInstalled ? (
            <button className="btn w-full" onClick={onSelect}>
              Manage slots
            </button>
          ) : isMulti ? (
            installable > 0 ? (
              <div className="flex gap-2">
                <button
                  className="btn-primary flex-1"
                  onClick={onInstallAll}
                  disabled={myPackBusy}
                >
                  {myPackBusy ? "Installing…" : `Install all (${installable})`}
                </button>
                <button className="btn shrink-0" onClick={onSelect}>
                  Pick slots
                </button>
              </div>
            ) : (
              <button className="btn w-full" onClick={onSubscribe}>
                Subscribe on Patreon
              </button>
            )
          ) : pack.slots[0]?.installed ? (
            <button className="btn w-full" disabled>
              Installed
            </button>
          ) : pack.any_tier_satisfied ? (
            <button
              className="btn-primary w-full"
              onClick={onInstallSingle}
              disabled={mySoloBusy}
            >
              {mySoloBusy ? "Installing…" : "Install"}
            </button>
          ) : (
            <button className="btn w-full" onClick={onSubscribe}>
              Subscribe on Patreon
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PackDetailDrawer({
  pack,
  busyKey,
  onClose,
  onInstallSlot,
  onInstallAll,
  onSubscribe,
  onOpenPost,
  onCreatorClick,
}: {
  pack: IndexedPack;
  busyKey: string | null;
  onClose: () => void;
  onInstallSlot: (slot: AnnotatedSkin) => void;
  onInstallAll: () => void;
  onSubscribe: () => void;
  onOpenPost: () => void;
  onCreatorClick: () => void;
}) {
  const kindLabel = KIND_LABELS[(pack.kind ?? "character_skin") as SkinKind];
  const previews = previewList(pack);
  const [activeIdx, setActiveIdx] = useState(0);
  const active = previews[Math.min(activeIdx, previews.length - 1)];
  const isMulti = pack.slot_count > 1;
  const installable = pack.slots.filter(
    (s) => !s.installed && s.tier_satisfied,
  ).length;
  const allInstalled = pack.installed_count === pack.slot_count;
  const myPackBusy = busyKey === `pack:${pack.pack_id}`;

  const metaPills: string[] = [kindLabel];
  if (pack.kind === "stage" && pack.slots[0]?.iso_target_filename) {
    metaPills.push(stageDisplay(pack.slots[0].iso_target_filename));
  }
  if (
    (pack.kind === "character_skin" ||
      pack.kind === "effect" ||
      pack.kind === "animation") &&
    pack.character_code
  ) {
    metaPills.push(characterDisplay(pack.character_code));
  }
  metaPills.push(
    pack.tier_required_cents === 0
      ? "Free"
      : `${dollars(pack.tier_required_cents)}/mo`,
  );

  return (
    <>
      <div
        className="fixed inset-0 bg-black/60 z-40"
        onClick={onClose}
        aria-hidden
      />
      <aside className="fixed top-0 right-0 bottom-0 w-full max-w-xl bg-surface border-l border-border z-50 overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-surface z-10">
          <div className="text-xs uppercase tracking-wide text-muted">
            {kindLabel}
            {isMulti && ` · ${pack.slot_count} slots`}
          </div>
          <button
            className="text-muted hover:text-white text-sm px-2"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-6 space-y-5">
          <div className="aspect-square bg-bg rounded overflow-hidden flex items-center justify-center">
            {active ? (
              <SafeImage
                src={active}
                alt={pack.display_name}
                className="max-w-full max-h-full object-contain"
                fallback={
                  <CharacterBadge code={pack.character_code} size={200} />
                }
              />
            ) : (
              <CharacterBadge code={pack.character_code} size={200} />
            )}
          </div>
          {previews.length > 1 && (
            <div className="flex gap-2 overflow-x-auto -mx-1 px-1">
              {previews.map((u, i) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setActiveIdx(i)}
                  className={`shrink-0 w-16 h-16 rounded overflow-hidden border-2 ${
                    i === activeIdx
                      ? "border-accent"
                      : "border-border hover:border-muted"
                  }`}
                >
                  <SafeImage
                    src={u}
                    alt=""
                    className="w-full h-full object-cover"
                    fallback={
                      <div className="w-full h-full bg-bg flex items-center justify-center text-muted text-xs">
                        ?
                      </div>
                    }
                  />
                </button>
              ))}
            </div>
          )}

          <div>
            <h2 className="text-2xl font-semibold leading-tight">
              {pack.display_name}
            </h2>
            <button
              type="button"
              onClick={onCreatorClick}
              className="text-sm text-muted hover:text-white hover:underline disabled:opacity-100 disabled:no-underline"
              disabled={!pack.creator?.id}
            >
              by {pack.creator?.display_name || pack.creator_id}
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5 text-xs">
            {allInstalled ? (
              <span className="pill-ok">
                {isMulti ? "all installed" : "installed"}
              </span>
            ) : pack.installed_count > 0 ? (
              <span className="pill-ok">
                {pack.installed_count}/{pack.slot_count} installed
              </span>
            ) : pack.any_tier_satisfied ? (
              <span className="pill-ok">available</span>
            ) : pack.backed ? (
              <span className="pill-muted text-accent">
                needs {dollars(pack.tier_required_cents)} tier · you're at{" "}
                {dollars(pack.current_tier_cents)}
              </span>
            ) : (
              <span className="pill-muted">
                subscribe ({dollars(pack.tier_required_cents)})
              </span>
            )}
            {pack.slots[0] && requiresUnzip(pack.slots[0].filename_in_post) && (
              <span className="pill-muted">zip</span>
            )}
            {metaPills.map((p) => (
              <span key={p} className="pill-muted">
                {p}
              </span>
            ))}
          </div>

          {isMulti && installable > 0 && (
            <div>
              <button
                className="btn-primary w-full"
                onClick={onInstallAll}
                disabled={myPackBusy}
              >
                {myPackBusy
                  ? "Installing…"
                  : `Install all available (${installable})`}
              </button>
            </div>
          )}

          {isMulti ? (
            <div className="border border-border rounded">
              <div className="text-xs uppercase tracking-wide text-muted px-3 py-2 border-b border-border">
                Slots
              </div>
              <div className="divide-y divide-border">
                {pack.slots.map((s) => (
                  <SlotRow
                    key={s.id}
                    slot={s}
                    busy={busyKey === `slot:${s.id}`}
                    onInstall={() => onInstallSlot(s)}
                    onSubscribe={onSubscribe}
                  />
                ))}
              </div>
            </div>
          ) : (
            <SoloInstallButton
              slot={pack.slots[0]}
              busy={pack.slots[0] ? busyKey === `slot:${pack.slots[0].id}` : false}
              onInstall={() => pack.slots[0] && onInstallSlot(pack.slots[0])}
              onSubscribe={onSubscribe}
            />
          )}

          <button className="btn w-full text-xs" onClick={onOpenPost}>
            Open Patreon post →
          </button>
        </div>
      </aside>
    </>
  );
}

function SlotRow({
  slot,
  busy,
  onInstall,
  onSubscribe,
}: {
  slot: AnnotatedSkin;
  busy: boolean;
  onInstall: () => void;
  onSubscribe: () => void;
}) {
  const slotName = slotDisplay(slot.slot_code) || slot.slot_code || "Slot";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{slotName}</div>
        {slot.display_name !== slotName && (
          <div className="text-xs text-muted truncate">{slot.display_name}</div>
        )}
      </div>
      {slot.installed ? (
        <span className="pill-ok shrink-0">installed</span>
      ) : !slot.tier_satisfied ? (
        <span
          className="text-xs text-muted shrink-0"
          title={`Needs ${dollars(slot.tier_required_cents)} tier`}
        >
          {dollars(slot.tier_required_cents)} tier
        </span>
      ) : null}
      <div className="shrink-0">
        {slot.installed ? (
          <button className="btn text-xs" disabled>
            Installed
          </button>
        ) : slot.tier_satisfied ? (
          <button
            className="btn-primary text-xs"
            onClick={onInstall}
            disabled={busy}
          >
            {busy ? "Installing…" : "Install"}
          </button>
        ) : (
          <button className="btn text-xs" onClick={onSubscribe}>
            Subscribe
          </button>
        )}
      </div>
    </div>
  );
}

function SoloInstallButton({
  slot,
  busy,
  onInstall,
  onSubscribe,
}: {
  slot: AnnotatedSkin | undefined;
  busy: boolean;
  onInstall: () => void;
  onSubscribe: () => void;
}) {
  if (!slot) return null;
  if (slot.installed) {
    return (
      <button className="btn w-full" disabled>
        Installed
      </button>
    );
  }
  if (slot.tier_satisfied) {
    return (
      <button className="btn-primary w-full" onClick={onInstall} disabled={busy}>
        {busy ? "Installing…" : "Install"}
      </button>
    );
  }
  return (
    <button className="btn w-full" onClick={onSubscribe}>
      Subscribe on Patreon
    </button>
  );
}

function CreatorHeader({
  creator,
  onClear,
  onSubscribe,
}: {
  creator: AnnotatedCreator;
  onClear: () => void;
  onSubscribe: () => void;
}) {
  return (
    <div className="card p-6 flex items-start justify-between gap-4">
      <div className="space-y-1 min-w-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted hover:text-white"
          >
            ← all mods
          </button>
        </div>
        <div className="text-xl font-semibold truncate">
          {creator.display_name}
        </div>
        {creator.tagline && (
          <p className="text-sm text-muted">{creator.tagline}</p>
        )}
        <div className="flex flex-wrap gap-1.5 text-xs pt-1">
          {creator.backed ? (
            <span className="pill-ok">
              backed at {dollars(creator.current_tier_cents)}
            </span>
          ) : (
            <span className="pill-muted">not subscribed</span>
          )}
          <span className="pill-muted">
            {creator.skin_count} skin{creator.skin_count === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <button className="btn flex-shrink-0" onClick={onSubscribe}>
        Open on Patreon
      </button>
    </div>
  );
}

function CreatorsIndex({
  creators,
  onPick,
  onSubscribe,
}: {
  creators: AnnotatedCreator[];
  onPick: (id: string) => void;
  onSubscribe: (url: string) => void;
}) {
  if (creators.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-muted">
        No creators in the texture index yet.
      </div>
    );
  }
  const sorted = [...creators].sort((a, b) => b.skin_count - a.skin_count);
  return (
    <div>
      <div className="flex items-center justify-between pb-3">
        <h2 className="text-lg font-semibold">All creators</h2>
        <div className="text-xs text-muted">
          {creators.length} creator{creators.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {sorted.map((c) => (
          <div key={c.id} className="card p-4 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <button
                  type="button"
                  className="text-base font-semibold truncate hover:underline text-left"
                  onClick={() => onPick(c.id)}
                >
                  {c.display_name}
                </button>
                {c.tagline && (
                  <p className="text-xs text-muted leading-relaxed">
                    {c.tagline}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {c.backed ? (
                <span className="pill-ok">
                  backed · {dollars(c.current_tier_cents)}
                </span>
              ) : (
                <span className="pill-muted">not subscribed</span>
              )}
              <span className="pill-muted">
                {c.skin_count} skin{c.skin_count === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                className="btn text-xs flex-1"
                onClick={() => onSubscribe(c.patreon_url)}
              >
                Open on Patreon
              </button>
              {c.skin_count > 0 && (
                <button
                  className="btn text-xs flex-1"
                  onClick={() => onPick(c.id)}
                >
                  See skins
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
