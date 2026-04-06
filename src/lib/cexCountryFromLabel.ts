/**
 * Map public name-tags / brand strings (from explorers, scrapes, etc.) to a country signal.
 * Heuristic only — global CEXs get multiple countryHints.
 */
export type InferredCexLabel = {
  country: string;
  countryHints: string[];
  type: "CEX";
};

const RULES: Array<{
  test: (haystack: string) => boolean;
  out: InferredCexLabel;
}> = [
  {
    test: (h) => /\bbitpanda\b/.test(h),
    out: { country: "Austria", countryHints: ["Austria"], type: "CEX" },
  },
  {
    test: (h) => /\bbitstamp\b/.test(h),
    out: { country: "Luxembourg", countryHints: ["Luxembourg", "United Kingdom"], type: "CEX" },
  },
  {
    test: (h) => /\b(kraken|payward)\b/.test(h),
    out: { country: "United States", countryHints: ["United States", "United Kingdom"], type: "CEX" },
  },
  {
    test: (h) => /\bcoinbase\b/.test(h),
    out: { country: "United States", countryHints: ["United States", "Ireland"], type: "CEX" },
  },
  {
    test: (h) => /\bgemini\b/.test(h),
    out: { country: "United States", countryHints: ["United States"], type: "CEX" },
  },
  {
    test: (h) => /\b(binance|bnb\s*chain)\b/.test(h),
    out: {
      country: "Malta",
      countryHints: ["Malta", "France", "Singapore", "United Arab Emirates"],
      type: "CEX",
    },
  },
  {
    test: (h) => /\b(okx|okex)\b/.test(h),
    out: { country: "Seychelles", countryHints: ["Seychelles", "Hong Kong"], type: "CEX" },
  },
  {
    test: (h) => /\bbybit\b/.test(h),
    out: { country: "Singapore", countryHints: ["Singapore", "British Virgin Islands"], type: "CEX" },
  },
  {
    test: (h) => /\b(kucoin|kucoin\s*\d)\b/.test(h),
    out: { country: "Seychelles", countryHints: ["Seychelles"], type: "CEX" },
  },
  {
    test: (h) => /\b(bitfinex|ifinex)\b/.test(h),
    out: { country: "British Virgin Islands", countryHints: ["British Virgin Islands"], type: "CEX" },
  },
  {
    test: (h) => /\b(huobi|htx)\b/.test(h),
    out: { country: "Seychelles", countryHints: ["Seychelles", "Hong Kong"], type: "CEX" },
  },
  {
    test: (h) => /\b(bitmex)\b/.test(h),
    out: { country: "Seychelles", countryHints: ["Seychelles"], type: "CEX" },
  },
  {
    test: (h) => /\b(crypto\.com|monaco\s*tech)\b/.test(h),
    out: { country: "Singapore", countryHints: ["Singapore", "Malta"], type: "CEX" },
  },
  {
    test: (h) => /\b(upbit)\b/.test(h),
    out: { country: "South Korea", countryHints: ["South Korea"], type: "CEX" },
  },
  {
    test: (h) => /\b(bithumb)\b/.test(h),
    out: { country: "South Korea", countryHints: ["South Korea"], type: "CEX" },
  },
  {
    test: (h) => /\bbitbank\b/.test(h),
    out: { country: "Japan", countryHints: ["Japan"], type: "CEX" },
  },
  {
    test: (h) => /\b(bitflyer)\b/.test(h),
    out: { country: "Japan", countryHints: ["Japan"], type: "CEX" },
  },
  {
    test: (h) => /\b(zaif|coincheck)\b/.test(h),
    out: { country: "Japan", countryHints: ["Japan"], type: "CEX" },
  },
  {
    test: (h) => /\b(bitso)\b/.test(h),
    out: { country: "Mexico", countryHints: ["Mexico", "Argentina", "Brazil"], type: "CEX" },
  },
  {
    test: (h) => /\b(mercado\s*bitcoin|mb\s*token)\b/.test(h),
    out: { country: "Brazil", countryHints: ["Brazil"], type: "CEX" },
  },
  {
    test: (h) => /\b(luno)\b/.test(h),
    out: { country: "United Kingdom", countryHints: ["United Kingdom", "Singapore"], type: "CEX" },
  },
  {
    test: (h) => /\bcoinspot\b/.test(h),
    out: { country: "Australia", countryHints: ["Australia"], type: "CEX" },
  },
  {
    test: (h) => /\bindodax\b/.test(h),
    out: { country: "Indonesia", countryHints: ["Indonesia"], type: "CEX" },
  },
  {
    test: (h) => /\bwazirx\b/.test(h),
    out: { country: "India", countryHints: ["India", "Singapore"], type: "CEX" },
  },
  {
    test: (h) => /\bpoloniex\b/.test(h),
    out: { country: "United States", countryHints: ["United States", "global"], type: "CEX" },
  },
  {
    test: (h) => /\byunbi\b/.test(h),
    out: { country: "China", countryHints: ["China"], type: "CEX" },
  },
  {
    test: (h) => /\b(brasil\s*bitcoin)\b/.test(h),
    out: { country: "Brazil", countryHints: ["Brazil"], type: "CEX" },
  },
  {
    test: (h) => /\bnobitex\b/.test(h),
    out: { country: "Iran", countryHints: ["Iran"], type: "CEX" },
  },
  {
    test: (h) => /\b(gmo\s*coin)\b/.test(h),
    out: { country: "Japan", countryHints: ["Japan"], type: "CEX" },
  },
  {
    test: (h) => /\bnewton\b/.test(h),
    out: { country: "Canada", countryHints: ["Canada"], type: "CEX" },
  },
  {
    test: (h) => /\b(revolut)\b/.test(h),
    out: { country: "United Kingdom", countryHints: ["United Kingdom", "Lithuania"], type: "CEX" },
  },
  {
    test: (h) => /\b(robinhood)\b/.test(h),
    out: { country: "United States", countryHints: ["United States"], type: "CEX" },
  },
  {
    test: (h) => /\b(swissborg)\b/.test(h),
    out: { country: "Switzerland", countryHints: ["Switzerland", "Lithuania"], type: "CEX" },
  },
  {
    test: (h) => /\bderibit\b/.test(h),
    out: { country: "Netherlands", countryHints: ["Netherlands"], type: "CEX" },
  },
];

export function inferCexCountryFromLabelPieces(pieces: string[]): InferredCexLabel | null {
  const haystack = pieces
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" ")
    .toLowerCase();
  if (!haystack.trim()) return null;
  for (const { test, out } of RULES) {
    if (test(haystack)) return { ...out, countryHints: [...out.countryHints] };
  }
  return null;
}
