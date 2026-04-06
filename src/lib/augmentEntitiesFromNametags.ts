import { getAddress, isAddress } from "ethers";
import type { EntityLabel } from "@/lib/entities";
import { inferCexCountryFromLabelPieces } from "@/lib/cexCountryFromLabel";
import { fetchEtherscanAddressNametag } from "@/lib/etherscanNametag";

type TxT = { from?: string | null; to?: string | null; timeStamp?: number | null };

/** First nametag call failed in a way that usually means the API key tier cannot use this endpoint. */
function nametagTierLikelyBlocked(reason: string): boolean {
  const r = reason.toLowerCase();
  if (r.includes("rate") || r.includes("limit") || r.includes("429")) return false;
  return (
    r.includes("notok") ||
    r.includes("pro") ||
    r.includes("free") ||
    r.includes("upgrade") ||
    r.includes("unauthorized") ||
    r.includes("permission")
  );
}

export function collectEarlyUnresolvedCounterpartyAddresses(args: {
  targetLower: string;
  txs: TxT[];
  entitiesMap: Map<string, EntityLabel>;
  earlyWindow: number;
  maxCalls: number;
}): string[] {
  const maxN = args.earlyWindow;
  const sorted = args.txs
    .filter((t) => t.timeStamp != null && Number.isFinite(t.timeStamp))
    .slice()
    .sort((a, b) => (a.timeStamp ?? 0) - (b.timeStamp ?? 0))
    .slice(0, maxN);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const tx of sorted) {
    if (out.length >= args.maxCalls) break;
    const from = typeof tx.from === "string" ? tx.from.toLowerCase() : "";
    const to = typeof tx.to === "string" ? tx.to.toLowerCase() : "";
    let cp = "";
    if (from === args.targetLower && to !== args.targetLower) cp = to;
    else if (to === args.targetLower && from !== args.targetLower) cp = from;
    if (!cp || args.entitiesMap.has(cp) || seen.has(cp)) continue;
    if (!isAddress(cp)) continue;
    seen.add(cp);
    out.push(cp);
  }
  return out;
}

export async function augmentEntitiesFromExplorerNametags(args: {
  entitiesMap: Map<string, EntityLabel>;
  targetLower: string;
  txs: TxT[];
  apiBase: string;
  chainId: string;
  apiKey: string;
  earlyWindow: number;
  maxCalls: number;
  delayMs: number;
}): Promise<{
  log: Array<{
    address: string;
    nametag?: string;
    inferredCountry?: string;
    skipped?: string;
  }>;
}> {
  const log: Array<{
    address: string;
    nametag?: string;
    inferredCountry?: string;
    skipped?: string;
  }> = [];

  if (args.maxCalls <= 0) {
    return { log };
  }

  const toResolve = collectEarlyUnresolvedCounterpartyAddresses({
    targetLower: args.targetLower,
    txs: args.txs,
    entitiesMap: args.entitiesMap,
    earlyWindow: args.earlyWindow,
    maxCalls: args.maxCalls,
  });

  let abortRest = false;

  for (let i = 0; i < toResolve.length; i += 1) {
    if (abortRest) break;
    const lower = toResolve[i];
    if (i > 0 && args.delayMs > 0) {
      await new Promise((r) => setTimeout(r, args.delayMs));
    }

    const checksum = getAddress(lower);
    const fetched = await fetchEtherscanAddressNametag({
      apiBase: args.apiBase,
      chainId: args.chainId,
      apiKey: args.apiKey,
      address: checksum,
    });

    if (!fetched.ok) {
      log.push({ address: checksum, skipped: fetched.reason });
      if (i === 0 && nametagTierLikelyBlocked(fetched.reason)) {
        abortRest = true;
      }
      continue;
    }

    const pieces = [fetched.row.nametag, ...fetched.row.labels];
    const inferred = inferCexCountryFromLabelPieces(pieces);
    if (!inferred) {
      log.push({
        address: checksum,
        nametag: fetched.row.nametag,
        skipped: "no_brand_match",
      });
      continue;
    }

    args.entitiesMap.set(lower, {
      address: checksum,
      name: fetched.row.nametag,
      type: inferred.type,
      country: inferred.country,
      countryHints: inferred.countryHints,
    });

    log.push({
      address: checksum,
      nametag: fetched.row.nametag,
      inferredCountry: inferred.country,
    });
  }

  return { log };
}
