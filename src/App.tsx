import { useEffect, useState } from "react";
import { Library } from "./routes/Library";
import { Settings } from "./routes/Settings";
import { Connect } from "./routes/Connect";
import { Browse } from "./routes/Browse";
import { FirstRunModal } from "./components/FirstRunModal";
import { Toaster, toast } from "./components/Toaster";
import { BusyOverlay, busy } from "./components/BusyOverlay";
import { ipc } from "./lib/ipc";
import type { PatreonStatus } from "./lib/types";

type Route = "connect" | "browse" | "library" | "settings";

export default function App() {
  const [route, setRoute] = useState<Route>("connect");
  const [needsFirstRun, setNeedsFirstRun] = useState<boolean | null>(null);
  const [patreon, setPatreon] = useState<PatreonStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const checkFirstRun = async () => {
    const s = await ipc.getSettings();
    const need = !s.vanilla_iso_path || !s.slippi_launcher_executable;
    setNeedsFirstRun(need);
  };

  const refreshPatreon = async () => {
    try {
      const s = await ipc.patreonStatus();
      setPatreon(s);
      setRoute((r) => {
        if (r === "settings") return r;
        if (r === "connect" && s.connected) return "browse";
        if ((r === "browse" || r === "library") && !s.connected) return "connect";
        return r;
      });
    } catch {
      setPatreon({ connected: false, user: null, last_verified_at: null });
    }
  };

  useEffect(() => {
    checkFirstRun();
    refreshPatreon();
  }, [refreshKey]);

  const launch = async () => {
    try {
      await ipc.launchSlippi();
      toast({ kind: "ok", text: "Slippi Launcher started" });
    } catch (e: any) {
      toast({ kind: "danger", text: `Launch failed: ${e?.message || e}` });
    }
  };

  const disconnect = async () => {
    try {
      await ipc.patreonDisconnect();
      setPatreon({ connected: false, user: null, last_verified_at: null });
      setRoute("connect");
      toast({ kind: "ok", text: "Disconnected from Patreon" });
    } catch (e: any) {
      toast({ kind: "danger", text: `Disconnect failed: ${e?.message || e}` });
    }
  };

  const reset = async () => {
    const ok = confirm(
      [
        "Uninstall ALL skins and clear the patched ISO?",
        "",
        "This will:",
        "  • Delete the-shop-patched.iso",
        "  • Mark every installed skin as not-installed",
        "  • Point Slippi back at your original ISO",
        "",
        "Your imported skin files in the library are kept.",
      ].join("\n"),
    );
    if (!ok) return;
    try {
      const r = await busy("Clearing installs…", () => ipc.resetToVanilla());
      toast({
        kind: "ok",
        text: `Cleared · removed patched ISO: ${r.patched_iso_removed ? "yes" : "no"} · ${r.packs_uninstalled} packs cleared`,
      });
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      toast({ kind: "danger", text: `Reset failed: ${e?.message || e}` });
    }
  };

  if (needsFirstRun === null || patreon === null) {
    return <div className="p-8 text-muted">Loading…</div>;
  }

  const navButton = (target: Route, label: string, disabled = false) => (
    <button
      key={target}
      className={`px-2.5 py-1 rounded ${
        route === target
          ? "bg-bg text-white"
          : disabled
            ? "text-muted opacity-40 cursor-not-allowed"
            : "text-muted hover:text-white"
      }`}
      onClick={() => !disabled && setRoute(target)}
      disabled={disabled}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-border bg-surface flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <div className="text-base font-bold tracking-tight">the shop</div>
          <nav className="flex gap-1 text-sm">
            {patreon.connected
              ? [
                  navButton("browse", "Browse"),
                  navButton("library", "Local"),
                  navButton("settings", "Settings"),
                ]
              : [
                  navButton("connect", "Connect"),
                  navButton("library", "Local", false),
                  navButton("settings", "Settings"),
                ]}
          </nav>
        </div>
        <div className="flex gap-2 items-center">
          {patreon.connected && patreon.user ? (
            <button
              className="text-xs text-muted hover:text-white px-2 py-1 rounded border border-border"
              onClick={disconnect}
              title="Sign out of Patreon"
            >
              {patreon.user.name || "Connected"} · disconnect
            </button>
          ) : (
            <span className="text-xs text-muted">not connected</span>
          )}
          <button
            className="btn-danger"
            onClick={reset}
            title="Uninstall all skins and remove the patched ISO."
          >
            Clear all installs
          </button>
          <button className="btn-primary" onClick={launch}>
            ▶ Launch Slippi
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {route === "connect" && (
          <Connect
            onConnected={() => {
              setRefreshKey((k) => k + 1);
              setRoute("browse");
            }}
          />
        )}
        {route === "browse" && (
          <Browse
            key={refreshKey}
            onAfterAction={() => setRefreshKey((k) => k + 1)}
          />
        )}
        {route === "library" && (
          <Library
            key={refreshKey}
            onAfterAction={() => setRefreshKey((k) => k + 1)}
          />
        )}
        {route === "settings" && (
          <Settings
            key={refreshKey}
            onChange={() => setRefreshKey((k) => k + 1)}
          />
        )}
      </main>

      {needsFirstRun && (
        <FirstRunModal
          onComplete={() => {
            setNeedsFirstRun(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      <Toaster />
      <BusyOverlay />
    </div>
  );
}
