import { useEffect, useState } from "react";
import { Library } from "./routes/Library";
import { Settings } from "./routes/Settings";
import { FirstRunModal } from "./components/FirstRunModal";
import { Toaster, toast } from "./components/Toaster";
import { BusyOverlay, busy } from "./components/BusyOverlay";
import { ipc } from "./lib/ipc";

type Route = "library" | "settings";

export default function App() {
  const [route, setRoute] = useState<Route>("library");
  const [needsFirstRun, setNeedsFirstRun] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const checkFirstRun = async () => {
    const s = await ipc.getSettings();
    const need = !s.vanilla_iso_path || !s.slippi_launcher_executable;
    setNeedsFirstRun(need);
  };

  useEffect(() => {
    checkFirstRun();
  }, [refreshKey]);

  const launch = async () => {
    try {
      await ipc.launchSlippi();
      toast({ kind: "ok", text: "Slippi Launcher started" });
    } catch (e: any) {
      toast({ kind: "danger", text: `Launch failed: ${e?.message || e}` });
    }
  };

  const reset = async () => {
    const ok = confirm(
      [
        "Uninstall ALL skins and clear the patched ISO?",
        "",
        "This will:",
        "  • Delete the-shop-patched.iso",
        "  • Mark every installed skin as not-installed in the library",
        "  • Point Slippi back at your original ISO (or m-ex base if you have one)",
        "",
        "Your imported skin files in the library are kept. Your m-ex base ISO is kept.",
        "Use this if installs got into a weird state, or to start fresh.",
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

  if (needsFirstRun === null) {
    return <div className="p-8 text-muted">Loading…</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-border bg-surface flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <div className="text-base font-bold tracking-tight">the shop</div>
          <nav className="flex gap-1 text-sm">
            <button
              className={`px-2.5 py-1 rounded ${route === "library" ? "bg-bg text-white" : "text-muted hover:text-white"}`}
              onClick={() => setRoute("library")}
            >
              Library
            </button>
            <button
              className={`px-2.5 py-1 rounded ${route === "settings" ? "bg-bg text-white" : "text-muted hover:text-white"}`}
              onClick={() => setRoute("settings")}
            >
              Settings
            </button>
          </nav>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-danger"
            onClick={reset}
            title="Uninstall all skins and remove the patched ISO. Your library and m-ex base are kept."
          >
            Clear all installs
          </button>
          <button className="btn-primary" onClick={launch}>
            ▶ Launch Slippi
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {route === "library" ? (
          <Library key={refreshKey} onAfterAction={() => setRefreshKey((k) => k + 1)} />
        ) : (
          <Settings key={refreshKey} onChange={() => setRefreshKey((k) => k + 1)} />
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
