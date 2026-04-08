import type { CountryGuessCandidate, LookupResponse } from "./lookupTypes";

export function buildGroundTruthLookupResponse(args: {
  addressChecksum: string;
  country: string;
}): LookupResponse {
  const { addressChecksum, country } = args;
  const best: CountryGuessCandidate = {
    country,
    offsetHours: 0,
    timezoneLabel: "Nhãn đã xác minh (dataset nội bộ)",
    score: 1,
    percent: 100,
  };
  return {
    address: addressChecksum,
    groundTruth: {
      source: "verified_wallet_labels",
      lookup: "sha256_salt_index",
    },
    network: "ethereum",
    totalTxFetched: 0,
    totalMatchedEntities: 0,
    candidates: [],
    bestCandidate: null,
    message:
      "Địa chỉ khớp nguồn nhãn tin cậy (tra cứu trước heuristic). Không cần tải giao dịch on-chain cho kết quả quốc gia.",
    countryCandidates: [best],
    topCountries: [best],
    bestCountry: best,
    confidence: 1,
    walletType: "human",
    signalBreakdown: {
      timezone: 0,
      counterparty: 0,
      token: 0,
      protocol: 0,
    },
    diagnostics: {
      totalTx: 0,
      timezoneEntropy: 0,
      timezoneReliability: 0,
      tokenReliability: 0,
      protocolReliability: 0,
      counterpartyReliability: 0,
      uniqueCounterparties: 0,
      fallbackUsed: false,
      verifiedGroundTruth: true,
    },
  };
}
