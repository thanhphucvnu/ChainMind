import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getAddress, isAddress } from "ethers";
import { z } from "zod";
import entitiesRaw from "@/data/entities.json";
import entityLabelsRaw from "@/data/entityLabels.json";
import { getEntitiesMap } from "@/lib/entities";
import type { CountryCandidate, CountryGuessCandidate, LookupResponse } from "@/lib/lookupTypes";
import {
  blendEngineWithLearned,
  getLearnedCountryModel,
  predictLearnedCountryProbs,
} from "@/lib/learnedCountryModel";
import type { TrainingFeatureInput } from "@/lib/trainingFeatures";
import { earlyLabeledCountryCandidates } from "@/lib/earlyLabeledSignal";
import { mergeTxEndpointsDedupe } from "@/lib/mergeTxLists";
import { buildUtcHourHistogram } from "@/lib/utcHourHistogram";
import { computeTrainingShapeFromTxs } from "@/lib/trainingFeatures";
import { hourHistogramToTimezoneCandidates } from "@/lib/timezone";
import { timezoneCandidatesToCountryCandidates } from "@/lib/countryFromTimezone";
import { priorToCountryCandidates } from "@/lib/countryPrior";
import { resolveChronologicalNamedCounterparty } from "@/lib/chronologicalExchangeScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Đổi khi entities.json / entityLabels.json thay đổi → cache lookup không dùng bản cũ (TTL 10 phút). */
const ENTITY_DATA_FINGERPRINT = createHash("sha256")
  .update(
    JSON.stringify({
      e: entitiesRaw,
      l: entityLabelsRaw,
    })
  )
  .digest("hex")
  .slice(0, 16);

const LookupSchema = z.object({
  address: z.string().min(2),
  maxTx: z.number().int().positive().max(2000).optional(),
});

type ChainConfig = {
  keyEnv: string;
  name: string;
  apiBase: string;
  chainId: string;
};

// Ethereum + optional extra EVM chainids on the same Etherscan API v2 key.
const ETHERSCAN: ChainConfig = {
  name: "ethereum",
  keyEnv: "ETHERSCAN_API_KEY",
  apiBase: "https://api.etherscan.io/v2/api",
  chainId: "1",
};

function parseExtraEvmChainIds(): string[] {
  const raw = process.env.LOOKUP_EXTRA_CHAIN_IDS?.trim();
  if (!raw) return [];
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const cap = envNum("LOOKUP_EXTRA_CHAIN_MAX", 3, 0, 8);
  return [...new Set(parts)].filter((id) => id !== "1" && id.length > 0).slice(0, cap);
}

const cache = new Map<
  string,
  { expiresAt: number; value: LookupResponse; cachedAt: number }
>();

const neighborTxCache = new Map<
  string,
  { expiresAt: number; value: EtherscanFetchResult; cachedAt: number }
>();

type TxEndpoint = {
  hash?: string | null;
  from?: string | null;
  to?: string | null;
  timeStamp?: number | null;
  tokenSymbol?: string | null;
  tokenDecimal?: number | null;
  valueRaw?: string | null;
};
type EtherscanAction = "txlist" | "txlistinternal" | "tokentx";
type EtherscanFetchResult = {
  txs: TxEndpoint[];
  ok: boolean;
  status?: string;
  message?: string;
  resultType?: string;
  note?: string;
};

type GraphCounterparty = {
  address: string; // lowercase normalized
  txCount: number;
  weight: number;
};

function envNum(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  let v = n;
  if (typeof min === "number" && v < min) v = min;
  if (typeof max === "number" && v > max) v = max;
  return v;
}

type LookupConfig = {
  oneHopTopN: number;
  oneHopMinTxCount: number;
  uiOneHopTopN: number;
  twoHopInputTopN: number;
  twoHopMaxNeighbors: number;
  twoHopMaxMillis: number;
  twoHopNeighborOffset: number;
  twoHopWeight: number;
  neighborCacheTtlMs: number;
  priorEntropyCutoff: number;
  priorLowTxCutoff: number;
  priorAlphaVeryLowTx: number;
  priorAlphaLowTx: number;
  priorVeryLowTxCutoff: number;
};

const PROFILE_DEFAULTS: Record<"safe" | "balanced" | "aggressive", LookupConfig> = {
  safe: {
    oneHopTopN: 60,
    oneHopMinTxCount: 3,
    uiOneHopTopN: 10,
    twoHopInputTopN: 12,
    twoHopMaxNeighbors: 4,
    twoHopMaxMillis: 4500,
    twoHopNeighborOffset: 40,
    twoHopWeight: 0.3,
    neighborCacheTtlMs: 1000 * 60 * 10,
    priorEntropyCutoff: 0.84,
    priorLowTxCutoff: 35,
    priorAlphaVeryLowTx: 0.65,
    priorAlphaLowTx: 0.45,
    priorVeryLowTxCutoff: 14,
  },
  balanced: {
    oneHopTopN: 80,
    oneHopMinTxCount: 2,
    uiOneHopTopN: 12,
    twoHopInputTopN: 20,
    twoHopMaxNeighbors: 6,
    twoHopMaxMillis: 6500,
    twoHopNeighborOffset: 60,
    twoHopWeight: 0.45,
    neighborCacheTtlMs: 1000 * 60 * 5,
    priorEntropyCutoff: 0.88,
    priorLowTxCutoff: 25,
    priorAlphaVeryLowTx: 0.55,
    priorAlphaLowTx: 0.35,
    priorVeryLowTxCutoff: 10,
  },
  aggressive: {
    oneHopTopN: 110,
    oneHopMinTxCount: 1,
    uiOneHopTopN: 15,
    twoHopInputTopN: 30,
    twoHopMaxNeighbors: 10,
    twoHopMaxMillis: 11000,
    twoHopNeighborOffset: 90,
    twoHopWeight: 0.6,
    neighborCacheTtlMs: 1000 * 60 * 3,
    priorEntropyCutoff: 0.92,
    priorLowTxCutoff: 18,
    priorAlphaVeryLowTx: 0.45,
    priorAlphaLowTx: 0.28,
    priorVeryLowTxCutoff: 8,
  },
};

function buildLookupConfig(): LookupConfig {
  const rawProfile = (process.env.LOOKUP_PROFILE ?? "balanced").toLowerCase();
  const profile: "safe" | "balanced" | "aggressive" =
    rawProfile === "safe" || rawProfile === "aggressive" ? rawProfile : "balanced";
  const base = PROFILE_DEFAULTS[profile];

  return {
    oneHopTopN: envNum("LOOKUP_ONE_HOP_TOP_N", base.oneHopTopN, 10, 300),
    oneHopMinTxCount: envNum("LOOKUP_ONE_HOP_MIN_TX_COUNT", base.oneHopMinTxCount, 1, 20),
    uiOneHopTopN: envNum("LOOKUP_UI_ONE_HOP_TOP_N", base.uiOneHopTopN, 5, 30),
    twoHopInputTopN: envNum("LOOKUP_TWO_HOP_INPUT_TOP_N", base.twoHopInputTopN, 5, 80),
    twoHopMaxNeighbors: envNum("LOOKUP_TWO_HOP_MAX_NEIGHBORS", base.twoHopMaxNeighbors, 1, 20),
    twoHopMaxMillis: envNum("LOOKUP_TWO_HOP_MAX_MILLIS", base.twoHopMaxMillis, 1000, 20000),
    twoHopNeighborOffset: envNum(
      "LOOKUP_TWO_HOP_NEIGHBOR_OFFSET",
      base.twoHopNeighborOffset,
      20,
      300
    ),
    twoHopWeight: envNum("LOOKUP_TWO_HOP_WEIGHT", base.twoHopWeight, 0, 1.5),
    neighborCacheTtlMs: envNum(
      "LOOKUP_NEIGHBOR_CACHE_TTL_MS",
      base.neighborCacheTtlMs,
      10000,
      1000 * 60 * 60
    ),
    priorEntropyCutoff: envNum(
      "LOOKUP_PRIOR_ENTROPY_CUTOFF",
      base.priorEntropyCutoff,
      0.6,
      0.99
    ),
    priorLowTxCutoff: envNum("LOOKUP_PRIOR_LOW_TX_CUTOFF", base.priorLowTxCutoff, 5, 200),
    priorAlphaVeryLowTx: envNum(
      "LOOKUP_PRIOR_ALPHA_VERY_LOW_TX",
      base.priorAlphaVeryLowTx,
      0,
      1
    ),
    priorAlphaLowTx: envNum("LOOKUP_PRIOR_ALPHA_LOW_TX", base.priorAlphaLowTx, 0, 1),
    priorVeryLowTxCutoff: envNum(
      "LOOKUP_PRIOR_VERY_LOW_TX_CUTOFF",
      base.priorVeryLowTxCutoff,
      1,
      100
    ),
  };
}

const CFG = buildLookupConfig();

function typeWeight(t?: string): number {
  switch (t) {
    case "CEX":
      return 1.25;
    case "BRIDGE":
      return 1.15;
    case "DEX":
      return 1.05;
    case "MIXER":
      return 1.3;
    case "LENDING":
      return 1.05;
    default:
      return 1.0;
  }
}

function buildOneHopGraph(args: {
  targetLower: string;
  txEndpoints: Array<{ from?: string | null; to?: string | null }>;
  topN?: number;
  minTxCount?: number;
}): { top: GraphCounterparty[]; nodes: number; edges: number } {
  const topN = args.topN ?? CFG.oneHopTopN;
  const minTxCount = args.minTxCount ?? CFG.oneHopMinTxCount;

  const countByCp = new Map<string, number>();
  for (const t of args.txEndpoints) {
    const from = typeof t.from === "string" ? t.from.toLowerCase() : "";
    const to = typeof t.to === "string" ? t.to.toLowerCase() : "";
    if (!from || !to) continue;
    if (from === args.targetLower && to !== args.targetLower) {
      countByCp.set(to, (countByCp.get(to) ?? 0) + 1);
    } else if (to === args.targetLower && from !== args.targetLower) {
      countByCp.set(from, (countByCp.get(from) ?? 0) + 1);
    }
  }

  const ranked = Array.from(countByCp.entries())
    .map(([address, txCount]) => ({ address, txCount, weight: txCount }))
    .filter((x) => x.txCount >= minTxCount)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, topN);

  const nodes = 1 + ranked.length;
  const edges = ranked.reduce((acc, x) => acc + x.txCount, 0);
  return { top: ranked, nodes, edges };
}

function mixCountryDistributions(args: {
  a: CountryGuessCandidate[];
  b: CountryGuessCandidate[];
  alpha: number; // fraction of b (prior)
  topK?: number;
}): CountryGuessCandidate[] {
  const topK = args.topK ?? 5;
  const alpha = clamp01(args.alpha);
  const eps = 1e-9;

  const aMap = new Map(args.a.map((x) => [x.country, x.percent / 100]));
  const bMap = new Map(args.b.map((x) => [x.country, x.percent / 100]));

  const all = new Set<string>();
  for (const k of aMap.keys()) all.add(k);
  for (const k of bMap.keys()) all.add(k);

  const rows: CountryGuessCandidate[] = [];
  for (const country of all) {
    const pa = aMap.get(country) ?? eps;
    const pb = bMap.get(country) ?? eps;
    const p = (1 - alpha) * pa + alpha * pb;
    const ref = args.a.find((x) => x.country === country);
    rows.push({
      country,
      offsetHours: ref?.offsetHours ?? 0,
      timezoneLabel: ref?.timezoneLabel ?? "Prior",
      score: p,
      percent: p * 100,
    });
  }

  rows.sort((x, y) => y.percent - x.percent);
  const top = rows.slice(0, topK);
  const sum = top.reduce((acc, r) => acc + r.percent, 0) || 1;
  return top.map((r) => ({ ...r, percent: (r.percent / sum) * 100 }));
}

function blendCountrySignals(
  timezoneCountries: CountryGuessCandidate[],
  labelCountries: CountryCandidate[],
  topK = 5
): { countryCandidates: CountryGuessCandidate[]; bestCountry: CountryGuessCandidate | null } {
  const scoreByCountry = new Map<string, number>();
  const tzRefByCountry = new Map<string, { offsetHours: number; timezoneLabel: string }>();

  // Base signal from timezone (always present with fallback).
  for (const c of timezoneCountries) {
    scoreByCountry.set(c.country, (scoreByCountry.get(c.country) ?? 0) + c.percent);
    if (!tzRefByCountry.has(c.country)) {
      tzRefByCountry.set(c.country, {
        offsetHours: c.offsetHours,
        timezoneLabel: c.timezoneLabel,
      });
    }
  }

  // Boost with on-chain labeled counterparties when available (stronger signal).
  // Label signal contributes up to +70 score points.
  for (const c of labelCountries) {
    const boost = c.percent * 0.7;
    scoreByCountry.set(c.country, (scoreByCountry.get(c.country) ?? 0) + boost);
    if (!tzRefByCountry.has(c.country)) {
      tzRefByCountry.set(c.country, { offsetHours: 0, timezoneLabel: "Label signal" });
    }
  }

  const ranked = Array.from(scoreByCountry.entries())
    .map(([country, score]) => {
      const ref = tzRefByCountry.get(country) ?? { offsetHours: 0, timezoneLabel: "UTC+0" };
      return {
        country,
        score,
        offsetHours: ref.offsetHours,
        timezoneLabel: ref.timezoneLabel,
        percent: 0,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const sum = ranked.reduce((acc, c) => acc + c.score, 0) || 1;
  const countryCandidates = ranked.map((c) => ({
    ...c,
    percent: (c.score / sum) * 100,
  }));

  return {
    countryCandidates,
    bestCountry: countryCandidates.length ? countryCandidates[0] : null,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function normalizedEntropy24(hist: number[]): number {
  const h = hist.slice(0, 24);
  while (h.length < 24) h.push(0);
  const total = h.reduce((a, b) => a + b, 0);
  if (total <= 0) return 1;
  let ent = 0;
  for (const c of h) {
    if (c <= 0) continue;
    const p = c / total;
    ent -= p * Math.log(p);
  }
  return clamp01(ent / Math.log(24));
}

function maxConsecutiveSleepHours(hist: number[]): number {
  const h = hist.slice(0, 24);
  while (h.length < 24) h.push(0);
  const total = h.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const avg = total / 24;
  const threshold = avg * 0.35;
  let best = 0;
  let cur = 0;
  for (let i = 0; i < 48; i += 1) {
    const v = h[i % 24] ?? 0;
    if (v <= threshold) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return Math.min(best, 24);
}

function classifyWalletType(args: {
  totalTx: number;
  uniqueCounterparties: number;
  timezoneEntropy: number;
  sleepHours: number;
  totalMatchedEntities: number;
  isContractLike: boolean;
}): { walletType: "human" | "bot" | "exchange" | "contract"; score: number } {
  if (args.isContractLike) return { walletType: "contract", score: 0.95 };
  if (args.totalMatchedEntities >= 20 || args.uniqueCounterparties >= 150) {
    return { walletType: "exchange", score: 0.8 };
  }
  if (args.totalTx >= 80 && args.timezoneEntropy > 0.9 && args.sleepHours < 3) {
    return { walletType: "bot", score: 0.75 };
  }
  return { walletType: "human", score: 0.7 };
}

function baseWeightsByWalletType(
  walletType: "human" | "bot" | "exchange" | "contract"
): { timezone: number; counterparty: number; token: number; protocol: number } {
  switch (walletType) {
    case "bot":
      return { timezone: 0.12, counterparty: 0.33, token: 0.30, protocol: 0.25 };
    case "exchange":
      return { timezone: 0.08, counterparty: 0.56, token: 0.22, protocol: 0.14 };
    case "contract":
      return { timezone: 0.05, counterparty: 0.45, token: 0.30, protocol: 0.20 };
    case "human":
    default:
      return { timezone: 0.45, counterparty: 0.30, token: 0.15, protocol: 0.10 };
  }
}

function reliabilityFromVolume(n: number, ref = 120): number {
  if (n <= 0) return 0;
  return clamp01(Math.log(1 + n) / Math.log(1 + ref));
}

function normalizeWeights(w: { timezone: number; counterparty: number; token: number; protocol: number }) {
  const s = w.timezone + w.counterparty + w.token + w.protocol;
  if (s <= 0) return { timezone: 0.25, counterparty: 0.25, token: 0.25, protocol: 0.25 };
  return {
    timezone: w.timezone / s,
    counterparty: w.counterparty / s,
    token: w.token / s,
    protocol: w.protocol / s,
  };
}

function fuseCountriesProbabilistically(args: {
  timezoneCountries: CountryGuessCandidate[];
  counterpartyCountries: CountryCandidate[];
  tokenCountries?: CountryGuessCandidate[];
  protocolCountries?: CountryGuessCandidate[];
  signalWeights: { timezone: number; counterparty: number; token: number; protocol: number };
  topK?: number;
}): { topCountries: CountryGuessCandidate[]; bestCountry: CountryGuessCandidate | null } {
  const topK = args.topK ?? 5;
  const all = new Set<string>();
  for (const c of args.timezoneCountries) all.add(c.country);
  for (const c of args.counterpartyCountries) all.add(c.country);
  for (const c of args.tokenCountries ?? []) all.add(c.country);
  for (const c of args.protocolCountries ?? []) all.add(c.country);
  if (all.size === 0) all.add("United States");

  const eps = 1e-6;
  const tzP = new Map(args.timezoneCountries.map((c) => [c.country, c.percent / 100]));
  const cpP = new Map(args.counterpartyCountries.map((c) => [c.country, c.percent / 100]));
  const tkP = new Map((args.tokenCountries ?? []).map((c) => [c.country, c.percent / 100]));
  const prP = new Map((args.protocolCountries ?? []).map((c) => [c.country, c.percent / 100]));

  const rows: CountryGuessCandidate[] = [];
  for (const country of all) {
    const pTz = Math.max(eps, tzP.get(country) ?? eps);
    const pCp = Math.max(eps, cpP.get(country) ?? eps);
    const pToken = Math.max(eps, tkP.get(country) ?? eps);
    const pProtocol = Math.max(eps, prP.get(country) ?? eps);
    const logScore =
      args.signalWeights.timezone * Math.log(pTz) +
      args.signalWeights.counterparty * Math.log(pCp) +
      args.signalWeights.token * Math.log(pToken) +
      args.signalWeights.protocol * Math.log(pProtocol);

    const ref = args.timezoneCountries.find((x) => x.country === country);
    rows.push({
      country,
      offsetHours: ref?.offsetHours ?? 0,
      timezoneLabel: ref?.timezoneLabel ?? "Prior",
      score: logScore,
      percent: 0,
    });
  }

  rows.sort((a, b) => b.score - a.score);
  const top = rows.slice(0, topK);
  // softmax on log-score (stable)
  const maxLog = Math.max(...top.map((x) => x.score));
  const exps = top.map((x) => Math.exp(x.score - maxLog));
  const sumExp = exps.reduce((a, b) => a + b, 0) || 1;
  const ranked = top.map((x, i) => ({
    ...x,
    percent: (exps[i] / sumExp) * 100,
  }));

  return {
    topCountries: ranked,
    bestCountry: ranked.length ? ranked[0] : null,
  };
}

function buildCountryGuessFromMap(
  scoreMap: Map<string, number>,
  timezoneLabel: string,
  topK = 5
): CountryGuessCandidate[] {
  const rows = Array.from(scoreMap.entries())
    .map(([country, score]) => ({
      country,
      offsetHours: 0,
      timezoneLabel,
      score,
      percent: 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  const sum = rows.reduce((acc, r) => acc + r.score, 0) || 1;
  return rows.map((r) => ({ ...r, percent: (r.score / sum) * 100 }));
}

function tokenSignalCandidates(tokenTxs: TxEndpoint[]): CountryGuessCandidate[] {
  const tokenCountryBias: Record<string, Record<string, number>> = {
    USDT: { Vietnam: 0.26, Thailand: 0.19, Indonesia: 0.15, Philippines: 0.12, Turkey: 0.1 },
    USDC: {
      "United States": 0.28,
      "United Kingdom": 0.1,
      Germany: 0.08,
      France: 0.08,
      Canada: 0.08,
    },
    DAI: { "United States": 0.18, Germany: 0.1, France: 0.08, "United Kingdom": 0.08 },
  };
  const score = new Map<string, number>();
  for (const t of tokenTxs) {
    const sym = typeof t.tokenSymbol === "string" ? t.tokenSymbol.toUpperCase().trim() : "";
    if (!sym || !tokenCountryBias[sym]) continue;
    const bias = tokenCountryBias[sym];
    for (const [country, w] of Object.entries(bias)) {
      score.set(country, (score.get(country) ?? 0) + w);
    }
  }
  return buildCountryGuessFromMap(score, "Token bias", 5);
}

function protocolSignalCandidates(args: {
  targetLower: string;
  txEndpoints: Array<{ from?: string | null; to?: string | null }>;
  entitiesMap: Map<string, { name?: string; country?: string; countryHints?: string[]; type?: string }>;
}): CountryGuessCandidate[] {
  const protoBiasByName: Array<{ key: string; countries: Record<string, number> }> = [
    { key: "pancakeswap", countries: { Vietnam: 0.28, Thailand: 0.24, Indonesia: 0.2 } },
    { key: "uniswap", countries: { "United States": 0.24, "United Kingdom": 0.14, Germany: 0.1 } },
    { key: "klaytn", countries: { "South Korea": 0.42 } },
    { key: "upbit", countries: { "South Korea": 0.5 } },
    { key: "wormhole", countries: { "United States": 0.15, Singapore: 0.12 } },
  ];

  const graph = buildOneHopGraph({
    targetLower: args.targetLower,
    txEndpoints: args.txEndpoints,
    topN: 100,
    minTxCount: 1,
  });
  const score = new Map<string, number>();
  for (const cp of graph.top) {
    const ent = args.entitiesMap.get(cp.address);
    if (!ent?.name) continue;
    const name = ent.name.toLowerCase();
    for (const p of protoBiasByName) {
      if (!name.includes(p.key)) continue;
      for (const [country, w] of Object.entries(p.countries)) {
        score.set(country, (score.get(country) ?? 0) + w * cp.weight);
      }
    }
  }
  return buildCountryGuessFromMap(score, "Protocol bias", 5);
}

function calibratedConfidence(args: {
  topCountries: CountryGuessCandidate[];
  reliabilities: { timezone: number; counterparty: number; token: number; protocol: number };
  walletTypeScore: number;
  totalTx: number;
}): number {
  const p1 = (args.topCountries[0]?.percent ?? 0) / 100;
  const p2 = (args.topCountries[1]?.percent ?? 0) / 100;
  const margin = clamp01(p1 - p2);
  const vol = reliabilityFromVolume(args.totalTx, 200);
  const rel =
    (args.reliabilities.timezone +
      args.reliabilities.counterparty +
      args.reliabilities.token +
      args.reliabilities.protocol) /
    4;

  const raw = 0.4 * margin + 0.25 * vol + 0.25 * rel + 0.1 * clamp01(args.walletTypeScore);
  return clamp01(raw);
}

function computeCandidates(
  targetLower: string,
  txEndpoints: Array<{ from?: string | null; to?: string | null }>,
  entitiesMap: Map<
    string,
    {
      address: string;
      country: string;
      name?: string;
      type?: "CEX" | "DEX" | "BRIDGE" | "MIXER" | "LENDING" | "GAMING" | "PAYMENT" | "OTHER";
      countryHints?: string[];
    }
  >
): { candidates: CountryCandidate[]; bestCandidate: CountryCandidate | null; totalMatchedEntities: number } {
  // Graph-weighted 1-hop scoring:
  // - only direct counterparties of target
  // - weight by interaction frequency (txCount)
  // - amplify by entity type; distribute score across countryHints if present
  const graph = buildOneHopGraph({ targetLower, txEndpoints, topN: 80, minTxCount: 2 });

  const byCountry = new Map<
    string,
    {
      weight: number;
      entities: Map<
        string,
        {
          address: string;
          name?: string;
          type?: "CEX" | "DEX" | "BRIDGE" | "MIXER" | "LENDING" | "GAMING" | "PAYMENT" | "OTHER";
        }
      >;
    }
  >();

  let totalMatchedEntities = 0;
  for (const cp of graph.top) {
    const ent = entitiesMap.get(cp.address);
    if (!ent) continue;

    const hints =
      Array.isArray(ent.countryHints) && ent.countryHints.length
        ? ent.countryHints
        : [ent.country];
    const w = cp.weight * typeWeight(ent.type);
    const perHint = w / (hints.length || 1);

    totalMatchedEntities += cp.txCount;
    for (const country of hints) {
      const key = typeof country === "string" ? country.trim() : "";
      if (!key) continue;

      let b = byCountry.get(key);
      if (!b) {
        b = { weight: 0, entities: new Map() };
        byCountry.set(key, b);
      }
      b.weight += perHint;

      const entKey = ent.address.toLowerCase();
      if (!b.entities.has(entKey)) {
        b.entities.set(entKey, { address: ent.address, name: ent.name, type: ent.type });
      }
    }
  }

  const totalWeight = Array.from(byCountry.values()).reduce((acc, v) => acc + v.weight, 0);
  const candidates: CountryCandidate[] = Array.from(byCountry.entries())
    .map(([country, v]) => ({
      country,
      count: Math.round(v.weight),
      percent: totalWeight ? (v.weight / totalWeight) * 100 : 0,
      entities: Array.from(v.entities.values()).slice(0, 8),
    }))
    .sort((a, b) => b.percent - a.percent);

  return { candidates, bestCandidate: candidates.length ? candidates[0] : null, totalMatchedEntities };
}

function mergeCountryCandidates(
  oneHop: CountryCandidate[],
  twoHop: CountryCandidate[],
  twoHopWeight = 0.45
): CountryCandidate[] {
  const byCountry = new Map<string, { score: number; entities: Map<string, { address: string; name?: string }> }>();

  for (const c of oneHop) {
    const row = byCountry.get(c.country) ?? { score: 0, entities: new Map() };
    row.score += c.percent;
    for (const e of c.entities) row.entities.set(e.address.toLowerCase(), { address: e.address, name: e.name });
    byCountry.set(c.country, row);
  }
  for (const c of twoHop) {
    const row = byCountry.get(c.country) ?? { score: 0, entities: new Map() };
    row.score += c.percent * twoHopWeight;
    for (const e of c.entities) row.entities.set(e.address.toLowerCase(), { address: e.address, name: e.name });
    byCountry.set(c.country, row);
  }

  const rows = Array.from(byCountry.entries())
    .map(([country, v]) => ({
      country,
      count: Math.round(v.score),
      percent: v.score,
      entities: Array.from(v.entities.values()).slice(0, 8),
    }))
    .sort((a, b) => b.percent - a.percent);

  const sum = rows.reduce((acc, r) => acc + r.percent, 0) || 1;
  return rows.map((r) => ({ ...r, percent: (r.percent / sum) * 100 }));
}

async function computeTwoHopCandidates(args: {
  targetLower: string;
  apiKey: string;
  oneHopTop: GraphCounterparty[];
  entitiesMap: Map<
    string,
    {
      address: string;
      country: string;
      name?: string;
      type?: "CEX" | "DEX" | "BRIDGE" | "MIXER" | "LENDING" | "GAMING" | "PAYMENT" | "OTHER";
      countryHints?: string[];
    }
  >;
  maxNeighbors?: number;
  maxMillis?: number;
}): Promise<{
  candidates: CountryCandidate[];
  scannedNeighbors: number;
  used: boolean;
  skippedReason?: string;
  topEntities: Array<{
    address: string;
    name?: string;
    type?: "CEX" | "DEX" | "BRIDGE" | "MIXER" | "LENDING" | "GAMING" | "PAYMENT" | "OTHER";
    countryHints?: string[];
    score: number;
  }>;
}> {
  const byCountry = new Map<string, { score: number; entities: Map<string, { address: string; name?: string }> }>();
  const byEntity = new Map<
    string,
    {
      address: string;
      name?: string;
      type?: "CEX" | "DEX" | "BRIDGE" | "MIXER" | "LENDING" | "GAMING" | "PAYMENT" | "OTHER";
      countryHints?: string[];
      score: number;
    }
  >();
  const topNeighbors = args.oneHopTop.slice(0, args.maxNeighbors ?? CFG.twoHopMaxNeighbors);
  const startedAt = Date.now();
  let scannedNeighbors = 0;
  let failCount = 0;

  for (const n of topNeighbors) {
    if (Date.now() - startedAt > (args.maxMillis ?? CFG.twoHopMaxMillis)) {
      return {
        candidates: [],
        scannedNeighbors,
        used: false,
        skippedReason: "two-hop time budget exceeded",
        topEntities: [],
      };
    }
    const res = await fetchEtherscanFamilyTxListCached({
      apiBase: ETHERSCAN.apiBase,
      chainId: ETHERSCAN.chainId,
      apiKey: args.apiKey,
      address: n.address,
      offset: CFG.twoHopNeighborOffset,
      action: "txlist",
      ttlMs: CFG.neighborCacheTtlMs,
    });
    if (!res.ok) {
      failCount += 1;
      if (failCount >= 2) {
        return {
          candidates: [],
          scannedNeighbors,
          used: false,
          skippedReason: "two-hop limited by explorer errors/rate-limit",
          topEntities: [],
        };
      }
      continue;
    }
    if (!res.txs.length) continue;
    scannedNeighbors += 1;

    const secondCounterparties = new Map<string, number>();
    for (const t of res.txs) {
      const from = typeof t.from === "string" ? t.from.toLowerCase() : "";
      const to = typeof t.to === "string" ? t.to.toLowerCase() : "";
      if (!from || !to) continue;
      if (from === n.address && to !== args.targetLower) {
        secondCounterparties.set(to, (secondCounterparties.get(to) ?? 0) + 1);
      } else if (to === n.address && from !== args.targetLower) {
        secondCounterparties.set(from, (secondCounterparties.get(from) ?? 0) + 1);
      }
    }

    for (const [addr, cnt] of secondCounterparties.entries()) {
      const ent = args.entitiesMap.get(addr);
      if (!ent) continue;
      const hints = ent.countryHints?.length ? ent.countryHints : [ent.country];
      const score = cnt * typeWeight(ent.type) * Math.max(1, n.weight * 0.2);
      const perHint = score / (hints.length || 1);

      const entKey = ent.address.toLowerCase();
      const prevEnt = byEntity.get(entKey);
      if (!prevEnt) {
        byEntity.set(entKey, {
          address: ent.address,
          name: ent.name,
          type: ent.type,
          countryHints: hints,
          score,
        });
      } else {
        prevEnt.score += score;
      }

      for (const country of hints) {
        const key = country.trim();
        if (!key) continue;
        const row = byCountry.get(key) ?? { score: 0, entities: new Map() };
        row.score += perHint;
        row.entities.set(ent.address.toLowerCase(), { address: ent.address, name: ent.name });
        byCountry.set(key, row);
      }
    }
  }

  const rows = Array.from(byCountry.entries())
    .map(([country, v]) => ({
      country,
      count: Math.round(v.score),
      percent: v.score,
      entities: Array.from(v.entities.values()).slice(0, 8),
    }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 8);
  const sum = rows.reduce((acc, r) => acc + r.percent, 0) || 1;
  const candidates = rows.map((r) => ({ ...r, percent: (r.percent / sum) * 100 }));
  const topEntities = Array.from(byEntity.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  return {
    candidates,
    scannedNeighbors,
    used: candidates.length > 0,
    skippedReason: candidates.length ? undefined : "two-hop produced no labeled signal",
    topEntities,
  };
}

async function fetchEtherscanFamilyTxList(args: {
  apiBase: string;
  chainId: string;
  apiKey: string;
  address: string;
  offset: number;
  action?: EtherscanAction;
  sort?: "asc" | "desc";
}): Promise<EtherscanFetchResult> {
  const url = new URL(args.apiBase);
  url.searchParams.set("chainid", args.chainId);
  url.searchParams.set("module", "account");
  url.searchParams.set("action", args.action ?? "txlist");
  url.searchParams.set("address", args.address);
  url.searchParams.set("startblock", "0");
  url.searchParams.set("endblock", "99999999");
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(args.offset));
  url.searchParams.set("sort", args.sort ?? "desc");
  url.searchParams.set("apikey", args.apiKey);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    return {
      txs: [],
      ok: false,
      status: String(res.status),
      message: "HTTP error from Etherscan",
      resultType: "http_error",
      note: `status=${res.status}`,
    };
  }

  type ExplorerResponse = { status?: string; message?: string; result?: unknown };
  const data = (await res.json().catch(() => null)) as ExplorerResponse | null;
  const result = data?.result;
  if (!Array.isArray(result)) {
    const resultType =
      result === null
        ? "null"
        : result === undefined
          ? "undefined"
          : Array.isArray(result)
            ? "array"
            : typeof result;
    const asString = typeof result === "string" ? result : "";
    const lower = asString.toLowerCase();
    const noTx =
      lower.includes("no transactions found") ||
      lower.includes("no records found");
    return {
      txs: [],
      ok: noTx,
      status: data?.status,
      message: data?.message,
      resultType,
      note: asString || undefined,
    };
  }

  const txs = (result as unknown[]).map((tx) => {
    if (!tx || typeof tx !== "object") return { from: null, to: null, timeStamp: null };
    const obj = tx as Record<string, unknown>;

    const tsRaw = obj.timeStamp;
    const ts =
      typeof tsRaw === "string"
        ? Number(tsRaw)
        : typeof tsRaw === "number"
          ? tsRaw
          : null;

    return {
      hash:
        typeof obj.hash === "string"
          ? obj.hash
          : typeof obj.transactionHash === "string"
            ? obj.transactionHash
            : null,
      from: typeof obj.from === "string" ? obj.from : null,
      to: typeof obj.to === "string" ? obj.to : null,
      timeStamp: Number.isFinite(ts) ? ts : null,
      tokenSymbol: typeof obj.tokenSymbol === "string" ? obj.tokenSymbol : null,
      tokenDecimal:
        typeof obj.tokenDecimal === "string"
          ? Number(obj.tokenDecimal)
          : typeof obj.tokenDecimal === "number"
            ? obj.tokenDecimal
            : null,
      valueRaw: typeof obj.value === "string" ? obj.value : null,
    };
  });

  return {
    txs,
    ok: true,
    status: data?.status,
    message: data?.message,
    resultType: "array",
  };
}

async function fetchEtherscanFamilyTxListCached(args: {
  apiBase: string;
  chainId: string;
  apiKey: string;
  address: string;
  offset: number;
  action?: EtherscanAction;
  ttlMs?: number;
}): Promise<EtherscanFetchResult> {
  const ttlMs = args.ttlMs ?? CFG.neighborCacheTtlMs;
  const key = `${args.chainId}:${args.action ?? "txlist"}:${args.address.toLowerCase()}:${args.offset}`;
  const cached = neighborTxCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await fetchEtherscanFamilyTxList({
    apiBase: args.apiBase,
    chainId: args.chainId,
    apiKey: args.apiKey,
    address: args.address,
    offset: args.offset,
    action: args.action,
  });
  neighborTxCache.set(key, { value, cachedAt: Date.now(), expiresAt: Date.now() + ttlMs });
  return value;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = LookupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Payload không hợp lệ. Dạng đúng: { address: string, maxTx?: number }",
      },
      { status: 400 }
    );
  }

  const { address, maxTx } = parsed.data;

  if (!isAddress(address)) {
    return NextResponse.json({ error: "Địa chỉ ví không hợp lệ." }, { status: 400 });
  }

  const targetChecksum = getAddress(address);
  const targetLower = targetChecksum.toLowerCase();

  const entitiesMap = new Map(getEntitiesMap());

  const offset = Math.min(maxTx ?? 200, 2000);
  const extraChainIds = parseExtraEvmChainIds();

  const cacheKey = `${targetLower}:${offset}:xc:${extraChainIds.join("-")}:ed:${ENTITY_DATA_FINGERPRINT}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.value);
  }

  const apiKey = process.env[ETHERSCAN.keyEnv];
  if (!apiKey || typeof apiKey !== "string") {
    return NextResponse.json(
      {
        error:
          "Thiếu biến môi trường `ETHERSCAN_API_KEY`. Vui lòng set key Etherscan rồi redeploy.",
      },
      { status: 500 }
    );
  }

  const [txsResult, internalTxsResult, tokenTxsResult] = await Promise.all([
    fetchEtherscanFamilyTxList({
      apiBase: ETHERSCAN.apiBase,
      chainId: ETHERSCAN.chainId,
      apiKey,
      address: targetChecksum,
      offset,
    }),
    fetchEtherscanFamilyTxList({
      apiBase: ETHERSCAN.apiBase,
      chainId: ETHERSCAN.chainId,
      apiKey,
      address: targetChecksum,
      offset,
      action: "txlistinternal",
    }),
    fetchEtherscanFamilyTxList({
      apiBase: ETHERSCAN.apiBase,
      chainId: ETHERSCAN.chainId,
      apiKey,
      address: targetChecksum,
      offset,
      action: "tokentx",
    }),
  ]);

  let txs = txsResult.txs;
  let internalTxs = internalTxsResult.txs;
  let tokenTxs = tokenTxsResult.txs;

  /** Gộp thêm N giao dịch cũ nhất (sort=asc) để luôn có on-ramp đầu chuỗi dù ví có nhiều tx. */
  const anchorAsc = envNum("LOOKUP_TX_ANCHOR_ASC_OFFSET", 25, 0, 100);
  if (anchorAsc > 0) {
    const anchorN = Math.min(anchorAsc, offset);
    const [ascA, ascB, ascC] = await Promise.all([
      fetchEtherscanFamilyTxList({
        apiBase: ETHERSCAN.apiBase,
        chainId: ETHERSCAN.chainId,
        apiKey,
        address: targetChecksum,
        offset: anchorN,
        sort: "asc",
      }),
      fetchEtherscanFamilyTxList({
        apiBase: ETHERSCAN.apiBase,
        chainId: ETHERSCAN.chainId,
        apiKey,
        address: targetChecksum,
        offset: anchorN,
        action: "txlistinternal",
        sort: "asc",
      }),
      fetchEtherscanFamilyTxList({
        apiBase: ETHERSCAN.apiBase,
        chainId: ETHERSCAN.chainId,
        apiKey,
        address: targetChecksum,
        offset: anchorN,
        action: "tokentx",
        sort: "asc",
      }),
    ]);
    txs = mergeTxEndpointsDedupe([txs, ascA.txs]);
    internalTxs = mergeTxEndpointsDedupe([internalTxs, ascB.txs]);
    tokenTxs = mergeTxEndpointsDedupe([tokenTxs, ascC.txs]);
  }

  const perChainTxFetched: Record<string, number> = {
    [`${ETHERSCAN.name}:txlist`]: txs.length,
    [`${ETHERSCAN.name}:txlistinternal`]: internalTxs.length,
    [`${ETHERSCAN.name}:tokentx`]: tokenTxs.length,
  };

  const extraTxOffset = Math.min(offset, envNum("LOOKUP_EXTRA_CHAIN_TX_OFFSET", 150, 40, 800));
  if (extraChainIds.length > 0) {
    const extraRows = await Promise.all(
      extraChainIds.map(async (chainId) => {
        const [a, b, c] = await Promise.all([
          fetchEtherscanFamilyTxList({
            apiBase: ETHERSCAN.apiBase,
            chainId,
            apiKey,
            address: targetChecksum,
            offset: extraTxOffset,
          }),
          fetchEtherscanFamilyTxList({
            apiBase: ETHERSCAN.apiBase,
            chainId,
            apiKey,
            address: targetChecksum,
            offset: extraTxOffset,
            action: "txlistinternal",
          }),
          fetchEtherscanFamilyTxList({
            apiBase: ETHERSCAN.apiBase,
            chainId,
            apiKey,
            address: targetChecksum,
            offset: extraTxOffset,
            action: "tokentx",
          }),
        ]);
        return { chainId, a, b, c };
      })
    );
    for (const row of extraRows) {
      perChainTxFetched[`chain:${row.chainId}:txlist`] = row.a.txs.length;
      perChainTxFetched[`chain:${row.chainId}:txlistinternal`] = row.b.txs.length;
      perChainTxFetched[`chain:${row.chainId}:tokentx`] = row.c.txs.length;
      txs = mergeTxEndpointsDedupe([txs, row.a.txs]);
      internalTxs = mergeTxEndpointsDedupe([internalTxs, row.b.txs]);
      tokenTxs = mergeTxEndpointsDedupe([tokenTxs, row.c.txs]);
    }
  }

  // Combine all available event types so a wallet with only token/internal activity
  // still gets a prediction instead of "not enough tx".
  const allTx: TxEndpoint[] = [...txs, ...internalTxs, ...tokenTxs];
  const scannedTransactions = [
    ...txs.map((t) => ({ ...t, source: "txlist" as const })),
    ...internalTxs.map((t) => ({ ...t, source: "txlistinternal" as const })),
    ...tokenTxs.map((t) => ({ ...t, source: "tokentx" as const })),
  ]
    .filter((t) => typeof t.hash === "string" && t.hash.length > 0)
    .sort((a, b) => (b.timeStamp ?? 0) - (a.timeStamp ?? 0))
    .slice(0, 120)
    .map((t) => ({
      hash: t.hash as string,
      source: t.source,
      timeStamp: t.timeStamp ?? null,
      from: t.from ?? null,
      to: t.to ?? null,
    }));

  const txEndpoints = allTx.map((t) => ({ from: t.from ?? null, to: t.to ?? null }));

  const { forDiagnostics: utcHourHistogram, forTimezone: utcHourHistogramForTz } =
    buildUtcHourHistogram({
      txs,
      internalTxs,
      tokenTxs,
      smoothRadius: 1,
    });

  const txForShapeAndEarly = mergeTxEndpointsDedupe([txs, internalTxs, tokenTxs]);

  const chronoMaxRaw = envNum("LOOKUP_NAMETAG_CHRONO_MAX", 25, 0, 60);
  const legacyMax = envNum("LOOKUP_NAMETAG_MAX_CALLS", 0, 0, 60);
  const nametagChronoMax = Math.max(chronoMaxRaw, legacyMax);
  const nametagDelay = envNum("LOOKUP_NAMETAG_DELAY_MS", 520, 0, 5000);
  const chronoResult = await resolveChronologicalNamedCounterparty({
    targetLower,
    txs,
    internalTxs,
    tokenTxs,
    entitiesMap,
    apiBase: ETHERSCAN.apiBase,
    chainId: ETHERSCAN.chainId,
    apiKey,
    maxNametagCalls: nametagChronoMax,
    delayMs: nametagDelay,
    maxTxPerType: offset,
  });
  const nametagAugment = { log: chronoResult.nametagLog };
  const firstTransaction = chronoResult.firstTransaction;

  const earlyLabeled = earlyLabeledCountryCandidates({
    targetLower,
    txs: txForShapeAndEarly,
    entitiesMap,
    maxChronologicalTx: envNum("LOOKUP_EARLY_TX_WINDOW", 80, 20, 200),
  });
  const { weekdayShare, peakHourNorm } = computeTrainingShapeFromTxs(
    txForShapeAndEarly,
    utcHourHistogram
  );
  const earlyEntitySignalNorm = Math.min(1, Math.log1p(Math.max(0, earlyLabeled.rawStrength)) / 4);
  const trainingShape = {
    weekdayShare,
    peakHourNorm,
    earlyEntitySignalNorm,
  };

  const timezoneEntropy = normalizedEntropy24(utcHourHistogram);
  const sleepHours = maxConsecutiveSleepHours(utcHourHistogram);

  const timezoneCandidates = hourHistogramToTimezoneCandidates(utcHourHistogramForTz, {
    topK: 5,
    activeStartHourLocal: 8,
    activeEndHourLocal: 23,
    fallbackPrior: false,
  });

  const totalTxFetched = Object.values(perChainTxFetched).reduce((a, b) => a + b, 0);
  // Always return candidates for country prediction.
  // If Etherscan returned txs but timestamps couldn't be used, hourHistogramToTimezoneCandidates()
  // will use fallback prior; if Etherscan returned nothing (rate limit / transient issue),
  // we also still use prior to avoid returning "not enough data" message.
  const timezoneCandidatesWithFallback =
    timezoneCandidates.length
      ? timezoneCandidates
      : hourHistogramToTimezoneCandidates(utcHourHistogram, {
          topK: 5,
          activeStartHourLocal: 8,
          activeEndHourLocal: 23,
          fallbackPrior: true,
        });

  const timezoneCountrySignal = timezoneCandidatesToCountryCandidates(
    timezoneCandidatesWithFallback,
    5
  );

  const countryPrior = priorToCountryCandidates(10);
  // If timezone signal is weak (flat histogram / bot-like) or tx volume is low,
  // blend in a global country prior so we don't overfit to random timezone noise.
  const shouldBlendPrior =
    timezoneEntropy > CFG.priorEntropyCutoff || totalTxFetched < CFG.priorLowTxCutoff;
  const timezoneCountrySignalWithPrior = shouldBlendPrior
    ? mixCountryDistributions({
        a: timezoneCountrySignal.countryCandidates,
        b: countryPrior,
        alpha:
          totalTxFetched < CFG.priorVeryLowTxCutoff
            ? CFG.priorAlphaVeryLowTx
            : CFG.priorAlphaLowTx,
        topK: 5,
      })
    : timezoneCountrySignal.countryCandidates;

  const unlabeledCounterpartiesSet = new Set<string>();
  if (txEndpoints.length) {
    // If entities.json is empty (or missing labels for these counterparties),
    // we still return the counterparties that would need manual labeling.
    for (const tx of txEndpoints) {
      for (const addr of [tx.from, tx.to]) {
        if (!addr || typeof addr !== "string") continue;
        if (!isAddress(addr)) continue;

        const addrLower = addr.toLowerCase();
        if (addrLower === targetLower) continue;
        if (entitiesMap.size > 0 && entitiesMap.has(addrLower)) continue;

        unlabeledCounterpartiesSet.add(getAddress(addr).toLowerCase());
        if (unlabeledCounterpartiesSet.size >= 15) break;
      }
      if (unlabeledCounterpartiesSet.size >= 15) break;
    }
  }

  const { candidates, bestCandidate, totalMatchedEntities } = computeCandidates(
    targetLower,
    txEndpoints,
    entitiesMap
  );
  const oneHopGraphForTwoHop = buildOneHopGraph({
    targetLower,
    txEndpoints,
    topN: CFG.twoHopInputTopN,
    minTxCount: CFG.oneHopMinTxCount,
  });
  const twoHop = await computeTwoHopCandidates({
    targetLower,
    apiKey,
    oneHopTop: oneHopGraphForTwoHop.top,
    entitiesMap,
    maxNeighbors: CFG.twoHopMaxNeighbors,
    maxMillis: CFG.twoHopMaxMillis,
  });
  let mergedCandidates = twoHop.used
    ? mergeCountryCandidates(candidates, twoHop.candidates, CFG.twoHopWeight)
    : candidates;
  if (earlyLabeled.candidates.length > 0) {
    mergedCandidates = mergeCountryCandidates(
      mergedCandidates,
      earlyLabeled.candidates,
      envNum("LOOKUP_EARLY_ENTITY_WEIGHT", 0.48, 0, 1.5)
    );
  }
  const mergedBestCandidate = mergedCandidates.length ? mergedCandidates[0] : bestCandidate;

  const blendedCountrySignal = blendCountrySignals(
    timezoneCountrySignalWithPrior,
    mergedCandidates,
    5
  );

  const uniqueCounterparties = new Set(
    txEndpoints
      .flatMap((t) => [t.from, t.to])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.toLowerCase())
      .filter((x) => x !== targetLower)
  ).size;
  const timezoneReliability = clamp01(
    (1 - timezoneEntropy) * 0.7 + clamp01(sleepHours / 8) * 0.3
  );
  let counterpartyReliability = clamp01(
    reliabilityFromVolume(totalMatchedEntities, 40) * 0.8 +
      clamp01(mergedCandidates.length / 5) * 0.2
  );
  if (earlyLabeled.rawStrength > 0.4) {
    counterpartyReliability = clamp01(counterpartyReliability + 0.07);
  }
  const tokenReliability = clamp01(
    reliabilityFromVolume(perChainTxFetched["ethereum:tokentx"] ?? 0, 80)
  );
  const protocolReliability = clamp01(reliabilityFromVolume(uniqueCounterparties, 100) * 0.4);
  const tokenCountries = tokenSignalCandidates(tokenTxs);
  const protocolCountries = protocolSignalCandidates({
    targetLower,
    txEndpoints,
    entitiesMap: entitiesMap as Map<
      string,
      { name?: string; country?: string; countryHints?: string[]; type?: string }
    >,
  });

  const wallet = classifyWalletType({
    totalTx: totalTxFetched,
    uniqueCounterparties,
    timezoneEntropy,
    sleepHours,
    totalMatchedEntities,
    isContractLike: false,
  });
  const baseWeights = baseWeightsByWalletType(wallet.walletType);
  const weightedSignals = normalizeWeights({
    timezone: baseWeights.timezone * timezoneReliability,
    counterparty: baseWeights.counterparty * counterpartyReliability,
    token: baseWeights.token * tokenReliability,
    protocol: baseWeights.protocol * protocolReliability,
  });

  const fused = fuseCountriesProbabilistically({
    timezoneCountries: blendedCountrySignal.countryCandidates,
    counterpartyCountries: mergedCandidates,
    tokenCountries,
    protocolCountries,
    signalWeights: weightedSignals,
    topK: 5,
  });

  const learnBlend = envNum("LEARNED_MODEL_BLEND", 0, 0, 1);
  let learnedModelApplied = false;
  let learnedModelSkipReason: string | undefined;
  let fusedTopCountries = fused.topCountries;
  let fusedBestCountry = fused.bestCountry;
  if (learnBlend > 0) {
    const pathSet = Boolean(
      process.env.LEARNED_COUNTRY_MODEL_PATH &&
        String(process.env.LEARNED_COUNTRY_MODEL_PATH).trim()
    );
    if (!pathSet) {
      learnedModelSkipReason = "LEARNED_MODEL_BLEND>0 but LEARNED_COUNTRY_MODEL_PATH is unset";
    } else {
      const learnedModel = getLearnedCountryModel();
      if (!learnedModel) {
        learnedModelSkipReason =
          "Could not load model file (missing path, invalid JSON, or W/mean length !== feature_dim)";
      } else {
        const preConfidence = calibratedConfidence({
          topCountries: fused.topCountries,
          reliabilities: {
            timezone: timezoneReliability,
            counterparty: counterpartyReliability,
            token: tokenReliability,
            protocol: protocolReliability,
          },
          walletTypeScore: wallet.score,
          totalTx: totalTxFetched,
        });
        const featureInput: TrainingFeatureInput = {
          utcHourHistogram,
          timezoneCandidates: timezoneCandidatesWithFallback,
          topCountries: fused.topCountries,
          diagnostics: {
            totalTx: totalTxFetched,
            timezoneEntropy,
            uniqueCounterparties,
            fallbackUsed: !timezoneCandidates.length,
          },
          totalTxFetched,
          walletType: wallet.walletType,
          confidence: preConfidence,
          trainingShape,
        };
        const learnedProbs = predictLearnedCountryProbs(learnedModel, featureInput);
        if (learnedProbs.size === 0) {
          learnedModelSkipReason =
            "Learned head returned no probabilities (feature length mismatch vs model, or unstable softmax)";
        } else {
          const blended = blendEngineWithLearned(fused.topCountries, learnedProbs, learnBlend, 5);
          fusedTopCountries = blended.topCountries;
          fusedBestCountry = blended.bestCountry;
          learnedModelApplied = true;
        }
      }
    }
  }

  let firstTxCountryPriorityApplied = false;
  const firstTxBlendAlpha = envNum("LOOKUP_FIRST_TX_COUNTRY_BLEND", 0.78, 0, 0.95);
  if (firstTransaction?.exchangePrimaryCountry && firstTxBlendAlpha > 0) {
    const primary = firstTransaction.exchangePrimaryCountry;
    const refTz = fusedTopCountries.find((c) => c.country === primary);
    const priorFirst: CountryGuessCandidate[] = [
      {
        country: primary,
        offsetHours: refTz?.offsetHours ?? 0,
        timezoneLabel: "Giao dịch sớm nhất — CEX / đối tác",
        score: 0,
        percent: 100,
      },
    ];
    fusedTopCountries = mixCountryDistributions({
      a: fusedTopCountries,
      b: priorFirst,
      alpha: firstTxBlendAlpha,
      topK: 5,
    });
    fusedBestCountry = fusedTopCountries[0] ?? fusedBestCountry;
    firstTxCountryPriorityApplied = true;
  }

  const confidence = calibratedConfidence({
    topCountries: fusedTopCountries,
    reliabilities: {
      timezone: timezoneReliability,
      counterparty: counterpartyReliability,
      token: tokenReliability,
      protocol: protocolReliability,
    },
    walletTypeScore: wallet.score,
    totalTx: totalTxFetched,
  });

  const response: LookupResponse = {
    address: targetChecksum,
    network: extraChainIds.length > 0 ? "multichain-evm" : "ethereum",
    totalTxFetched,
    totalMatchedEntities,
    candidates: mergedCandidates,
    bestCandidate: mergedBestCandidate,
    message:
      totalTxFetched > 0
        ? timezoneCandidates.length
          ? "Đã ước lượng quốc gia theo mapping UTC offset từ histogram giờ hoạt động (proxy)."
          : "Không suy ra timezone từ histogram (thiếu timestamp). Dùng fallback prior theo UTC offset để trả quốc gia gần đúng."
        : "Etherscan có thể trả rỗng (rate limit / transient issue). Dùng prior theo UTC offset để trả quốc gia gần đúng.",
    firstTransaction,
    unlabeledCounterparties: unlabeledCounterpartiesSet.size
      ? Array.from(unlabeledCounterpartiesSet)
      : undefined,
    timezoneCandidates: timezoneCandidatesWithFallback.length
      ? timezoneCandidatesWithFallback
      : undefined,
    graph: (() => {
      const g = buildOneHopGraph({
        targetLower,
        txEndpoints,
        topN: CFG.uiOneHopTopN,
        minTxCount: CFG.oneHopMinTxCount,
      });
      return {
        nodes: g.nodes,
        edges: g.edges,
        twoHopScanned: twoHop.scannedNeighbors,
        twoHopUsed: twoHop.used,
        twoHopSkippedReason: twoHop.skippedReason,
        twoHopTopEntities: twoHop.topEntities.length ? twoHop.topEntities : undefined,
        topCounterparties: g.top.map((cp) => {
          const ent = entitiesMap.get(cp.address);
          return {
            address: cp.address,
            txCount: cp.txCount,
            weight: cp.weight,
            entity: ent
              ? { name: ent.name, type: ent.type, countryHints: ent.countryHints ?? [ent.country] }
              : undefined,
          };
        }),
      };
    })(),
    countryCandidates: fusedTopCountries.length ? fusedTopCountries : undefined,
    topCountries: fusedTopCountries.length ? fusedTopCountries : undefined,
    bestCountry: fusedBestCountry ?? blendedCountrySignal.bestCountry,
    confidence,
    walletType: wallet.walletType,
    signalBreakdown: {
      timezone: weightedSignals.timezone,
      counterparty: weightedSignals.counterparty,
      token: weightedSignals.token,
      protocol: weightedSignals.protocol,
    },
    diagnostics: {
      totalTx: totalTxFetched,
      timezoneEntropy,
      timezoneReliability,
      tokenReliability,
      protocolReliability,
      counterpartyReliability,
      uniqueCounterparties,
      fallbackUsed: !timezoneCandidates.length,
      learnedModelApplied,
      learnedModelSkipReason,
      ...(nametagAugment.log.length > 0 ? { nametagResolution: nametagAugment.log } : {}),
      ...(firstTxCountryPriorityApplied
        ? { firstTxCountryPriorityApplied: true, firstTxCountryBlendAlpha: firstTxBlendAlpha }
        : {}),
    },
    perChainTxFetched,
    utcHourHistogram,
    build: {
      commit:
        process.env.RENDER_GIT_COMMIT ??
        process.env.VERCEL_GIT_COMMIT_SHA ??
        process.env.GITHUB_SHA,
      service: process.env.RENDER_SERVICE_NAME ?? process.env.VERCEL,
    },
    etherscanDiagnostics: {
      txlist: {
        ok: txsResult.ok,
        status: txsResult.status,
        message: txsResult.message,
        resultType: txsResult.resultType,
        note: txsResult.note,
      },
      txlistinternal: {
        ok: internalTxsResult.ok,
        status: internalTxsResult.status,
        message: internalTxsResult.message,
        resultType: internalTxsResult.resultType,
        note: internalTxsResult.note,
      },
      tokentx: {
        ok: tokenTxsResult.ok,
        status: tokenTxsResult.status,
        message: tokenTxsResult.message,
        resultType: tokenTxsResult.resultType,
        note: tokenTxsResult.note,
      },
    },
    scannedTransactions: scannedTransactions.length ? scannedTransactions : undefined,
    trainingShape,
  };

  // Avoid caching "empty tx" results too aggressively. If Etherscan had a transient issue,
  // caching it would keep returning "no data" for 10 minutes.
  if (totalTxFetched > 0) {
    cache.set(cacheKey, {
      value: response,
      cachedAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 10, // 10 phút
    });
  }

  return NextResponse.json(response);
}

