#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DEFAULT = path.join(ROOT, "src", "data", "entityLabels.eth-labels.seed.json");

const LABEL_MAP = {
  binance: { type: "CEX", country: "Unknown", countryHints: ["global", "Singapore"] },
  coinbase: { type: "CEX", country: "United States", countryHints: ["United States", "global"] },
  kraken: { type: "CEX", country: "United States", countryHints: ["United States", "global"] },
  upbit: { type: "CEX", country: "South Korea", countryHints: ["South Korea"] },
  bitget: { type: "CEX", country: "Unknown", countryHints: ["global"] },
  bybit: { type: "CEX", country: "Unknown", countryHints: ["global"] },
  okx: { type: "CEX", country: "Unknown", countryHints: ["global"] },
  kucoin: { type: "CEX", country: "Unknown", countryHints: ["global"] },
  huobi: { type: "CEX", country: "Unknown", countryHints: ["global"] },
  cryptocom: { type: "CEX", country: "Singapore", countryHints: ["Singapore", "global"] },
  uniswap: { type: "DEX", country: "Unknown", countryHints: ["global", "United States", "Europe"] },
  pancakeswap: { type: "DEX", country: "Unknown", countryHints: ["global", "Vietnam", "Thailand"] },
  sushiswap: { type: "DEX", country: "Unknown", countryHints: ["global"] },
  curve: { type: "DEX", country: "Unknown", countryHints: ["global", "Europe"] },
  wormhole: { type: "BRIDGE", country: "Unknown", countryHints: ["global"] },
  synapse: { type: "BRIDGE", country: "Unknown", countryHints: ["global"] },
  stargate: { type: "BRIDGE", country: "Unknown", countryHints: ["global"] },
};

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/import-eth-labels.mjs [--max-per-label 120] [--out src/data/file.json]",
      "",
      "This script calls eth-labels public API and writes normalized seed JSON.",
      "No wallet or blockchain transactions are performed.",
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = { maxPerLabel: 120, out: OUT_DEFAULT };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--max-per-label") {
      args.maxPerLabel = Number(argv[i + 1] ?? "120");
      i += 1;
    } else if (a === "--out") {
      const p = argv[i + 1] ?? "";
      args.out = path.isAbsolute(p) ? p : path.join(ROOT, p);
      i += 1;
    } else if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.maxPerLabel) || args.maxPerLabel <= 0) args.maxPerLabel = 120;
  return args;
}

function normalizeAddress(address) {
  if (typeof address !== "string") return null;
  const v = address.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(v) ? v : null;
}

function isNoisyNameTag(v) {
  if (typeof v !== "string") return false;
  const s = v.toLowerCase();
  return (
    s.includes("scam") ||
    s.includes("phish") ||
    s.includes("hack") ||
    s.includes("exploit") ||
    s.includes("spam") ||
    s.includes("drainer") ||
    s.includes("blocked")
  );
}

async function fetchLabelAccounts(label) {
  const url = `https://eth-labels.com/accounts?chainId=1&label=${encodeURIComponent(label)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for label=${label}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = [];

  for (const [label, meta] of Object.entries(LABEL_MAP)) {
    try {
      const accounts = await fetchLabelAccounts(label);
      const picked = accounts.slice(0, args.maxPerLabel);
      let kept = 0;
      for (const a of picked) {
        const address = normalizeAddress(a?.address);
        if (!address) continue;
        const nameTag =
          typeof a?.nameTag === "string" && a.nameTag.trim() ? a.nameTag.trim() : `${label} labeled address`;
        if (isNoisyNameTag(nameTag)) continue;
        rows.push({
          address,
          name: nameTag,
          type: meta.type,
          country: meta.country,
          countryHints: meta.countryHints,
        });
        kept += 1;
      }
      console.log(`label=${label} fetched=${accounts.length} sliced=${picked.length} kept=${kept}`);
    } catch (err) {
      console.error(`label=${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const byAddr = new Map();
  for (const r of rows) {
    const prev = byAddr.get(r.address);
    if (!prev) {
      byAddr.set(r.address, r);
      continue;
    }
    byAddr.set(r.address, {
      ...prev,
      name: prev.name || r.name,
      // Keep existing hints and union any additional hints.
      countryHints: Array.from(new Set([...(prev.countryHints ?? []), ...(r.countryHints ?? [])])),
    });
  }

  const out = Array.from(byAddr.values()).sort((a, b) => a.address.localeCompare(b.address));
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`Wrote ${out.length} labels -> ${args.out}`);
}

main();

