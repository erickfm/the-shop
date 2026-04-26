export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function shortHash(h: string | undefined | null): string {
  if (!h) return "";
  return h.slice(0, 8) + "…" + h.slice(-4);
}

export function basename(p: string): string {
  const seps = ["/", "\\"];
  let i = -1;
  for (const s of seps) {
    const k = p.lastIndexOf(s);
    if (k > i) i = k;
  }
  return i < 0 ? p : p.slice(i + 1);
}
