import { useEffect, useState } from "react";
import { Account } from "./routes/Account";
import { Connect } from "./routes/Connect";
import { Browse } from "./routes/Browse";
import { FirstRunModal } from "./components/FirstRunModal";
import { Toaster, toast } from "./components/Toaster";
import { Wordmark } from "./components/Wordmark";
import { Logo } from "./components/Logo";
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
          className="shrink-0 flex items-center gap-3 hover:opacity-80 transition-opacity"
        >
          <Logo size={36} />
          <Wordmark />
        </button>
        <div className="flex items-baseline gap-5 shrink-0 text-sm">
          <button
            className={`transition-colors p-1 -m-1 ${
              route === "account"
                ? "text-white"
                : "text-muted hover:text-white"
            }`}
            onClick={() => setRoute("account")}
            title="your installed skins, paths, account"
            aria-label="open your stash and settings"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {/* Eight-tooth cog: gear teeth + center hole. */}
              <path d="M12 2.5l1.6 2.4 2.9-.4.6 2.8 2.5 1.5-1 2.7 1 2.7-2.5 1.5-.6 2.8-2.9-.4L12 21.5l-1.6-2.4-2.9.4-.6-2.8L4.4 15.2l1-2.7-1-2.7L7 8.3l.6-2.8 2.9.4z" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
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
