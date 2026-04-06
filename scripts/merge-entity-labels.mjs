#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TARGET_PATH = path.join(ROOT, "src", "data", "entityLabels.json");

const VALID_TYPES = new Set([
  "CEX",
  "DEX",
  "BRIDGE",
  "MIXER",
  "LENDING",
  "GAMING",
  "PAYMENT",
  "OTHER",
]);

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/merge-entity-labels.mjs --input <path-to-json> [--dry-run]",
      "",
      "Input format (array):",
      '  [{ "address": "0x...", "name": "...", "type": "CEX", "country": "United States", "countryHints": ["global","Singapore"] }]',
      "",
      "This script is read-only with blockchain/wallets: it only reads local files and updates src/data/entityLabels.json.",
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = { input: "", dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input") {
      args.input = argv[i + 1] ?? "";
      i += 1;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    }
  }
  return args;
}

function normalizeAddress(address) {
  if (typeof address !== "string") return null;
  const v = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(v)) return null;
  return v;
}

function normType(t) {
  if (typeof t !== "string") return "OTHER";
  const u = t.trim().toUpperCase();
  return VALID_TYPES.has(u) ? u : "OTHER";
}

function toLabel(raw) {
  const address = normalizeAddress(raw?.address);
  if (!address) return null;
  const name = typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  const country =
    typeof raw?.country === "string" && raw.country.trim() ? raw.country.trim() : "Unknown";
  const type = normType(raw?.type);
  const countryHints = Array.isArray(raw?.countryHints)
    ? raw.countryHints
        .filter((x) => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  return { address, name, type, country, countryHints };
}

function readJsonArray(filePath, fallback = []) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : fallback;
}

function dedupByAddress(rows) {
  const byAddress = new Map();
  for (const r of rows) {
    const clean = toLabel(r);
    if (!clean) continue;
    const prev = byAddress.get(clean.address);
    if (!prev) {
      byAddress.set(clean.address, clean);
      continue;
    }
    byAddress.set(clean.address, {
      address: clean.address,
      name: clean.name ?? prev.name,
      type: clean.type !== "OTHER" ? clean.type : prev.type,
      country: clean.country !== "Unknown" ? clean.country : prev.country,
      countryHints: Array.from(new Set([...(prev.countryHints ?? []), ...(clean.countryHints ?? [])])),
    });
  }
  return Array.from(byAddress.values()).sort((a, b) => a.address.localeCompare(b.address));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    usage();
    process.exit(1);
  }

  const inputPath = path.isAbsolute(args.input) ? args.input : path.join(ROOT, args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const current = readJsonArray(TARGET_PATH, []);
  const incoming = readJsonArray(inputPath, []);
  const merged = dedupByAddress([...current, ...incoming]);

  const before = dedupByAddress(current).length;
  const after = merged.length;
  const addedOrUpdated = Math.max(0, after - before);

  if (args.dryRun) {
    console.log(`Dry-run OK. current=${before} merged=${after} delta=${addedOrUpdated}`);
    return;
  }

  fs.writeFileSync(TARGET_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`Merged labels into ${TARGET_PATH}`);
  console.log(`current=${before} merged=${after} delta=${addedOrUpdated}`);
}

main();

