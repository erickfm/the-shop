import logoUrl from "../assets/logo.png";

/// the-shop logo — the user-supplied isometric "metal box" with the
/// cartoon `!` on each face. PNG asset (Vite resolves via import).
/// `select-none` + `pointer-events-none` so it stays purely decorative
/// when sitting next to clickable nav text.
///
/// The CSS filter recolors the source PNG (originally rendered in
/// grey) to titanium white. brightness(0) collapses the artwork to
/// black, invert(1) flips it to pure white, then a faint sepia +
/// saturation step adds the warm-white cast that distinguishes
/// titanium white (~#F8F8F0) from clinical pure white. drop-shadow
/// softens the edge against the dark header so the recolored mark
/// doesn't read as a flat sticker.
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
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        filter:
          "brightness(0) invert(1) sepia(0.08) saturate(180%) hue-rotate(-5deg)",
      }}
    />
  );
}
