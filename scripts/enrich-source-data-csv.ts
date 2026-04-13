/**
 * Đọc danh sách địa chỉ (phase 1), gọi Etherscan account APIs, suy quốc gia từ
 * giao dịch chrono sớm nhất trong batch (txlist + internal + token) giống
 * firstTransactionSummary.buildFirstTransactionInfo.
 *
 * Ghi / append src/data/source-data.csv dạng address,Country (resume: bỏ qua
 * địa chỉ đã có trong file out). Mỗi lần chạy: nếu file out có nhiều dòng cùng
 * địa chỉ, gộp thành một (giữ bản ghi cuối), sắp xếp theo address rồi mới tiếp tục.
 * Các dòng quốc gia `Unknown` bị xóa khỏi CSV; địa chỉ đã thử ra Unknown được ghi vào
 * file kèm `*.unknown-attempts.txt` để lần sau không gọi API lặp lại.
 * File địa chỉ đầu vào cũng được lọc trùng theo thứ tự xuất hiện.
 *
 * Env:
 *   ETHERSCAN_API_KEY_CRAWL — ưu tiên cho script (tách pool với web)
 *   ETHERSCAN_API_KEY — fallback nếu không set CRAWL
 *   ENRICH_TX_DELAY_MS — mặc định 200 (giữa mỗi request Etherscan; ~5 req/s free tier)
 *   ENRICH_TX_OFFSET — mặc định 100 (offset sort=asc mỗi loại)
 *   ENRICH_SCRAPE_DELAY_MS — mặc định 450 (trước khi scrape HTML fallback)
 *
 * Usage:
 *   npx tsx scripts/enrich-source-data-csv.ts --in src/data/source-addresses.txt
 *   npx tsx scripts/enrich-source-data-csv.ts --in src/data/source-addresses.txt --out src/data/source-data.csv
 *   npx tsx scripts/enrich-source-data-csv.ts --dedupe-only [--out src/data/source-data.csv]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "ethers";
import { getEntitiesMap } from "../src/lib/entities";
import { buildFirstTransactionInfo } from "../src/lib/firstTransactionSummary";
import { inferCexCountryFromLabelPieces } from "../src/lib/cexCountryFromLabel";
import { fetchEtherscanAddressNametag } from "../src/lib/etherscanNametag";
import type { EtherscanNametagRow } from "../src/lib/etherscanNametag";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const API_BASE = "https://api.etherscan.io/v2/api";
const CHAIN_ID = "1";

const DEFAULT_IN = path.join(ROOT, "src", "data", "source-addresses.txt");
const DEFAULT_OUT = path.join(ROOT, "src", "data", "source-data.csv");

type Source = "txlist" | "txlistinternal" | "tokentx";

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Tuần tự từng request: 200ms ≈ 5 req/s (hướng dẫn free tier). Tăng nếu hay 429/NOTOK rate limit. */
const DELAY_REQ_MS = envMs("ENRICH_TX_DELAY_MS", 200);
const SCRAPE_DELAY_MS = envMs("ENRICH_SCRAPE_DELAY_MS", 450);

let enrichRateLimitHits = 0;

function warnRateLimitRevert() {
  enrichRateLimitHits += 1;
  if (enrichRateLimitHits !== 1 && enrichRateLimitHits % 12 !== 0) return;
  console.warn(
    "\n=== [RATE LIMIT] Etherscan ===\n" +
      "Nếu thông báo này lặp lại nhiều: dừng job, đặt ENRICH_TX_DELAY_MS lại an toàn hơn rồi chạy tiếp:\n" +
      '  PowerShell: $env:ENRICH_TX_DELAY_MS="250"\n' +
      "  (hoặc 280–300 nếu vẫn limit). Trước khi tối ưu tốc độ mặc định là 250ms.\n" +
      `  (đếm sự kiện rate-limit: ${enrichRateLimitHits})\n`
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tránh dừng cả batch khi TLS/socket reset (UND_ERR_SOCKET, fetch failed). */
async function fetchResilient(
  url: string,
  label: string,
  init?: RequestInit
): Promise<Response> {
  const max = 8;
  let last: unknown;
  const merged: RequestInit = { cache: "no-store", ...init };
  for (let i = 1; i <= max; i += 1) {
    try {
      return await fetch(url, merged);
    } catch (e) {
      last = e;
      const ms = Math.min(45_000, 2000 * 2 ** (i - 1));
      console.warn(
        `[${label}] Lỗi mạng (${i}/${max}), chờ ${ms}ms:`,
        e instanceof Error ? e.message : e
      );
      await sleep(ms);
    }
  }
  throw last;
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

function parseArgs(): { inPath: string; outPath: string; offset: number } {
  const argv = process.argv.slice(2);
  let inPath = DEFAULT_IN;
  let outPath = DEFAULT_OUT;
  let offset = envMs("ENRICH_TX_OFFSET", 100);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--in" && argv[i + 1]) {
      inPath = path.resolve(ROOT, argv[++i]);
    } else if (a === "--out" && argv[i + 1]) {
      outPath = path.resolve(ROOT, argv[++i]);
    } else if (a === "--offset" && argv[i + 1]) {
      offset = Math.max(1, Math.min(10000, parseInt(argv[++i], 10) || offset));
    }
  }
  return { inPath, outPath, offset };
}

function loadAddressesFromFile(filePath: string): string[] {
  const text = fs.readFileSync(filePath, "utf8");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const first = t.split(",")[0]?.trim() ?? "";
    if (first && /^0x[a-fA-F0-9]{40}$/.test(first)) {
      const checksum = getAddress(first);
      const low = checksum.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(checksum);
    }
  }
  return out;
}

function isUnknownCountry(country: string): boolean {
  return country.trim().toLowerCase() === "unknown";
}

function unknownAttemptsPath(outCsv: string): string {
  if (outCsv.toLowerCase().endsWith(".csv")) {
    return `${outCsv.slice(0, -4)}.unknown-attempts.txt`;
  }
  return `${outCsv}.unknown-attempts.txt`;
}

function loadLowerAddressLines(filePath: string): Set<string> {
  const s = new Set<string>();
  if (!fs.existsSync(filePath)) return s;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().toLowerCase();
    if (t && /^0x[a-f0-9]{40}$/.test(t)) s.add(t);
  }
  return s;
}

/**
 * Trùng địa chỉ: giữ giá trị **dòng cuối** (kể cả Unknown). Sau đó bỏ hết Unknown khỏi CSV;
 * trả về tập địa chỉ cuối cùng là Unknown để ghi vào file attempts (resume).
 */
function dedupeOutCsv(outPath: string): {
  done: Set<string>;
  duplicateRowsDropped: number;
  unknownRowsRemoved: number;
  unknownLowersFromCsv: Set<string>;
} {
  const empty = (): {
    done: Set<string>;
    duplicateRowsDropped: number;
    unknownRowsRemoved: number;
    unknownLowersFromCsv: Set<string>;
  } => ({
    done: new Set(),
    duplicateRowsDropped: 0,
    unknownRowsRemoved: 0,
    unknownLowersFromCsv: new Set(),
  });
  if (!fs.existsSync(outPath)) return empty();
  const text = fs.readFileSync(outPath, "utf8");
  const lastWin = new Map<string, string>();
  let parsedRows = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const comma = t.indexOf(",");
    if (comma < 0) continue;
    const addr = t.slice(0, comma).trim();
    const country = t.slice(comma + 1).trim();
    if (!addr || !/^0x[a-fA-F0-9]{40}$/i.test(addr)) continue;
    parsedRows += 1;
    lastWin.set(addr.toLowerCase(), country);
  }
  const duplicateRowsDropped = parsedRows - lastWin.size;

  const unknownLowersFromCsv = new Set<string>();
  const kept = new Map<string, string>();
  for (const [low, country] of lastWin) {
    if (isUnknownCountry(country)) unknownLowersFromCsv.add(low);
    else kept.set(low, country);
  }
  const unknownRowsRemoved = unknownLowersFromCsv.size;

  const needsRewrite = duplicateRowsDropped > 0 || unknownRowsRemoved > 0;
  if (needsRewrite) {
    const sorted = [...kept.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const body = sorted.map(([low, c]) => `${low},${c}`).join("\n");
    fs.writeFileSync(outPath, sorted.length > 0 ? `${body}\n` : "", "utf8");
  }
  return {
    done: new Set(kept.keys()),
    duplicateRowsDropped,
    unknownRowsRemoved,
    unknownLowersFromCsv,
  };
}

function isNoisyNametag(s: string): boolean {
  return /scam|phish|hack|exploit|spam|drainer|blocked/i.test(s.toLowerCase());
}

async function scrapeEtherscanTitleName(checksum: string): Promise<string | null> {
  await sleep(SCRAPE_DELAY_MS);
  const url = `https://etherscan.io/address/${checksum}`;
  const res = await fetchResilient(url, "scrape", {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
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

async function resolveNametagForCounterparty(
  apiKey: string,
  checksum: string
): Promise<EtherscanNametagRow | null> {
  if (apiKey) {
    await sleep(DELAY_REQ_MS);
    let fetched: Awaited<ReturnType<typeof fetchEtherscanAddressNametag>> | null = null;
    for (let n = 1; n <= 6; n += 1) {
      try {
        fetched = await fetchEtherscanAddressNametag({
          apiBase: API_BASE,
          chainId: CHAIN_ID,
          apiKey,
          address: checksum,
        });
        break;
      } catch (e) {
        const ms = Math.min(30_000, 1500 * 2 ** (n - 1));
        console.warn(
          `[nametag] Lỗi mạng (${n}/6), chờ ${ms}ms:`,
          e instanceof Error ? e.message : e
        );
        await sleep(ms);
      }
    }
    if (fetched?.ok) {
      const nt = fetched.row.nametag.trim();
      if (nt && !isNoisyNametag(nt)) return fetched.row;
    }
  }
  const scraped = await scrapeEtherscanTitleName(checksum);
  if (scraped) return { nametag: scraped, labels: [] };
  return null;
}

async function fetchAccountAction(
  apiKey: string,
  address: string,
  action: Source,
  offset: number
): Promise<unknown[]> {
  const url = new URL(API_BASE);
  url.searchParams.set("chainid", CHAIN_ID);
  url.searchParams.set("module", "account");
  url.searchParams.set("action", action);
  url.searchParams.set("address", getAddress(address));
  url.searchParams.set("startblock", "0");
  url.searchParams.set("endblock", "99999999");
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("sort", "asc");
  url.searchParams.set("apikey", apiKey);

  const maxAttempts = 5;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    await sleep(DELAY_REQ_MS);
    const res = await fetchResilient(url.toString(), `account:${action}`);
    const data = (await res.json().catch(() => null)) as {
      status?: string;
      message?: string;
      result?: unknown;
    } | null;

    if (!data) {
      await sleep(1500 * attempt);
      continue;
    }

    const msg = (data.message || "").toString().toLowerCase();
    if (msg.includes("rate") || msg.includes("limit") || res.status === 429) {
      warnRateLimitRevert();
      await sleep(2000 * attempt);
      continue;
    }

    if (data.status === "1") {
      const r = data.result;
      return Array.isArray(r) ? r : [];
    }

    const resultStr =
      typeof data.result === "string" ? data.result.toLowerCase() : "";
    if (resultStr.includes("rate") || resultStr.includes("limit")) {
      warnRateLimitRevert();
      await sleep(2000 * attempt);
      continue;
    }

    return [];
  }
  return [];
}

async function resolveCountryForWallet(
  apiKey: string,
  wallet: string,
  offset: number,
  entitiesMap: ReturnType<typeof getEntitiesMap>
): Promise<string> {
  const targetLower = getAddress(wallet).toLowerCase();

  const txs = await fetchAccountAction(apiKey, wallet, "txlist", offset);
  const internal = await fetchAccountAction(apiKey, wallet, "txlistinternal", offset);
  const tokens = await fetchAccountAction(apiKey, wallet, "tokentx", offset);

  let info = buildFirstTransactionInfo({
    targetLower,
    txs: txs as Parameters<typeof buildFirstTransactionInfo>[0]["txs"],
    internalTxs: internal as Parameters<typeof buildFirstTransactionInfo>[0]["internalTxs"],
    tokenTxs: tokens as Parameters<typeof buildFirstTransactionInfo>[0]["tokenTxs"],
    entitiesMap,
    maxTxPerType: offset,
  });

  if (!info) {
    return "Unknown";
  }

  if (info.exchangePrimaryCountry?.trim()) {
    return info.exchangePrimaryCountry.trim();
  }

  if (info.exchangeOrEntityName?.trim()) {
    const inf = inferCexCountryFromLabelPieces([info.exchangeOrEntityName.trim()]);
    if (inf) return inf.country;
  }

  const cp = info.counterparty;
  if (!cp || !isAddress(cp)) {
    return "Unknown";
  }

  const row = await resolveNametagForCounterparty(apiKey, cp);
  if (!row) {
    return "Unknown";
  }

  const pieces = [row.nametag.trim(), ...(row.labels ?? [])].filter(Boolean);
  const inferred = inferCexCountryFromLabelPieces(pieces);
  if (inferred) return inferred.country;

  info = buildFirstTransactionInfo({
    targetLower,
    txs: txs as Parameters<typeof buildFirstTransactionInfo>[0]["txs"],
    internalTxs: internal as Parameters<typeof buildFirstTransactionInfo>[0]["internalTxs"],
    tokenTxs: tokens as Parameters<typeof buildFirstTransactionInfo>[0]["tokenTxs"],
    entitiesMap,
    nametagResolution: [{ address: cp, nametag: row.nametag }],
    maxTxPerType: offset,
  });

  if (info?.exchangePrimaryCountry?.trim()) {
    return info.exchangePrimaryCountry.trim();
  }

  return "Unknown";
}

function normalizeOutCsvAndAttempts(outPath: string): {
  done: Set<string>;
  attemptsPath: string;
} {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (!fs.existsSync(outPath)) {
    fs.writeFileSync(outPath, "", "utf8");
  }
  const attemptsPath = unknownAttemptsPath(outPath);
  const {
    done: doneCsv,
    duplicateRowsDropped,
    unknownRowsRemoved,
    unknownLowersFromCsv,
  } = dedupeOutCsv(outPath);
  if (duplicateRowsDropped > 0) {
    console.log(
      `Đã khử trùng ${outPath}: bỏ ${duplicateRowsDropped} dòng trùng địa chỉ, còn ${doneCsv.size} dòng trong CSV.`
    );
  }
  if (unknownRowsRemoved > 0) {
    console.log(
      `Đã xóa ${unknownRowsRemoved} địa chỉ (Unknown) khỏi ${path.basename(outPath)}.`
    );
  }
  const doneAttempts = loadLowerAddressLines(attemptsPath);
  for (const low of unknownLowersFromCsv) {
    if (!doneAttempts.has(low)) {
      fs.appendFileSync(attemptsPath, `${low}\n`, "utf8");
      doneAttempts.add(low);
    }
  }
  if (unknownLowersFromCsv.size > 0) {
    console.log(
      `Đã ghi ${unknownLowersFromCsv.size} địa chỉ Unknown vào ${path.basename(attemptsPath)} (bỏ qua khi enrich lại).`
    );
  }
  const done = new Set<string>([...doneCsv, ...doneAttempts]);
  return { done, attemptsPath };
}

async function main() {
  const dedupeOnly = process.argv.includes("--dedupe-only");
  const { inPath, outPath, offset } = parseArgs();

  if (dedupeOnly) {
    normalizeOutCsvAndAttempts(outPath);
    console.log("Hoàn tất --dedupe-only.");
    return;
  }

  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error("Cần ETHERSCAN_API_KEY_CRAWL hoặc ETHERSCAN_API_KEY trong .env / biến môi trường.");
    process.exit(1);
  }

  if (!fs.existsSync(inPath)) {
    console.error(`Không tìm thấy file input: ${inPath}`);
    process.exit(1);
  }

  const wallets = loadAddressesFromFile(inPath);
  const entitiesMap = getEntitiesMap();

  const { done, attemptsPath } = normalizeOutCsvAndAttempts(outPath);

  let processed = 0;
  for (let i = 0; i < wallets.length; i += 1) {
    const w = wallets[i];
    const lower = w.toLowerCase();
    if (done.has(lower)) continue;

    let country = "Unknown";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        country = await resolveCountryForWallet(apiKey, w, offset, entitiesMap);
        break;
      } catch (e) {
        console.error(
          `Lỗi ví ${lower} (${attempt}/4):`,
          e instanceof Error ? e.message : e
        );
        if (attempt < 4) {
          await sleep(3000 * attempt);
        }
      }
    }

    if (isUnknownCountry(country)) {
      fs.appendFileSync(attemptsPath, `${lower}\n`, "utf8");
    } else {
      const line = `${lower},${country}\n`;
      fs.appendFileSync(outPath, line, "utf8");
    }
    done.add(lower);
    processed += 1;

    if (processed % 50 === 0 || processed === 1) {
      console.log(`[${processed} mới] ${lower} → ${country}`);
    }
  }

  console.log(
    `Hoàn tất. Đã xử lý thêm ${processed} ví (Unknown → ${path.basename(attemptsPath)}, còn lại → ${path.basename(outPath)}).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
