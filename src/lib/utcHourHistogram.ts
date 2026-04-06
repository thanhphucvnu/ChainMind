/**
 * Build UTC hour-of-day histograms for timezone inference.
 * - Dedupes by tx hash so the same logical tx isn't triple-counted across lists.
 * - Weights sources: native transfers matter more than token spam for "human hours".
 */

export type TxLike = {
  hash?: string | null;
  timeStamp?: number | null;
  from?: string | null;
  to?: string | null;
};

const SOURCE_WEIGHT = {
  txlist: 1,
  txlistinternal: 0.72,
  tokentx: 0.42,
} as const;

type SourceKey = keyof typeof SOURCE_WEIGHT;

function txDedupeKey(t: TxLike, source: SourceKey): string {
  const h = typeof t.hash === "string" && t.hash.length > 0 ? t.hash.toLowerCase() : "";
  if (h) return h;
  const from = typeof t.from === "string" ? t.from.toLowerCase() : "";
  const to = typeof t.to === "string" ? t.to.toLowerCase() : "";
  const ts = t.timeStamp ?? 0;
  return `${source}:${ts}:${from}:${to}`;
}

function ingestSource(
  map: Map<string, { ts: number; weight: number }>,
  list: TxLike[],
  source: SourceKey
): void {
  const w0 = SOURCE_WEIGHT[source];
  for (const t of list) {
    if (t.timeStamp == null || !Number.isFinite(t.timeStamp)) continue;
    const key = txDedupeKey(t, source);
    const prev = map.get(key);
    if (!prev || w0 > prev.weight) {
      map.set(key, { ts: t.timeStamp, weight: w0 });
    }
  }
}

/** Circular triangular smoothing (reduces single-hour spikes from one-off txs). */
export function smoothCircularHistogram(hist: number[], radius = 1): number[] {
  const n = 24;
  const h = hist.slice(0, n);
  while (h.length < n) h.push(0);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    let wsum = 0;
    for (let d = -radius; d <= radius; d += 1) {
      const j = (i + d + n * 10) % n;
      const kernel = 1 - Math.abs(d) / (radius + 1);
      const v = h[j] ?? 0;
      s += v * kernel;
      wsum += kernel;
    }
    out[i] = wsum > 0 ? s / wsum : 0;
  }
  return out;
}

/**
 * @returns forDiagnostics — deduped weighted counts (entropy / sleep / API body)
 * @returns forTimezone — smoothed copy for offset scoring
 */
export function buildUtcHourHistogram(args: {
  txs: TxLike[];
  internalTxs: TxLike[];
  tokenTxs: TxLike[];
  smoothRadius?: number;
}): { forDiagnostics: number[]; forTimezone: number[] } {
  const byKey = new Map<string, { ts: number; weight: number }>();
  ingestSource(byKey, args.txs, "txlist");
  ingestSource(byKey, args.internalTxs, "txlistinternal");
  ingestSource(byKey, args.tokenTxs, "tokentx");

  const forDiagnostics = new Array(24).fill(0);
  for (const { ts, weight } of byKey.values()) {
    const hour = new Date(ts * 1000).getUTCHours();
    forDiagnostics[hour] = (forDiagnostics[hour] ?? 0) + weight;
  }

  const radius = args.smoothRadius ?? 1;
  const forTimezone =
    radius <= 0 ? forDiagnostics.slice() : smoothCircularHistogram(forDiagnostics, radius);

  return { forDiagnostics, forTimezone };
}
