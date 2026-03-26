export type EntityMatch = {
  address: string; // address of the matched entity (checksum if possible)
  name?: string;
};

export type CountryCandidate = {
  country: string;
  count: number; // number of matched tx endpoints for this country
  percent: number; // 0..100 based on totalMatchedEntities
  entities: EntityMatch[];
};

export type TimezoneCandidate = {
  offsetHours: number; // e.g. +7
  label: string; // e.g. "UTC+7"
  score: number;
  percent: number; // 0..100 among returned candidates
};

export type LookupResponse = {
  address: string; // checksummed input
  network: "multichain-evm";
  totalTxFetched: number; // summed across chains
  totalMatchedEntities: number;
  candidates: CountryCandidate[];
  bestCandidate: CountryCandidate | null;
  message?: string;
  unlabeledCounterparties?: string[]; // counterparties found in tx endpoints but missing from entities.json
  timezoneCandidates?: TimezoneCandidate[];
  countryCandidates?: CountryGuessCandidate[];
  bestCountry?: CountryGuessCandidate | null;
  perChainTxFetched?: Record<string, number>;
  utcHourHistogram?: number[]; // length 24, aggregated across chains
  build?: {
    commit?: string;
    service?: string;
  };
};

export type CountryGuessCandidate = {
  country: string;
  offsetHours: number;
  score: number;
  percent: number; // 0..100 among returned candidates
  // explain which timezone bin contributed most.
  timezoneLabel: string;
};

