import type { CountryGuessCandidate, TimezoneCandidate } from "@/lib/lookupTypes";

type OffsetCountryWeight = { country: string; weight: number };

// Rough mapping from UTC offset -> plausible countries.
// This is heuristic and NOT a reliable inference of a wallet owner's country.
const COUNTRIES_BY_OFFSET: Record<number, OffsetCountryWeight[]> = {
  // -10..+14 common offsets (subset for practicality)
  [-8]: [
    { country: "United States", weight: 0.55 },
    { country: "Mexico", weight: 0.25 },
    { country: "Canada", weight: 0.15 },
  ],
  [-7]: [
    { country: "United States", weight: 0.45 },
    { country: "Mexico", weight: 0.30 },
    { country: "Canada", weight: 0.15 },
  ],
  [-6]: [
    { country: "Mexico", weight: 0.40 },
    { country: "United States", weight: 0.25 },
    { country: "Guatemala", weight: 0.10 },
    { country: "Costa Rica", weight: 0.10 },
  ],
  [-5]: [
    { country: "United States", weight: 0.30 },
    { country: "Canada", weight: 0.20 },
    { country: "Colombia", weight: 0.15 },
    { country: "Peru", weight: 0.10 },
  ],
  [-4]: [
    { country: "Venezuela", weight: 0.25 },
    { country: "Brazil", weight: 0.20 },
    { country: "Colombia", weight: 0.15 },
    { country: "Dominican Republic", weight: 0.10 },
  ],
  [-3]: [
    { country: "Brazil", weight: 0.35 },
    { country: "Argentina", weight: 0.20 },
    { country: "Uruguay", weight: 0.10 },
    { country: "Chile", weight: 0.10 },
  ],
  [-2]: [
    { country: "South Georgia & South Sandwich Islands", weight: 0.40 },
    { country: "Brazil", weight: 0.20 },
    { country: "South Africa", weight: 0.10 },
  ],
  [-1]: [{ country: "Portugal", weight: 0.35 }, { country: "United Kingdom", weight: 0.25 }, { country: "Morocco", weight: 0.20 }],
  [0]: [
    { country: "United Kingdom", weight: 0.35 },
    { country: "Ireland", weight: 0.20 },
    { country: "Portugal", weight: 0.15 },
    { country: "Ghana", weight: 0.10 },
  ],
  [1]: [
    { country: "Germany", weight: 0.25 },
    { country: "France", weight: 0.20 },
    { country: "Netherlands", weight: 0.10 },
    { country: "United Kingdom", weight: 0.08 },
    { country: "Italy", weight: 0.12 },
  ],
  [2]: [
    { country: "Egypt", weight: 0.25 },
    { country: "Greece", weight: 0.15 },
    { country: "South Africa", weight: 0.15 },
    { country: "Turkey", weight: 0.15 },
  ],
  [3]: [
    { country: "Saudi Arabia", weight: 0.25 },
    { country: "United Arab Emirates", weight: 0.20 },
    { country: "Russia", weight: 0.15 },
    { country: "Israel", weight: 0.10 },
  ],
  [4]: [
    { country: "United Arab Emirates", weight: 0.35 },
    { country: "Oman", weight: 0.15 },
    { country: "Azerbaijan", weight: 0.15 },
    { country: "Saudi Arabia", weight: 0.10 },
  ],
  [5]: [
    { country: "Pakistan", weight: 0.45 },
    { country: "Uzbekistan", weight: 0.15 },
    { country: "Tajikistan", weight: 0.10 },
  ],
  [6]: [
    { country: "Bangladesh", weight: 0.40 },
    { country: "Uzbekistan", weight: 0.15 },
    { country: "Bhutan", weight: 0.10 },
  ],
  [7]: [
    { country: "Vietnam", weight: 0.35 },
    { country: "Thailand", weight: 0.25 },
    { country: "Indonesia", weight: 0.20 },
    { country: "Cambodia", weight: 0.10 },
    { country: "Laos", weight: 0.10 },
  ],
  [8]: [
    { country: "China", weight: 0.30 },
    { country: "Singapore", weight: 0.15 },
    { country: "Malaysia", weight: 0.15 },
    { country: "Philippines", weight: 0.15 },
    { country: "Taiwan", weight: 0.10 },
  ],
  [9]: [
    { country: "Japan", weight: 0.45 },
    { country: "South Korea", weight: 0.35 },
    { country: "Russia", weight: 0.10 },
  ],
  [10]: [
    { country: "Australia", weight: 0.40 },
    { country: "Papua New Guinea", weight: 0.20 },
    { country: "Russia", weight: 0.15 },
  ],
  [11]: [
    { country: "Solomon Islands", weight: 0.40 },
    { country: "New Caledonia", weight: 0.20 },
    { country: "Russia", weight: 0.15 },
  ],
  [12]: [
    { country: "New Zealand", weight: 0.35 },
    { country: "Fiji", weight: 0.20 },
    { country: "Kiribati", weight: 0.20 },
  ],
  [13]: [{ country: "Tonga", weight: 0.45 }, { country: "Samoa", weight: 0.35 }],
  [14]: [{ country: "Kiribati", weight: 1.0 }],
};

function getOffsetCountries(offsetHours: number): OffsetCountryWeight[] {
  return COUNTRIES_BY_OFFSET[offsetHours] ?? [{ country: "Unknown", weight: 1 }];
}

export function timezoneCandidatesToCountryCandidates(
  timezoneCandidates: TimezoneCandidate[],
  topK = 5
): { countryCandidates: CountryGuessCandidate[]; bestCountry: CountryGuessCandidate | null } {
  const byCountry = new Map<string, { score: number; bestTz: TimezoneCandidate; offset: number }>();

  for (const tz of timezoneCandidates) {
    const countries = getOffsetCountries(tz.offsetHours);
    const totalW = countries.reduce((a, b) => a + b.weight, 0) || 1;

    for (const c of countries) {
      const add = tz.percent * (c.weight / totalW);
      const prev = byCountry.get(c.country);
      if (!prev) {
        byCountry.set(c.country, { score: add, bestTz: tz, offset: tz.offsetHours });
      } else {
        prev.score += add;
        // Keep the timezone that contributed most (rough).
        if (tz.score > prev.bestTz.score) {
          prev.bestTz = tz;
          prev.offset = tz.offsetHours;
        }
      }
    }
  }

  const scored = Array.from(byCountry.entries())
    .map(([country, v]) => ({
      country,
      offsetHours: v.offset,
      score: v.score,
      percent: 0, // filled later
      timezoneLabel: v.bestTz.label,
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, topK);
  const sum = top.reduce((a, b) => a + b.score, 0) || 1;
  const countryCandidates: CountryGuessCandidate[] = top.map((c) => ({
    ...c,
    percent: (c.score / sum) * 100,
  }));

  return {
    countryCandidates,
    bestCountry: countryCandidates.length ? countryCandidates[0] : null,
  };
}

