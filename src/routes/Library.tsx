import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import { toast } from "../components/Toaster";
import { busy as withBusy } from "../components/BusyOverlay";
import { CharacterBadge } from "../components/CharacterBadge";
import type { CharacterDef, SkinPack } from "../lib/types";

export function Library({ onAfterAction }: { onAfterAction?: () => void }) {
  const [packs, setPacks] = useState<SkinPack[]>([]);
  const [chars, setChars] = useState<CharacterDef[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const [p, c] = await Promise.all([ipc.listSkinPacks(), ipc.listCharacters()]);
    setPacks(p);
    setChars(c);
  };

  useEffect(() => {
    refresh();
  }, []);

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
        text: `Imported ${r.imported}, skipped ${r.skipped_duplicates}${failed}`,
      });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `Import failed: ${e?.message || e}` });
    }
  };

  const install = async (p: SkinPack) => {
    setBusy(`${p.character_code}/${p.pack_name}`);
    try {
      const r = await withBusy(
        `Installing ${p.character_display} · ${p.pack_name}…`,
        () => ipc.installPack(p.character_code, p.pack_name),
      );
      const installedCount = r.installed_slots.length;
      const skipped = r.skipped_slots.length;
      const routed = r.installed_slots.filter((s) => s.routed);
      const routedNote =
        routed.length > 0
          ? ` · Routed to extended slots: ${routed
              .map((s) => `${s.requested_slot_code}→${s.actual_slot_code}`)
              .join(", ")}`
          : "";
      if (skipped > 0) {
        const detail = r.skipped_slots
          .map((s) => `${s.slot_code}: ${s.reason}`)
          .join(" · ");
        toast({
          kind: installedCount > 0 ? "info" : "danger",
          text: `Installed ${installedCount}/${installedCount + skipped} slots${routedNote}. Skipped: ${detail}`,
        });
      } else {
        toast({
          kind: "ok",
          text: `Installed ${p.character_display} · ${p.pack_name}${routedNote}`,
        });
      }
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `Install failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (p: SkinPack) => {
    setBusy(`${p.character_code}/${p.pack_name}`);
    try {
      await withBusy(
        `Uninstalling ${p.character_display} · ${p.pack_name}…`,
        () => ipc.uninstallPack(p.character_code, p.pack_name),
      );
      toast({ kind: "ok", text: `Uninstalled ${p.character_display} · ${p.pack_name}` });
      await refresh();
      onAfterAction?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `Uninstall failed: ${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  if (packs.length === 0) {
    return (
      <div className="p-8">
        <EmptyState onAdd={addSkins} />
      </div>
    );
  }

  return (
    <div className="p-8 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Library</h2>
        <button className="btn" onClick={addSkins}>
          + Add skins
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {packs.map((p) => {
          const charDef = chars.find((c) => c.code === p.character_code);
          const allSlots = charDef?.slots ?? [];
          const myKey = `${p.character_code}/${p.pack_name}`;
          return (
            <div key={myKey} className="card p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <CharacterBadge code={p.character_code} size={56} />
                  <div className="min-w-0">
                    <div className="text-base font-semibold truncate">
                      {p.character_display}
                      <span className="text-muted"> · </span>
                      <span>{p.pack_name}</span>
                    </div>
                    <div className="text-xs text-muted">
                      {p.slots.length} slot{p.slots.length === 1 ? "" : "s"}
                      {p.fully_installed && (
                        <span className="text-ok"> · installed</span>
                      )}
                      {p.partially_installed && (
                        <span className="text-accent"> · partial</span>
                      )}
                    </div>
                  </div>
                </div>
                {p.fully_installed || p.partially_installed ? (
                  <button
                    className="btn-danger"
                    onClick={() => uninstall(p)}
                    disabled={busy === myKey}
                  >
                    {busy === myKey ? (
                      <span className="inline-flex items-center gap-2">
                        <BusyDot /> Uninstalling…
                      </span>
                    ) : (
                      "Uninstall"
                    )}
                  </button>
                ) : (
                  <button
                    className="btn-primary"
                    onClick={() => install(p)}
                    disabled={busy === myKey}
                  >
                    {busy === myKey ? (
                      <span className="inline-flex items-center gap-2">
                        <BusyDot /> Installing…
                      </span>
                    ) : (
                      "Install"
                    )}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {allSlots.map((s) => {
                  const ours = p.slots.find((ps) => ps.slot_code === s.code);
                  if (!ours) {
                    return (
                      <span key={s.code} className="pill-muted opacity-40">
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
          );
        })}
      </div>
    </div>
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

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="card p-10 text-center space-y-4">
      <div className="text-lg font-semibold">No skins yet</div>
      <p className="text-sm text-muted max-w-md mx-auto">
        Add some <span className="font-mono">.dat</span> files to get started. The filename should
        look like{" "}
        <code className="px-1 rounded bg-bg border border-border">PlFxNr-MyName.dat</code>.
      </p>
      <button className="btn-primary" onClick={onAdd}>
        + Add skins
      </button>
    </div>
  );
}
