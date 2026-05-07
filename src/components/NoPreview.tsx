import { characterDisplay } from "../lib/melee";

/// Placeholder rendered inside a card's preview area when we have no
/// hero image for the skin. Used in both the storefront and "my stuff"
/// — replaces the louder `CharacterBadge` (gradient circle with the
/// HAL character code) with quiet typography that reads as
/// "intentionally minimal" rather than "the image failed to load."
///
/// CharacterBadge still renders elsewhere (creator avatars, slot
/// rows) where a tagged colored disc is the right call. This is just
/// the no-preview fallback for hero-image slots.
export function NoPreview({
  characterCode,
  size = "md",
}: {
  characterCode: string;
  /// Match the size of the surrounding card so small carousel
  /// thumbnails don't get a 3xl font and big detail headers don't
  /// get a tiny one.
  size?: "sm" | "md" | "lg";
}) {
  const text =
    size === "lg" ? "text-4xl" : size === "sm" ? "text-lg" : "text-2xl";
  return (
    <div className="flex items-center justify-center px-4 text-center">
      <span className={`heading-display ${text} text-muted/40 leading-tight`}>
        {characterDisplay(characterCode) || "no preview"}
      </span>
    </div>
  );
}
