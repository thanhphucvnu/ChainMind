export type EntityMatch = {
  address: string; // address of the matched entity (checksum if possible)
  name?: string;
  type?: "CEX" | "DEX" | "BRIDGE" | "MIXER" | "LENDING" | "GAMING" | "PAYMENT" | "OTHER";
};

/** Earliest tx involving the wallet within the fetched batch (not necessarily absolute chain-first). */
export type FirstTransactionInfo = {
  hash: string;
  timeStamp: number | null;
  source: "txlist" | "txlistinternal" | "tokentx";
  direction: "in" | "out";
  counterparty: string;
  /** From entities / nametag (e.g. exchange display name). */
  exchangeOrEntityName?: string;
  entityType?: EntityMatch["type"];
  /** Primary country for this counterparty (entity country or inferred from name). */
  exchangePrimaryCountry?: string;
  exchangeCountryHints?: string[];
  /** Thứ tự 1-based trong batch (sớm → muộn, chỉ giao dịch có timestamp). */
  chronologicalIndex?: number;
  /** Tổng số giao dịch trong batch sau khi gộp & sắp theo thời gian. */
  chronologicalTotalCount?: number;
  /** Đã tìm được tên nhãn (entity / explorer) khi quét; false = chỉ hiển thị tx sớm nhất không có tên. */
  namedCounterpartyResolved?: boolean;
  note?: string;
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
  /** Khớp nguồn nhãn tin cậy (verifiedWalletLabels); không gọi Etherscan. */
  groundTruth?: {
    source: "verified_wallet_labels";
    /** Khóa tra cứu trong store = SHA256(address_lower + salt). */
    lookup: "sha256_salt_index";
  };
  network: "ethereum" | "multichain-evm";
  totalTxFetched: number; // summed across chains
  totalMatchedEntities: number;
  candidates: CountryCandidate[];
  bestCandidate: CountryCandidate | null;
  message?: string;
  /** Earliest activity in loaded tx batch + counterparty label when known. */
  firstTransaction?: FirstTransactionInfo;
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
    /** True when histogram did not yield timezone candidates (prior fallback). */
    fallbackUsed?: boolean;
    /** True when learned JSON head was applied after fuse. */
    learnedModelApplied?: boolean;
    /** Why learned head was skipped (e.g. invalid file, empty probs). */
    learnedModelSkipReason?: string;
    /** Dynamic explorer nametag → brand → country (see LOOKUP_NAMETAG_CHRONO_MAX). */
    nametagResolution?: Array<{
      address: string;
      nametag?: string;
      inferredCountry?: string;
      skipped?: string;
    }>;
    /** True when final country ranking was blended toward first-tx CEX country. */
    firstTxCountryPriorityApplied?: boolean;
    /** Weight given to first-tx CEX country prior (see LOOKUP_FIRST_TX_COUNTRY_BLEND). */
    firstTxCountryBlendAlpha?: number;
    /** Địa chỉ khớp index nhãn đã xác minh (data.csv → verifiedWalletLabels.json). */
    verifiedGroundTruth?: boolean;
  };
  graph?: {
    nodes: number;
    edges: number;
    twoHopScanned?: number;
    twoHopUsed?: boolean;
    twoHopSkippedReason?: string;
    twoHopTopEntities?: Array<{
      address: string;
      name?: string;
      type?: EntityMatch["type"];
      countryHints?: string[];
      score: number;
    }>;
    topCounterparties?: Array<{
      address: string;
      txCount: number;
      weight: number;
      entity?: { name?: string; type?: EntityMatch["type"]; countryHints?: string[] };
    }>;
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
  /** Extra shape stats for ML export / learned head (UTC weekday share, etc.). */
  trainingShape?: {
    weekdayShare: number;
    peakHourNorm: number;
    earlyEntitySignalNorm: number;
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

