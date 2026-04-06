import { getAddress, isAddress } from "ethers";
import type { EntityMatch, FirstTransactionInfo } from "@/lib/lookupTypes";
import { inferCexCountryFromLabelPieces } from "@/lib/cexCountryFromLabel";

export type TxRowInput = {
  hash?: string | null;
  from?: string | null;
  to?: string | null;
  timeStamp?: number | null;
};

type EntityLite = {
  name?: string;
  type?: EntityMatch["type"];
  country?: string;
  countryHints?: string[];
};

type NametagResolutionRow = {
  address: string;
  nametag?: string;
};

type Source = FirstTransactionInfo["source"];

export type ChronologicalTxRow = {
  hash: string;
  timeStamp: number | null;
  from: string | null;
  to: string | null;
  source: Source;
};

function collectRows(
  list: TxRowInput[],
  source: Source
): Array<{
  hash: string;
  timeStamp: number | null;
  from: string | null;
  to: string | null;
  source: Source;
}> {
  const out: Array<{
    hash: string;
    timeStamp: number | null;
    from: string | null;
    to: string | null;
    source: Source;
  }> = [];
  for (const t of list) {
    const h = typeof t.hash === "string" ? t.hash.trim() : "";
    if (!h) continue;
    const ts = t.timeStamp;
    const timeStamp =
      typeof ts === "number" && Number.isFinite(ts)
        ? ts
        : typeof ts === "string" && /^\d+$/.test(ts)
          ? Number(ts)
          : null;
    out.push({
      hash: h,
      timeStamp,
      from: typeof t.from === "string" ? t.from : null,
      to: typeof t.to === "string" ? t.to : null,
      source,
    });
  }
  return out;
}

/** Dedupe by tx hash; if duplicates, keep the row with the smallest timestamp. */
function dedupeByHash(
  rows: Array<{
    hash: string;
    timeStamp: number | null;
    from: string | null;
    to: string | null;
    source: Source;
  }>
) {
  const byHash = new Map<
    string,
    { hash: string; timeStamp: number | null; from: string | null; to: string | null; source: Source }
  >();
  for (const r of rows) {
    const key = r.hash.toLowerCase();
    const prev = byHash.get(key);
    if (!prev) {
      byHash.set(key, { ...r });
      continue;
    }
    const a = r.timeStamp;
    const b = prev.timeStamp;
    if (a != null && (b == null || a < b)) {
      byHash.set(key, { ...r });
    }
  }
  return Array.from(byHash.values());
}

/** Gộp normal/internal/token, dedupe hash, lọc có timestamp, sắp cũ → mới. */
export function getChronologicalWalletTxRows(args: {
  txs: TxRowInput[];
  internalTxs: TxRowInput[];
  tokenTxs: TxRowInput[];
}): ChronologicalTxRow[] {
  const rows = dedupeByHash([
    ...collectRows(args.txs, "txlist"),
    ...collectRows(args.internalTxs, "txlistinternal"),
    ...collectRows(args.tokenTxs, "tokentx"),
  ]);
  return rows
    .filter((r) => r.timeStamp != null && Number.isFinite(r.timeStamp))
    .sort((a, b) => (a.timeStamp ?? 0) - (b.timeStamp ?? 0));
}

export function buildFirstTransactionInfo(args: {
  targetLower: string;
  txs: TxRowInput[];
  internalTxs: TxRowInput[];
  tokenTxs: TxRowInput[];
  entitiesMap: Map<string, EntityLite>;
  nametagResolution?: NametagResolutionRow[] | undefined;
  /** Giới hạn offset mỗi loại tx đã gọi explorer (để hiển thị caveat). */
  maxTxPerType: number;
}): FirstTransactionInfo | undefined {
  const rows = dedupeByHash([
    ...collectRows(args.txs, "txlist"),
    ...collectRows(args.internalTxs, "txlistinternal"),
    ...collectRows(args.tokenTxs, "tokentx"),
  ]);

  const sorted = rows
    .filter((r) => r.timeStamp != null && Number.isFinite(r.timeStamp))
    .sort((a, b) => (a.timeStamp ?? 0) - (b.timeStamp ?? 0));

  for (const r of sorted) {
    const from = typeof r.from === "string" ? r.from.toLowerCase() : "";
    const to = typeof r.to === "string" ? r.to.toLowerCase() : "";
    let cp = "";
    let direction: "in" | "out" | null = null;
    if (from === args.targetLower && to && to !== args.targetLower) {
      cp = to;
      direction = "out";
    } else if (to === args.targetLower && from && from !== args.targetLower) {
      cp = from;
      direction = "in";
    }
    if (!cp || !direction) continue;
    if (!isAddress(cp)) continue;

    const cpChecksum = getAddress(cp);
    const cpLower = cpChecksum.toLowerCase();
    const ent = args.entitiesMap.get(cpLower);
    let exchangeOrEntityName = ent?.name;
    if (!exchangeOrEntityName && args.nametagResolution?.length) {
      const hit = args.nametagResolution.find((x) => x.address.toLowerCase() === cpLower);
      if (hit?.nametag) exchangeOrEntityName = hit.nametag;
    }

    let exchangePrimaryCountry: string | undefined;
    let exchangeCountryHints: string[] | undefined;
    const ctry = typeof ent?.country === "string" ? ent.country.trim() : "";
    if (ctry) {
      exchangePrimaryCountry = ctry;
      exchangeCountryHints =
        Array.isArray(ent?.countryHints) && ent.countryHints.length > 0
          ? [...ent.countryHints]
          : [ctry];
    } else if (exchangeOrEntityName) {
      const inf = inferCexCountryFromLabelPieces([exchangeOrEntityName]);
      if (inf) {
        exchangePrimaryCountry = inf.country;
        exchangeCountryHints = [...inf.countryHints];
      }
    }

    return {
      hash: r.hash.startsWith("0x") ? r.hash : `0x${r.hash}`,
      timeStamp: r.timeStamp,
      source: r.source,
      direction,
      counterparty: cpChecksum,
      exchangeOrEntityName,
      entityType: ent?.type,
      exchangePrimaryCountry,
      exchangeCountryHints,
      note: `Theo dữ liệu đã tải (tối đa ${args.maxTxPerType} giao dịch mỗi loại: normal / internal / token — explorer trả các giao dịch mới nhất). Giao dịch sớm nhất thực tế trên chuỗi có thể cũ hơn nếu ví có rất nhiều hoạt động.`,
    };
  }

  return undefined;
}
