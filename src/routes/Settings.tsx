import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import { bytes } from "../lib/format";
import { toast } from "../components/Toaster";
import { busy } from "../components/BusyOverlay";
import type {
  DetectedPaths,
  PatreonStatus,
  Settings as SettingsT,
} from "../lib/types";

export function Settings({ onChange }: { onChange?: () => void }) {
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [detected, setDetected] = useState<DetectedPaths | null>(null);
  const [patreon, setPatreon] = useState<PatreonStatus | null>(null);
  const [isoBusy, setIsoBusy] = useState(false);

  const refresh = async () => {
    const [s, d, p] = await Promise.all([
      ipc.getSettings(),
      ipc.detectPaths(),
      ipc.patreonStatus(),
    ]);
    setSettings(s);
    setDetected(d);
    setPatreon(p);
  };

  const disconnectPatreon = async () => {
    try {
      await ipc.patreonDisconnect();
      toast({ kind: "ok", text: "disconnected from patreon" });
      await refresh();
      onChange?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `disconnect failed: ${e?.message || e}` });
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const pickIso = async () => {
    const sel = await open({
      multiple: false,
      filters: [{ name: "gamecube iso", extensions: ["iso", "gcm"] }],
    });
    if (typeof sel !== "string") return;
    setIsoBusy(true);
    try {
      const info = await ipc.setVanillaIsoPath(sel);
      toast({
        kind: "ok",
        text: `iso recognized: ${info.recognized || "unknown — proceed at your own risk"}`,
      });
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

  const reset = async () => {
    const ok = confirm(
      [
        "uninstall all skins and clear the patched iso?",
        "",
        "this will:",
        "  • delete the-shop-patched.iso",
        "  • mark every installed skin as not-installed",
        "  • point slippi back at your original iso",
        "",
        "your imported skin files in the library are kept.",
      ].join("\n"),
    );
    if (!ok) return;
    try {
      const r = await busy("clearing installs…", () => ipc.resetToVanilla());
      toast({
        kind: "ok",
        text: `cleared · removed patched iso: ${r.patched_iso_removed ? "yes" : "no"} · ${r.packs_uninstalled} packs cleared`,
      });
      await refresh();
      onChange?.();
    } catch (e: any) {
      toast({ kind: "danger", text: `reset failed: ${e?.message || e}` });
    }
  };

  if (!settings) return <div className="p-8 text-muted">loading…</div>;

  // Every section follows the same shape — section-title h2, then a
  // card with consistent padding + vertical rhythm. Body content uses
  // text-sm by default; secondary metadata is text-xs text-muted. No
  // per-section font-size overrides on the card itself; let the inner
  // elements decide their own size against a uniform container.
  return (
    <div className="p-8 max-w-3xl space-y-8">
      <Section title="vanilla melee iso">
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
          <div className="text-xs text-muted font-mono space-y-1">
            <div>size: {bytes(settings.vanilla_iso.size_bytes)}</div>
            <div>
              recognized:{" "}
              <span
                className={
                  settings.vanilla_iso.recognized ? "text-ok" : "text-muted"
                }
              >
                {settings.vanilla_iso.recognized ??
                  "unknown — proceed with care"}
              </span>
            </div>
          </div>
        )}
      </Section>

      <Section title="slippi launcher">
        <div className="flex gap-2">
          <input
            className="input font-mono"
            value={settings.slippi_launcher_executable ?? ""}
            readOnly
            placeholder={detected?.slippi_launcher_executable || "not detected"}
          />
          <button className="btn" onClick={pickLauncher}>
            browse…
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
            browse user dir…
          </button>
        </div>
        <div className="text-xs text-muted">
          currently configured iso in slippi:{" "}
          <span className="font-mono">
            {settings.current_slippi_iso_path ?? "(none / cannot read)"}
          </span>
        </div>
      </Section>

      <Section title="patreon">
        {patreon?.connected && patreon.user ? (
          <>
            <div className="text-sm text-muted">
              connected as{" "}
              <span className="text-white lowercase">
                {patreon.user.name || "(no name)"}
              </span>
            </div>
            <button
              className="text-xs text-muted hover:text-danger transition-colors self-start"
              onClick={disconnectPatreon}
              title="sign out of patreon"
            >
              disconnect →
            </button>
          </>
        ) : (
          <div className="text-sm text-muted">not connected</div>
        )}
      </Section>

      <Section title="storage">
        <div className="text-xs text-muted font-mono space-y-1">
          <div>skins: {settings.skins_dir}</div>
          <div>patched iso: {settings.patched_iso_path}</div>
        </div>
      </Section>

      <Section title="danger zone">
        <button
          className="text-xs text-muted hover:text-danger transition-colors self-start"
          onClick={reset}
          title="uninstall all skins and remove the patched iso"
        >
          clear all installs →
        </button>
      </Section>
    </div>
  );
}

/// Section primitive — keeps every Settings subsection visually
/// identical. Title + card body with consistent padding and vertical
/// gap. flex-col on the card so `self-start` works on inline links
/// without stretching them across the row.
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="section-title text-base mb-3">{title}</h2>
      <div className="card p-4 flex flex-col gap-3">{children}</div>
    </div>
  );
}
