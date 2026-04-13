/**
 * Quét ví trong src/data/data.csv: với mỗi ví lấy **đối tác chrono đầu tiên**
 * chưa có `name` trong entityLabels (theo getEntitiesMap), thử:
 *  1) Etherscan nametag API (nếu key Pro)
 *  2) Fallback: tiêu đề HTML etherscan.io/address/... (thường có "Bitpanda 3 | ...")
 *
 * Chỉ append mục mới vào entityLabels.json (giữ thứ tự phần cũ).
 *
 * Usage:
 *   npx tsx scripts/sync-labels-from-data-csv.ts [--dry-run]
 *
 * Biến môi trường (tùy chọn):
 *   ETHERSCAN_API_KEY_CRAWL — ưu tiên; ETHERSCAN_API_KEY — fallback
 *   CSV_SYNC_SCRAPE_DELAY_MS — mặc định 550 (giữa mỗi lần fetch HTML)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "ethers";
import { getEntitiesMap } from "../src/lib/entities";
import { inferCexCountryFromLabelPieces } from "../src/lib/cexCountryFromLabel";
import type { EtherscanNametagRow } from "../src/lib/etherscanNametag";
import { fetchEtherscanAddressNametag } from "../src/lib/etherscanNametag";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CSV_PATH = path.join(ROOT, "src", "data", "data.csv");
const LABELS_PATH = path.join(ROOT, "src", "data", "entityLabels.json");

const API_BASE = "https://api.etherscan.io/v2/api";
const CHAIN_ID = "1";
const ASC_OFFSET = 50;
const DELAY_TX_MS = 220;

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DELAY_SCRAPE_MS = envMs("CSV_SYNC_SCRAPE_DELAY_MS", 550);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadApiKey(): string {
  const envPath = path.join(ROOT, ".env");
  let raw = "";
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    /* empty */
  }
  const fromFile = (key: string): string =>
    raw.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return (
    process.env.ETHERSCAN_API_KEY_CRAWL?.trim() ||
    fromFile("ETHERSCAN_API_KEY_CRAWL") ||
    process.env.ETHERSCAN_API_KEY?.trim() ||
    fromFile("ETHERSCAN_API_KEY") ||
    ""
  );
}

function parseCsvWallets(filePath: string): string[] {
  const text = fs.readFileSync(filePath, "utf8");
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const addr = t.split(",")[0]?.trim();
    if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) out.push(addr);
  }
  return out;
}

type Source = "txlist" | "txlistinternal" | "tokentx";

type Row = {
  hash: string;
  timeStamp: number;
  from: string | null;
  to: string | null;
  source: Source;
};

function collectRows(list: unknown[], source: Source): Row[] {
  const out: Row[] = [];
  if (!Array.isArray(list)) return out;
  for (const t of list) {
    const o = t as Record<string, unknown>;
    const h = typeof o.hash === "string" ? o.hash.trim() : "";
    if (!h) continue;
    const ts = Number(o.timeStamp);
    if (!Number.isFinite(ts)) continue;
    out.push({
      hash: h,
      timeStamp: ts,
      from: typeof o.from === "string" ? o.from : null,
      to: typeof o.to === "string" ? o.to : null,
      source,
    });
  }
  return out;
}

function dedupeByHash(rows: Row[]): Row[] {
  const byHash = new Map<string, Row>();
  for (const r of rows) {
    const k = r.hash.toLowerCase();
    const prev = byHash.get(k);
    if (!prev || r.timeStamp < prev.timeStamp) byHash.set(k, { ...r });
  }
  return Array.from(byHash.values());
}

function mergeChrono(args: {
  txs: unknown[];
  internal: unknown[];
  tokens: unknown[];
}): Row[] {
  const rows = dedupeByHash([
    ...collectRows(args.txs, "txlist"),
    ...collectRows(args.internal, "txlistinternal"),
    ...collectRows(args.tokens, "tokentx"),
  ]);
  return rows.filter((r) => Number.isFinite(r.timeStamp)).sort((a, b) => a.timeStamp - b.timeStamp);
}

function counterparty(row: Row, targetLower: string): string | null {
  const from = (row.from || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  if (from === targetLower && to && to !== targetLower) return to;
  if (to === targetLower && from && from !== targetLower) return from;
  return null;
}

async function fetchAccountAction(
  apiKey: string,
  address: string,
  action: Source
): Promise<unknown[]> {
  const url = new URL(API_BASE);
  url.searchParams.set("chainid", CHAIN_ID);
  url.searchParams.set("module", "account");
  url.searchParams.set("action", action);
  url.searchParams.set("address", getAddress(address));
  url.searchParams.set("startblock", "0");
  url.searchParams.set("endblock", "99999999");
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(ASC_OFFSET));
  url.searchParams.set("sort", "asc");
  url.searchParams.set("apikey", apiKey);
  const res = await fetch(url.toString(), { cache: "no-store" });
  const data = (await res.json().catch(() => null)) as {
    status?: string;
    result?: unknown;
  } | null;
  if (!data || data.status !== "1") return [];
  const r = data.result;
  return Array.isArray(r) ? r : [];
}

function isNoisyNametag(s: string): boolean {
  return /scam|phish|hack|exploit|spam|drainer|blocked/i.test(s.toLowerCase());
}

function nametagLooksLikeNumberedHotWallet(nt: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9]*\s+\d{1,4}$/.test(nt.trim());
}

function labelsSuggestExchange(labels: string[]): boolean {
  return labels.some((l) => /exchange|cex|custody|hot\s*wallet/i.test(l));
}

function guessTypeFromName(name: string): "CEX" | "DEX" | "BRIDGE" | "OTHER" {
  const n = name.toLowerCase();
  if (/\b(router|pool|swap|uniswap|sushiswap|pancake|curve|balancer|aerodrome)\b/i.test(n))
    return "DEX";
  if (/\b(bridge|wormhole|stargate|synapse|layerzero|celer)\b/i.test(n)) return "BRIDGE";
  return "OTHER";
}

function rowToLabel(
  addressChecksum: string,
  row: EtherscanNametagRow
): {
  address: string;
  name: string;
  type: "CEX" | "DEX" | "BRIDGE" | "MIXER" | "LENDING" | "GAMING" | "PAYMENT" | "OTHER";
  country: string;
  countryHints: string[];
} {
  const nt = row.nametag.trim();
  const labels = row.labels ?? [];
  const pieces = [nt, ...labels];
  const inferred = inferCexCountryFromLabelPieces(pieces);
  const looksCex =
    inferred != null ||
    labelsSuggestExchange(labels) ||
    nametagLooksLikeNumberedHotWallet(nt);

  let type: "CEX" | "DEX" | "BRIDGE" | "OTHER" = "OTHER";
  if (inferred) type = "CEX";
  else {
    const g = guessTypeFromName(nt);
    if (g === "DEX" || g === "BRIDGE") type = g;
    else if (looksCex) type = "CEX";
    else type = "OTHER";
  }

  let country = "Unknown";
  let countryHints: string[] = ["Unknown"];
  if (inferred) {
    country = inferred.country;
    countryHints = [...inferred.countryHints];
  } else if (type === "DEX") {
    country = "global";
    countryHints = ["global"];
  } else if (type === "BRIDGE") {
    country = "United States";
    countryHints = ["United States", "global"];
  }

  return {
    address: addressChecksum,
    name: nt,
    type,
    country,
    countryHints,
  };
}

function isLabeledInMap(
  map: ReturnType<typeof getEntitiesMap>,
  addrLower: string
): boolean {
  const e = map.get(addrLower);
  return Boolean(e?.name?.trim());
}

/** Tiêu đề trang Etherscan: "Bitpanda 3 | Address: ..." hoặc "Address 0x... | Etherscan" */
async function scrapeEtherscanTitleName(checksum: string): Promise<string | null> {
  const url = `https://etherscan.io/address/${checksum}`;
  const res = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<title>([^<]{1,200})<\/title>/i);
  if (!m) return null;
  const title = m[1].replace(/\s+/g, " ").trim();
  const first = title.split("|")[0]?.trim() ?? "";
  if (!first || first.length < 2) return null;
  if (/^address\s*[:\s]/i.test(first)) return null;
  if (/\b0x[a-fA-F0-9]{8,}\b/.test(first)) return null;
  if (/^ethereum\s*\(/i.test(first)) return null;
  if (isNoisyNametag(first)) return null;
  return first;
}

async function resolvePublicName(
  apiKey: string,
  checksum: string
): Promise<EtherscanNametagRow | null> {
  if (apiKey) {
    const fetched = await fetchEtherscanAddressNametag({
      apiBase: API_BASE,
      chainId: CHAIN_ID,
      apiKey,
      address: checksum,
    });
    if (fetched.ok) {
      const nt = fetched.row.nametag.trim();
      if (nt && !isNoisyNametag(nt)) return fetched.row;
    }
  }
  const scraped = await scrapeEtherscanTitleName(checksum);
  if (scraped) return { nametag: scraped, labels: [] };
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error("Cần ETHERSCAN_API_KEY_CRAWL hoặc ETHERSCAN_API_KEY trong .env để tải txlist / tokentx / internal.");
    process.exit(1);
  }

  const wallets = parseCsvWallets(CSV_PATH);
  console.log(`Wallets trong data.csv: ${wallets.length}`);

  const entityMap = getEntitiesMap();
  /** Đối tác đầu tiên (chrono) chưa có nhãn local — mỗi ví tối đa 1 địa chỉ */
  const firstMissingByWallet: { wallet: string; counterpartyLower: string }[] = [];

  for (let i = 0; i < wallets.length; i += 1) {
    const w = wallets[i];
    const targetLower = getAddress(w).toLowerCase();
    await sleep(DELAY_TX_MS);
    const txs = await fetchAccountAction(apiKey, w, "txlist");
    await sleep(DELAY_TX_MS);
    const internal = await fetchAccountAction(apiKey, w, "txlistinternal");
    await sleep(DELAY_TX_MS);
    const tokens = await fetchAccountAction(apiKey, w, "tokentx");

    const sorted = mergeChrono({ txs, internal, tokens });
    let found: string | null = null;
    for (const row of sorted) {
      const cp = counterparty(row, targetLower);
      if (!cp || !isAddress(cp)) continue;
      const cpLower = getAddress(cp).toLowerCase();
      if (isLabeledInMap(entityMap, cpLower)) continue;
      found = cpLower;
      break;
    }
    if (found) firstMissingByWallet.push({ wallet: w, counterpartyLower: found });
    if ((i + 1) % 25 === 0) {
      console.log(`  Đã quét ${i + 1}/${wallets.length} ví — ví còn thiếu nhãn đối tác đầu: ${firstMissingByWallet.length}`);
    }
  }

  const uniqueCp = [...new Set(firstMissingByWallet.map((x) => x.counterpartyLower))];
  console.log(`\nVí có đối tác đầu chưa trong entityLabels: ${firstMissingByWallet.length}`);
  console.log(`Địa chỉ đối tác unique cần resolve: ${uniqueCp.length}`);

  const proposals: ReturnType<typeof rowToLabel>[] = [];
  let resolved = 0;
  let failed = 0;

  for (let i = 0; i < uniqueCp.length; i += 1) {
    const cpLower = uniqueCp[i];
    let checksum: string;
    try {
      checksum = getAddress(cpLower);
    } catch {
      failed += 1;
      continue;
    }
    if (i > 0) await sleep(DELAY_SCRAPE_MS);
    const row = await resolvePublicName(apiKey, checksum);
    if (!row) {
      failed += 1;
      continue;
    }
    resolved += 1;
    proposals.push(rowToLabel(checksum, row));
    if ((i + 1) % 10 === 0) {
      console.log(`  Resolve ${i + 1}/${uniqueCp.length}…`);
    }
  }

  console.log(`\nResolve OK: ${resolved}, thất bại: ${failed}`);
  console.log(`Đề xuất thêm: ${proposals.length}`);

  const missingPath = path.join(__dirname, "data-csv-first-missing-counterparties.txt");
  const still = uniqueCp.filter(
    (low) => !proposals.some((p) => getAddress(p.address).toLowerCase() === low)
  );
  if (still.length) {
    fs.writeFileSync(missingPath, `${still.join("\n")}\n`, "utf8");
    console.log(`Ghi ${still.length} địa chỉ chưa resolve → ${missingPath}`);
  }

  if (dryRun || proposals.length === 0) {
    if (dryRun) console.log("--dry-run: không ghi entityLabels.json");
    return;
  }

  const raw = fs.readFileSync(LABELS_PATH, "utf8");
  const arr = JSON.parse(raw) as Array<Record<string, unknown>>;
  if (!Array.isArray(arr)) {
    console.error("entityLabels.json không phải mảng.");
    process.exit(1);
  }

  const existingLower = new Set<string>();
  for (const e of arr) {
    const a = typeof e.address === "string" ? e.address : "";
    try {
      if (a && isAddress(a)) existingLower.add(getAddress(a).toLowerCase());
    } catch {
      /* skip */
    }
  }

  let appended = 0;
  for (const p of proposals) {
    const low = getAddress(p.address).toLowerCase();
    if (existingLower.has(low)) continue;
    existingLower.add(low);
    arr.push({ ...p });
    appended += 1;
  }

  fs.writeFileSync(LABELS_PATH, `${JSON.stringify(arr, null, 2)}\n`, "utf8");
  console.log(`Đã append ${appended} mục vào entityLabels.json (tổng ${arr.length}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
