import { getCurrentWindow } from "@tauri-apps/api/window";

/// Minimize / maximize / close cluster for the custom titlebar.
/// We disabled the OS window decorations in tauri.conf.json so the
/// app reads as one seamless surface; this gives the user back the
/// three controls every desktop window needs. Lives in the top-right
/// of the App header. data-tauri-drag-region="false" prevents the
/// surrounding header's drag handle from swallowing button clicks.
export function WindowControls() {
  const win = getCurrentWindow();
  return (
    <div
      data-tauri-drag-region="false"
      className="flex items-center gap-1 shrink-0"
    >
      <ControlButton
        label="minimize"
        onClick={() => {
          win.minimize().catch(() => {});
        }}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="pointer-events-none">
          <line
            x1="2.5"
            y1="6"
            x2="9.5"
            y2="6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </ControlButton>
      <ControlButton
        label="toggle maximize"
        onClick={() => {
          win.toggleMaximize().catch(() => {});
        }}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="pointer-events-none">
          <rect
            x="2.5"
            y="2.5"
            width="7"
            height="7"
            rx="0.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      </ControlButton>
      <ControlButton
        label="close"
        danger
        onClick={() => {
          win.close().catch(() => {});
        }}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="pointer-events-none">
          <line
            x1="3"
            y1="3"
            x2="9"
            y2="9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <line
            x1="9"
            y1="3"
            x2="3"
            y2="9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </ControlButton>
    </div>
  );
}

function ControlButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        "flex items-center justify-center w-7 h-7 rounded text-muted transition-colors " +
        (danger
          ? "hover:bg-danger/20 hover:text-danger"
          : "hover:bg-white/10 hover:text-white")
      }
    >
      {children}
    </button>
  );
}
