import { getAddress, isAddress } from "ethers";
import entitiesRaw from "@/data/entities.json";
import entityLabelsRaw from "@/data/entityLabels.json";
import type { EntityMatch } from "./lookupTypes";

export type EntityLabel = EntityMatch & {
  country: string;
  countryHints?: string[];
  type?: EntityMatch["type"];
};

type RawEntity = {
  address?: string;
  country?: string;
  name?: string;
  type?: EntityMatch["type"];
  countryHints?: string[];
};

function normalizeAddress(addr: string): string | null {
  try {
    if (!isAddress(addr)) return null;
    return getAddress(addr).toLowerCase();
  } catch {
    return null;
  }
}

export function getEntitiesMap(): Map<string, EntityLabel> {
  const m = new Map<string, EntityLabel>();

  const listA = entitiesRaw as unknown as RawEntity[];
  const listB = entityLabelsRaw as unknown as RawEntity[];
  const entitiesList: RawEntity[] = [
    ...(Array.isArray(listA) ? listA : []),
    ...(Array.isArray(listB) ? listB : []),
  ];

  for (const e of entitiesList) {
    const addr = typeof e?.address === "string" ? e.address : "";
    const country = typeof e?.country === "string" ? e.country : "";
    const name = typeof e?.name === "string" ? e.name : undefined;
    const type = e?.type;
    const countryHints = Array.isArray(e?.countryHints)
      ? e.countryHints.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : undefined;

    const normalized = normalizeAddress(addr);
    if (!normalized) continue;
    if (!country.trim()) continue;

    m.set(normalized, { address: addr, country, name, type, countryHints });
  }

  return m;
}

