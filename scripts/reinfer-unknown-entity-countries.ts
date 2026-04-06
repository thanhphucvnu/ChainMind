import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferCexCountryFromLabelPieces } from "../src/lib/cexCountryFromLabel";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = path.join(__dirname, "..", "src", "data", "entityLabels.json");

const arr = JSON.parse(fs.readFileSync(p, "utf8")) as Array<Record<string, unknown>>;
let n = 0;
for (const e of arr) {
  const name = typeof e.name === "string" ? e.name : "";
  if (!name) continue;
  const inf = inferCexCountryFromLabelPieces([name]);
  if (inf && e.country === "Unknown") {
    e.country = inf.country;
    e.countryHints = [...inf.countryHints];
    e.type = "CEX";
    n += 1;
  }
  if (name.includes("Tether: USDT") || name === "Tether: USDT Stablecoin") {
    e.type = "PAYMENT";
    e.country = "global";
    e.countryHints = ["global"];
    n += 1;
  }
  if (name.includes("0x: Allowance")) {
    e.type = "OTHER";
    e.country = "global";
    e.countryHints = ["global"];
    n += 1;
  }
}
fs.writeFileSync(p, `${JSON.stringify(arr, null, 2)}\n`, "utf8");
console.log("updated rows (field touches):", n);
