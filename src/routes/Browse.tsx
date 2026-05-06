import { useEffect, useMemo, useRef, useState } from "react";
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
  isLegalRankedStage,
  packTilt,
  previewList,
  requiresUnzip,
  slotDisplay,
  stageDisplay,
  stripColorSuffix,
} from "../lib/melee";
import type { CSSProperties } from "react";
import { SearchBar } from "../components/SearchBar";

function dollars(cents: number): string {
  if (cents <= 0) return "free";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

const KIND_LABELS: Record<SkinKind, string> = {
  character_skin: "character",
  stage: "stage",
  music: "music",
  effect: "effect",
  animation: "animation",
  ui: "ui",
  item: "item",
  texture_pack: "texture pack",
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
  | { tag: "storefront" }
  | { tag: "creator"; id: string }
  | { tag: "creators-index" };

export function Browse({ onAfterAction }: { onAfterAction?: () => void }) {
  const [creators, setCreators] = useState<BackedCreator[]>([]);
  const [indexedCreators, setIndexedCreators] = useState<AnnotatedCreator[]>([]);
  const [packs, setPacks] = useState<IndexedPack[]>([]);
  const [view, setView] = useState<View>({ tag: "storefront" });
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
        toast({ kind: "ok", text: "index refreshed" });
      } catch (e: any) {
        toast({
          kind: "danger",
          text: `couldn't refresh from upstream (using bundled): ${e?.message || e}`,
        });
      }
    }
  };

  useEffect(() => {
    refresh(false);
  }, []);

  const backedCreatorIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of creators) {
      const matched = indexedCreators.find(
        (ic) => ic.patreon_campaign_id === c.campaign_id,
      );
      if (matched?.id) ids.add(matched.id);
    }
    return ids;
  }, [creators, indexedCreators]);

  // Pin the *selection* of featured packs / featured creator at first-load
  // (or manual refresh) instead of recomputing on every `packs` mutation —
  // otherwise the carousel re-rolls each time you install a slot, which is
  // jarring. We only store IDs and resolve to current pack objects on every
  // render, so install-state updates still flow through to the same featured
  // entries.
  const [featuredPackIds, setFeaturedPackIds] = useState<string[] | null>(null);
  const [featuredCreatorId, setFeaturedCreatorId] = useState<string | null>(null);

  useEffect(() => {
    if (featuredPackIds === null && packs.length > 0) {
      setFeaturedPackIds(pickRandomFeaturedPackIds(packs));
    }
  }, [packs, featuredPackIds]);

  useEffect(() => {
    if (
      featuredCreatorId === null &&
      indexedCreators.length > 0 &&
      // wait until backed-set is computed too, so we can prefer a creator
      // the user actually backs on first load
      (creators.length === 0 || backedCreatorIds.size > 0 || creators.length > 0)
    ) {
      setFeaturedCreatorId(
        pickRandomFeaturedCreatorId(indexedCreators, backedCreatorIds),
      );
    }
  }, [indexedCreators, backedCreatorIds, featuredCreatorId, creators.length]);

  const featuredPacks = useMemo(() => {
    if (!featuredPackIds) return [];
    return featuredPackIds
      .map((id) => packs.find((p) => p.pack_id === id))
      .filter((p): p is IndexedPack => !!p);
  }, [packs, featuredPackIds]);

  const featuredCreator = useMemo(() => {
    if (!featuredCreatorId) return null;
    return indexedCreators.find((c) => c.id === featuredCreatorId) ?? null;
  }, [indexedCreators, featuredCreatorId]);

  const reshuffle = () => {
    setFeaturedPackIds(pickRandomFeaturedPackIds(packs));
    setFeaturedCreatorId(
      pickRandomFeaturedCreatorId(indexedCreators, backedCreatorIds),
    );
  };
  const featuredCreatorPacks = useMemo(() => {
    if (!featuredCreator) return [];
    return packs
      .filter((p) => p.creator?.id === featuredCreator.id)
      .sort((a, b) => b.slot_count - a.slot_count)
      .slice(0, 8);
  }, [packs, featuredCreator]);
  const backedPacks = useMemo(() => {
    if (backedCreatorIds.size === 0) return [];
    return packs
      .filter((p) => p.creator?.id && backedCreatorIds.has(p.creator.id))
      .filter((p) => !featuredCreator || p.creator?.id !== featuredCreator.id)
      .sort((a, b) => b.slot_count - a.slot_count)
      .slice(0, 16);
  }, [packs, backedCreatorIds, featuredCreator]);

  // For All-mods grid
  const filteredPacks = useMemo(() => {
    return packs.filter((p) => {
      if (filterKind !== "all" && (p.kind ?? "character_skin") !== filterKind)
        return false;
      if (filterCharacter && p.character_code !== filterCharacter) return false;
      return true;
    });
  }, [packs, filterKind, filterCharacter]);

  const kindCounts = useMemo(() => {
    const counts = new Map<SkinKind, number>();
    for (const p of packs) {
      const k = (p.kind ?? "character_skin") as SkinKind;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [packs]);

  const characterCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const kindFiltered = packs.filter((p) => {
      const k = (p.kind ?? "character_skin") as SkinKind;
      return filterKind === "all" || k === filterKind;
    });
    for (const p of kindFiltered) {
      if (!p.character_code) continue;
      counts.set(p.character_code, (counts.get(p.character_code) ?? 0) + 1);
    }
    return counts;
  }, [packs, filterKind]);

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

  // For creator-scoped view
  const creatorPacks = useMemo(() => {
    if (view.tag !== "creator") return [];
    return packs.filter((p) => p.creator?.id === view.id);
  }, [packs, view]);
  const creatorFilteredPacks = useMemo(() => {
    return creatorPacks.filter((p) => {
      if (filterKind !== "all" && (p.kind ?? "character_skin") !== filterKind)
        return false;
      if (filterCharacter && p.character_code !== filterCharacter) return false;
      return true;
    });
  }, [creatorPacks, filterKind, filterCharacter]);

  const installSlot = async (slot: AnnotatedSkin) => {
    setBusyKey(`slot:${slot.id}`);
    try {
      await withBusy(`installing ${slot.display_name}…`, () =>
        ipc.installPatreonSkin(slot.id),
      );
      toast({ kind: "ok", text: `installed ${slot.display_name}` });
      await refresh(false);
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `install failed: ${e?.message || e}` });
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
        `installing ${installable.length} slot${
          installable.length === 1 ? "" : "s"
        } from ${pack.display_name}…`,
        () => ipc.installPatreonSkinsBulk(installable.map((s) => s.id)),
      );
      const okCount = result.installed.length;
      const failCount = result.failed.length;
      if (failCount > 0) {
        const detail = result.failed.slice(0, 2).map((f) => f.error).join(" · ");
        toast({
          kind: okCount > 0 ? "info" : "danger",
          text: `installed ${okCount}/${okCount + failCount} from ${pack.display_name}. Failed: ${detail}`,
        });
      } else {
        toast({
          kind: "ok",
          text: `installed ${okCount} slot${okCount === 1 ? "" : "s"} from ${pack.display_name}`,
        });
      }
      await refresh(false);
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `install failed: ${e?.message || e}` });
    } finally {
      setBusyKey(null);
    }
  };

  const subscribeOnPatreon = async (url: string) => {
    try {
      await openExternal(url);
    } catch (e: any) {
      toast({ kind: "danger", text: `could not open browser: ${e?.message || e}` });
    }
  };

  const openPatreonPost = async (postId: string) => {
    try {
      await openExternal(`https://www.patreon.com/posts/${postId}`);
    } catch (e: any) {
      toast({ kind: "danger", text: `could not open browser: ${e?.message || e}` });
    }
  };

  const goToCreator = (id: string) => {
    setView({ tag: "creator", id });
    setFilterKind("all");
    setFilterCharacter(null);
    window.scrollTo?.({ top: 0, behavior: "instant" as ScrollBehavior });
  };

  const currentCreator =
    view.tag === "creator"
      ? (indexedCreators.find((c) => c.id === view.id) ?? null)
      : null;

  const selectedPack = selectedPackId
    ? (packs.find((p) => p.pack_id === selectedPackId) ?? null)
    : null;

  return (
    <div className="h-full overflow-y-auto">
      {error && (
        <div className="m-8 card p-4 text-sm text-danger">
          Could not load: {error}
        </div>
      )}

      {view.tag === "storefront" && (
        <Storefront
          featuredPacks={featuredPacks}
          featuredCreator={featuredCreator}
          featuredCreatorPacks={featuredCreatorPacks}
          backedPacks={backedPacks}
          allPacks={filteredPacks}
          searchPacks={packs}
          totalPackCount={packs.length}
          totalCreatorCount={indexedCreators.length}
          kindCounts={kindCounts}
          filterKind={filterKind}
          setFilterKind={setFilterKind}
          sortedCharacters={sortedCharacters}
          filterCharacter={filterCharacter}
          setFilterCharacter={setFilterCharacter}
          busyKey={busyKey}
          onSelectPack={(id) => setSelectedPackId(id)}
          onInstallAll={installPackAll}
          onInstallSingle={(p) => p.slots[0] && installSlot(p.slots[0])}
          onSubscribe={subscribeOnPatreon}
          onCreatorClick={goToCreator}
          onShowAllCreators={() => setView({ tag: "creators-index" })}
          onRefresh={() => refresh(true)}
          onReshuffle={reshuffle}
        />
      )}

      {view.tag === "creators-index" && (
        <div className="p-8 space-y-6">
          <BackBar onClick={() => setView({ tag: "storefront" })} />
          <CreatorsIndex
            creators={indexedCreators}
            onPick={(id) => goToCreator(id)}
            onSubscribe={(url) => subscribeOnPatreon(url)}
          />
        </div>
      )}

      {view.tag === "creator" && currentCreator && (
        <div className="p-8 space-y-6">
          <BackBar onClick={() => setView({ tag: "storefront" })} />
          <CreatorHeader
            creator={currentCreator}
            onSubscribe={() => subscribeOnPatreon(currentCreator.patreon_url)}
          />
          <AllModsSection
            packs={creatorFilteredPacks}
            totalCount={creatorPacks.length}
            kindCounts={kindCountsFor(creatorPacks)}
            filterKind={filterKind}
            setFilterKind={setFilterKind}
            sortedCharacters={charactersFor(creatorPacks, filterKind)}
            filterCharacter={filterCharacter}
            setFilterCharacter={setFilterCharacter}
            busyKey={busyKey}
            onSelectPack={(id) => setSelectedPackId(id)}
            onInstallAll={installPackAll}
            onInstallSingle={(p) => p.slots[0] && installSlot(p.slots[0])}
            onSubscribe={subscribeOnPatreon}
            onCreatorClick={goToCreator}
            title={`Mods from ${currentCreator.display_name}`}
            hideTopActions
          />
        </div>
      )}

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

// ─── selection helpers ────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickRandomFeaturedPackIds(packs: IndexedPack[]): string[] {
  // Prefer packs with at least one usable preview image — otherwise the
  // carousel falls back to character badges, which is fine but less
  // showcase-worthy. If we don't have 5 with previews, top up from the
  // rest so the carousel still fills.
  const withPreview = packs.filter((p) => previewList(p).length > 0);
  const without = packs.filter((p) => previewList(p).length === 0);
  const picked = [...shuffle(withPreview).slice(0, 5)];
  if (picked.length < 5) {
    picked.push(...shuffle(without).slice(0, 5 - picked.length));
  }
  return picked.map((p) => p.pack_id);
}

function pickRandomFeaturedCreatorId(
  creators: AnnotatedCreator[],
  backed: Set<string>,
): string | null {
  const withSkins = creators.filter((c) => c.skin_count > 0);
  if (withSkins.length === 0) return null;
  const backedWithSkins = withSkins.filter((c) => backed.has(c.id));
  if (backedWithSkins.length > 0) {
    return backedWithSkins[Math.floor(Math.random() * backedWithSkins.length)].id;
  }
  return withSkins[Math.floor(Math.random() * withSkins.length)].id;
}

function kindCountsFor(packs: IndexedPack[]): Map<SkinKind, number> {
  const counts = new Map<SkinKind, number>();
  for (const p of packs) {
    const k = (p.kind ?? "character_skin") as SkinKind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function charactersFor(
  packs: IndexedPack[],
  filterKind: SkinKind | "all",
): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of packs) {
    const k = (p.kind ?? "character_skin") as SkinKind;
    if (filterKind !== "all" && k !== filterKind) continue;
    if (!p.character_code) continue;
    counts.set(p.character_code, (counts.get(p.character_code) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) =>
    characterDisplay(a[0]).localeCompare(characterDisplay(b[0])),
  );
}

// ─── Storefront ───────────────────────────────────────────────────────────────

function Storefront(props: {
  featuredPacks: IndexedPack[];
  featuredCreator: AnnotatedCreator | null;
  featuredCreatorPacks: IndexedPack[];
  backedPacks: IndexedPack[];
  allPacks: IndexedPack[];
  searchPacks: IndexedPack[];
  totalPackCount: number;
  totalCreatorCount: number;
  kindCounts: Map<SkinKind, number>;
  filterKind: SkinKind | "all";
  setFilterKind: (k: SkinKind | "all") => void;
  sortedCharacters: [string, number][];
  filterCharacter: string | null;
  setFilterCharacter: (c: string | null) => void;
  busyKey: string | null;
  onSelectPack: (id: string) => void;
  onInstallAll: (pack: IndexedPack) => void;
  onInstallSingle: (pack: IndexedPack) => void;
  onSubscribe: (url: string) => void;
  onCreatorClick: (id: string) => void;
  onShowAllCreators: () => void;
  onRefresh: () => void;
  onReshuffle: () => void;
}) {
  return (
    <div>
      <div className="px-8 pt-3 flex justify-end">
        <SearchBar
          packs={props.searchPacks}
          onSelectPack={props.onSelectPack}
          onCreatorClick={props.onCreatorClick}
        />
      </div>

      {props.featuredPacks.length > 0 && (
        <div className="px-8 pt-4 relative">
          <button
            type="button"
            onClick={props.onReshuffle}
            className="absolute left-10 top-10 z-10 text-white/40 hover:text-white/90 p-1.5 rounded-full bg-bg/40 hover:bg-bg/70 border border-border/40 hover:border-border/70 transition-colors"
            title="pick different featured packs and creator"
            aria-label="shuffle"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <polyline points="21 4 21 11 14 11" />
            </svg>
          </button>
          <FeaturedHero
            packs={props.featuredPacks}
            busyKey={props.busyKey}
            onSelectPack={props.onSelectPack}
            onInstallAll={props.onInstallAll}
            onInstallSingle={props.onInstallSingle}
            onSubscribe={props.onSubscribe}
            onCreatorClick={props.onCreatorClick}
          />
        </div>
      )}

      {props.featuredCreator && props.featuredCreatorPacks.length > 0 && (
        <FeaturedCreatorBand
          creator={props.featuredCreator}
          packs={props.featuredCreatorPacks}
          isBacked={!!props.featuredCreator.backed}
          onCreatorClick={() => props.onCreatorClick(props.featuredCreator!.id)}
          onSubscribe={() =>
            props.onSubscribe(props.featuredCreator!.patreon_url)
          }
          onSelectPack={props.onSelectPack}
        />
      )}

      {props.backedPacks.length > 0 && (
        <Section title="from creators you back">
          <HorizontalPackStrip
            packs={props.backedPacks}
            onSelectPack={props.onSelectPack}
            onCreatorClick={props.onCreatorClick}
          />
        </Section>
      )}

      <AllModsSection
        packs={props.allPacks}
        totalCount={props.totalPackCount}
        kindCounts={props.kindCounts}
        filterKind={props.filterKind}
        setFilterKind={props.setFilterKind}
        sortedCharacters={props.sortedCharacters}
        filterCharacter={props.filterCharacter}
        setFilterCharacter={props.setFilterCharacter}
        busyKey={props.busyKey}
        onSelectPack={props.onSelectPack}
        onInstallAll={props.onInstallAll}
        onInstallSingle={props.onInstallSingle}
        onSubscribe={props.onSubscribe}
        onCreatorClick={props.onCreatorClick}
        onShowAllCreators={props.onShowAllCreators}
        totalCreatorCount={props.totalCreatorCount}
        onRefresh={props.onRefresh}
      />
    </div>
  );
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="px-8 pt-10">
      <div className="flex items-baseline justify-between pb-3 gap-4">
        <h2 className="section-title">{title}</h2>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function BackBar({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-muted hover:text-white"
    >
      ← back to storefront
    </button>
  );
}

// ─── Featured hero carousel ───────────────────────────────────────────────────

function FeaturedHero({
  packs,
  busyKey,
  onSelectPack,
  onInstallAll,
  onInstallSingle,
  onSubscribe,
  onCreatorClick,
}: {
  packs: IndexedPack[];
  busyKey: string | null;
  onSelectPack: (id: string) => void;
  onInstallAll: (p: IndexedPack) => void;
  onInstallSingle: (p: IndexedPack) => void;
  onSubscribe: (url: string) => void;
  onCreatorClick: (id: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (paused || packs.length <= 1) return;
    timer.current = window.setTimeout(
      () => setIdx((i) => (i + 1) % packs.length),
      7000,
    );
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, [idx, paused, packs.length]);

  if (packs.length === 0) return null;
  const safeIdx = Math.min(idx, packs.length - 1);
  const pack = packs[safeIdx];
  const previews = previewList(pack);
  const heroImage = previews[0];
  const installable = pack.slots.filter(
    (s) => !s.installed && s.tier_satisfied,
  ).length;
  const allInstalled = pack.installed_count === pack.slot_count;
  const isMulti = pack.slot_count > 1;
  const myBusy = busyKey === `pack:${pack.pack_id}`;
  const soloBusy = pack.slots[0] && busyKey === `slot:${pack.slots[0].id}`;

  return (
    <div
      className="relative aspect-[16/7] rounded-xl overflow-hidden bg-bg group"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {heroImage ? (
        <SafeImage
          key={heroImage}
          src={heroImage}
          alt={pack.display_name}
          className="w-full h-full object-cover"
          fallback={
            <div className="w-full h-full flex items-center justify-center">
              <CharacterBadge code={pack.character_code} size={240} />
            </div>
          }
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <CharacterBadge code={pack.character_code} size={240} />
        </div>
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent pointer-events-none" />

      {/* Click-capture for the top half of the hero — opens the drawer.
          Partial-area so the bottom panel's own buttons stay reachable. */}
      <button
        type="button"
        onClick={() => onSelectPack(pack.pack_id)}
        aria-label={`open ${pack.display_name}`}
        className="absolute top-0 left-0 right-0 h-[55%] cursor-pointer"
      />

      <div className="absolute bottom-0 left-0 right-0 p-8 flex items-end justify-between gap-6">
        <div className="min-w-0 max-w-2xl">
          <div className="flex items-center gap-2 text-xs text-muted tracking-wide pb-2">
            <span>featured</span>
            <span>·</span>
            <span>{KIND_LABELS[(pack.kind ?? "character_skin") as SkinKind]}</span>
            {isMulti && (
              <>
                <span>·</span>
                <span>{pack.slot_count} slots</span>
              </>
            )}
            {pack.character_code && (pack.kind === "character_skin" ||
              pack.kind === "effect" ||
              pack.kind === "animation") && (
              <>
                <span>·</span>
                <span>{characterDisplay(pack.character_code)}</span>
              </>
            )}
            {pack.kind === "stage" && pack.slots[0]?.iso_target_filename && (
              <>
                <span>·</span>
                <span>{stageDisplay(pack.slots[0].iso_target_filename)}</span>
                {isLegalRankedStage(pack.slots[0].iso_target_filename) && (
                  <>
                    <span>·</span>
                    <span className="text-accent">ranked legal</span>
                  </>
                )}
              </>
            )}
            {pack.format && (
              <>
                <span>·</span>
                <span className="text-accent">{pack.format}</span>
              </>
            )}
          </div>
          <h1 className="text-3xl md:text-4xl leading-tight text-white drop-shadow">
            {stripColorSuffix(pack.display_name)}
          </h1>
          <button
            type="button"
            onClick={() =>
              pack.creator?.id && onCreatorClick(pack.creator.id)
            }
            className="text-sm text-muted hover:text-white hover:underline mt-1 disabled:opacity-100 disabled:no-underline"
            disabled={!pack.creator?.id}
          >
            by {pack.creator?.display_name || pack.creator_id}
          </button>
          <div className="flex flex-wrap gap-1.5 text-xs pt-3">
            {allInstalled ? (
              <span className="pill-ok">all installed</span>
            ) : pack.installed_count > 0 ? (
              <span className="pill-ok">
                {pack.installed_count}/{pack.slot_count} installed
              </span>
            ) : pack.any_tier_satisfied ? (
              <span className="pill-ok">available</span>
            ) : (
              <span className="pill-muted">
                subscribe ({dollars(pack.tier_required_cents)})
              </span>
            )}
            {pack.tier_required_cents === 0 && !pack.installed_count && (
              <span className="pill-muted">free</span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          {allInstalled ? (
            <button
              className="btn-primary px-6"
              onClick={() => onSelectPack(pack.pack_id)}
            >
              manage slots
            </button>
          ) : isMulti ? (
            installable > 0 ? (
              <button
                className="btn-primary px-6"
                onClick={() => onInstallAll(pack)}
                disabled={myBusy}
              >
                {myBusy ? "installing…" : `install all (${installable})`}
              </button>
            ) : (
              <button
                className="btn-primary px-6"
                onClick={() =>
                  onSubscribe(
                    pack.creator?.patreon_url || "https://www.patreon.com",
                  )
                }
              >
                subscribe on patreon
              </button>
            )
          ) : pack.slots[0]?.installed ? (
            <button className="btn px-6" disabled>
              Installed
            </button>
          ) : pack.any_tier_satisfied ? (
            <button
              className="btn-primary px-6"
              onClick={() => onInstallSingle(pack)}
              disabled={soloBusy}
            >
              {soloBusy ? "installing…" : "install"}
            </button>
          ) : (
            <button
              className="btn-primary px-6"
              onClick={() =>
                onSubscribe(
                  pack.creator?.patreon_url || "https://www.patreon.com",
                )
              }
            >
              subscribe on patreon
            </button>
          )}
        </div>
      </div>

      {packs.length > 1 && (
        <>
          <button
            type="button"
            className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-bg/70 hover:bg-bg/90 text-white border border-border opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => setIdx((i) => (i - 1 + packs.length) % packs.length)}
            aria-label="Previous"
          >
            ‹
          </button>
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-bg/70 hover:bg-bg/90 text-white border border-border opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => setIdx((i) => (i + 1) % packs.length)}
            aria-label="Next"
          >
            ›
          </button>
          <div className="absolute top-3 right-3 flex gap-1.5">
            {packs.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                aria-label={`Go to slide ${i + 1}`}
                className={`w-2 h-2 rounded-full transition-all ${
                  i === safeIdx
                    ? "bg-white w-6"
                    : "bg-white/40 hover:bg-white/70"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Featured creator band ────────────────────────────────────────────────────

function FeaturedCreatorBand({
  creator,
  packs,
  isBacked,
  onCreatorClick,
  onSubscribe,
  onSelectPack,
}: {
  creator: AnnotatedCreator;
  packs: IndexedPack[];
  isBacked: boolean;
  onCreatorClick: () => void;
  onSubscribe: () => void;
  onSelectPack: (id: string) => void;
}) {
  return (
    <Section
      title={isBacked ? "featured · you back" : "featured creator"}
      trailing={
        <div className="flex items-center gap-3 text-xs">
          <button
            className="text-muted hover:text-white hover:underline"
            onClick={onSubscribe}
          >
            open on patreon →
          </button>
        </div>
      }
    >
      <div className="glass-card glass-glow rounded-lg p-5 flex flex-col gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-full bg-bg border border-border shrink-0 flex items-center justify-center stat-num text-2xl">
            {creator.avatar_url ? (
              <SafeImage
                src={creator.avatar_url}
                alt={creator.display_name}
                className="w-full h-full object-cover rounded-full"
                fallback={<span>{creator.display_name[0]?.toUpperCase()}</span>}
              />
            ) : (
              <span>{creator.display_name[0]?.toUpperCase()}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onCreatorClick}
              className="page-title text-xl hover:underline text-left"
            >
              {creator.display_name}
            </button>
            {creator.tagline && (
              <p className="text-sm text-muted">{creator.tagline}</p>
            )}
            <div className="flex flex-wrap gap-1.5 text-xs pt-2">
              {isBacked ? (
                <span className="pill-ok">
                  backed · {dollars(creator.current_tier_cents)}
                </span>
              ) : (
                <span className="pill-muted">not subscribed</span>
              )}
              <span className="pill-muted">
                {creator.skin_count} skin{creator.skin_count === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <button
            className="btn shrink-0"
            onClick={onCreatorClick}
            title={`See all ${creator.skin_count} mods from ${creator.display_name}`}
          >
            See all →
          </button>
        </div>

        <HorizontalPackStrip
          packs={packs}
          onSelectPack={onSelectPack}
          onCreatorClick={onCreatorClick}
          hideCreator
        />
      </div>
    </Section>
  );
}

// ─── Horizontal strip ────────────────────────────────────────────────────────

function HorizontalPackStrip({
  packs,
  onSelectPack,
  onCreatorClick,
  hideCreator,
}: {
  packs: IndexedPack[];
  onSelectPack: (id: string) => void;
  onCreatorClick: (id: string) => void;
  hideCreator?: boolean;
}) {
  return (
    <div className="overflow-x-auto tilt-cradle">
      <div className="flex gap-3 px-2">
        {packs.map((p) => (
          <MiniPackCard
            key={p.pack_id}
            pack={p}
            onSelect={() => onSelectPack(p.pack_id)}
            onCreatorClick={
              hideCreator
                ? undefined
                : () => p.creator?.id && onCreatorClick(p.creator.id)
            }
          />
        ))}
      </div>
    </div>
  );
}

function MiniPackCard({
  pack,
  onSelect,
  onCreatorClick,
}: {
  pack: IndexedPack;
  onSelect: () => void;
  onCreatorClick?: () => void;
}) {
  const previews = previewList(pack);
  const isMulti = pack.slot_count > 1;
  return (
    <div
      className="card tactile overflow-hidden flex flex-col w-48 shrink-0"
      style={packTilt(pack.pack_id) as CSSProperties}
    >
      <button
        type="button"
        onClick={onSelect}
        className="relative aspect-square bg-bg flex items-center justify-center w-full cursor-pointer group overflow-hidden"
      >
        {previews[0] ? (
          <SafeImage
            src={previews[0]}
            alt={pack.display_name}
            className="max-w-full max-h-full object-contain transition-transform group-hover:scale-[1.04]"
            fallback={<CharacterBadge code={pack.character_code} size={80} />}
          />
        ) : (
          <CharacterBadge code={pack.character_code} size={80} />
        )}
        {isMulti && (
          <span className="label-mono absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-bg/80 border border-border text-white">
            {pack.slot_count} slots
          </span>
        )}
        {pack.installed_count > 0 && (
          <span className="label-mono absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-ok/30 border border-ok text-ok">
            {pack.installed_count === pack.slot_count
              ? "installed"
              : `${pack.installed_count}/${pack.slot_count}`}
          </span>
        )}
      </button>
      <div className="p-2.5 space-y-0.5 min-w-0">
        <button
          type="button"
          onClick={onSelect}
          className="text-sm truncate text-left w-full hover:underline"
        >
          {stripColorSuffix(pack.display_name)}
        </button>
        {onCreatorClick && (
          <button
            type="button"
            onClick={onCreatorClick}
            className="text-xs text-muted hover:text-white hover:underline truncate text-left w-full disabled:opacity-100 disabled:no-underline"
            disabled={!pack.creator?.id}
          >
            {pack.creator?.display_name || pack.creator_id}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── All-mods section (filter chips + grid) ──────────────────────────────────

function AllModsSection({
  packs,
  totalCount,
  kindCounts,
  filterKind,
  setFilterKind,
  sortedCharacters,
  filterCharacter,
  setFilterCharacter,
  busyKey,
  onSelectPack,
  onInstallAll,
  onInstallSingle,
  onSubscribe,
  onCreatorClick,
  onShowAllCreators,
  totalCreatorCount,
  onRefresh,
  title,
  hideTopActions,
}: {
  packs: IndexedPack[];
  totalCount: number;
  kindCounts: Map<SkinKind, number>;
  filterKind: SkinKind | "all";
  setFilterKind: (k: SkinKind | "all") => void;
  sortedCharacters: [string, number][];
  filterCharacter: string | null;
  setFilterCharacter: (c: string | null) => void;
  busyKey: string | null;
  onSelectPack: (id: string) => void;
  onInstallAll: (p: IndexedPack) => void;
  onInstallSingle: (p: IndexedPack) => void;
  onSubscribe: (url: string) => void;
  onCreatorClick: (id: string) => void;
  onShowAllCreators?: () => void;
  totalCreatorCount?: number;
  onRefresh?: () => void;
  title?: string;
  hideTopActions?: boolean;
}) {
  return (
    <Section
      title={title ?? "all mods"}
      trailing={
        !hideTopActions ? (
          <div className="flex items-center gap-3 text-xs">
            {onShowAllCreators && (
              <button
                className="text-muted hover:text-white hover:underline"
                onClick={onShowAllCreators}
              >
                {totalCreatorCount
                  ? `Browse all ${totalCreatorCount} creators →`
                  : "browse all creators →"}
              </button>
            )}
            {onRefresh && (
              <button
                className="text-muted hover:text-white hover:underline"
                onClick={onRefresh}
                title="pull the latest texture index"
              >
                ↻ refresh index
              </button>
            )}
          </div>
        ) : null
      }
    >
      <div className="text-xs text-muted pb-3">
        {packs.length} of {totalCount} pack{totalCount === 1 ? "" : "s"}
        {filterKind !== "all" || filterCharacter ? " · filtered" : ""}
      </div>

      <div className="flex flex-wrap gap-1.5 pb-2">
        {KIND_FILTER_ORDER.map((k) => {
          const count =
            k === "all" ? totalCount : (kindCounts.get(k as SkinKind) ?? 0);
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
              {k === "all" ? "all" : KIND_LABELS[k as SkinKind]}{" "}
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
            all characters
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

      {packs.length === 0 ? (
        <div className="card p-10 text-center text-sm text-muted">
          No mods match this filter.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-12 off-kilter">
          {packs.map((p) => (
            <PackCard
              key={p.pack_id}
              pack={p}
              busyKey={busyKey}
              onSelect={() => onSelectPack(p.pack_id)}
              onInstallAll={() => onInstallAll(p)}
              onInstallSingle={() => onInstallSingle(p)}
              onSubscribe={() =>
                onSubscribe(
                  p.creator?.patreon_url || "https://www.patreon.com",
                )
              }
              onCreatorClick={() =>
                p.creator?.id && onCreatorClick(p.creator.id)
              }
            />
          ))}
        </div>
      )}
    </Section>
  );
}

// ─── Safety pill ─────────────────────────────────────────────────────────────
//
// Renders one of four states. Effects intentionally render "unchecked"
// rather than "unverified" since we don't have an effect validator yet
// — distinguishing "we tried and couldn't" from "the validator doesn't
// cover this kind."

function SafetyPill({
  safety,
  kind,
}: {
  safety: { verdict: string; warnings: string[] } | null;
  kind: SkinKind;
}) {
  if (!safety) {
    if (kind !== "character_skin" && kind !== "stage") return null;
    return (
      <span
        className="label-mono px-1.5 py-0.5 rounded bg-bg border border-border text-muted/70 shrink-0"
        title="slippi safety: not validated (tier-locked or scrape couldn't fetch the file)"
      >
        unverified
      </span>
    );
  }
  if (safety.verdict === "safe") {
    return (
      <span
        className="label-mono px-1.5 py-0.5 rounded bg-bg border border-ok/40 text-ok shrink-0"
        title="slippi safety: structurally identical to vanilla"
      >
        ✓ slippi
      </span>
    );
  }
  if (safety.verdict === "warn") {
    return (
      <span
        className="label-mono px-1.5 py-0.5 rounded bg-bg border border-yellow-500/60 text-yellow-500 shrink-0"
        title={safety.warnings.join(" · ") || "minor structural drift from vanilla"}
      >
        review
      </span>
    );
  }
  if (safety.verdict === "unsafe") {
    const baseTooltip =
      kind === "stage"
        ? "this stage's collision table differs from vanilla. desyncs online if the actual play surface or blastzones changed (most stage mods); harmless if only unreachable/disabled lines moved (rare). each client loads its own ISO's stage even in ranked."
        : "structural mismatch from vanilla — will desync online.";
    return (
      <span
        className="label-mono px-1.5 py-0.5 rounded bg-bg border border-danger/60 text-danger shrink-0"
        title={
          (safety.warnings.length
            ? safety.warnings.join(" · ") + " · "
            : "") + baseTooltip
        }
      >
        may desync
      </span>
    );
  }
  return (
    <span
      className="label-mono px-1.5 py-0.5 rounded bg-bg border border-border text-muted shrink-0"
      title={safety.warnings.join(" · ") || "couldn't parse one or both files"}
    >
      unverified
    </span>
  );
}

// ─── Pack card (grid) ─────────────────────────────────────────────────────────

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
    <div
      className="card tactile overflow-hidden flex flex-col"
      style={packTilt(pack.pack_id) as CSSProperties}
    >
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
          <span className="label-mono absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-bg/80 border border-border text-white">
            +{extra}
          </span>
        )}
        {isMulti && (
          <span className="label-mono absolute top-2 left-2 px-1.5 py-0.5 rounded bg-bg/80 border border-border text-white">
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
              className="text-base truncate flex-1 text-left hover:underline"
            >
              {stripColorSuffix(pack.display_name)}
            </button>
            <span className="label-mono px-1.5 py-0.5 rounded bg-bg border border-border text-muted shrink-0">
              {KIND_LABELS[(pack.kind ?? "character_skin") as SkinKind]}
            </span>
            {pack.kind === "stage" &&
              isLegalRankedStage(pack.slots[0]?.iso_target_filename) && (
                <span
                  className="label-mono px-1.5 py-0.5 rounded bg-bg border border-accent/40 text-accent shrink-0"
                  title="this targets a legal slippi ranked stage — collision changes affect ranked play"
                >
                  ranked
                </span>
              )}
            {pack.format && (
              <span
                className="label-mono px-1.5 py-0.5 rounded bg-bg border border-accent/40 text-accent shrink-0"
                title={`format: ${pack.format}`}
              >
                {pack.format}
              </span>
            )}
            <SafetyPill safety={pack.safety} kind={pack.kind} />
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
              <span title="bundled inside an archive">{" · zip"}</span>
            )}
          </div>
        </div>

        {pack.kind === "character_skin" && (
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
              manage slots
            </button>
          ) : isMulti ? (
            installable > 0 ? (
              <div className="flex gap-2">
                <button
                  className="btn-primary flex-1"
                  onClick={onInstallAll}
                  disabled={myPackBusy}
                >
                  {myPackBusy ? "installing…" : `install all (${installable})`}
                </button>
                <button className="btn shrink-0" onClick={onSelect}>
                  Pick
                </button>
              </div>
            ) : (
              <button className="btn w-full" onClick={onSubscribe}>
                subscribe on patreon
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
              {mySoloBusy ? "installing…" : "install"}
            </button>
          ) : (
            <button className="btn w-full" onClick={onSubscribe}>
              subscribe on patreon
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

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
    if (isLegalRankedStage(pack.slots[0].iso_target_filename)) {
      metaPills.push("ranked legal");
    }
  }
  if (
    (pack.kind === "character_skin" ||
      pack.kind === "effect" ||
      pack.kind === "animation") &&
    pack.character_code
  ) {
    metaPills.push(characterDisplay(pack.character_code));
  }
  // For solo character_skin packs the SlotRow list is hidden (one button is
  // simpler than a one-row list), so the slot the install will overwrite
  // wouldn't show up anywhere otherwise. Multi-slot packs surface this in
  // the SlotRow list instead.
  if (
    pack.kind === "character_skin" &&
    pack.slot_count === 1 &&
    pack.slots[0]?.slot_code
  ) {
    metaPills.push(slotDisplay(pack.slots[0].slot_code));
  }
  if (pack.format) {
    metaPills.push(pack.format);
  }
  metaPills.push(
    pack.tier_required_cents === 0
      ? "free"
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
          <div className="label-mono">
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
          {/* Natural-aspect image area — caps height so the largest portrait
              images don't push the rest of the drawer offscreen, but keeps
              the original aspect ratio so nothing gets cropped. min-h
              keeps the slot from collapsing while the image loads. */}
          <div className="bg-bg rounded overflow-hidden flex items-center justify-center min-h-[14rem]">
            {active ? (
              <SafeImage
                src={active}
                alt={pack.display_name}
                className="block max-w-full max-h-[70vh] w-auto h-auto object-contain"
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
            <h2 className="text-2xl leading-tight">
              {stripColorSuffix(pack.display_name)}
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
                  ? "installing…"
                  : `Install all available (${installable})`}
              </button>
            </div>
          )}

          {isMulti ? (
            <div className="border border-border rounded">
              <div className="label-mono px-3 py-2 border-b border-border">
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
            open patreon post →
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
  const slotName = slotDisplay(slot.slot_code) || slot.slot_code || "slot";
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
            {busy ? "installing…" : "install"}
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
        {busy ? "installing…" : "install"}
      </button>
    );
  }
  return (
    <button className="btn w-full" onClick={onSubscribe}>
      subscribe on patreon
    </button>
  );
}

// ─── Creator views ────────────────────────────────────────────────────────────

function CreatorHeader({
  creator,
  onSubscribe,
}: {
  creator: AnnotatedCreator;
  onSubscribe: () => void;
}) {
  return (
    <div className="glass-card glass-glow rounded-lg p-6 flex items-start justify-between gap-4">
      <div className="space-y-1 min-w-0 flex items-center gap-4">
        <div className="w-16 h-16 rounded-full bg-bg border border-border shrink-0 flex items-center justify-center stat-num text-3xl">
          {creator.avatar_url ? (
            <SafeImage
              src={creator.avatar_url}
              alt={creator.display_name}
              className="w-full h-full object-cover rounded-full"
              fallback={<span>{creator.display_name[0]?.toUpperCase()}</span>}
            />
          ) : (
            <span>{creator.display_name[0]?.toUpperCase()}</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="page-title text-2xl truncate">
            {creator.display_name}
          </div>
          {creator.tagline && (
            <p className="text-sm text-muted">{creator.tagline}</p>
          )}
          <div className="flex flex-wrap gap-1.5 text-xs pt-2">
            {creator.backed ? (
              <span className="pill-ok">
                backed · {dollars(creator.current_tier_cents)}
              </span>
            ) : (
              <span className="pill-muted">not subscribed</span>
            )}
            <span className="pill-muted">
              {creator.skin_count} skin{creator.skin_count === 1 ? "" : "s"}
            </span>
          </div>
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
        <h2 className="text-lg">all creators</h2>
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
                  className="text-base truncate hover:underline text-left"
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
