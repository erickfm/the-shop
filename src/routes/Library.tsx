import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import { toast } from "../components/Toaster";
import { busy as withBusy } from "../components/BusyOverlay";
import { CharacterBadge } from "../components/CharacterBadge";
import { SafeImage } from "../components/SafeImage";
import type {
  AnnotatedCreator,
  CharacterDef,
  IsoAssetRow,
  SkinPack,
} from "../lib/types";
import { characterDisplay, packTilt, stageDisplay } from "../lib/melee";
import type { CSSProperties } from "react";

const KIND_LABEL: Record<string, string> = {
  effect: "effect",
  stage: "stage",
  ui: "ui",
  item: "item",
  animation: "animation",
};

export function Library({ onAfterAction }: { onAfterAction?: () => void }) {
  const [packs, setPacks] = useState<SkinPack[]>([]);
  const [chars, setChars] = useState<CharacterDef[]>([]);
  const [assets, setAssets] = useState<IsoAssetRow[]>([]);
  const [creators, setCreators] = useState<AnnotatedCreator[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const [p, c, a, cr] = await Promise.all([
      ipc.listSkinPacks(),
      ipc.listCharacters(),
      ipc.listIsoAssets(),
      ipc.listIndexedCreators().catch(() => [] as AnnotatedCreator[]),
    ]);
    setPacks(p);
    setChars(c);
    setAssets(a);
    setCreators(cr);
  };

  // Stash candidates: creators with at least one viewable file the user
  // doesn't already have on disk. Sorted by remaining-to-fetch desc so
  // the most useful targets surface first.
  const stashCreators = useMemo(() => {
    return creators
      .map((c) => ({
        creator: c,
        remaining: Math.max(0, c.viewable_count - c.stashed_count),
      }))
      .filter((c) => c.creator.viewable_count > 0)
      .sort((a, b) => b.remaining - a.remaining || b.creator.viewable_count - a.creator.viewable_count);
  }, [creators]);

  const stashAllFromCreator = async (c: AnnotatedCreator, remaining: number) => {
    const myKey = `stash:${c.id}`;
    setBusy(myKey);
    try {
      const r = await withBusy(
        `downloading ${remaining} from ${c.display_name}…`,
        () => ipc.downloadAllFromCreator(c.id),
      );
      const failedNote = r.failed.length
        ? ` · ${r.failed.length} failed (${r.failed[0].error})`
        : "";
      toast({
        kind: r.failed.length ? (r.downloaded > 0 ? "info" : "danger") : "ok",
        text: `${c.display_name}: downloaded ${r.downloaded} · skipped ${r.skipped_existing} already on disk${failedNote}`,
      });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `download failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const { patreonPacks, manualPacks, patreonAssets, manualAssets } = useMemo(() => {
    const patreonPacks: SkinPack[] = [];
    const manualPacks: SkinPack[] = [];
    const patreonAssets: IsoAssetRow[] = [];
    const manualAssets: IsoAssetRow[] = [];
    for (const p of packs) {
      if (p.source === "patreon") patreonPacks.push(p);
      else manualPacks.push(p);
    }
    for (const a of assets) {
      if (a.source === "patreon") patreonAssets.push(a);
      else manualAssets.push(a);
    }
    return { patreonPacks, manualPacks, patreonAssets, manualAssets };
  }, [packs, assets]);

  const addSkins = async () => {
    const sel = await open({
      multiple: true,
      filters: [{ name: "Melee skin (.dat / .usd)", extensions: ["dat", "usd"] }],
    });
    if (!sel || (Array.isArray(sel) && sel.length === 0)) return;
    const arr = Array.isArray(sel) ? sel : [sel];
    try {
      const r = await ipc.importSkinFiles(arr);
      const failed = r.failed.length
        ? ` · ${r.failed.length} failed (${r.failed[0].filename}: ${r.failed[0].error})`
        : "";
      toast({
        kind: r.failed.length ? "danger" : "ok",
        text: `imported ${r.imported}, skipped ${r.skipped_duplicates}${failed}`,
      });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `import failed: ${e?.message || e}` });
    }
  };

  const install = async (p: SkinPack) => {
    setBusy(`${p.character_code}/${p.pack_name}`);
    try {
      const r = await withBusy(
        `installing ${p.character_display} · ${p.pack_name}…`,
        () => ipc.installPack(p.character_code, p.pack_name),
      );
      const installedCount = r.installed_slots.length;
      const skipped = r.skipped_slots.length;
      const routed = r.installed_slots.filter((s) => s.routed);
      const routedNote =
        routed.length > 0
          ? ` · routed to extended slots: ${routed
              .map((s) => `${s.requested_slot_code}→${s.actual_slot_code}`)
              .join(", ")}`
          : "";
      if (skipped > 0) {
        const detail = r.skipped_slots
          .map((s) => `${s.slot_code}: ${s.reason}`)
          .join(" · ");
        toast({
          kind: installedCount > 0 ? "info" : "danger",
          text: `installed ${installedCount}/${installedCount + skipped} slots${routedNote}. skipped: ${detail}`,
        });
      } else {
        toast({
          kind: "ok",
          text: `installed ${p.character_display} · ${p.pack_name}${routedNote}`,
        });
      }
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `install failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  const removeAll = async (source: "manual" | "patreon") => {
    const list = source === "patreon" ? patreonPacks : manualPacks;
    if (list.length === 0) return;
    const verb = source === "patreon" ? "remove" : "unimport";
    const ok = window.confirm(
      `${verb} all ${list.length} ${source === "patreon" ? "patreon-installed" : "manually-imported"} skin${
        list.length === 1 ? "" : "s"
      }? files will be deleted from disk and the ISO rebuilt once.${
        source === "patreon"
          ? " you can reinstall any of them from browse."
          : ""
      }`,
    );
    if (!ok) return;
    setBusy(`__bulk_${source}`);
    try {
      const r = await withBusy(
        `${verb === "remove" ? "removing" : "unimporting"} ${list.length} skin${
          list.length === 1 ? "" : "s"
        }…`,
        () => ipc.deleteSkinPacksBulk(source),
      );
      toast({
        kind: "ok",
        text: `${verb}d ${r.packs_removed} pack${
          r.packs_removed === 1 ? "" : "s"
        } (${r.files_removed} file${r.files_removed === 1 ? "" : "s"})`,
      });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `${verb} all failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  const removePack = async (p: SkinPack) => {
    const verb = p.source === "patreon" ? "remove" : "unimport";
    const ok = window.confirm(
      `${verb} "${p.pack_name}" (${p.character_display})? this deletes the file${
        p.slots.length === 1 ? "" : "s"
      } from disk${
        p.fully_installed || p.partially_installed
          ? " and uninstalls from the iso"
          : ""
      }.${
        p.source === "patreon"
          ? " you can reinstall from browse anytime."
          : ""
      }`,
    );
    if (!ok) return;
    setBusy(`${p.character_code}/${p.pack_name}`);
    try {
      const r = await withBusy(`removing ${p.pack_name}…`, () =>
        ipc.deleteSkinPack(p.character_code, p.pack_name),
      );
      toast({
        kind: "ok",
        text: `removed ${p.pack_name} (${r.files_removed} file${
          r.files_removed === 1 ? "" : "s"
        })`,
      });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `remove failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  const installAsset = async (a: IsoAssetRow) => {
    setBusy(`asset:${a.id}`);
    try {
      await withBusy(`installing ${a.filename}…`, () =>
        ipc.installIsoAssetFromFile(a.id),
      );
      toast({ kind: "ok", text: `installed ${a.filename}` });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `install failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  const uninstallAsset = async (a: IsoAssetRow) => {
    setBusy(`asset:${a.id}`);
    try {
      await withBusy(`uninstalling ${a.filename}…`, () =>
        ipc.uninstallIsoAsset(a.iso_target_filename),
      );
      toast({ kind: "ok", text: `uninstalled ${a.filename}` });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `uninstall failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  const removeAsset = async (a: IsoAssetRow) => {
    const ok = window.confirm(
      `remove "${a.filename}"? file will be deleted from disk${
        a.installed ? " and uninstalled from the iso" : ""
      }.`,
    );
    if (!ok) return;
    setBusy(`asset:${a.id}`);
    try {
      await withBusy(`removing ${a.filename}…`, () =>
        ipc.deleteIsoAsset(a.id),
      );
      toast({ kind: "ok", text: `removed ${a.filename}` });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `remove failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (p: SkinPack) => {
    setBusy(`${p.character_code}/${p.pack_name}`);
    try {
      await withBusy(
        `uninstalling ${p.character_display} · ${p.pack_name}…`,
        () => ipc.uninstallPack(p.character_code, p.pack_name),
      );
      toast({ kind: "ok", text: `uninstalled ${p.character_display} · ${p.pack_name}` });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `uninstall failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-8 max-w-5xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="section-title">my stuff</h2>
          <p className="text-sm text-muted">
            everything you've installed or imported.
          </p>
        </div>
        <button className="btn shrink-0" onClick={addSkins}>
          + import
        </button>
      </div>

      <StashSection
        creators={stashCreators}
        onStashAll={stashAllFromCreator}
        busy={busy}
      />

      <SourceGroup
        title="from patreon"
        subtitle="anything you installed by clicking install in browse."
        emptyText="nothing here yet. head to browse to install something."
        packs={patreonPacks}
        assets={patreonAssets}
        chars={chars}
        busy={busy}
        onInstall={install}
        onUninstall={uninstall}
        onRemove={removePack}
        onRemoveAll={() => removeAll("patreon")}
        bulkBusy={busy === "__bulk_patreon"}
        bulkLabel="remove all"
        onInstallAsset={installAsset}
        onUninstallAsset={uninstallAsset}
        onRemoveAsset={removeAsset}
      />

      <SourceGroup
        title="imported by you"
        subtitle={
          <>
            files you dropped in by hand (
            <code className="px-1 rounded bg-bg border border-border">
              PlFxNr-Name.dat
            </code>
            ,{" "}
            <code className="px-1 rounded bg-bg border border-border">
              GrFs-Custom.usd
            </code>
            , etc.). use the import button above.
          </>
        }
        emptyText="nothing imported yet. drop some .dat / .usd files via the import button."
        packs={manualPacks}
        assets={manualAssets}
        chars={chars}
        busy={busy}
        onInstall={install}
        onUninstall={uninstall}
        onRemove={removePack}
        onRemoveAll={() => removeAll("manual")}
        bulkBusy={busy === "__bulk_manual"}
        bulkLabel="unimport all"
        onInstallAsset={installAsset}
        onUninstallAsset={uninstallAsset}
        onRemoveAsset={removeAsset}
      />
    </div>
  );
}

/// One section per source ("from patreon" / "imported by you"). Both
/// character_skin packs and non-character ISO assets render together
/// under the source's header, with the same source-side action buttons
/// and bulk-remove. Removes the old "characters split by source +
/// stages-effects-ui all together" inconsistency.
function SourceGroup({
  title,
  subtitle,
  emptyText,
  packs,
  assets,
  chars,
  busy,
  onInstall,
  onUninstall,
  onRemove,
  onRemoveAll,
  bulkBusy,
  bulkLabel,
  onInstallAsset,
  onUninstallAsset,
  onRemoveAsset,
}: {
  title: string;
  subtitle: React.ReactNode;
  emptyText: string;
  packs: SkinPack[];
  assets: IsoAssetRow[];
  chars: CharacterDef[];
  busy: string | null;
  onInstall: (p: SkinPack) => void;
  onUninstall: (p: SkinPack) => void;
  onRemove: (p: SkinPack) => void;
  onRemoveAll: () => void;
  bulkBusy: boolean;
  bulkLabel: string;
  onInstallAsset: (a: IsoAssetRow) => void;
  onUninstallAsset: (a: IsoAssetRow) => void;
  onRemoveAsset: (a: IsoAssetRow) => void;
}) {
  const totalCount = packs.length + assets.length;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <div>
          <h3 className="section-title text-base">{title}</h3>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-xs text-muted">
            {totalCount} item{totalCount === 1 ? "" : "s"}
          </div>
          {totalCount > 0 && (
            <button
              type="button"
              className="text-xs text-muted hover:text-danger px-2 py-1 border border-border rounded"
              onClick={onRemoveAll}
              disabled={bulkBusy}
              title={`${bulkLabel} all ${totalCount} item${totalCount === 1 ? "" : "s"} in this section`}
            >
              {bulkBusy ? `${bulkLabel}…` : bulkLabel}
            </button>
          )}
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">{emptyText}</div>
      ) : (
        <div className="space-y-4">
          {packs.length > 0 && (
            <PackGrid
              packs={packs}
              chars={chars}
              busy={busy}
              onInstall={onInstall}
              onUninstall={onUninstall}
              onRemove={onRemove}
            />
          )}
          {assets.length > 0 && (
            <AssetRows
              assets={assets}
              busy={busy}
              onInstall={onInstallAsset}
              onUninstall={onUninstallAsset}
              onRemove={onRemoveAsset}
            />
          )}
        </div>
      )}
    </section>
  );
}

function AssetRows({
  assets,
  busy,
  onInstall,
  onUninstall,
  onRemove,
}: {
  assets: IsoAssetRow[];
  busy: string | null;
  onInstall: (a: IsoAssetRow) => void;
  onUninstall: (a: IsoAssetRow) => void;
  onRemove: (a: IsoAssetRow) => void;
}) {
  return (
    <div className="card divide-y divide-border">
      {assets.map((a) => {
        const myKey = `asset:${a.id}`;
        const kindLabel = KIND_LABEL[a.kind] ?? a.kind;
        const subtitleParts: string[] = [kindLabel];
        if (a.kind === "stage") {
          subtitleParts.push(stageDisplay(a.iso_target_filename));
        }
        if (
          (a.kind === "effect" ||
            a.kind === "animation" ||
            a.kind === "ui") &&
          a.character_code
        ) {
          subtitleParts.push(characterDisplay(a.character_code));
        }
        subtitleParts.push(a.iso_target_filename);
        return (
          <div
            key={a.id}
            className="flex items-center gap-4 p-4"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{a.filename}</div>
              <div className="text-xs text-muted truncate">
                {subtitleParts.join(" · ")}
                {a.installed && (
                  <span className="text-ok"> · installed</span>
                )}
                {a.source === "patreon" && a.source_creator_display && (
                  <> · by {a.source_creator_display}</>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 shrink-0 items-stretch">
              {a.installed ? (
                <button
                  className="btn-danger"
                  onClick={() => onUninstall(a)}
                  disabled={busy === myKey}
                >
                  {busy === myKey ? "uninstalling…" : "uninstall"}
                </button>
              ) : (
                <button
                  className="btn-primary"
                  onClick={() => onInstall(a)}
                  disabled={busy === myKey}
                >
                  {busy === myKey ? "installing…" : "install"}
                </button>
              )}
              <button
                className="text-xs text-muted hover:text-danger px-2 py-1"
                onClick={() => onRemove(a)}
                disabled={busy === myKey}
                title="delete file from disk"
              >
                {a.source === "patreon" ? "remove" : "unimport"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PackGrid({
  packs,
  chars,
  busy,
  onInstall,
  onUninstall,
  onRemove,
}: {
  packs: SkinPack[];
  chars: CharacterDef[];
  busy: string | null;
  onInstall: (p: SkinPack) => void;
  onUninstall: (p: SkinPack) => void;
  onRemove: (p: SkinPack) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 off-kilter">
          {packs.map((p) => {
            const charDef = chars.find((c) => c.code === p.character_code);
            const allSlots = charDef?.slots ?? [];
            const myKey = `${p.character_code}/${p.pack_name}`;
            return (
              <div
                key={myKey}
                className="card tactile overflow-hidden flex flex-col"
                style={packTilt(myKey) as CSSProperties}
              >
                <div className="relative aspect-square bg-bg flex items-center justify-center overflow-hidden">
                  {p.preview_url ? (
                    <SafeImage
                      src={p.preview_url}
                      alt={p.pack_display_name || p.pack_name}
                      className="max-w-full max-h-full object-contain"
                      fallback={<CharacterBadge code={p.character_code} size={120} />}
                    />
                  ) : (
                    <CharacterBadge code={p.character_code} size={120} />
                  )}
                  <span
                    className="label-mono absolute top-2 left-2 px-1.5 py-0.5 rounded bg-bg/80 border border-border text-white"
                    title={
                      p.source === "patreon"
                        ? `installed from Patreon${
                            p.source_creator_display
                              ? ` (${p.source_creator_display})`
                              : ""
                          }`
                        : "imported from your filesystem"
                    }
                  >
                    {p.source === "patreon" ? "patreon" : "imported"}
                  </span>
                  {p.slots.length > 1 && (
                    <span className="label-mono absolute top-2 right-2 px-1.5 py-0.5 rounded bg-bg/80 border border-border text-white">
                      {p.slots.length} slots
                    </span>
                  )}
                  {(p.fully_installed || p.partially_installed) && (
                    <span className="label-mono absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-ok/30 border border-ok text-ok">
                      {p.fully_installed
                        ? "installed"
                        : `${p.slots.filter((s) => s.installed).length}/${p.slots.length}`}
                    </span>
                  )}
                </div>
                <div className="p-4 space-y-3 flex-1 flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-base truncate flex-1">
                          {p.pack_display_name || p.pack_name}
                        </div>
                        {p.format === "animelee" && (
                          <span
                            className="label-mono px-1.5 py-0.5 rounded bg-bg border border-accent/40 text-accent shrink-0"
                            title="animelee — cel-shaded cartoon style. unmarked / vanilla skins keep Melee's original look."
                          >
                            {p.format}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted truncate">
                        {p.character_display}
                        {p.source === "patreon" && p.source_creator_display && (
                          <> · by {p.source_creator_display}</>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0 items-stretch">
                      {p.fully_installed || p.partially_installed ? (
                        <button
                          className="btn-danger"
                          onClick={() => onUninstall(p)}
                          disabled={busy === myKey}
                        >
                          {busy === myKey ? (
                            <span className="inline-flex items-center gap-2">
                              <BusyDot /> Uninstalling…
                            </span>
                          ) : (
                            "uninstall"
                          )}
                        </button>
                      ) : (
                        <button
                          className="btn-primary"
                          onClick={() => onInstall(p)}
                          disabled={busy === myKey}
                        >
                          {busy === myKey ? (
                            <span className="inline-flex items-center gap-2">
                              <BusyDot /> Installing…
                            </span>
                          ) : (
                            "install"
                          )}
                        </button>
                      )}
                      <button
                        className="text-xs text-muted hover:text-danger px-2 py-1"
                        onClick={() => onRemove(p)}
                        disabled={busy === myKey}
                        title={
                          p.source === "patreon"
                            ? "delete file from disk (re-installable from browse)"
                            : "delete file from disk (forgets the import)"
                        }
                      >
                        {p.source === "patreon" ? "remove" : "unimport"}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {allSlots.map((s) => {
                      const ours = p.slots.find(
                        (ps) => ps.slot_code === s.code,
                      );
                      if (!ours) {
                        return (
                          <span
                            key={s.code}
                            className="pill-muted opacity-40"
                          >
                            {s.display}
                          </span>
                        );
                      }
                      const routed =
                        ours.installed &&
                        ours.actual_slot_code &&
                        ours.actual_slot_code !== ours.slot_code;
                      return (
                        <span
                          key={s.code}
                          className={ours.installed ? "pill-ok" : "pill-muted"}
                          title={ours.source_path}
                        >
                          {s.display}
                          {routed && (
                            <span className="ml-1 text-accent">
                              → {ours.actual_slot_code}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
    </div>
  );
}

/// Per-creator bulk-download UI. For each creator the user has viewable
/// content from, shows "X of Y already on disk" and a button to fetch
/// the rest. Use case: cancelling a Patreon sub but wanting to keep
/// access to everything you can still see right now. The backend
/// download command is idempotent — clicking again after it finishes
/// just re-checks the on-disk set and skips everything that's already
/// there.
function StashSection({
  creators,
  onStashAll,
  busy,
}: {
  creators: { creator: AnnotatedCreator; remaining: number }[];
  onStashAll: (c: AnnotatedCreator, remaining: number) => void;
  busy: string | null;
}) {
  if (creators.length === 0) return null;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <div>
          <h3 className="section-title text-base">stash from creators</h3>
          <p className="text-xs text-muted">
            cache every skin you can currently view from a creator. handy
            before letting a sub lapse — files land in your skin library
            ready to install later.
          </p>
        </div>
        <div className="text-xs text-muted shrink-0">
          {creators.length} creator{creators.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="card divide-y divide-border">
        {creators.map(({ creator, remaining }) => {
          const myKey = `stash:${creator.id}`;
          const isBusy = busy === myKey;
          const onDisk = creator.stashed_count;
          const total = creator.viewable_count;
          const allCached = remaining === 0;
          return (
            <div
              key={creator.id}
              className="flex items-center gap-4 p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{creator.display_name}</div>
                <div className="text-xs text-muted truncate">
                  {onDisk}/{total} already on disk
                  {creator.backed && (
                    <> · backed</>
                  )}
                </div>
              </div>
              <button
                className={allCached ? "btn" : "btn-primary"}
                onClick={() => onStashAll(creator, remaining)}
                disabled={isBusy || allCached}
                title={
                  allCached
                    ? "everything you can view is already cached locally"
                    : `download ${remaining} skin file${remaining === 1 ? "" : "s"} into your library`
                }
              >
                {isBusy
                  ? "downloading…"
                  : allCached
                    ? "all cached"
                    : `download ${remaining}`}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BusyDot() {
  return (
    <svg
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
