import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import { bytes } from "../lib/format";
import { toast } from "../components/Toaster";
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
      toast({ kind: "ok", text: `iso recognized: ${info.recognized || "unknown — proceed at your own risk"}` });
      await refresh();
      onChange?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `iso error: ${e?.message || e}` });
    } finally {
      setIsoBusy(false);
    }
  };

  const pickLauncher = async () => {
    const sel = await open({ multiple: false });
    if (typeof sel !== "string") return;
    await ipc.setSlippiLauncherExecutable(sel);
    toast({ kind: "ok", text: "slippi launcher path saved" });
    await refresh();
  };

  const pickUserDir = async () => {
    const sel = await open({ multiple: false, directory: true });
    if (typeof sel !== "string") return;
    await ipc.setSlippiUserDir(sel);
    toast({ kind: "ok", text: "slippi user dir saved" });
    await refresh();
  };

  if (!settings) return <div className="p-8 text-muted">loading…</div>;

  return (
    <div className="p-8 max-w-3xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold mb-1">vanilla melee iso</h2>
        <p className="text-sm text-muted mb-3">
          A clean, unmodified ISO. The Shop never modifies this file — it's read-only here.
        </p>
        <div className="card p-4 space-y-3">
          <div className="flex gap-2">
            <input
              className="input font-mono"
              value={settings.vanilla_iso_path ?? ""}
              readOnly
              placeholder="no iso selected"
            />
            <button className="btn-primary" onClick={pickIso} disabled={isoBusy}>
              {isoBusy ? "reading…" : "browse…"}
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
        <h2 className="text-lg font-semibold mb-1">slippi launcher</h2>
        <p className="text-sm text-muted mb-3">
          Where to find the Slippi Launcher binary so we can launch it for you.
        </p>
        <div className="card p-4 space-y-3">
          <div className="flex gap-2">
            <input
              className="input font-mono"
              value={settings.slippi_launcher_executable ?? ""}
              readOnly
              placeholder={detected?.slippi_launcher_executable || "not detected"}
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
              placeholder={detected?.slippi_user_dir || "not detected"}
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
        <h2 className="text-lg font-semibold mb-1">storage</h2>
        <div className="card p-4 text-xs text-muted font-mono space-y-1">
          <div>skins: {settings.skins_dir}</div>
          <div>patched ISO: {settings.patched_iso_path}</div>
        </div>
      </div>
    </div>
  );
}
