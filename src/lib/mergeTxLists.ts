/** Dedupe by tx hash (lowercase); keeps first occurrence order. */
export function mergeTxEndpointsDedupe<T extends { hash?: string | null }>(lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const t of list) {
      const h = typeof t.hash === "string" ? t.hash.toLowerCase() : "";
      if (h) {
        if (seen.has(h)) continue;
        seen.add(h);
      }
      out.push(t);
    }
  }
  return out;
}
