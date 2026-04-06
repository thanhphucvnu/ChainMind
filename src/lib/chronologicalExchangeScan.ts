import { getAddress, isAddress } from "ethers";
import type { EntityLabel } from "@/lib/entities";
import type { FirstTransactionInfo } from "@/lib/lookupTypes";
import { inferCexCountryFromLabelPieces } from "@/lib/cexCountryFromLabel";
import { fetchEtherscanAddressNametag } from "@/lib/etherscanNametag";
import {
  getChronologicalWalletTxRows,
  type ChronologicalTxRow,
  type TxRowInput,
} from "@/lib/firstTransactionSummary";

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

function labelsSuggestExchange(labels: string[]): boolean {
  return labels.some((l) => /exchange|cex|custody|hot\s*wallet/i.test(l));
}

/** Etherscan hay gắn nhãn ví nóng sàn dạng "Bitbank 3", "Coinbase 10". */
function nametagLooksLikeNumberedHotWallet(nt: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9]*\s+\d{1,4}$/.test(nt.trim());
}

function counterpartyFromRow(
  row: ChronologicalTxRow,
  targetLower: string
): { cpLower: string; cpChecksum: string; direction: "in" | "out" } | null {
  const from = typeof row.from === "string" ? row.from.toLowerCase() : "";
  const to = typeof row.to === "string" ? row.to.toLowerCase() : "";
  let cp = "";
  let direction: "in" | "out" | null = null;
  if (from === targetLower && to && to !== targetLower) {
    cp = to;
    direction = "out";
  } else if (to === targetLower && from && from !== targetLower) {
    cp = from;
    direction = "in";
  }
  if (!cp || !direction) return null;
  if (!isAddress(cp)) return null;
  const cpChecksum = getAddress(cp);
  return { cpLower: cpChecksum.toLowerCase(), cpChecksum, direction };
}

function rowToInfo(args: {
  row: ChronologicalTxRow;
  direction: "in" | "out";
  counterparty: string;
  chronologicalIndex: number;
  chronologicalTotalCount: number;
  namedCounterpartyResolved: boolean;
  ent: EntityLabel | undefined;
  exchangeOrEntityName?: string;
  maxTxPerType: number;
}): FirstTransactionInfo {
  const ent = args.ent;
  const name = args.exchangeOrEntityName ?? ent?.name;
  let exchangePrimaryCountry: string | undefined;
  let exchangeCountryHints: string[] | undefined;
  const ctry = typeof ent?.country === "string" ? ent.country.trim() : "";
  if (ctry) {
    exchangePrimaryCountry = ctry;
    exchangeCountryHints =
      Array.isArray(ent?.countryHints) && ent.countryHints.length > 0
        ? [...ent.countryHints]
        : [ctry];
  } else if (name) {
    const inf = inferCexCountryFromLabelPieces([name]);
    if (inf) {
      exchangePrimaryCountry = inf.country;
      exchangeCountryHints = [...inf.countryHints];
    }
  }

  return {
    hash: args.row.hash.startsWith("0x") ? args.row.hash : `0x${args.row.hash}`,
    timeStamp: args.row.timeStamp,
    source: args.row.source,
    direction: args.direction,
    counterparty: args.counterparty,
    exchangeOrEntityName: name?.trim() || undefined,
    entityType: ent?.type,
    exchangePrimaryCountry,
    exchangeCountryHints,
    chronologicalIndex: args.chronologicalIndex,
    chronologicalTotalCount: args.chronologicalTotalCount,
    namedCounterpartyResolved: args.namedCounterpartyResolved,
    note: `Quét ${args.chronologicalTotalCount} giao dịch có timestamp trong batch (tối đa ${args.maxTxPerType} mỗi loại từ explorer — dữ liệu là các giao dịch mới nhất đã tải). Giao dịch sớm nhất thực tế trên chuỗi có thể cũ hơn nếu ví rất hoạt động.`,
  };
}

export async function resolveChronologicalNamedCounterparty(args: {
  targetLower: string;
  txs: TxRowInput[];
  internalTxs: TxRowInput[];
  tokenTxs: TxRowInput[];
  entitiesMap: Map<string, EntityLabel>;
  apiBase: string;
  chainId: string;
  apiKey: string;
  maxNametagCalls: number;
  delayMs: number;
  maxTxPerType: number;
}): Promise<{
  firstTransaction: FirstTransactionInfo | undefined;
  nametagLog: Array<{
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

  const sorted = getChronologicalWalletTxRows({
    txs: args.txs,
    internalTxs: args.internalTxs,
    tokenTxs: args.tokenTxs,
  });
  const total = sorted.length;

  if (total === 0) {
    return { firstTransaction: undefined, nametagLog: log };
  }

  let nametagCalls = 0;
  let abortNametag = false;
  const triedNametagFor = new Set<string>();

  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const cp = counterpartyFromRow(row, args.targetLower);
    if (!cp) continue;

    let ent = args.entitiesMap.get(cp.cpLower);
    if (ent?.name?.trim()) {
      return {
        firstTransaction: rowToInfo({
          row,
          direction: cp.direction,
          counterparty: cp.cpChecksum,
          chronologicalIndex: i + 1,
          chronologicalTotalCount: total,
          namedCounterpartyResolved: true,
          ent,
          maxTxPerType: args.maxTxPerType,
        }),
        nametagLog: log,
      };
    }

    const needFetch =
      !abortNametag &&
      args.maxNametagCalls > 0 &&
      nametagCalls < args.maxNametagCalls &&
      !triedNametagFor.has(cp.cpLower);

    if (needFetch) {
      triedNametagFor.add(cp.cpLower);
      if (nametagCalls > 0 && args.delayMs > 0) {
        await new Promise((r) => setTimeout(r, args.delayMs));
      }

      const fetched = await fetchEtherscanAddressNametag({
        apiBase: args.apiBase,
        chainId: args.chainId,
        apiKey: args.apiKey,
        address: cp.cpChecksum,
      });
      nametagCalls += 1;

      if (!fetched.ok) {
        log.push({ address: cp.cpChecksum, skipped: fetched.reason });
        if (nametagCalls === 1 && nametagTierLikelyBlocked(fetched.reason)) {
          abortNametag = true;
        }
        continue;
      }

      const nt = fetched.row.nametag.trim();
      const labels = fetched.row.labels ?? [];
      const pieces = [nt, ...labels];
      const inferred = inferCexCountryFromLabelPieces(pieces);
      const looksLikeExchange =
        Boolean(nt) &&
        (inferred != null ||
          labelsSuggestExchange(labels) ||
          nametagLooksLikeNumberedHotWallet(nt));

      if (inferred) {
        args.entitiesMap.set(cp.cpLower, {
          address: cp.cpChecksum,
          name: nt || fetched.row.nametag,
          type: inferred.type,
          country: inferred.country,
          countryHints: inferred.countryHints,
        });
        ent = args.entitiesMap.get(cp.cpLower);
        log.push({
          address: cp.cpChecksum,
          nametag: nt || fetched.row.nametag,
          inferredCountry: inferred.country,
        });
      } else if (nt) {
        log.push({
          address: cp.cpChecksum,
          nametag: nt,
          skipped: "no_brand_match",
        });
      }

      if (looksLikeExchange && nt) {
        return {
          firstTransaction: rowToInfo({
            row,
            direction: cp.direction,
            counterparty: cp.cpChecksum,
            chronologicalIndex: i + 1,
            chronologicalTotalCount: total,
            namedCounterpartyResolved: true,
            ent,
            exchangeOrEntityName: nt,
            maxTxPerType: args.maxTxPerType,
          }),
          nametagLog: log,
        };
      }
    }
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const cp = counterpartyFromRow(row, args.targetLower);
    if (!cp) continue;
    const ent = args.entitiesMap.get(cp.cpLower);
    return {
      firstTransaction: rowToInfo({
        row,
        direction: cp.direction,
        counterparty: cp.cpChecksum,
        chronologicalIndex: i + 1,
        chronologicalTotalCount: total,
        namedCounterpartyResolved: Boolean(ent?.name?.trim()),
        ent,
        maxTxPerType: args.maxTxPerType,
      }),
      nametagLog: log,
    };
  }

  return { firstTransaction: undefined, nametagLog: log };
}
