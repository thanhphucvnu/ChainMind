/**
 * One-shot: replace country "Unknown" in entityLabels.json with sourced heuristics.
 * Run: node scripts/patch-unknown-entity-countries.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "src", "data", "entityLabels.json");
const raw = fs.readFileSync(file, "utf8");
const data = JSON.parse(raw);

function patch(entry) {
  if (entry.country !== "Unknown") return entry;
  const n = String(entry.name ?? "").toLowerCase();
  const t = entry.type;

  if (t === "CEX") {
    if (/kucoin/.test(n)) {
      return {
        ...entry,
        country: "Seychelles",
        countryHints: ["Seychelles", "Singapore", "Hong Kong"],
      };
    }
    if (/bitget/.test(n)) {
      return {
        ...entry,
        country: "Singapore",
        countryHints: ["Singapore", "Seychelles"],
      };
    }
    if (/okx/.test(n)) {
      return {
        ...entry,
        country: "Seychelles",
        countryHints: ["Seychelles", "Hong Kong"],
      };
    }
    if (/coinspot/.test(n)) {
      return {
        ...entry,
        country: "Australia",
        countryHints: ["Australia"],
      };
    }
    return entry;
  }

  if (t === "BRIDGE") {
    if (/wormhole/.test(n)) {
      return {
        ...entry,
        country: "United States",
        countryHints: ["United States", "Singapore"],
      };
    }
    if (/stargate/.test(n)) {
      return {
        ...entry,
        country: "United States",
        countryHints: ["United States", "Canada"],
      };
    }
    if (/synapse/.test(n)) {
      return {
        ...entry,
        country: "United States",
        countryHints: ["United States"],
      };
    }
    return entry;
  }

  if (t === "DEX") {
    return { ...entry, country: "global", countryHints: ["global"] };
  }

  return entry;
}

const out = data.map(patch);
const remaining = out.filter((e) => e.country === "Unknown");
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("Patched entityLabels.json");
console.log("Remaining Unknown:", remaining.length);
if (remaining.length) {
  console.log(
    remaining.slice(0, 20).map((e) => ({ type: e.type, name: e.name }))
  );
}
