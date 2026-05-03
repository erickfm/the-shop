import { useEffect, useMemo, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ipc } from "../lib/ipc";
import { toast } from "../components/Toaster";
import { busy as withBusy } from "../components/BusyOverlay";
import { CharacterBadge } from "../components/CharacterBadge";
import type { AnnotatedSkin, BackedCreator } from "../lib/types";

function dollars(cents: number): string {
  if (cents <= 0) return "free";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function Browse({ onAfterAction }: { onAfterAction?: () => void }) {
  const [creators, setCreators] = useState<BackedCreator[]>([]);
  const [skins, setSkins] = useState<AnnotatedSkin[]>([]);
  const [filterCreatorId, setFilterCreatorId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (forceIndex = false) => {
    setError(null);
    try {
      if (forceIndex) {
        await ipc.refreshSkinIndex();
      }
      const [c, s] = await Promise.all([
        ipc.listBackedCreators(false),
        ipc.listSkinIndex(),
      ]);
      setCreators(c);
      setSkins(s);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  useEffect(() => {
    refresh(false);
  }, []);

  const filtered = useMemo(() => {
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

  const subscribeOnPatreon = async (s: AnnotatedSkin) => {
    const url =
      s.creator?.patreon_url ||
      (s.creator
        ? `https://www.patreon.com/c/${s.creator.id}`
        : "https://www.patreon.com");
    try {
      await openExternal(url);
    } catch (e: any) {
      toast({ kind: "danger", text: `Could not open browser: ${e?.message || e}` });
    }
  };

  return (
    <div className="flex h-full">
      <aside className="w-64 border-r border-border bg-surface p-4 overflow-y-auto space-y-1 shrink-0">
        <div className="text-xs uppercase tracking-wide text-muted px-2 pb-2">
          You back
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
            No creators yet. Subscribe to Melee creators on Patreon to see
            their skins here.
          </div>
        )}
        {creators.map((c) => {
          const indexedId = skins.find(
            (s) => s.creator?.patreon_campaign_id === c.campaign_id,
          )?.creator?.id;
          const filterValue = indexedId ?? null;
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
              title={
                !filterValue
                  ? "This creator isn't in the skin index yet"
                  : undefined
              }
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
            title="Pull the latest skin index from GitHub"
          >
            Refresh index
          </button>
        </div>
      </aside>

      <section className="flex-1 overflow-y-auto p-8 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {filterCreatorId
              ? skins.find((s) => s.creator?.id === filterCreatorId)?.creator
                  ?.display_name || "Creator"
              : "Browse skins"}
          </h2>
          <div className="text-xs text-muted">
            {filtered.length} skin{filtered.length === 1 ? "" : "s"}
          </div>
        </div>

        {error && (
          <div className="card p-4 text-sm text-danger">
            Could not load: {error}
          </div>
        )}

        {filtered.length === 0 && !error && (
          <div className="card p-10 text-center text-sm text-muted">
            No skins to show yet. Either the index hasn't loaded any skins for
            this filter, or you need to back creators on Patreon to see their
            content.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s) => {
            const myKey = s.id;
            const buttonState: "install" | "installed" | "subscribe" =
              s.installed ? "installed" : s.tier_satisfied ? "install" : "subscribe";
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
                        needs {dollars(s.tier_required_cents)} tier · you're at{" "}
                        {dollars(s.current_tier_cents)}
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
                        onClick={() => subscribeOnPatreon(s)}
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
      </section>
    </div>
  );
}
