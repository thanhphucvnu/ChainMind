import { NextResponse } from "next/server";
import { getAddress, isAddress } from "ethers";
import { z } from "zod";
import { getEntitiesMap } from "@/lib/entities";
import type { CountryCandidate, LookupResponse } from "@/lib/lookupTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LookupSchema = z.object({
  address: z.string().min(2),
  maxTx: z.number().int().positive().max(2000).optional(),
});

const cache = new Map<
  string,
  { expiresAt: number; value: LookupResponse; cachedAt: number }
>();

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
  if (entitiesMap.size === 0) {
    const response: LookupResponse = {
      address: targetChecksum,
      network: "ethereum",
      totalTxFetched: 0,
      totalMatchedEntities: 0,
      candidates: [],
      bestCandidate: null,
      message:
        "`entities.json` hiện đang rỗng. Hãy thêm danh sách nhãn (địa chỉ đối tác -> country) để suy đoán.",
    };
    return NextResponse.json(response);
  }

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Thiếu biến môi trường `ETHERSCAN_API_KEY`. Hãy thêm trong môi trường deploy (Vercel/Env).",
      },
      { status: 500 }
    );
  }

  const offset = Math.min(maxTx ?? 200, 2000);

  const cacheKey = `${targetLower}:${offset}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.value);
  }

  const etherscanUrl = new URL("https://api.etherscan.io/api");
  etherscanUrl.searchParams.set("module", "account");
  etherscanUrl.searchParams.set("action", "txlist");
  etherscanUrl.searchParams.set("address", targetChecksum);
  etherscanUrl.searchParams.set("startblock", "0");
  etherscanUrl.searchParams.set("endblock", "99999999");
  etherscanUrl.searchParams.set("page", "1");
  etherscanUrl.searchParams.set("offset", String(offset));
  etherscanUrl.searchParams.set("sort", "desc");
  etherscanUrl.searchParams.set("apikey", apiKey);

  const res = await fetch(etherscanUrl.toString(), { cache: "no-store" });
  if (!res.ok) {
    return NextResponse.json({ error: "Không fetch được dữ liệu từ Etherscan." }, { status: 502 });
  }

  type EtherscanResponse = {
    status?: string;
    message?: string;
    result?: unknown;
  };

  const data = (await res.json().catch(() => null)) as EtherscanResponse | null;

  const result = data?.result;
  if (!Array.isArray(result)) {
    return NextResponse.json(
      {
        error:
          "Etherscan trả về dữ liệu không mong đợi. Hãy thử lại hoặc kiểm tra `ETHERSCAN_API_KEY`.",
        details: data?.message ?? null,
      },
      { status: 502 }
    );
  }

  const txEndpoints = (result as unknown[]).map((tx) => {
    if (!tx || typeof tx !== "object") return { from: null, to: null };
    const obj = tx as Record<string, unknown>;
    return {
      from: typeof obj.from === "string" ? obj.from : null,
      to: typeof obj.to === "string" ? obj.to : null,
    };
  });

  const { candidates, bestCandidate, totalMatchedEntities } = computeCandidates(
    targetLower,
    txEndpoints,
    entitiesMap
  );

  const response: LookupResponse = {
    address: targetChecksum,
    network: "ethereum",
    totalTxFetched: txEndpoints.length,
    totalMatchedEntities,
    candidates,
    bestCandidate,
    message: candidates.length
      ? "Đã suy đoán theo heuristic dựa trên nhãn đối tác."
      : "Không đủ dữ liệu từ nhãn hiện tại (entities.json) để suy đoán.",
  };

  cache.set(cacheKey, {
    value: response,
    cachedAt: Date.now(),
    expiresAt: Date.now() + 1000 * 60 * 10, // 10 phút
  });

  return NextResponse.json(response);
}

