/// Per-letter mixed-type wordmark, the underground-shop signature.
/// Same DNA as bank's <Logo /> — every glyph runs in a different family
/// with its own slight rotation, so the word reads as hand-set, not
/// rendered. Three families layered: serif (Georgia), sans (system),
/// mono — plus an italic-serif kicker.
export function Wordmark() {
  return (
    <span
      className="select-none inline-flex items-baseline gap-[1px] leading-none"
      aria-label="the shop"
    >
      <Letter family="serif" weight={700} size={20} rotate={-3} dy={1}>
        t
      </Letter>
      <Letter family="sans" weight={500} size={18} rotate={1.5} dy={-1}>
        h
      </Letter>
      <Letter family="mono" weight={600} size={17} rotate={-1} dy={0.5}>
        e
      </Letter>
      <span className="inline-block" style={{ width: 6 }} />
      <Letter family="serif-italic" weight={700} size={19} rotate={2.5} dy={-0.5}>
        s
      </Letter>
      <Letter family="sans" weight={400} size={18} rotate={-1.2} dy={0.5}>
        h
      </Letter>
      <Letter family="serif" weight={700} size={20} rotate={1.8} dy={-1}>
        o
      </Letter>
      <Letter family="mono" weight={600} size={17} rotate={-2.2} dy={1}>
        p
      </Letter>
    </span>
  );
}

function Letter({
  children,
  family,
  weight,
  size,
  rotate,
  dy,
}: {
  children: string;
  family: "serif" | "serif-italic" | "sans" | "mono";
  weight: number;
  size: number;
  rotate: number;
  dy: number;
}) {
  const fontFamily =
    family === "serif" || family === "serif-italic"
      ? "Georgia, 'Times New Roman', serif"
      : family === "mono"
        ? "ui-monospace, 'JetBrains Mono', monospace"
        : "ui-sans-serif, system-ui, -apple-system, Inter, sans-serif";
  return (
    <span
      style={{
        fontFamily,
        fontStyle: family === "serif-italic" ? "italic" : "normal",
        fontWeight: weight,
        fontSize: size,
        transform: `rotate(${rotate}deg) translateY(${dy}px)`,
        display: "inline-block",
      }}
    >
      {children}
    </span>
  );
}
