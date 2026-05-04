import { useEffect, useMemo, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ipc } from "../lib/ipc";
import { toast } from "../components/Toaster";
import { busy as withBusy } from "../components/BusyOverlay";
import { CharacterBadge } from "../components/CharacterBadge";
import type { AnnotatedCreator, AnnotatedSkin, BackedCreator } from "../lib/types";

function dollars(cents: number): string {
  if (cents <= 0) return "free";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function Browse({ onAfterAction }: { onAfterAction?: () => void }) {
  const [creators, setCreators] = useState<BackedCreator[]>([]);
  const [indexedCreators, setIndexedCreators] = useState<AnnotatedCreator[]>([]);
  const [skins, setSkins] = useState<AnnotatedSkin[]>([]);
  const [filterCreatorId, setFilterCreatorId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = async () => {
    const [c, ic, s] = await Promise.all([
      ipc.listBackedCreators(false),
      ipc.listIndexedCreators(),
      ipc.listSkinIndex(),
    ]);
    setCreators(c);
    setIndexedCreators(ic);
    setSkins(s);
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

  const filteredSkins = useMemo(() => {
    if (!filterCreatorId) return skins;
    return skins.filter((s) => s.creator?.id === filterCreatorId);
  }, [skins, filterCreatorId]);

  const installSkin = async (s: AnnotatedSkin) => {
    setBusyKey(s.id);
    try {
      await withBusy(`Installing ${s.display_name}…`, () =>
        ipc.installPatreonSkin(s.id),
      );
      toast({ kind: "ok", text: `Installed ${s.display_name}` });
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

  const filteredCreator = filterCreatorId
    ? indexedCreators.find((c) => c.id === filterCreatorId)
    : null;

  return (
    <div className="flex h-full">
      <aside className="w-64 border-r border-border bg-surface p-4 overflow-y-auto space-y-1 shrink-0">
        <div className="text-xs uppercase tracking-wide text-muted px-2 pb-2">
          You back on Patreon
        </div>
        <button
          className={`w-full text-left px-3 py-2 rounded text-sm ${
            filterCreatorId === null ? "bg-bg text-white" : "text-muted hover:text-white"
          }`}
          onClick={() => setFilterCreatorId(null)}
        >
          All creators
        </button>
        {creators.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted">
            No Patreon subscriptions yet.
          </div>
        )}
        {creators.map((c) => {
          const matched = indexedCreators.find(
            (ic) => ic.patreon_campaign_id === c.campaign_id,
          );
          const filterValue = matched?.id ?? null;
          return (
            <button
              key={c.campaign_id}
              className={`w-full text-left px-3 py-2 rounded text-sm ${
                filterValue && filterCreatorId === filterValue
                  ? "bg-bg text-white"
                  : "text-muted hover:text-white"
              }`}
              onClick={() => filterValue && setFilterCreatorId(filterValue)}
              disabled={!filterValue}
              title={!filterValue ? "Not in the texture index yet" : undefined}
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
        <div className="pt-4">
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

        {filterCreatorId && filteredCreator ? (
          <CreatorHeader
            creator={filteredCreator}
            onClear={() => setFilterCreatorId(null)}
            onSubscribe={() => subscribeOnPatreon(filteredCreator.patreon_url)}
          />
        ) : (
          <IndexedCreatorsSection
            creators={indexedCreators}
            onPick={(id) => setFilterCreatorId(id)}
            onSubscribe={(url) => subscribeOnPatreon(url)}
          />
        )}

        <div>
          <div className="flex items-center justify-between pb-3">
            <h3 className="text-base font-semibold">
              {filterCreatorId ? "Skins from this creator" : "All skins"}
            </h3>
            <div className="text-xs text-muted">
              {filteredSkins.length} skin{filteredSkins.length === 1 ? "" : "s"}
            </div>
          </div>

          {filteredSkins.length === 0 && !error && (
            <div className="card p-10 text-center text-sm text-muted">
              No skin entries in the index yet for this view. The index ships
              with creator metadata first; individual skin entries (post IDs,
              tier requirements, slot codes) land via PR as creators opt in.
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSkins.map((s) => {
              const myKey = s.id;
              const buttonState: "install" | "installed" | "subscribe" =
                s.installed
                  ? "installed"
                  : s.tier_satisfied
                    ? "install"
                    : "subscribe";
              return (
                <div key={myKey} className="card overflow-hidden flex flex-col">
                  <div className="relative aspect-square bg-bg flex items-center justify-center">
                    {s.preview_url ? (
                      <img
                        src={s.preview_url}
                        alt={s.display_name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <CharacterBadge code={s.character_code} size={120} />
                    )}
                  </div>
                  <div className="p-4 space-y-3 flex-1 flex flex-col">
                    <div className="min-w-0">
                      <div className="text-base font-semibold truncate">
                        {s.display_name}
                      </div>
                      <div className="text-xs text-muted truncate">
                        {s.creator?.display_name || s.creator_id} ·{" "}
                        {s.character_code} · {s.slot_code}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      {s.installed ? (
                        <span className="pill-ok">installed</span>
                      ) : s.tier_satisfied ? (
                        <span className="pill-ok">available</span>
                      ) : s.backed ? (
                        <span className="pill-muted text-accent">
                          needs {dollars(s.tier_required_cents)} tier · you're
                          at {dollars(s.current_tier_cents)}
                        </span>
                      ) : (
                        <span className="pill-muted">
                          subscribe ({dollars(s.tier_required_cents)})
                        </span>
                      )}
                    </div>
                    <div className="mt-auto pt-2">
                      {buttonState === "installed" && (
                        <button className="btn w-full" disabled>
                          Installed
                        </button>
                      )}
                      {buttonState === "install" && (
                        <button
                          className="btn-primary w-full"
                          onClick={() => installSkin(s)}
                          disabled={busyKey === myKey}
                        >
                          {busyKey === myKey ? "Installing…" : "Install"}
                        </button>
                      )}
                      {buttonState === "subscribe" && (
                        <button
                          className="btn w-full"
                          onClick={() =>
                            subscribeOnPatreon(
                              s.creator?.patreon_url ||
                                "https://www.patreon.com",
                            )
                          }
                        >
                          Subscribe on Patreon
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
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
            ← all creators
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

function IndexedCreatorsSection({
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
  return (
    <div>
      <div className="flex items-center justify-between pb-3">
        <h2 className="text-lg font-semibold">Creators in the texture index</h2>
        <div className="text-xs text-muted">
          {creators.length} creator{creators.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {creators.map((c) => (
          <div
            key={c.id}
            className="card p-4 flex flex-col gap-2"
          >
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
