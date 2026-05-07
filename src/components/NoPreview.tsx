import logoUrl from "../assets/logo.png";

/// Placeholder rendered inside a card's preview area when we have no
/// hero image for the skin. Shows a faded, desaturated version of the
/// shop's own logo — reads as an intentional empty state, ties the
/// no-preview surface back to the brand. CharacterBadge (the colored
/// letter circle) is no longer used for this; it stays available for
/// any small-disc cases where it's the right call.
///
/// The CSS filter chain bleaches the source PNG to a quiet
/// near-white grey at low opacity. Same brightness(0)+invert(1) base
/// the header logo uses, just without the warm sepia kick — we want
/// it to recede, not call attention.
export function NoPreview({
  size = "md",
}: {
  /// Match the size of the surrounding card so small carousel
  /// thumbnails don't get a 200px logo and the drawer hero doesn't
  /// get a tiny one.
  size?: "sm" | "md" | "lg";
  /// Accepted but ignored — kept in the API so callers can pass the
  /// character code without a refactor when this changes its mind
  /// again. (No-op for now; the empty state is identical across
  /// characters.)
  characterCode?: string;
}) {
  const px = size === "lg" ? 180 : size === "sm" ? 56 : 110;
  return (
    <div className="flex items-center justify-center px-4">
      <img
        src={logoUrl}
        alt=""
        aria-hidden
        draggable={false}
        className="select-none pointer-events-none"
        style={{
          width: px,
          height: px,
          objectFit: "contain",
          filter: "brightness(0) invert(1) opacity(0.18)",
        }}
      />
    </div>
  );
}
