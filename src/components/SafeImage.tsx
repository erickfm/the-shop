import { ReactNode, useState } from "react";

/// Image that lazily loads, decodes async, and falls back to `fallback`
/// if the load errors. Built around two webkit2gtk-on-Linux pain points:
///
/// 1. Loading hundreds of `<img>` tags eagerly can trigger
///    "WebKit encountered an internal error... internallyFailedLoadTimerFired"
///    when the loader's task queue overflows. `loading="lazy"` keeps off-screen
///    images from being requested until they scroll near the viewport.
/// 2. A single 403 / expired Patreon CDN URL otherwise leaves a broken-image
///    icon and (in some webkit2gtk builds) wedges the loader for adjacent
///    images. Catching `onError` and swapping to a non-`<img>` fallback
///    short-circuits that path.
export function SafeImage({
  src,
  alt,
  className,
  fallback,
}: {
  src: string;
  alt: string;
  className?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
