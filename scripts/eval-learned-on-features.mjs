/**
 * Đánh giá learned head trên ĐÚNG vector đã export (features.jsonl),
 * không gọi Etherscan — để biết mô hình có khớp nhãn trên dữ liệu đóng băng hay không.
 *
 *   node scripts/eval-learned-on-features.mjs --model src/data/learnedCountryModel.json --data training/data/features.jsonl
 */

import { readFileSync } from "fs";
import { resolve } from "path";

function softmax(logits) {
  const maxL = Math.max(...logits, -Infinity);
  const exps = logits.map((z) => Math.exp(z - maxL));
  const s = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / s);
}

function argmax(arr) {
  let j = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[j]) j = i;
  return j;
}

function predict(model, x) {
  const d = model.feature_dim;
  if (x.length !== d) return -1;
  const xs = x.map((v, i) => {
    const m = model.mean[i] ?? 0;
    const sc = model.scale[i] ?? 1;
    const denom = sc === 0 ? 1 : sc;
    return (v - m) / denom;
  });
  const logits = [];
  for (let c = 0; c < model.W.length; c++) {
    let z = model.b[c] ?? 0;
    const row = model.W[c];
    for (let i = 0; i < d; i++) z += (row[i] ?? 0) * xs[i];
    logits.push(z);
  }
  const p = softmax(logits);
  return argmax(p);
}

function main() {
  let modelPath = "src/data/learnedCountryModel.json";
  let dataPath = "training/data/features.jsonl";
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--model" && argv[i + 1]) modelPath = argv[++i];
    if (argv[i] === "--data" && argv[i + 1]) dataPath = argv[++i];
  }
  const model = JSON.parse(readFileSync(resolve(modelPath), "utf8"));
  const lines = readFileSync(resolve(dataPath), "utf8").split(/\r?\n/).filter(Boolean);
  let ok = 0;
  let n = 0;
  const wrong = [];
  for (const line of lines) {
    const row = JSON.parse(line);
    if (row.error || !Array.isArray(row.features)) continue;
    const predIdx = predict(model, row.features);
    if (predIdx < 0) continue;
    const pred = model.classes[predIdx];
    const truth = String(row.country).trim();
    n += 1;
    if (pred === truth) ok += 1;
    else wrong.push({ address: row.address?.slice(0, 14), truth, pred });
  }
  console.log(`Rows evaluated: ${n}`);
  console.log(`Top-1 accuracy (frozen features, learned head only): ${n ? ((ok / n) * 100).toFixed(1) : 0}%`);
  if (wrong.length && wrong.length <= 25) {
    console.log("\nMismatches (sample):");
    wrong.slice(0, 15).forEach((w) => console.log(`  ${w.address}…  label=${w.truth}  pred=${w.pred}`));
  } else if (wrong.length > 25) {
    console.log(`\nMismatches: ${wrong.length} (show first 15)`);
    wrong.slice(0, 15).forEach((w) => console.log(`  ${w.address}…  label=${w.truth}  pred=${w.pred}`));
  }
}

main();
