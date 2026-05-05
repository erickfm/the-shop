import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import { toast } from "../components/Toaster";
import { busy as withBusy } from "../components/BusyOverlay";
import { CharacterBadge } from "../components/CharacterBadge";
import type { CharacterDef, IsoAssetRow, SkinPack } from "../lib/types";
import { characterDisplay, stageDisplay } from "../lib/melee";

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
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const [p, c, a] = await Promise.all([
      ipc.listSkinPacks(),
      ipc.listCharacters(),
      ipc.listIsoAssets(),
    ]);
    setPacks(p);
    setChars(c);
    setAssets(a);
  };

  useEffect(() => {
    refresh();
  }, []);

  const { patreonPacks, manualPacks } = useMemo(() => {
    const patreonPacks: SkinPack[] = [];
    const manualPacks: SkinPack[] = [];
    for (const p of packs) {
      if (p.source === "patreon") patreonPacks.push(p);
      else manualPacks.push(p);
    }
    return { patreonPacks, manualPacks };
  }, [packs]);

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
      }? Files will be deleted from disk and the ISO rebuilt once.${
        source === "patreon"
          ? " You can reinstall any of them from Browse."
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
      `${verb} "${p.pack_name}" (${p.character_display})? This deletes the file${
        p.slots.length === 1 ? "" : "s"
      } from disk${
        p.fully_installed || p.partially_installed
          ? " and uninstalls from the ISO"
          : ""
      }.${
        p.source === "patreon"
          ? " You can reinstall from Browse anytime."
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
      `remove "${a.filename}"? File will be deleted from disk${
        a.installed ? " and uninstalled from the ISO" : ""
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
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 max-w-2xl">
          <h2 className="section-title">skins Skins &amp; assetsamp; assets</h2>
          <p className="text-sm text-muted">
            Everything <span className="text-white">on this machine</span> —
            character skins (from Patreon or imported by hand), plus stages /
            effects / UI / animation files you've imported. Use{" "}
            <span className="text-white">+ Import .dat / .usd files</span> for
            anything you've downloaded outside of Browse.
          </p>
        </div>
        <button className="btn shrink-0" onClick={addSkins}>
          + Import .dat / .usd files
        </button>
      </div>

      <Section
        title="from patreon"
        subtitle="character skins you installed by clicking install in browse."
        emptyText="no patreon-installed character skins yet. head to browse to install one."
        packs={patreonPacks}
        chars={chars}
        busy={busy}
        onInstall={install}
        onUninstall={uninstall}
        onRemove={removePack}
        onRemoveAll={() => removeAll("patreon")}
        bulkBusy={busy === "__bulk_patreon"}
        bulkLabel="remove all"
      />

      <Section
        title="imported from your filesystem"
        subtitle={
          <>
            Character skins you dropped in by hand (
            <code className="px-1 rounded bg-bg border border-border">
              PlFxNr-Name.dat
            </code>{" "}
            etc.). Use{" "}
            <span className="text-white">+ Import .dat / .usd files</span>{" "}
            above.
          </>
        }
        emptyText='No manually-imported skins yet. Click "+ Import .dat / .usd files" to add some.'
        packs={manualPacks}
        chars={chars}
        busy={busy}
        onInstall={install}
        onUninstall={uninstall}
        onRemove={removePack}
        onRemoveAll={() => removeAll("manual")}
        bulkBusy={busy === "__bulk_manual"}
        bulkLabel="unimport all"
      />

      <IsoAssetsSection
        assets={assets}
        busy={busy}
        onInstall={installAsset}
        onUninstall={uninstallAsset}
        onRemove={removeAsset}
      />
    </div>
  );
}

function IsoAssetsSection({
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
    <section>
      <div className="flex items-baseline justify-between pb-2 gap-3">
        <div>
          <h3 className="section-title text-base">stages, effects, ui</h3>
          <p className="text-xs text-muted">
            Non-character ISO assets — file names like{" "}
            <code className="px-1 rounded bg-bg border border-border">
              EfFxData-Variant.dat
            </code>
            ,{" "}
            <code className="px-1 rounded bg-bg border border-border">
              GrFs-Custom.usd
            </code>
            ,{" "}
            <code className="px-1 rounded bg-bg border border-border">
              MnSlChr-AnimatedCSS.usd
            </code>
            . Each one replaces a single HAL file in the ISO; only one variant
            per target can be installed at a time.
          </p>
        </div>
        <div className="text-xs text-muted shrink-0">
          {assets.length} asset{assets.length === 1 ? "" : "s"}
        </div>
      </div>

      {assets.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          No imported ISO assets yet. Drop in a stage / effect / UI file via{" "}
          <span className="text-white">+ Import .dat / .usd files</span>.
        </div>
      ) : (
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
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg border border-border text-muted shrink-0">
                  {a.source === "patreon" ? "patreon" : "imported"}
                </span>
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
      )}
    </section>
  );
}

function Section({
  title,
  subtitle,
  emptyText,
  packs,
  chars,
  busy,
  onInstall,
  onUninstall,
  onRemove,
  onRemoveAll,
  bulkBusy,
  bulkLabel,
}: {
  title: string;
  subtitle: React.ReactNode;
  emptyText: string;
  packs: SkinPack[];
  chars: CharacterDef[];
  busy: string | null;
  onInstall: (p: SkinPack) => void;
  onUninstall: (p: SkinPack) => void;
  onRemove: (p: SkinPack) => void;
  onRemoveAll: () => void;
  bulkBusy: boolean;
  bulkLabel: string;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between pb-2 gap-3">
        <div>
          <h3 className="section-title text-base">{title}</h3>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-xs text-muted">
            {packs.length} skin{packs.length === 1 ? "" : "s"}
          </div>
          {packs.length > 0 && (
            <button
              type="button"
              className="text-xs text-muted hover:text-danger px-2 py-1 border border-border rounded"
              onClick={onRemoveAll}
              disabled={bulkBusy}
              title={`${bulkLabel} all ${packs.length} skin${packs.length === 1 ? "" : "s"} in this section`}
            >
              {bulkBusy ? `${bulkLabel}…` : bulkLabel}
            </button>
          )}
        </div>
      </div>

      {packs.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">{emptyText}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 off-kilter">
          {packs.map((p) => {
            const charDef = chars.find((c) => c.code === p.character_code);
            const allSlots = charDef?.slots ?? [];
            const myKey = `${p.character_code}/${p.pack_name}`;
            return (
              <div key={myKey} className="card tactile overflow-hidden flex flex-col">
                <div className="relative aspect-square bg-bg flex items-center justify-center">
                  <CharacterBadge code={p.character_code} size={120} />
                  <span
                    className="absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-surface/90 border border-border text-muted"
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
                </div>
                <div className="p-4 space-y-3 flex-1 flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-base font-semibold truncate">
                        {p.pack_name}
                      </div>
                      <div className="text-xs text-muted truncate">
                        {p.character_display} · {p.slots.length} slot
                        {p.slots.length === 1 ? "" : "s"}
                        {p.source === "patreon" && p.source_creator_display && (
                          <> · by {p.source_creator_display}</>
                        )}
                        {p.fully_installed && (
                          <span className="text-ok"> · installed</span>
                        )}
                        {p.partially_installed && (
                          <span className="text-accent"> · partial</span>
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
      )}
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
