import { useEffect, useState } from "react";
import { Account } from "./routes/Account";
import { Connect } from "./routes/Connect";
import { Browse } from "./routes/Browse";
import { FirstRunModal } from "./components/FirstRunModal";
import { Toaster, toast } from "./components/Toaster";
import { Wordmark } from "./components/Wordmark";
import { Logo } from "./components/Logo";
import { BusyOverlay } from "./components/BusyOverlay";
import { WindowControls } from "./components/WindowControls";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ipc } from "./lib/ipc";
import type { PatreonStatus } from "./lib/types";

type Route = "connect" | "browse" | "account";

export default function App() {
  const [route, setRoute] = useState<Route>("connect");
  const [needsFirstRun, setNeedsFirstRun] = useState<boolean | null>(null);
  const [patreon, setPatreon] = useState<PatreonStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped only on logo / wordmark click. Used as a React `key` on the
  // route's content so clicking "home" gives a clean remount (scroll
  // top, drawer closed, search cleared, carousel re-randomized) — i.e.
  // the user's expected "refresh the page" behavior. Distinct from
  // refreshKey, which gates patreon-status side effects only.
  const [homeKey, setHomeKey] = useState(0);

  const checkFirstRun = async () => {
    const s = await ipc.getSettings();
    const need = !s.vanilla_iso_path || !s.slippi_launcher_executable;
    setNeedsFirstRun(need);
  };

  const refreshPatreon = async () => {
    try {
      const s = await ipc.patreonStatus();
      // Use functional setState so we can compare prev → next and only
      // kick off the heavy viewable-post refresh on a true
      // (disconnected → connected) transition. We deliberately don't
      // re-fetch on every refreshKey bump (those fire on each install /
      // first-run too) — the home-button reload path is the user-driven
      // refresh. This is the authoritative gate for "can the user
      // actually install this skin" — see refresh_viewable_posts in
      // patreon.rs for why memberships alone aren't enough.
      setPatreon((prev) => {
        const wasConnected = prev?.connected ?? false;
        if (s.connected && !wasConnected) {
          ipc.refreshViewablePosts().catch(() => {});
        }
        return s;
      });
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

  const goHome = () => {
    setRoute(patreon.connected ? "browse" : "connect");
    setHomeKey((k) => k + 1);
    // Pull the latest index in the background — fire-and-forget; if it
    // fails the existing cache stays in place. Browse's own onMount
    // re-fetches from the (possibly updated) cache after the remount.
    ipc.refreshSkinIndex().catch(() => {});
    // Also refresh per-post viewability while we're at it — the user's
    // entitlement may have changed since session start (cancellation
    // ages out, new sub kicks in, etc.).
    if (patreon.connected) {
      ipc.refreshViewablePosts().catch(() => {});
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Custom titlebar — the OS chrome is off (decorations: false in
          tauri.conf.json) so the user gets a single seamless surface
          with rounded corners. data-tauri-drag-region on the header
          makes the empty space draggable; interactive children
          (buttons, links) stay clickable, and WindowControls opts
          itself out of the drag handle so its buttons aren't lost
          to drag-starts. */}
      <header
        data-tauri-drag-region
        onMouseDown={(e) => {
          // Belt-and-suspenders: data-tauri-drag-region is flaky on
          // some Linux compositors. Explicit startDragging() on
          // primary-button mousedown is reliable. Two subtle gotchas:
          //   1. e.target may be SVG-tree elements (path / rect / line)
          //      which are SVGElement, not HTMLElement. Use Element so
          //      the instanceof check lets them through to the
          //      closest() walk; otherwise SVG-only clicks fall
          //      through and startDragging steals the click before
          //      the parent button can fire.
          //   2. closest() walks the full ancestor chain — buttons
          //      with SVG children correctly resolve to <button>.
          if (e.button !== 0) return;
          if (
            e.target instanceof Element &&
            e.target.closest("button, a, input, select, textarea")
          ) {
            return;
          }
          getCurrentWindow().startDragging().catch(() => {});
        }}
        className="flex items-center justify-between px-6 py-3 gap-6 select-none"
      >
        <button
          type="button"
          onClick={goHome}
          aria-label="home"
          className="shrink-0 flex items-center gap-3 hover:opacity-80 transition-opacity"
        >
          <Logo size={56} />
          <Wordmark />
        </button>
        <div className="flex items-center gap-3 shrink-0 text-sm">
          <button
            className={`transition-colors p-1 -m-1 relative -top-[2px] ${
              route === "account"
                ? "text-white"
                : "text-muted hover:text-white"
            }`}
            onClick={() => setRoute("account")}
            title="your installed skins, paths, account"
            aria-label="open my stuff and settings"
          >
            <svg
              width="16"
              height="16"
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
            className="btn"
            onClick={launch}
            title="launch slippi"
          >
            <span aria-hidden>▶</span>
            <span>launch</span>
          </button>
          <WindowControls />
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
        {/* Browse and Account manage their own data refreshes on install /
            uninstall / remove (each handler calls a local refresh() that
            re-fetches via ipc and updates state). They no longer key off
            App's refreshKey — that was forcing a full remount on every
            install, resetting scroll position, the open drawer, the search
            input, and the carousel. App still bumps refreshKey for
            connect / disconnect / first-run completion to re-fetch its
            own patreon + first-run state, but the route components stay
            mounted. */}
        {route === "browse" && <Browse key={homeKey} />}
        {route === "account" && <Account key={homeKey} />}
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
