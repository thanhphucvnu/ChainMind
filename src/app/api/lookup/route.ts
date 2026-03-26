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

// For now we only infer using Ethereum via Etherscan (single chain).
const ETHERSCAN: ChainConfig = {
  name: "ethereum",
  keyEnv: "ETHERSCAN_API_KEY",
  apiBase: "https://api.etherscan.io/api",
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
  action?: EtherscanAction;
}): Promise<EtherscanFetchResult> {
  const url = new URL(args.apiBase);
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
    apiKey,
    address: targetChecksum,
    offset,
  });

  const internalTxsResult = await fetchEtherscanFamilyTxList({
    apiBase: ETHERSCAN.apiBase,
    apiKey,
    address: targetChecksum,
    offset,
    action: "txlistinternal",
  });

  const tokenTxsResult = await fetchEtherscanFamilyTxList({
    apiBase: ETHERSCAN.apiBase,
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

