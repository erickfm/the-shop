/// the-shop logo — monochrome riff on Melee's metal-box item:
///   - Chunky rounded square outline
///   - Four corner rivets / bolts
///   - A fat, cartoony, slightly bulb-topped exclamation point in the
///     middle (not a thin straight line — a tapered pillar with a fat dot)
/// All paths inherit `currentColor` so the logo recolors with surrounding
/// text. Keep the front-facing flat perspective; no fake gradients.
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden
      role="img"
      style={{ flex: "none" }}
    >
      {/* Outer rounded square — the box body, outline only. */}
      <rect
        x="2.5"
        y="2.5"
        width="27"
        height="27"
        rx="5.5"
        ry="5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />

      {/* Corner rivets — small filled bolts at each corner of the box. */}
      <circle cx="6" cy="6" r="1.1" fill="currentColor" />
      <circle cx="26" cy="6" r="1.1" fill="currentColor" />
      <circle cx="6" cy="26" r="1.1" fill="currentColor" />
      <circle cx="26" cy="26" r="1.1" fill="currentColor" />

      {/* Cartoony exclamation stem — a fat pillar that bulges at the top
          and tapers slightly toward the bottom. The top is a wide rounded
          arch (like a balloon), the bottom is a smaller rounded edge. */}
      <path
        d="M 12 8.5 Q 12 6 16 6 Q 20 6 20 8.5 L 18.5 18 Q 18.5 19.5 16 19.5 Q 13.5 19.5 13.5 18 Z"
        fill="currentColor"
      />

      {/* Fat round exclamation dot — proportionally chunky, sits below
          the stem with a clean gap. */}
      <circle cx="16" cy="23" r="2.5" fill="currentColor" />
    </svg>
  );
}
