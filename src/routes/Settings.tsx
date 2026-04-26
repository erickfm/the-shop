import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import { bytes } from "../lib/format";
import { toast } from "../components/Toaster";
import { busy as withBusy } from "../components/BusyOverlay";
import type { DetectedPaths, Settings as SettingsT } from "../lib/types";

export function Settings({ onChange }: { onChange?: () => void }) {
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [detected, setDetected] = useState<DetectedPaths | null>(null);
  const [isoBusy, setIsoBusy] = useState(false);

  const refresh = async () => {
    const [s, d] = await Promise.all([ipc.getSettings(), ipc.detectPaths()]);
    setSettings(s);
    setDetected(d);
  };

  useEffect(() => {
    refresh();
  }, []);

  const pickIso = async () => {
    const sel = await open({
      multiple: false,
      filters: [{ name: "GameCube ISO", extensions: ["iso", "gcm"] }],
    });
    if (typeof sel !== "string") return;
    setIsoBusy(true);
    try {
      const info = await ipc.setVanillaIsoPath(sel);
      toast({ kind: "ok", text: `ISO recognized: ${info.recognized || "unknown — proceed at your own risk"}` });
      await refresh();
      onChange?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `ISO error: ${e?.message || e}` });
    } finally {
      setIsoBusy(false);
    }
  };

  const pickLauncher = async () => {
    const sel = await open({ multiple: false });
    if (typeof sel !== "string") return;
    await ipc.setSlippiLauncherExecutable(sel);
    toast({ kind: "ok", text: "Slippi Launcher path saved" });
    await refresh();
  };

  const pickUserDir = async () => {
    const sel = await open({ multiple: false, directory: true });
    if (typeof sel !== "string") return;
    await ipc.setSlippiUserDir(sel);
    toast({ kind: "ok", text: "Slippi user dir saved" });
    await refresh();
  };

  if (!settings) return <div className="p-8 text-muted">Loading…</div>;

  return (
    <div className="p-8 max-w-3xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-1">Vanilla Melee ISO</h2>
        <p className="text-sm text-muted mb-3">
          A clean, unmodified ISO. The Shop never modifies this file — it's read-only here.
        </p>
        <div className="card p-4 space-y-3">
          <div className="flex gap-2">
            <input
              className="input font-mono"
              value={settings.vanilla_iso_path ?? ""}
              readOnly
              placeholder="No ISO selected"
            />
            <button className="btn-primary" onClick={pickIso} disabled={isoBusy}>
              {isoBusy ? "Reading…" : "Browse…"}
            </button>
          </div>
          {settings.vanilla_iso && (
            <div className="text-xs text-muted space-y-1 font-mono">
              <div>size: {bytes(settings.vanilla_iso.size_bytes)}</div>
              <div>
                recognized:{" "}
                <span className={settings.vanilla_iso.recognized ? "text-ok" : "text-muted"}>
                  {settings.vanilla_iso.recognized ?? "unknown — proceed with care"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Slippi Launcher</h2>
        <p className="text-sm text-muted mb-3">
          Where to find the Slippi Launcher binary so we can launch it for you.
        </p>
        <div className="card p-4 space-y-3">
          <div className="flex gap-2">
            <input
              className="input font-mono"
              value={settings.slippi_launcher_executable ?? ""}
              readOnly
              placeholder={detected?.slippi_launcher_executable || "Not detected"}
            />
            <button className="btn" onClick={pickLauncher}>
              Browse…
            </button>
          </div>
          <div className="flex gap-2">
            <input
              className="input font-mono"
              value={settings.slippi_user_dir ?? ""}
              readOnly
              placeholder={detected?.slippi_user_dir || "Not detected"}
            />
            <button className="btn" onClick={pickUserDir}>
              Browse user dir…
            </button>
          </div>
          <div className="text-xs text-muted">
            Currently configured ISO in Slippi:{" "}
            <span className="font-mono">
              {settings.current_slippi_iso_path ?? "(none / cannot read)"}
            </span>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">m-ex Slippi Template</h2>
        <p className="text-sm text-muted mb-3">
          Apply the m-ex Slippi Template once to enable extended costume slots — required for
          modern skins that don't fit in vanilla file slots.
        </p>
        <MexSection settings={settings} onChanged={refresh} />
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-1">Storage</h2>
        <div className="card p-4 text-xs text-muted font-mono space-y-1">
          <div>skins: {settings.skins_dir}</div>
          <div>patched ISO: {settings.patched_iso_path}</div>
          {settings.mex_base_iso_path && (
            <div>m-ex base: {settings.mex_base_iso_path}</div>
          )}
          {settings.gecko_ini_path && (
            <div>gecko ini: {settings.gecko_ini_path}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function MexSection({
  settings,
  onChanged,
}: {
  settings: SettingsT;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    if (!settings.vanilla_iso_path) {
      toast({ kind: "danger", text: "Set your vanilla Melee ISO first" });
      return;
    }
    if (!confirm("Apply m-ex Slippi Template to your vanilla ISO? Creates a separate the-shop-mex-base.iso next to your original.")) return;
    setBusy(true);
    try {
      const r = await withBusy(
        "Applying m-ex template (decoding xdelta against your 1.4GB ISO; ~30s)…",
        () => ipc.applyMexTemplate(),
      );
      toast({
        kind: "ok",
        text: `m-ex applied → ${r.patched_iso_path.split("/").pop()}; Skip Slippi SSS Gecko code installed`,
      });
      await onChanged();
    } catch (e: any) {
      toast({ kind: "danger", text: `m-ex apply failed: ${e?.message || e}` });
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    if (!confirm("Revert m-ex? Deletes the-shop-mex-base.iso and removes the Gecko code from Slippi.")) return;
    setBusy(true);
    try {
      await ipc.revertMexBase();
      toast({ kind: "ok", text: "m-ex base reverted" });
      await onChanged();
    } catch (e: any) {
      toast({ kind: "danger", text: `Revert failed: ${e?.message || e}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-3">
        {settings.mex_base_active ? (
          <>
            <span className="pill-ok">m-ex base ready</span>
            <button className="btn-danger ml-auto" onClick={revert} disabled={busy}>
              {busy ? "…" : "Revert m-ex"}
            </button>
          </>
        ) : (
          <>
            <span className="pill-muted">vanilla mode</span>
            <button className="btn-primary ml-auto" onClick={apply} disabled={busy}>
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner /> Applying… (~30s)
                </span>
              ) : (
                "Apply m-ex template"
              )}
            </button>
          </>
        )}
      </div>
      {busy && !settings.mex_base_active && (
        <div className="text-xs text-muted">
          Decoding the xdelta patch against your 1.4GB ISO. Memory will spike to ~3GB
          briefly. Don't close the app.
        </div>
      )}
      <div className="text-xs text-muted">
        Template by{" "}
        <span className="text-white">davidvkimball</span> — m-ex Slippi Template Pack v5.1.
        Bundled with attribution. Underlying m-ex framework by Team Akaneia.
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
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
