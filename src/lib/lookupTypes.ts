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
  network: "ethereum" | "multichain-evm";
  totalTxFetched: number; // summed across chains
  totalMatchedEntities: number;
  candidates: CountryCandidate[];
  bestCandidate: CountryCandidate | null;
  message?: string;
  unlabeledCounterparties?: string[]; // counterparties found in tx endpoints but missing from entities.json
  timezoneCandidates?: TimezoneCandidate[];
  countryCandidates?: CountryGuessCandidate[];
  topCountries?: CountryGuessCandidate[];
  bestCountry?: CountryGuessCandidate | null;
  confidence?: number; // 0..1 calibrated
  walletType?: "human" | "bot" | "exchange" | "contract";
  signalBreakdown?: {
    timezone: number; // 0..1 contribution weight after reliability
    counterparty: number; // 0..1
    token: number; // 0..1
    protocol: number; // 0..1
  };
  diagnostics?: {
    totalTx: number;
    timezoneEntropy: number; // 0..1 normalized
    timezoneReliability: number; // 0..1
    tokenReliability: number; // 0..1
    protocolReliability: number; // 0..1
    counterpartyReliability: number; // 0..1
    uniqueCounterparties: number;
    fallbackUsed: boolean;
  };
  perChainTxFetched?: Record<string, number>;
  utcHourHistogram?: number[]; // length 24, aggregated across chains
  build?: {
    commit?: string;
    service?: string;
  };
  etherscanDiagnostics?: Record<
    string,
    {
      ok: boolean;
      status?: string;
      message?: string;
      resultType?: string;
      note?: string;
    }
  >;
  scannedTransactions?: Array<{
    hash: string;
    source: "txlist" | "txlistinternal" | "tokentx";
    timeStamp?: number | null;
    from?: string | null;
    to?: string | null;
  }>;
};

export type CountryGuessCandidate = {
  country: string;
  offsetHours: number;
  score: number;
  percent: number; // 0..100 among returned candidates
  // explain which timezone bin contributed most.
  timezoneLabel: string;
};

