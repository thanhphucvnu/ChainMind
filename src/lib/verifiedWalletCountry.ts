import { createHash } from "node:crypto";
import { getAddress, isAddress } from "ethers";
import verifiedIndex from "@/data/verifiedWalletLabels.json";

type VerifiedIndexFile = {
  v: number;
  entries: Array<{ k: string; country: string }>;
};

const DEFAULT_SALT = "chainmind:verified-wallet-labels:v1";

function labelSalt(): string {
  const fromEnv = process.env.VERIFIED_WALLET_LABEL_SALT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return DEFAULT_SALT;
}

function hashAddressKey(addressLower: string): string {
  return createHash("sha256").update(addressLower + labelSalt(), "utf8").digest("hex");
}

const verifiedByHash = (() => {
  const raw = verifiedIndex as VerifiedIndexFile;
  const m = new Map<string, string>();
  if (raw?.v === 1 && Array.isArray(raw.entries)) {
    for (const e of raw.entries) {
      if (typeof e?.k === "string" && e.k.length === 64 && typeof e?.country === "string" && e.country.trim()) {
        m.set(e.k.toLowerCase(), e.country.trim());
      }
    }
  }
  return m;
})();

/**
 * Tra cứu quốc gia đã gắn nhãn tin cậy (nguồn verifiedWalletLabels.json, sinh từ data.csv).
 * Khóa lưu trữ = SHA256(lowercase_address + salt), không lưu địa chỉ thô trong JSON.
 */
export function lookupVerifiedWalletCountry(address: string): string | null {
  try {
    if (!isAddress(address)) return null;
    const lower = getAddress(address).toLowerCase();
    const k = hashAddressKey(lower);
    return verifiedByHash.get(k) ?? null;
  } catch {
    return null;
  }
}
