/**
 * Đọc CSV (address,country), sinh verifiedWalletLabels.json
 * với khóa SHA256(lowercase_address + salt) để không lưu địa chỉ thô trong artifact.
 *
 * Salt: VERIFIED_WALLET_LABEL_SALT hoặc mặc định giống src/lib/verifiedWalletCountry.ts
 *
 * Usage:
 *   npx tsx scripts/generate-verified-labels-from-csv.ts
 *   npx tsx scripts/generate-verified-labels-from-csv.ts --csv src/data/data.test.csv
 *   npx tsx scripts/generate-verified-labels-from-csv.ts --csv src/data/data.csv --out src/data/verifiedWalletLabels.json
 *
 * Env (bị CLI ghi đè nếu có --csv / --out):
 *   VERIFIED_LABELS_CSV, VERIFIED_LABELS_JSON
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULT_CSV = path.join(ROOT, "src", "data", "data.csv");
const DEFAULT_OUT = path.join(ROOT, "src", "data", "verifiedWalletLabels.json");

const DEFAULT_SALT = "chainmind:verified-wallet-labels:v1";

function labelSalt(): string {
  const fromEnv = process.env.VERIFIED_WALLET_LABEL_SALT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return DEFAULT_SALT;
}

function hashKey(addressLower: string, salt: string): string {
  return createHash("sha256").update(addressLower + salt, "utf8").digest("hex");
}

function parseCliPaths(): { csvPath: string; outPath: string } {
  const argv = process.argv.slice(2);
  let csv: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--csv" && argv[i + 1]) {
      csv = argv[++i];
    } else if (argv[i] === "--out" && argv[i + 1]) {
      out = argv[++i];
    }
  }
  const envCsv = process.env.VERIFIED_LABELS_CSV?.trim();
  const envOut = process.env.VERIFIED_LABELS_JSON?.trim();
  const csvPath = path.resolve(ROOT, csv ?? envCsv ?? DEFAULT_CSV);
  const outPath = path.resolve(ROOT, out ?? envOut ?? DEFAULT_OUT);
  return { csvPath, outPath };
}

type Row = { lower: string; country: string };

function parseCsv(filePath: string): Row[] {
  const text = fs.readFileSync(filePath, "utf8");
  const byLower = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const comma = t.indexOf(",");
    if (comma < 0) continue;
    const addrRaw = t.slice(0, comma).trim();
    const country = t.slice(comma + 1).trim();
    if (!addrRaw || !country || !isAddress(addrRaw)) continue;
    const lower = getAddress(addrRaw).toLowerCase();
    byLower.set(lower, country);
  }
  return Array.from(byLower.entries()).map(([lower, country]) => ({ lower, country }));
}

function main() {
  const { csvPath, outPath } = parseCliPaths();
  if (!fs.existsSync(csvPath)) {
    console.error("Không thấy file CSV:", csvPath);
    process.exit(1);
  }
  const salt = labelSalt();
  const rows = parseCsv(csvPath);
  const entries = rows.map((r) => ({
    k: hashKey(r.lower, salt),
    country: r.country,
  }));

  const payload = {
    v: 1 as const,
    entries,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Đọc: ${path.relative(ROOT, csvPath)}`);
  console.log(`Đã ghi ${entries.length} mục → ${path.relative(ROOT, outPath)}`);
  console.log(`Salt: ${process.env.VERIFIED_WALLET_LABEL_SALT?.trim() ? "(từ VERIFIED_WALLET_LABEL_SALT)" : "(mặc định built-in)"}`);
}

main();
