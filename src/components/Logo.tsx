import logoUrl from "../assets/logo.png";

/// the-shop logo — the user-supplied isometric "metal box" with the
/// cartoon `!` on each face. PNG asset (Vite resolves via import).
/// `select-none` + `pointer-events-none` so it stays purely decorative
/// when sitting next to clickable nav text.
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden
      width={size}
      height={size}
      draggable={false}
      className="select-none pointer-events-none shrink-0"
      style={{ width: size, height: size, objectFit: "contain" }}
    />
  );
}
