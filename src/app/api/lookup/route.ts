import { NextResponse } from "next/server";
import { getAddress, isAddress } from "ethers";
import { z } from "zod";
import { getEntitiesMap } from "@/lib/entities";
import type { CountryCandidate, LookupResponse } from "@/lib/lookupTypes";
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
};

const CHAINS: ChainConfig[] = [
  { name: "ethereum", keyEnv: "ETHERSCAN_API_KEY", apiBase: "https://api.etherscan.io/api" },
  { name: "bsc", keyEnv: "BSCSCAN_API_KEY", apiBase: "https://api.bscscan.com/api" },
  { name: "polygon", keyEnv: "POLYGONSCAN_API_KEY", apiBase: "https://api.polygonscan.com/api" },
  { name: "arbitrum", keyEnv: "ARBISCAN_API_KEY", apiBase: "https://api.arbiscan.io/api" },
  { name: "base", keyEnv: "BASESCAN_API_KEY", apiBase: "https://api.basescan.org/api" },
];

const cache = new Map<
  string,
  { expiresAt: number; value: LookupResponse; cachedAt: number }
>();

type TxEndpoint = { from?: string | null; to?: string | null; timeStamp?: number | null };

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
  apiKey: string;
  address: string;
  offset: number;
}): Promise<TxEndpoint[]> {
  const url = new URL(args.apiBase);
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", args.address);
  url.searchParams.set("startblock", "0");
  url.searchParams.set("endblock", "99999999");
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(args.offset));
  url.searchParams.set("sort", "desc");
  url.searchParams.set("apikey", args.apiKey);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return [];

  type ExplorerResponse = { status?: string; message?: string; result?: unknown };
  const data = (await res.json().catch(() => null)) as ExplorerResponse | null;
  const result = data?.result;
  if (!Array.isArray(result)) return [];

  return (result as unknown[]).map((tx) => {
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

  const enabledChains = CHAINS.map((c) => ({
    ...c,
    apiKey: process.env[c.keyEnv],
  })).filter((c) => typeof c.apiKey === "string" && c.apiKey.length > 0);

  if (enabledChains.length === 0) {
    return NextResponse.json(
      {
        error:
          "Thiếu API key explorer. Hãy set ít nhất 1 biến: ETHERSCAN_API_KEY / BSCSCAN_API_KEY / POLYGONSCAN_API_KEY / ARBISCAN_API_KEY / BASESCAN_API_KEY",
      },
      { status: 500 }
    );
  }

  const perChainTxFetched: Record<string, number> = {};
  const allTx: TxEndpoint[] = [];

  // Keep it sequential to be friendlier to free-tier rate limits.
  for (const chain of enabledChains) {
    const txs = await fetchEtherscanFamilyTxList({
      apiBase: chain.apiBase,
      apiKey: chain.apiKey as string,
      address: targetChecksum,
      offset,
    });
    perChainTxFetched[chain.name] = txs.length;
    allTx.push(...txs);
  }

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
  const timezoneCandidatesWithFallback =
    timezoneCandidates.length
      ? timezoneCandidates
      : totalTxFetched === 0
        ? []
        : hourHistogramToTimezoneCandidates(utcHourHistogram, {
            topK: 5,
            activeStartHourLocal: 8,
            activeEndHourLocal: 23,
            fallbackPrior: true,
          });

  const { countryCandidates, bestCountry } =
    timezoneCandidatesToCountryCandidates(timezoneCandidatesWithFallback, 5);

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

  const response: LookupResponse = {
    address: targetChecksum,
    network: "multichain-evm",
    totalTxFetched,
    totalMatchedEntities,
    candidates,
    bestCandidate,
    message:
      timezoneCandidatesWithFallback.length
        ? timezoneCandidates.length
          ? "Đã ước lượng timezone (proxy) và suy ra quốc gia khả dĩ theo mapping UTC offset."
          : "Không suy ra timezone từ histogram (thiếu timestamp). Dùng fallback prior theo UTC offset để trả quốc gia gần đúng."
        : "Không đủ dữ liệu để ước lượng quốc gia.",
    unlabeledCounterparties: unlabeledCounterpartiesSet.size
      ? Array.from(unlabeledCounterpartiesSet)
      : undefined,
    timezoneCandidates: timezoneCandidatesWithFallback.length
      ? timezoneCandidatesWithFallback
      : undefined,
    countryCandidates: countryCandidates.length ? countryCandidates : undefined,
    bestCountry,
    perChainTxFetched,
    utcHourHistogram,
    build: {
      commit:
        process.env.RENDER_GIT_COMMIT ??
        process.env.VERCEL_GIT_COMMIT_SHA ??
        process.env.GITHUB_SHA,
      service: process.env.RENDER_SERVICE_NAME ?? process.env.VERCEL,
    },
  };

  cache.set(cacheKey, {
    value: response,
    cachedAt: Date.now(),
    expiresAt: Date.now() + 1000 * 60 * 10, // 10 phút
  });

  return NextResponse.json(response);
}

