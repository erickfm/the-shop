import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { ipc } from "../lib/ipc";
import { toast } from "../components/Toaster";
import type { BrowserProbe, PatreonUser } from "../lib/types";

const BROWSER_LABELS: Record<string, string> = {
  firefox: "firefox",
  librewolf: "librewolf",
  chrome: "chrome",
  chromium: "chromium",
  brave: "brave",
  edge: "edge",
  opera: "opera",
  opera_gx: "opera gx",
  vivaldi: "vivaldi",
  safari: "safari",
};

export function Connect({ onConnected }: { onConnected: (user: PatreonUser) => void }) {
  const [probes, setProbes] = useState<BrowserProbe[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const refreshProbes = async () => {
    try {
      const list = await ipc.detectBrowsersWithPatreon();
      setProbes(list);
    } catch (e: any) {
      setProbes([]);
      toast({ kind: "danger", text: `browser scan failed: ${e?.message || e}` });
    }
  };

  useEffect(() => {
    refreshProbes();
    const unlistenPromise = listen<PatreonUser>("patreon-connected", (e) => {
      toast({ kind: "ok", text: `connected as ${e.payload.name}` });
      onConnected(e.payload);
    });
    const unlistenErrPromise = listen<string>("patreon-connect-error", (e) => {
      toast({ kind: "danger", text: `patreon login failed: ${e.payload}` });
    });
    return () => {
      unlistenPromise.then((u) => u());
      unlistenErrPromise.then((u) => u());
    };
  }, [onConnected]);

  const connectAuto = async (preferBrowser?: string) => {
    setBusy(preferBrowser ?? "auto");
    try {
      const result = await ipc.patreonConnectViaBrowser(preferBrowser);
      toast({
        kind: "ok",
        text: `connected as ${result.user.name} (via ${BROWSER_LABELS[result.browser] || result.browser})`,
      });
      onConnected(result.user);
    } catch (e: any) {
      toast({ kind: "danger", text: `${e?.message || e}` });
    } finally {
      setBusy(null);
    }
  };

  const openInBrowser = async () => {
    try {
      await openExternal("https://www.patreon.com/login");
    } catch (e: any) {
      toast({ kind: "danger", text: `could not open browser: ${e?.message || e}` });
    }
  };

  const connectInApp = async () => {
    try {
      await ipc.patreonConnect();
    } catch (e: any) {
      toast({ kind: "danger", text: `connect failed: ${e?.message || e}` });
    }
  };

  const found = (probes ?? []).filter((p) => p.has_session_cookie);
  const errors = (probes ?? []).filter((p) => p.error && !p.has_session_cookie);

  return (
    <div className="p-12 max-w-2xl mx-auto space-y-6">
      <div className="card p-10 text-center space-y-4">
        <div className="text-2xl font-bold tracking-tight">connect patreon</div>
        <p className="text-sm text-muted max-w-md mx-auto leading-relaxed">
          The shop reads your Patreon login from the browser you're already
          signed into. Files come straight from Patreon's CDN to your machine —
          nothing is proxied through us.
        </p>
      </div>

      {probes === null ? (
        <div className="card p-6 text-sm text-muted text-center">
          Scanning browsers…
        </div>
      ) : found.length > 0 ? (
        <div className="card p-6 space-y-4">
          <div className="text-sm">
            Found Patreon sessions in:{" "}
            <span className="font-semibold text-white">
              {found.map((p) => BROWSER_LABELS[p.browser] || p.browser).join(", ")}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-primary"
              onClick={() => connectAuto()}
              disabled={busy !== null}
            >
              {busy === "auto" ? "connecting…" : "connect"}
            </button>
            {found.length > 1 &&
              found.map((p) => (
                <button
                  key={p.browser}
                  className="btn"
                  onClick={() => connectAuto(p.browser)}
                  disabled={busy !== null}
                >
                  {busy === p.browser
                    ? "connecting…"
                    : `Use ${BROWSER_LABELS[p.browser] || p.browser}`}
                </button>
              ))}
          </div>
          <p className="text-xs text-muted leading-relaxed">
            On Linux/macOS, Chrome may pop a one-time keyring prompt the first
            time we read its cookies. Firefox doesn't prompt.
          </p>
        </div>
      ) : (
        <div className="card p-6 space-y-3">
          <div className="text-sm font-semibold">no patreon login detected</div>
          <p className="text-xs text-muted leading-relaxed">
            We didn't find a Patreon session in any browser on this machine.
            Sign into patreon.com in your normal browser (any login method —
            Google, Apple, email — all work), then come back here.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={openInBrowser}>
              Open patreon.com
            </button>
            <button className="btn" onClick={refreshProbes}>
              I'm signed in — re-check
            </button>
          </div>
        </div>
      )}

      <div className="card p-4 space-y-2">
        <button
          type="button"
          className="text-xs text-muted hover:text-white"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          {advancedOpen ? "▾" : "▸"} Other ways to connect
        </button>
        {advancedOpen && (
          <div className="space-y-3 pt-2">
            <div className="text-xs text-muted leading-relaxed">
              If your normal browser isn't installed on this machine, you can
              sign in inside the app instead. Note: Google sign-in won't work
              this way (Google blocks embedded webviews); use email or Apple.
            </div>
            <button className="btn" onClick={connectInApp}>
              Sign in inside the app
            </button>
            {errors.length > 0 && (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer">
                  Browser scan errors ({errors.length})
                </summary>
                <ul className="pl-4 pt-2 space-y-1">
                  {errors.map((e) => (
                    <li key={e.browser}>
                      <strong className="text-white">
                        {BROWSER_LABELS[e.browser] || e.browser}:
                      </strong>{" "}
                      {e.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
