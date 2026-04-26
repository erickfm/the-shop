import { useEffect, useState } from "react";

let setLabel: ((label: string | null) => void) | null = null;

export function busy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  setLabel?.(label);
  return fn().finally(() => setLabel?.(null));
}

export function BusyOverlay() {
  const [label, set] = useState<string | null>(null);

  useEffect(() => {
    setLabel = set;
    return () => {
      setLabel = null;
    };
  }, []);

  if (!label) return null;

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center pointer-events-none">
      <div className="card px-6 py-5 flex items-center gap-4 shadow-2xl">
        <svg
          className="animate-spin text-accent"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
            strokeOpacity="0.25"
          />
          <path
            d="M22 12a10 10 0 0 1-10 10"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted">Working — don't close the app.</div>
        </div>
      </div>
    </div>
  );
}
