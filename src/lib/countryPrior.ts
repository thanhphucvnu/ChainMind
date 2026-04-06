import priorRaw from "@/data/countryPrior.json";
import type { CountryGuessCandidate } from "@/lib/lookupTypes";

type RawPriorRow = { country?: string; weight?: number };

export function getCountryPriorMap(): Map<string, number> {
  const m = new Map<string, number>();
  const rows = priorRaw as unknown as RawPriorRow[];
  if (!Array.isArray(rows)) return m;

  for (const r of rows) {
    const country = typeof r?.country === "string" ? r.country.trim() : "";
    const w = typeof r?.weight === "number" ? r.weight : Number(r?.weight);
    if (!country) continue;
    if (!Number.isFinite(w) || w <= 0) continue;
    m.set(country, (m.get(country) ?? 0) + w);
  }

  const sum = Array.from(m.values()).reduce((a, b) => a + b, 0);
  if (!sum) return m;
  for (const [k, v] of m.entries()) m.set(k, v / sum);
  return m;
}

export function priorToCountryCandidates(topK = 8): CountryGuessCandidate[] {
  const m = getCountryPriorMap();
  const rows = Array.from(m.entries())
    .map(([country, p]) => ({
      country,
      offsetHours: 0,
      timezoneLabel: "Prior",
      score: p,
      percent: p * 100,
    }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, topK);

  const sum = rows.reduce((acc, r) => acc + r.percent, 0) || 1;
  return rows.map((r) => ({ ...r, percent: (r.percent / sum) * 100 }));
}

