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

export type LookupResponse = {
  address: string; // checksummed input
  network: "ethereum";
  totalTxFetched: number;
  totalMatchedEntities: number;
  candidates: CountryCandidate[];
  bestCandidate: CountryCandidate | null;
  message?: string;
  unlabeledCounterparties?: string[]; // counterparties found in tx endpoints but missing from entities.json
};

