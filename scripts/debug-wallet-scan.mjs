import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_WALLET = "0x05a27da647b989798c74bc62b802544bb92da858";
const walletRaw = process.argv[2]?.trim() || DEFAULT_WALLET;
const wallet = /^0x[a-fA-F0-9]{40}$/.test(walletRaw) ? walletRaw : null;
if (!wallet) {
  console.error("Usage: node scripts/debug-wallet-scan.mjs <0x...address>");
  process.exit(1);
}
const targetLower = wallet.toLowerCase();

let envText = "";
try {
  envText = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
} catch {
  /* optional */
}
const key =
  envText.match(/^ETHERSCAN_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";

function u(action, sort, offset) {
  const x = new URL("https://api.etherscan.io/v2/api");
  x.searchParams.set("chainid", "1");
  x.searchParams.set("module", "account");
  x.searchParams.set("action", action);
  x.searchParams.set("address", wallet);
  x.searchParams.set("startblock", "0");
  x.searchParams.set("endblock", "99999999");
  x.searchParams.set("page", "1");
  x.searchParams.set("offset", String(offset));
  x.searchParams.set("sort", sort);
  x.searchParams.set("apikey", key);
  return x;
}

function collect(list, source) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const t of list) {
    const h = typeof t.hash === "string" ? t.hash.trim() : "";
    if (!h) continue;
    const ts = Number(t.timeStamp);
    if (!Number.isFinite(ts)) continue;
    out.push({
      hash: h,
      timeStamp: ts,
      from: typeof t.from === "string" ? t.from : null,
      to: typeof t.to === "string" ? t.to : null,
      source,
    });
  }
  return out;
}

function dedupeByHash(rows) {
  const byHash = new Map();
  for (const r of rows) {
    const key = r.hash.toLowerCase();
    const prev = byHash.get(key);
    if (!prev || r.timeStamp < prev.timeStamp) byHash.set(key, { ...r });
  }
  return Array.from(byHash.values());
}

function counterpartyFromRow(row) {
  const from = (row.from || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  if (from === targetLower && to && to !== targetLower) {
    return { cpLower: to, direction: "out" };
  }
  if (to === targetLower && from && from !== targetLower) {
    return { cpLower: from, direction: "in" };
  }
  return null;
}

function loadEntitiesMap() {
  const labelsPath = path.join(__dirname, "..", "src", "data", "entityLabels.json");
  const entitiesPath = path.join(__dirname, "..", "src", "data", "entities.json");
  const listB = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
  const listA = JSON.parse(fs.readFileSync(entitiesPath, "utf8"));
  const m = new Map();
  for (const e of [...(Array.isArray(listA) ? listA : []), ...(Array.isArray(listB) ? listB : [])]) {
    const addr = typeof e?.address === "string" ? e.address : "";
    const country = typeof e?.country === "string" ? e.country.trim() : "";
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    if (!addr || !country || !name) continue;
    m.set(addr.toLowerCase(), { ...e, name, country });
  }
  return m;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(400);
const asc = await (await fetch(u("txlist", "asc", 5))).json();
await sleep(400);
const desc200 = await (await fetch(u("txlist", "desc", 200))).json();
await sleep(400);
const intAsc = await (await fetch(u("txlistinternal", "asc", 5))).json();
await sleep(400);
const tokAsc = await (await fetch(u("tokentx", "asc", 10))).json();
await sleep(400);
const tokDesc200 = await (await fetch(u("tokentx", "desc", 200))).json();

const firstNormal = Array.isArray(asc.result) ? asc.result[0] : null;
const nNormal = Array.isArray(desc200.result) ? desc200.result.length : 0;
const minTsInDesc =
  Array.isArray(desc200.result) && desc200.result.length
    ? Math.min(...desc200.result.map((t) => Number(t.timeStamp)))
    : null;
const firstTs = firstNormal ? Number(firstNormal.timeStamp) : null;

console.log("Wallet:", wallet);
console.log("\n=== First normal tx (ETH tab chain-first) ===");
console.log(
  firstNormal
    ? JSON.stringify(
        {
          timeStamp: firstNormal.timeStamp,
          from: firstNormal.from,
          to: firstNormal.to,
          hash: firstNormal.hash,
        },
        null,
        2
      )
    : asc
);

console.log("\n=== desc offset=200 count, min timestamp in that window ===");
console.log({ nNormal, minTsInDesc, firstTs, firstInWindow: firstTs >= minTsInDesc });

console.log("\n=== First internal ASC ===");
console.log(JSON.stringify(intAsc, null, 2).slice(0, 800));

console.log("\n=== First token ASC (preview) ===");
console.log(JSON.stringify(tokAsc, null, 2).slice(0, 1200));

const tokArr = Array.isArray(tokDesc200.result) ? tokDesc200.result : [];
const tokMinTs =
  tokArr.length > 0 ? Math.min(...tokArr.map((t) => Number(t.timeStamp))) : null;
const tokMaxTs =
  tokArr.length > 0 ? Math.max(...tokArr.map((t) => Number(t.timeStamp))) : null;
const firstTokTs =
  Array.isArray(tokAsc.result) && tokAsc.result[0]
    ? Number(tokAsc.result[0].timeStamp)
    : null;
console.log("\n=== tokentx desc=200 count, min/max ts in window ===");
console.log({
  nTok: tokArr.length,
  tokMinTs,
  tokMaxTs,
  firstTokTs,
  firstTokInDescWindow: tokMinTs != null && firstTokTs != null && firstTokTs >= tokMinTs,
});

const entitiesMap = loadEntitiesMap();

// Mirror app: merge normal + internal + token (first pages asc — enough for low-activity wallets)
const merged = dedupeByHash([
  ...collect(Array.isArray(asc.result) ? asc.result : [], "txlist"),
  ...collect(Array.isArray(intAsc.result) ? intAsc.result : [], "txlistinternal"),
  ...collect(Array.isArray(tokAsc.result) ? tokAsc.result : [], "tokentx"),
]);
merged.sort((a, b) => a.timeStamp - b.timeStamp);

console.log("\n=== Chrono merge (asc first pages): earliest row with entityLabels name+country ===");
let found = null;
for (let i = 0; i < merged.length; i += 1) {
  const row = merged[i];
  const cp = counterpartyFromRow(row);
  if (!cp) continue;
  const ent = entitiesMap.get(cp.cpLower);
  if (ent?.name) {
    found = { chronologicalIndex: i + 1, total: merged.length, row, ent };
    break;
  }
}
if (found) {
  console.log({
    chronologicalIndex: found.chronologicalIndex,
    totalInMerge: found.total,
    hash: found.row.hash,
    source: found.row.source,
    timeStamp: found.row.timeStamp,
    counterparty: found.row.from?.toLowerCase() === targetLower ? found.row.to : found.row.from,
    entityName: found.ent.name,
    country: found.ent.country,
    type: found.ent.type,
  });
} else {
  console.log("No labeled counterparty in merged asc window (try higher offset or check API).");
}

const cpEth = firstNormal?.from?.toLowerCase();
if (cpEth) {
  const hit = entitiesMap.get(cpEth);
  console.log("\n=== entityLabels for first ETH tx counterparty (from) ===");
  console.log(hit ?? "NO ENTRY for " + cpEth);
}

const firstTok = Array.isArray(tokAsc.result) ? tokAsc.result[0] : null;
if (firstTok) {
  const cpTok =
    firstTok.to?.toLowerCase() === targetLower
      ? firstTok.from?.toLowerCase()
      : firstTok.from?.toLowerCase() === targetLower
        ? firstTok.to?.toLowerCase()
        : null;
  if (cpTok) {
    const hitT = entitiesMap.get(cpTok);
    console.log("\n=== entityLabels for first token tx counterparty ===");
    console.log(hitT ?? "NO ENTRY for " + cpTok);
  }
}
