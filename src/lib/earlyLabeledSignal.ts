import type { CountryCandidate, EntityMatch } from "@/lib/lookupTypes";
import type { EntityLabel } from "@/lib/entities";

function typeWeight(t?: EntityMatch["type"]): number {
  switch (t) {
    case "CEX":
      return 1.35;
    case "BRIDGE":
      return 1.2;
    case "PAYMENT":
      return 1.15;
    case "DEX":
      return 1.05;
    case "MIXER":
      return 1.1;
    case "LENDING":
      return 1.05;
    default:
      return 1.0;
  }
}

type TxT = {
  from?: string | null;
  to?: string | null;
  timeStamp?: number | null;
};

/**
 * Stronger weight for labeled counterparties that appear in the wallet's *earliest* txs
 * (on-ramp / first CEX touch proxy). Complements volume-based 1-hop graph.
 */
export function earlyLabeledCountryCandidates(args: {
  targetLower: string;
  txs: TxT[];
  entitiesMap: Map<string, EntityLabel>;
  maxChronologicalTx?: number;
}): { candidates: CountryCandidate[]; rawStrength: number } {
  const maxN = args.maxChronologicalTx ?? 80;
  const sorted = args.txs
    .filter((t) => t.timeStamp != null && Number.isFinite(t.timeStamp))
    .slice()
    .sort((a, b) => (a.timeStamp ?? 0) - (b.timeStamp ?? 0))
    .slice(0, maxN);

  const byCountry = new Map<
    string,
    { weight: number; entities: Map<string, { address: string; name?: string; type?: EntityMatch["type"] }> }
  >();
  let rawStrength = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const tx = sorted[i];
    const from = typeof tx.from === "string" ? tx.from.toLowerCase() : "";
    const to = typeof tx.to === "string" ? tx.to.toLowerCase() : "";
    if (!from || !to) continue;
    let cp = "";
    if (from === args.targetLower && to !== args.targetLower) cp = to;
    else if (to === args.targetLower && from !== args.targetLower) cp = from;
    if (!cp) continue;

    const ent = args.entitiesMap.get(cp);
    if (!ent) continue;

    const ageRank = i + 1;
    const recencyBoost = (maxN - ageRank + 1) / maxN;
    const w = typeWeight(ent.type) * (0.55 + 1.45 * recencyBoost);
    rawStrength += w;

    const hints =
      Array.isArray(ent.countryHints) && ent.countryHints.length
        ? ent.countryHints
        : [ent.country];
    const perHint = w / (hints.length || 1);

    for (const country of hints) {
      const key = typeof country === "string" ? country.trim() : "";
      if (!key) continue;
      let b = byCountry.get(key);
      if (!b) {
        b = { weight: 0, entities: new Map() };
        byCountry.set(key, b);
      }
      b.weight += perHint;
      const ek = ent.address.toLowerCase();
      if (!b.entities.has(ek)) {
        b.entities.set(ek, { address: ent.address, name: ent.name, type: ent.type });
      }
    }
  }

  const totalW = Array.from(byCountry.values()).reduce((a, b) => a + b.weight, 0);
  const candidates: CountryCandidate[] = Array.from(byCountry.entries())
    .map(([country, v]) => ({
      country,
      count: Math.round(v.weight),
      percent: totalW ? (v.weight / totalW) * 100 : 0,
      entities: Array.from(v.entities.values()).slice(0, 6),
    }))
    .sort((a, b) => b.percent - a.percent);

  return { candidates, rawStrength };
}
