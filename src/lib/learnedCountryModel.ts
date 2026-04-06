import type { CountryGuessCandidate } from "@/lib/lookupTypes";
import { extractTrainingFeatureVector, type TrainingFeatureInput } from "@/lib/trainingFeatures";

export type LearnedModelJsonV1 = {
  version: 1;
  classes: string[];
  /** StandardScaler: (x - mean) / scale */
  mean: number[];
  scale: number[];
  /** LogisticRegression coef_: shape [n_classes, n_features] */
  W: number[][];
  b: number[];
  feature_dim: number;
};

let cached: LearnedModelJsonV1 | null | undefined;

function validateLearnedModel(j: LearnedModelJsonV1): boolean {
  const d = j.feature_dim;
  if (!Number.isFinite(d) || d <= 0) return false;
  if (!Array.isArray(j.classes) || j.classes.length < 2) return false;
  if (!Array.isArray(j.mean) || j.mean.length !== d) return false;
  if (!Array.isArray(j.scale) || j.scale.length !== d) return false;
  if (!Array.isArray(j.b) || j.b.length !== j.classes.length) return false;
  if (!Array.isArray(j.W) || j.W.length !== j.classes.length) return false;
  for (const row of j.W) {
    if (!Array.isArray(row) || row.length !== d) return false;
  }
  return true;
}

function loadModelFromPath(filePath: string): LearnedModelJsonV1 | null {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw) as LearnedModelJsonV1;
    if (j.version !== 1 || !Array.isArray(j.classes) || !Array.isArray(j.W)) return null;
    if (j.W.length !== j.classes.length) return null;
    if (!validateLearnedModel(j)) return null;
    return j;
  } catch {
    return null;
  }
}

export function getLearnedCountryModel(): LearnedModelJsonV1 | null {
  if (cached !== undefined) return cached;
  const p = process.env.LEARNED_COUNTRY_MODEL_PATH;
  if (!p || typeof p !== "string" || !p.trim()) {
    cached = null;
    return null;
  }
  const pathMod = require("node:path") as typeof import("node:path");
  const cwd = process.cwd();
  const resolved = pathMod.isAbsolute(p) ? p : pathMod.join(/* turbopackIgnore: true */ cwd, p);
  cached = loadModelFromPath(resolved);
  return cached;
}

export function clearLearnedCountryModelCache(): void {
  cached = undefined;
}

function softmax(logits: number[]): number[] {
  const maxL = Math.max(...logits, -Infinity);
  const exps = logits.map((z) => Math.exp(z - maxL));
  const s = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / s);
}

/**
 * Returns probability per class name (same order as model.classes).
 */
export function predictLearnedCountryProbs(
  model: LearnedModelJsonV1,
  input: TrainingFeatureInput
): Map<string, number> {
  const x = extractTrainingFeatureVector(input);
  if (x.length !== model.feature_dim) {
    return new Map();
  }
  const mean = model.mean;
  const scale = model.scale;
  const xs = x.map((v, i) => {
    const m = mean[i] ?? 0;
    const sc = scale[i] ?? 1;
    const denom = sc === 0 ? 1 : sc;
    return (v - m) / denom;
  });

  const logits: number[] = [];
  for (let c = 0; c < model.W.length; c += 1) {
    const row = model.W[c] ?? [];
    let z = model.b[c] ?? 0;
    for (let i = 0; i < xs.length; i += 1) {
      z += (row[i] ?? 0) * xs[i];
    }
    logits.push(z);
  }

  const probs = softmax(logits);
  const sumP = probs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (!Number.isFinite(sumP) || sumP < 1e-12 || probs.some((p) => !Number.isFinite(p))) {
    return new Map();
  }
  const out = new Map<string, number>();
  model.classes.forEach((cls, i) => {
    out.set(cls, probs[i] ?? 0);
  });
  return out;
}

/**
 * Convex blend between engine fused distribution and learned probs, then top-K.
 */
export function blendEngineWithLearned(
  engineTop: CountryGuessCandidate[],
  learned: Map<string, number>,
  learnWeight: number,
  topK: number
): { topCountries: CountryGuessCandidate[]; bestCountry: CountryGuessCandidate | null } {
  const wL = Math.min(1, Math.max(0, learnWeight));
  if (wL <= 0 || learned.size === 0) {
    const top = engineTop.slice(0, topK);
    return {
      topCountries: top,
      bestCountry: top.length ? top[0] : null,
    };
  }
  const wE = 1 - wL;
  const eps = 1e-8;
  const countries = new Set<string>();
  for (const c of engineTop) countries.add(c.country);
  for (const k of learned.keys()) countries.add(k);

  const rows: CountryGuessCandidate[] = [];
  for (const country of countries) {
    const rawE = (engineTop.find((x) => x.country === country)?.percent ?? 0) / 100;
    const pEngine = rawE > 0 ? rawE : eps;
    const rawL = learned.has(country) ? (learned.get(country) ?? 0) : 0;
    const pLearn = Number.isFinite(rawL) && rawL > 0 ? rawL : eps;
    let p = wE * pEngine + wL * pLearn;
    if (!Number.isFinite(p) || p <= 0) p = eps;
    const ref = engineTop.find((x) => x.country === country);
    rows.push({
      country,
      offsetHours: ref?.offsetHours ?? 0,
      timezoneLabel: ref?.timezoneLabel ?? "Learned",
      score: p,
      percent: p * 100,
    });
  }

  rows.sort((a, b) => b.percent - a.percent);
  const top = rows.slice(0, topK);
  const sum = top.reduce((acc, r) => acc + r.percent, 0) || 1;
  const normalized = top.map((r) => ({
    ...r,
    percent: (r.percent / sum) * 100,
  }));

  return {
    topCountries: normalized,
    bestCountry: normalized.length ? normalized[0] : null,
  };
}
