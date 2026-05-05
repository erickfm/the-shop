import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import { toast } from "./Toaster";
import type { DetectedPaths, Settings } from "../lib/types";

export function FirstRunModal({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [detected, setDetected] = useState<DetectedPaths | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([ipc.getSettings(), ipc.detectPaths()]).then(([s, d]) => {
      setSettings(s);
      setDetected(d);
    });
  }, []);

  if (!settings || !detected) return null;

  const hasIso = !!settings.vanilla_iso_path;
  const hasLauncher = !!settings.slippi_launcher_executable;
  const projectDats = detected.project_root_dat_files;

  const pickIso = async () => {
    const sel = await open({
      multiple: false,
      filters: [{ name: "GameCube ISO", extensions: ["iso", "gcm"] }],
    });
    if (typeof sel !== "string") return;
    setBusy(true);
    try {
      await ipc.setVanillaIsoPath(sel);
      const s = await ipc.getSettings();
      setSettings(s);
    } catch (e: any) {
      toast({ kind: "danger", text: `ISO error: ${e?.message || e}` });
    } finally {
      setBusy(false);
    }
  };

  const useDetectedLauncher = async () => {
    if (!detected.slippi_launcher_executable) return;
    await ipc.setSlippiLauncherExecutable(detected.slippi_launcher_executable);
    const s = await ipc.getSettings();
    setSettings(s);
  };

  const importProjectDats = async () => {
    if (projectDats.length === 0) return;
    setBusy(true);
    try {
      const r = await ipc.importSkinFiles(projectDats);
      toast({
        kind: "ok",
        text: `Imported ${r.imported} files (${r.skipped_duplicates} duplicates)`,
      });
    } finally {
      setBusy(false);
    }
  };

  const finish = () => onComplete();

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-8">
      <div className="card max-w-2xl w-full p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold">Welcome to the shop</h1>
          <p className="text-sm text-muted mt-1">
            Two things to set up before we can install skins.
          </p>
        </div>

        <Step
          n={1}
          title="vanilla melee iso"
          done={hasIso}
          body={
            hasIso ? (
              <span className="font-mono text-xs text-muted">
                {settings.vanilla_iso_path}
              </span>
            ) : (
              <button className="btn-primary" onClick={pickIso} disabled={busy}>
                Choose ISO file…
              </button>
            )
          }
        />

        <Step
          n={2}
          title="slippi launcher"
          done={hasLauncher}
          body={
            hasLauncher ? (
              <span className="font-mono text-xs text-muted">
                {settings.slippi_launcher_executable}
              </span>
            ) : detected.slippi_launcher_executable ? (
              <div className="space-y-2">
                <div className="text-xs text-muted font-mono">
                  Detected: {detected.slippi_launcher_executable}
                </div>
                <button className="btn-primary" onClick={useDetectedLauncher}>
                  Use this
                </button>
              </div>
            ) : (
              <span className="text-danger text-xs">
                Couldn't auto-detect. Set it in Settings.
              </span>
            )
          }
        />

        {projectDats.length > 0 && (
          <Step
            n={3}
            title={`Import ${projectDats.length} .dat file(s) from project root`}
            done={false}
            body={
              <div className="space-y-2">
                <ul className="text-xs text-muted font-mono space-y-0.5">
                  {projectDats.slice(0, 6).map((f) => (
                    <li key={f}>{f.split("/").slice(-1)[0]}</li>
                  ))}
                </ul>
                <button className="btn" onClick={importProjectDats} disabled={busy}>
                  Import them
                </button>
              </div>
            }
          />
        )}

        <div className="flex justify-between items-center pt-2">
          <span className="text-xs text-muted">
            You can change everything later in Settings.
          </span>
          <button className="btn-primary" onClick={finish} disabled={!hasIso || !hasLauncher}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  done,
  body,
}: {
  n: number;
  title: string;
  done: boolean;
  body: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-xs font-semibold ${
          done ? "bg-ok/20 text-ok border-ok/40" : "bg-surface border-border"
        }`}
      >
        {done ? "✓" : n}
      </div>
      <div className="flex-1 space-y-2">
        <div className="font-medium">{title}</div>
        <div>{body}</div>
      </div>
    </div>
  );
}
