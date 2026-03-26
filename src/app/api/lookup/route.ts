import { NextResponse } from "next/server";
import { getAddress, isAddress } from "ethers";
import { z } from "zod";
import { getEntitiesMap } from "@/lib/entities";
import type { CountryCandidate, CountryGuessCandidate, LookupResponse } from "@/lib/lookupTypes";
import { hourHistogramToTimezoneCandidates } from "@/lib/timezone";
import { timezoneCandidatesToCountryCandidates } from "@/lib/countryFromTimezone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

// For now we only infer using Ethereum via Etherscan (single chain).
const ETHERSCAN: ChainConfig = {
  name: "ethereum",
  keyEnv: "ETHERSCAN_API_KEY",
  apiBase: "https://api.etherscan.io/v2/api",
  chainId: "1",
};

const cache = new Map<
  string,
  { expiresAt: number; value: LookupResponse; cachedAt: number }
>();

type TxEndpoint = { from?: string | null; to?: string | null; timeStamp?: number | null };
type EtherscanAction = "txlist" | "txlistinternal" | "tokentx";
type EtherscanFetchResult = {
  txs: TxEndpoint[];
  ok: boolean;
  status?: string;
  message?: string;
  resultType?: string;
  note?: string;
};

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
  signalWeights: { timezone: number; counterparty: number; token: number; protocol: number };
  topK?: number;
}): { topCountries: CountryGuessCandidate[]; bestCountry: CountryGuessCandidate | null } {
  const topK = args.topK ?? 5;
  const all = new Set<string>();
  for (const c of args.timezoneCountries) all.add(c.country);
  for (const c of args.counterpartyCountries) all.add(c.country);
  if (all.size === 0) all.add("United States");

  const eps = 1e-6;
  const tzP = new Map(args.timezoneCountries.map((c) => [c.country, c.percent / 100]));
  const cpP = new Map(args.counterpartyCountries.map((c) => [c.country, c.percent / 100]));

  const rows: CountryGuessCandidate[] = [];
  for (const country of all) {
    const pTz = Math.max(eps, tzP.get(country) ?? eps);
    const pCp = Math.max(eps, cpP.get(country) ?? eps);
    // token/protocol placeholders: until dedicated signal maps are added, keep neutral impact.
    const pToken = 0.5;
    const pProtocol = 0.5;
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
  entitiesMap: Map<string, { address: string; country: string; name?: string }>
): { candidates: CountryCandidate[]; bestCandidate: CountryCandidate | null; totalMatchedEntities: number } {
  const totalByCountry = new Map<
    string,
    { count: number; entities: Map<string, { address: string; name?: string }> }
  >();

  for (const tx of txEndpoints) {
    const addrs = [tx.from, tx.to];
    for (const addrRaw of addrs) {
      if (!addrRaw || typeof addrRaw !== "string") continue;
      const addrLower = addrRaw.toLowerCase();
      if (addrLower === targetLower) continue;

      const ent = entitiesMap.get(addrLower);
      if (!ent) continue;

      const country = ent.country;
      let b = totalByCountry.get(country);
      if (!b) {
        b = {
          count: 0,
          entities: new Map<string, { address: string; name?: string }>(),
        };
        totalByCountry.set(country, b);
      }
      b.count += 1;
      const entKey = ent.address.toLowerCase();
      if (!b.entities.has(entKey)) {
        b.entities.set(entKey, { address: ent.address, name: ent.name });
      }
    }
  }

  const totalMatchedEntities = Array.from(totalByCountry.values()).reduce(
    (acc, v) => acc + v.count,
    0
  );

  const candidates: CountryCandidate[] = Array.from(totalByCountry.entries())
    .map(([country, v]) => ({
      country,
      count: v.count,
      percent: totalMatchedEntities ? (v.count / totalMatchedEntities) * 100 : 0,
      entities: Array.from(v.entities.values()).slice(0, 8),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    candidates,
    bestCandidate: candidates.length ? candidates[0] : null,
    totalMatchedEntities,
  };
}

async function fetchEtherscanFamilyTxList(args: {
  apiBase: string;
  chainId: string;
  apiKey: string;
  address: string;
  offset: number;
  action?: EtherscanAction;
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
  url.searchParams.set("sort", "desc");
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
      from: typeof obj.from === "string" ? obj.from : null,
      to: typeof obj.to === "string" ? obj.to : null,
      timeStamp: Number.isFinite(ts) ? ts : null,
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

  const entitiesMap = getEntitiesMap();

  const offset = Math.min(maxTx ?? 200, 2000);

  const cacheKey = `${targetLower}:${offset}`;
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

  const txsResult = await fetchEtherscanFamilyTxList({
    apiBase: ETHERSCAN.apiBase,
    chainId: ETHERSCAN.chainId,
    apiKey,
    address: targetChecksum,
    offset,
  });

  const internalTxsResult = await fetchEtherscanFamilyTxList({
    apiBase: ETHERSCAN.apiBase,
    chainId: ETHERSCAN.chainId,
    apiKey,
    address: targetChecksum,
    offset,
    action: "txlistinternal",
  });

  const tokenTxsResult = await fetchEtherscanFamilyTxList({
    apiBase: ETHERSCAN.apiBase,
    chainId: ETHERSCAN.chainId,
    apiKey,
    address: targetChecksum,
    offset,
    action: "tokentx",
  });

  const txs = txsResult.txs;
  const internalTxs = internalTxsResult.txs;
  const tokenTxs = tokenTxsResult.txs;

  const perChainTxFetched: Record<string, number> = {
    [`${ETHERSCAN.name}:txlist`]: txs.length,
    [`${ETHERSCAN.name}:txlistinternal`]: internalTxs.length,
    [`${ETHERSCAN.name}:tokentx`]: tokenTxs.length,
  };

  // Combine all available event types so a wallet with only token/internal activity
  // still gets a prediction instead of "not enough tx".
  const allTx: TxEndpoint[] = [...txs, ...internalTxs, ...tokenTxs];

  const txEndpoints = allTx.map((t) => ({ from: t.from ?? null, to: t.to ?? null }));

  const utcHourHistogram = new Array<number>(24).fill(0);
  for (const t of allTx) {
    if (!t.timeStamp || !Number.isFinite(t.timeStamp)) continue;
    const d = new Date(t.timeStamp * 1000);
    const h = d.getUTCHours();
    utcHourHistogram[h] = (utcHourHistogram[h] ?? 0) + 1;
  }

  const timezoneCandidates = hourHistogramToTimezoneCandidates(utcHourHistogram, {
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

  const blendedCountrySignal = blendCountrySignals(
    timezoneCountrySignal.countryCandidates,
    candidates,
    5
  );

  const uniqueCounterparties = new Set(
    txEndpoints
      .flatMap((t) => [t.from, t.to])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.toLowerCase())
      .filter((x) => x !== targetLower)
  ).size;
  const timezoneEntropy = normalizedEntropy24(utcHourHistogram);
  const sleepHours = maxConsecutiveSleepHours(utcHourHistogram);
  const timezoneReliability = clamp01(
    (1 - timezoneEntropy) * 0.7 + clamp01(sleepHours / 8) * 0.3
  );
  const counterpartyReliability = clamp01(
    reliabilityFromVolume(totalMatchedEntities, 40) * 0.8 +
      clamp01(candidates.length / 5) * 0.2
  );
  const tokenReliability = clamp01(
    reliabilityFromVolume(perChainTxFetched["ethereum:tokentx"] ?? 0, 80)
  );
  const protocolReliability = clamp01(reliabilityFromVolume(uniqueCounterparties, 100) * 0.4);

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
    counterpartyCountries: candidates,
    signalWeights: weightedSignals,
    topK: 5,
  });

  const confidence = calibratedConfidence({
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

  const response: LookupResponse = {
    address: targetChecksum,
    network: "ethereum",
    totalTxFetched,
    totalMatchedEntities,
    candidates,
    bestCandidate,
    message:
      totalTxFetched > 0
        ? timezoneCandidates.length
          ? "Đã ước lượng quốc gia theo mapping UTC offset từ histogram giờ hoạt động (proxy)."
          : "Không suy ra timezone từ histogram (thiếu timestamp). Dùng fallback prior theo UTC offset để trả quốc gia gần đúng."
        : "Etherscan có thể trả rỗng (rate limit / transient issue). Dùng prior theo UTC offset để trả quốc gia gần đúng.",
    unlabeledCounterparties: unlabeledCounterpartiesSet.size
      ? Array.from(unlabeledCounterpartiesSet)
      : undefined,
    timezoneCandidates: timezoneCandidatesWithFallback.length
      ? timezoneCandidatesWithFallback
      : undefined,
    countryCandidates: fused.topCountries.length ? fused.topCountries : undefined,
    topCountries: fused.topCountries.length ? fused.topCountries : undefined,
    bestCountry: fused.bestCountry ?? blendedCountrySignal.bestCountry,
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

