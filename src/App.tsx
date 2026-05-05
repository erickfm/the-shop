import { useEffect, useState } from "react";
import { Library } from "./routes/Library";
import { Settings } from "./routes/Settings";
import { Connect } from "./routes/Connect";
import { Browse } from "./routes/Browse";
import { FirstRunModal } from "./components/FirstRunModal";
import { Toaster, toast } from "./components/Toaster";
import { Wordmark } from "./components/Wordmark";
import { Logo } from "./components/Logo";
import { BusyOverlay } from "./components/BusyOverlay";
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
      toast({ kind: "ok", text: "slippi launcher started" });
    } catch (e: any) {
      toast({ kind: "danger", text: `launch failed: ${e?.message || e}` });
    }
  };

  const disconnect = async () => {
    try {
      await ipc.patreonDisconnect();
      setPatreon({ connected: false, user: null, last_verified_at: null });
      setRoute("connect");
      toast({ kind: "ok", text: "disconnected from patreon" });
    } catch (e: any) {
      toast({ kind: "danger", text: `disconnect failed: ${e?.message || e}` });
    }
  };


  if (needsFirstRun === null || patreon === null) {
    return <div className="p-8 text-muted">loading…</div>;
  }

  const navLink = (target: Route, label: string, disabled = false) => (
    <button
      key={target}
      className={`text-sm transition-colors ${
        route === target
          ? "text-white"
          : disabled
            ? "text-muted opacity-30 cursor-not-allowed"
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
      <header className="border-b border-border/60 bg-surface flex items-center justify-between px-6 py-2.5 gap-6">
        <nav className="flex items-center gap-5 min-w-0">
          <span className="flex items-center gap-2.5 text-muted">
            <Logo size={26} />
            <Wordmark />
          </span>
          <span className="text-muted/30 text-sm">·</span>
          {patreon.connected
            ? [
                navLink("browse", "browse"),
                navLink("library", "skins"),
                navLink("settings", "settings"),
              ]
            : [
                navLink("connect", "connect"),
                navLink("library", "skins", false),
                navLink("settings", "settings"),
              ]}
        </nav>
        <div className="flex items-baseline gap-5 shrink-0">
          {patreon.connected && patreon.user ? (
            <button
              className="text-xs text-muted hover:text-white transition-colors lowercase"
              onClick={disconnect}
              title="sign out of patreon"
            >
              as {patreon.user.name || "connected"}
            </button>
          ) : (
            <span className="text-xs text-muted">not connected</span>
          )}
          <button
            className="text-sm text-muted hover:text-white transition-colors"
            onClick={launch}
            title="launch slippi"
          >
            ▶ launch
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
