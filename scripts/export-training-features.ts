/**
 * Export fixed feature vectors for supervised training.
 *
 * Usage:
 *   npm run train:export -- --input training/examples/labels.jsonl --out training/data/features.jsonl
 *
 * Requires `npm run dev` (or set LOOKUP_BASE_URL) and `ETHERSCAN_API_KEY_WEB` or `ETHERSCAN_API_KEY` in .env
 */

import { createWriteStream, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

import type { LookupResponse } from "../src/lib/lookupTypes";
import { extractTrainingFeatureVectorFromResponse, TRAINING_FEATURE_DIM } from "../src/lib/trainingFeatures";

type LabelRow = { address: string; country: string };

function parseArgs(argv: string[]): {
  input: string;
  out: string;
  baseUrl: string;
  maxTx: number;
  delayMs: number;
  limit: number;
} {
  const out: Record<string, string | number> = {
    input: "",
    out: "training/data/features.jsonl",
    baseUrl: process.env.LOOKUP_BASE_URL ?? "http://127.0.0.1:3000",
    maxTx: 200,
    delayMs: 350,
    limit: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      out.input = argv[++i];
    } else if (a === "--out" && argv[i + 1]) {
      out.out = argv[++i];
    } else if (a === "--base-url" && argv[i + 1]) {
      out.baseUrl = argv[++i];
    } else if (a === "--max-tx" && argv[i + 1]) {
      out.maxTx = Number(argv[++i]);
    } else if (a === "--delay-ms" && argv[i + 1]) {
      out.delayMs = Number(argv[++i]);
    } else if (a === "--limit" && argv[i + 1]) {
      out.limit = Number(argv[++i]);
    }
  }
  if (!out.input || typeof out.input !== "string") {
    throw new Error("Missing --input path to labels file (.jsonl)");
  }
  return {
    input: out.input as string,
    out: out.out as string,
    baseUrl: (out.baseUrl as string).replace(/\/$/, ""),
    maxTx: Number(out.maxTx) || 200,
    delayMs: Number(out.delayMs) || 0,
    limit: Number(out.limit) || 0,
  };
}

function loadLabels(path: string): LabelRow[] {
  const text = readFileSync(resolve(path), "utf8").trim();
  const ext = path.toLowerCase();
  const rows: LabelRow[] = [];
  if (ext.endsWith(".jsonl")) {
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      const j = JSON.parse(s) as { address?: string; country?: string };
      const address = typeof j.address === "string" ? j.address.trim() : "";
      const country = typeof j.country === "string" ? j.country.trim() : "";
      if (address && country) rows.push({ address, country });
    }
    return rows;
  }
  // Simple CSV: address,country (no commas inside fields)
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === 0 && /address/i.test(line) && /country/i.test(line)) continue;
    const idx = line.indexOf(",");
    if (idx < 0) continue;
    const address = line.slice(0, idx).trim().replace(/^"|"$/g, "");
    const country = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (address && country) rows.push({ address, country });
  }
  return rows;
}

async function fetchLookup(baseUrl: string, address: string, maxTx: number): Promise<LookupResponse> {
  const res = await fetch(`${baseUrl}/api/lookup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, maxTx }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`lookup HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return (await res.json()) as LookupResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const labels = loadLabels(args.input);
  const slice = args.limit > 0 ? labels.slice(0, args.limit) : labels;
  const outPath = resolve(args.out);
  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const stream = createWriteStream(outPath, { flags: "w" });
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < slice.length; i += 1) {
    const row = slice[i];
    process.stderr.write(`[${i + 1}/${slice.length}] ${row.address.slice(0, 12)}…\n`);
    try {
      const lookup = await fetchLookup(args.baseUrl, row.address, args.maxTx);
      const features = extractTrainingFeatureVectorFromResponse(lookup);
      if (features.length !== TRAINING_FEATURE_DIM) {
        throw new Error(`feature dim ${features.length} != ${TRAINING_FEATURE_DIM}`);
      }
      const line = JSON.stringify({
        address: lookup.address,
        country: row.country,
        features,
        feature_dim: TRAINING_FEATURE_DIM,
      });
      stream.write(line + "\n");
      ok += 1;
    } catch (e) {
      fail += 1;
      const msg = e instanceof Error ? e.message : String(e);
      stream.write(
        JSON.stringify({
          address: row.address,
          country: row.country,
          error: msg,
        }) + "\n"
      );
    }
    if (args.delayMs > 0 && i < slice.length - 1) await sleep(args.delayMs);
  }

  stream.end();
  await new Promise<void>((res, rej) => {
    stream.on("finish", () => res());
    stream.on("error", rej);
  });
  process.stderr.write(`Done. ok=${ok} fail=${fail} -> ${outPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
