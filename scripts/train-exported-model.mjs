/**
 * Train multinomial logistic regression (softmax) on features.jsonl without Python.
 * Output schema matches src/lib/learnedCountryModel.ts (version 1).
 *
 * Usage: node scripts/train-exported-model.mjs --data training/data/features.jsonl --out src/data/learnedCountryModel.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

function parseArgs(argv) {
  let data = "training/data/features.jsonl";
  let out = "src/data/learnedCountryModel.json";
  let minClass = 3;
  let epochs = 800;
  let lr = 0.08;
  let testFrac = 0.2;
  let seed = 42;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data" && argv[i + 1]) data = argv[++i];
    else if (a === "--out" && argv[i + 1]) out = argv[++i];
    else if (a === "--min-class" && argv[i + 1]) minClass = Number(argv[++i]);
    else if (a === "--epochs" && argv[i + 1]) epochs = Number(argv[++i]);
    else if (a === "--lr" && argv[i + 1]) lr = Number(argv[++i]);
    else if (a === "--test-frac" && argv[i + 1]) testFrac = Number(argv[++i]);
    else if (a === "--seed" && argv[i + 1]) seed = Number(argv[++i]);
  }
  return { data, out, minClass, epochs, lr, testFrac, seed };
}

function softmax(logits) {
  const m = Math.max(...logits);
  const ex = logits.map((z) => Math.exp(z - m));
  const s = ex.reduce((a, b) => a + b, 0) || 1;
  return ex.map((e) => e / s);
}

function argmax(arr) {
  let j = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[j]) j = i;
  return j;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const { data, out, minClass, epochs, lr, testFrac, seed } = parseArgs(process.argv);
  const text = readFileSync(resolve(data), "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const j = JSON.parse(s);
    if (j.error || !Array.isArray(j.features)) continue;
    rows.push({ country: String(j.country).trim(), features: j.features.map(Number) });
  }
  if (rows.length < 15) {
    console.error("Too few rows with features:", rows.length);
    process.exit(1);
  }

  const dim = rows[0].features.length;
  if (!rows.every((r) => r.features.length === dim)) {
    console.error("Inconsistent feature dimensions");
    process.exit(1);
  }

  const counts = new Map();
  for (const r of rows) counts.set(r.country, (counts.get(r.country) || 0) + 1);
  const keep = new Set([...counts.entries()].filter(([, n]) => n >= minClass).map(([c]) => c));
  const filtered = rows.filter((r) => keep.has(r.country));
  const dropped = [...counts.keys()].filter((c) => !keep.has(c));
  if (dropped.length) console.error("Dropped rare labels (< min-class):", dropped.join(", "));

  const classes = [...new Set(filtered.map((r) => r.country))].sort();
  const C = classes.length;
  if (C < 2) {
    console.error("Need >= 2 classes after filter");
    process.exit(1);
  }
  const rnd = mulberry32(seed);
  const order = filtered.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const nTest = Math.max(1, Math.floor(filtered.length * testFrac));
  const testI = new Set(order.slice(0, nTest));
  const trainRows = filtered.filter((_, i) => !testI.has(i));
  const testRows = filtered.filter((_, i) => testI.has(i));

  const yIdxTr = trainRows.map((r) => classes.indexOf(r.country));
  const yIdxTe = testRows.map((r) => classes.indexOf(r.country));
  const N = trainRows.length;
  let X = trainRows.map((r) => r.features.slice());

  const mean = Array(dim).fill(0);
  for (const x of X) for (let f = 0; f < dim; f++) mean[f] += x[f];
  for (let f = 0; f < dim; f++) mean[f] /= N;

  const scale = Array(dim).fill(1);
  for (let f = 0; f < dim; f++) {
    let v = 0;
    for (const x of X) v += (x[f] - mean[f]) ** 2;
    const std = Math.sqrt(v / N) || 1;
    scale[f] = std < 1e-8 ? 1 : std;
  }
  X = X.map((x) => x.map((v, f) => (v - mean[f]) / scale[f]));

  const W = Array.from({ length: C }, () => Array(dim).fill(0));
  const b = Array(C).fill(0);

  for (let e = 0; e < epochs; e++) {
    const gW = W.map((row) => row.map(() => 0));
    const gb = Array(C).fill(0);
    for (let i = 0; i < N; i++) {
      const x = X[i];
      const logits = b.map((bi, c) => bi + W[c].reduce((s, wcf, f) => s + wcf * x[f], 0));
      const p = softmax(logits);
      for (let c = 0; c < C; c++) {
        const diff = p[c] - (yIdxTr[i] === c ? 1 : 0);
        gb[c] += diff;
        for (let f = 0; f < dim; f++) gW[c][f] += diff * x[f];
      }
    }
    const inv = lr / N;
    for (let c = 0; c < C; c++) {
      b[c] -= inv * gb[c];
      for (let f = 0; f < dim; f++) W[c][f] -= inv * gW[c][f];
    }
    const l2 = 1e-4;
    for (let c = 0; c < C; c++) for (let f = 0; f < dim; f++) W[c][f] *= 1 - lr * l2;
  }

  const normX = (raw) => raw.map((v, f) => (v - mean[f]) / scale[f]);

  let correctTr = 0;
  for (let i = 0; i < N; i++) {
    const x = X[i];
    const logits = b.map((bi, c) => bi + W[c].reduce((s, wcf, f) => s + wcf * x[f], 0));
    if (argmax(softmax(logits)) === yIdxTr[i]) correctTr += 1;
  }

  let correctTe = 0;
  for (let i = 0; i < testRows.length; i++) {
    const x = normX(testRows[i].features);
    const logits = b.map((bi, c) => bi + W[c].reduce((s, wcf, f) => s + wcf * x[f], 0));
    if (argmax(softmax(logits)) === yIdxTe[i]) correctTe += 1;
  }

  console.error(
    `Holdout (~${(testFrac * 100).toFixed(0)}%): ${((correctTe / testRows.length) * 100).toFixed(1)}%  (n=${testRows.length})`
  );
  console.error(`Train fit: ${((correctTr / N) * 100).toFixed(1)}%  (n=${N})  classes=${C}`);

  // Final model: refit on all filtered rows (maximize data for deployment).
  const Nall = filtered.length;
  const yAll = filtered.map((r) => classes.indexOf(r.country));
  let Xall = filtered.map((r) => r.features.slice());
  const meanF = Array(dim).fill(0);
  for (const x of Xall) for (let f = 0; f < dim; f++) meanF[f] += x[f];
  for (let f = 0; f < dim; f++) meanF[f] /= Nall;
  const scaleF = Array(dim).fill(1);
  for (let f = 0; f < dim; f++) {
    let v = 0;
    for (const x of Xall) v += (x[f] - meanF[f]) ** 2;
    const std = Math.sqrt(v / Nall) || 1;
    scaleF[f] = std < 1e-8 ? 1 : std;
  }
  Xall = Xall.map((x) => x.map((v, f) => (v - meanF[f]) / scaleF[f]));

  const Wf = Array.from({ length: C }, () => Array(dim).fill(0));
  const bf = Array(C).fill(0);
  for (let e = 0; e < epochs; e++) {
    const gW = Wf.map((row) => row.map(() => 0));
    const gb = Array(C).fill(0);
    for (let i = 0; i < Nall; i++) {
      const x = Xall[i];
      const logits = bf.map((bi, c) => bi + Wf[c].reduce((s, wcf, f) => s + wcf * x[f], 0));
      const p = softmax(logits);
      for (let c = 0; c < C; c++) {
        const diff = p[c] - (yAll[i] === c ? 1 : 0);
        gb[c] += diff;
        for (let f = 0; f < dim; f++) gW[c][f] += diff * x[f];
      }
    }
    const inv = lr / Nall;
    for (let c = 0; c < C; c++) {
      bf[c] -= inv * gb[c];
      for (let f = 0; f < dim; f++) Wf[c][f] -= inv * gW[c][f];
    }
    const l2 = 1e-4;
    for (let c = 0; c < C; c++) for (let f = 0; f < dim; f++) Wf[c][f] *= 1 - lr * l2;
  }
  console.error("Refit on all filtered samples for exported weights.");

  const model = {
    version: 1,
    classes,
    mean: meanF,
    scale: scaleF,
    W: Wf,
    b: bf,
    feature_dim: dim,
  };
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(model, null, 2), "utf8");
  console.error("Wrote", outPath);
}

main();
