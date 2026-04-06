import type { LookupResponse } from "@/lib/lookupTypes";

/**
 * Fixed feature vector for supervised country models (export + inference).
 * Keep in sync with `training/train_multicountry.py` (FEATURE_LAYOUT).
 */
export const TRAINING_FEATURE_NAMES: string[] = [
  ...Array.from({ length: 24 }, (_, i) => `hist_${i}`),
  ...Array.from({ length: 5 }, (_, i) => `tz_pct_${i}`),
  ...Array.from({ length: 5 }, (_, i) => `engine_pct_${i}`),
  "timezone_entropy",
  "log1p_unique_cp",
  "log1p_total_tx",
  "wallet_human",
  "wallet_bot",
  "wallet_exchange",
  "wallet_contract",
  "confidence",
  "fallback_used",
  "weekday_share_utc",
  "peak_hour_norm",
  "early_entity_signal_norm",
];

export const TRAINING_FEATURE_DIM = TRAINING_FEATURE_NAMES.length;

export type TrainingFeatureInput = Pick<
  LookupResponse,
  "utcHourHistogram" | "timezoneCandidates" | "walletType" | "confidence" | "totalTxFetched"
> & {
  /** Fused top countries from the engine (same as API `topCountries`). */
  topCountries?: LookupResponse["topCountries"];
  diagnostics?: {
    timezoneEntropy?: number;
    uniqueCounterparties?: number;
    totalTx?: number;
    fallbackUsed?: boolean;
  };
  /** From API `trainingShape` after export; optional for older clients. */
  trainingShape?: LookupResponse["trainingShape"];
};

function walletOneHot(walletType: string | undefined): [number, number, number, number] {
  const w = (walletType ?? "human").toLowerCase();
  return [
    w === "human" ? 1 : 0,
    w === "bot" ? 1 : 0,
    w === "exchange" ? 1 : 0,
    w === "contract" ? 1 : 0,
  ];
}

/**
 * Builds the numeric vector used for ML export and optional learned head at inference.
 */
export function extractTrainingFeatureVector(input: TrainingFeatureInput): number[] {
  const hist = input.utcHourHistogram ?? Array<number>(24).fill(0);
  const h = hist.slice(0, 24);
  while (h.length < 24) h.push(0);
  const histSum = h.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) || 1;
  const histNorm = h.map((x) => (Number.isFinite(x) ? x : 0) / histSum);

  const tz = input.timezoneCandidates ?? [];
  const tz5: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    tz5.push(((tz[i]?.percent ?? 0) as number) / 100);
  }

  const top = input.topCountries ?? [];
  const eng5: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    eng5.push(((top[i]?.percent ?? 0) as number) / 100);
  }

  const d = input.diagnostics ?? {};
  const entropy = typeof d.timezoneEntropy === "number" ? d.timezoneEntropy : 0;
  const ucp = typeof d.uniqueCounterparties === "number" ? d.uniqueCounterparties : 0;
  const totalTx =
    typeof d.totalTx === "number"
      ? d.totalTx
      : typeof input.totalTxFetched === "number"
        ? input.totalTxFetched
        : 0;

  const [wh, wb, we, wc] = walletOneHot(input.walletType);
  const conf = typeof input.confidence === "number" ? input.confidence : 0;
  const fallback = d.fallbackUsed ? 1 : 0;

  const ts = input.trainingShape;
  const weekdayShare =
    typeof ts?.weekdayShare === "number" && Number.isFinite(ts.weekdayShare)
      ? clamp01(ts.weekdayShare)
      : 0.5;
  const peakHourNorm =
    typeof ts?.peakHourNorm === "number" && Number.isFinite(ts.peakHourNorm)
      ? clamp01(ts.peakHourNorm)
      : 0.5;
  const earlyNorm =
    typeof ts?.earlyEntitySignalNorm === "number" && Number.isFinite(ts.earlyEntitySignalNorm)
      ? clamp01(ts.earlyEntitySignalNorm)
      : 0;

  return [
    ...histNorm,
    ...tz5,
    ...eng5,
    entropy,
    Math.log1p(Math.max(0, ucp)) / 10,
    Math.log1p(Math.max(0, totalTx)) / 15,
    wh,
    wb,
    we,
    wc,
    conf,
    fallback,
    weekdayShare,
    peakHourNorm,
    earlyNorm,
  ];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** UTC weekday (Mon–Fri) share + histogram peak hour position for ML / diagnostics. */
export function computeTrainingShapeFromTxs(
  txs: Array<{ timeStamp?: number | null }>,
  utcHourHistogram24: number[]
): { weekdayShare: number; peakHourNorm: number } {
  let wd = 0;
  let tot = 0;
  for (const t of txs) {
    if (t.timeStamp == null || !Number.isFinite(t.timeStamp)) continue;
    tot += 1;
    const day = new Date(t.timeStamp * 1000).getUTCDay();
    if (day >= 1 && day <= 5) wd += 1;
  }
  const weekdayShare = tot > 0 ? wd / tot : 0.5;

  const hist = utcHourHistogram24.slice(0, 24);
  while (hist.length < 24) hist.push(0);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < 24; i += 1) {
    const v = hist[i] ?? 0;
    sum += v;
    if (v > (hist[peak] ?? 0)) peak = i;
  }
  const peakHourNorm = sum > 0 ? peak / 23 : 0.5;
  return { weekdayShare, peakHourNorm };
}

export function extractTrainingFeatureVectorFromResponse(r: LookupResponse): number[] {
  return extractTrainingFeatureVector({
    utcHourHistogram: r.utcHourHistogram,
    timezoneCandidates: r.timezoneCandidates,
    topCountries: r.topCountries ?? r.countryCandidates,
    diagnostics: r.diagnostics,
    totalTxFetched: r.totalTxFetched,
    walletType: r.walletType,
    confidence: r.confidence,
    trainingShape: r.trainingShape,
  });
}
