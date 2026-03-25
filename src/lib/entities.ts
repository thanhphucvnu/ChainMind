import { getAddress, isAddress } from "ethers";
import entitiesRaw from "@/data/entities.json";
import type { EntityMatch } from "./lookupTypes";

export type EntityLabel = EntityMatch & {
  country: string;
};

type RawEntity = {
  address?: string;
  country?: string;
  name?: string;
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

  const entitiesList = entitiesRaw as unknown as RawEntity[];
  if (!Array.isArray(entitiesList)) return m;

  for (const e of entitiesList) {
    const addr = typeof e?.address === "string" ? e.address : "";
    const country = typeof e?.country === "string" ? e.country : "";
    const name = typeof e?.name === "string" ? e.name : undefined;

    const normalized = normalizeAddress(addr);
    if (!normalized) continue;
    if (!country.trim()) continue;

    m.set(normalized, { address: addr, country, name });
  }

  return m;
}

