/// the-shop logo — a chunky-dotted rounded square with a rounded
/// exclamation point inside, riffing on Melee's item-crate. Currents
/// inherit `currentColor` so the logo recolors with the surrounding text.
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden
      role="img"
      style={{ flex: "none" }}
    >
      {/* Chunky dotted rounded square. `stroke-dasharray="0 11"` with
          rounded line caps draws fat circular dots spaced 11 units
          apart — same trick used for stippled UI borders. */}
      <rect
        x="8"
        y="8"
        width="48"
        height="48"
        rx="11"
        ry="11"
        fill="none"
        stroke="currentColor"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray="0 11"
      />
      {/* Exclamation stem — thick line with round caps reads as a pill. */}
      <line
        x1="32"
        y1="22"
        x2="32"
        y2="38"
        stroke="currentColor"
        strokeWidth={6}
        strokeLinecap="round"
      />
      {/* Exclamation dot. */}
      <circle cx="32" cy="46" r="3.2" fill="currentColor" />
    </svg>
  );
}
