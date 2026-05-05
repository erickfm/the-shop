import { useEffect, useState } from "react";
import { Account } from "./routes/Account";
import { Connect } from "./routes/Connect";
import { Browse } from "./routes/Browse";
import { FirstRunModal } from "./components/FirstRunModal";
import { Toaster, toast } from "./components/Toaster";
import { Wordmark } from "./components/Wordmark";
import { BusyOverlay } from "./components/BusyOverlay";
import { ipc } from "./lib/ipc";
import type { PatreonStatus } from "./lib/types";

type Route = "connect" | "browse" | "account";

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
        // account stays open across (dis)connects so the user can still
        // reach settings + reconnect controls; browse routes to connect
        // when not signed in.
        if (r === "account") return r;
        if (r === "connect" && s.connected) return "browse";
        if (r === "browse" && !s.connected) return "connect";
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

  if (needsFirstRun === null || patreon === null) {
    return <div className="p-8 text-muted">loading…</div>;
  }

  const goHome = () => setRoute(patreon.connected ? "browse" : "connect");

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-6 py-3 gap-6">
        <button
          type="button"
          onClick={goHome}
          aria-label="home"
          className="shrink-0 hover:opacity-80 transition-opacity"
        >
          <Wordmark />
        </button>
        <div className="flex items-baseline gap-5 shrink-0 text-sm">
          <button
            className={`transition-colors ${
              route === "account"
                ? "text-white"
                : "text-muted hover:text-white"
            }`}
            onClick={() => setRoute("account")}
            title="installed skins, paths, account"
          >
            you
          </button>
          <button
            className="text-muted hover:text-white transition-colors"
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
        {route === "account" && (
          <Account
            key={refreshKey}
            onAfterAction={() => setRefreshKey((k) => k + 1)}
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
