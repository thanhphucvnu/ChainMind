#!/usr/bin/env python3
"""
Train a multiclass logistic regression head on exported ChainMind features.

Input: JSONL from `npm run train:export` (lines with "features" array; skip "error" lines).

Output: JSON model for Next.js (`learnedCountryModel.ts` loader), version 1.

Usage (from repo root):
  cd training
  python -m venv .venv
  .venv\\Scripts\\activate   # Windows
  pip install -r requirements.txt
  python train_multicountry.py --data data/features.jsonl --out ../src/data/learnedCountryModel.json

Keep feature order in sync with `src/lib/trainingFeatures.ts` (TRAINING_FEATURE_NAMES).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, top_k_accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder, StandardScaler


def load_rows(path: Path) -> tuple[np.ndarray, np.ndarray]:
    xs: list[list[float]] = []
    ys: list[str] = []
    skipped = 0
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if "error" in row or "features" not in row:
                skipped += 1
                continue
            feat = row["features"]
            country = str(row.get("country", "")).strip()
            if not country or not isinstance(feat, list):
                skipped += 1
                continue
            xs.append([float(x) for x in feat])
            ys.append(country)
    if skipped:
        print(f"Skipped {skipped} lines (errors or missing features)", file=sys.stderr)
    return np.asarray(xs, dtype=np.float64), np.asarray(ys)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="features.jsonl")
    ap.add_argument("--out", type=Path, required=True, help="learnedCountryModel.json")
    ap.add_argument("--test-size", type=float, default=0.2)
    ap.add_argument("--min-class-count", type=int, default=3, help="drop classes with fewer rows")
    ap.add_argument("--random-state", type=int, default=42)
    args = ap.parse_args()

    X, y_raw = load_rows(args.data)
    if len(X) < 10:
        print("Need at least ~10 labeled rows for stable training.", file=sys.stderr)
        sys.exit(1)

    # Drop rare classes
    from collections import Counter

    cnt = Counter(y_raw)
    keep = {c for c, n in cnt.items() if n >= args.min_class_count}
    mask = np.array([c in keep for c in y_raw])
    X, y_raw = X[mask], y_raw[mask]
    dropped = sorted(set(cnt.keys()) - keep)
    if dropped:
        print(f"Dropped rare classes (<{args.min_class_count}): {dropped}", file=sys.stderr)

    if len(np.unique(y_raw)) < 2:
        print("Need at least 2 country classes after filtering.", file=sys.stderr)
        sys.exit(1)

    le = LabelEncoder()
    y = le.fit_transform(y_raw)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=args.test_size, random_state=args.random_state, stratify=y
    )

    clf = Pipeline(
        [
            ("scaler", StandardScaler()),
            (
                "lr",
                LogisticRegression(
                    max_iter=2000,
                    multi_class="multinomial",
                    solver="lbfgs",
                    C=1.0,
                ),
            ),
        ]
    )
    clf.fit(X_train, y_train)
    y_pred = clf.predict(X_test)

    print(classification_report(y_test, y_pred, target_names=le.classes_), file=sys.stderr)

    proba = clf.predict_proba(X_test)
    try:
        k = min(3, proba.shape[1])
        topk = top_k_accuracy_score(y_test, proba, k=k)
        print(f"top-{k} accuracy (holdout): {topk:.4f}", file=sys.stderr)
    except Exception as e:
        print(f"(top-k accuracy skipped: {e})", file=sys.stderr)

    lr: LogisticRegression = clf.named_steps["lr"]
    scaler: StandardScaler = clf.named_steps["scaler"]

    model = {
        "version": 1,
        "classes": le.classes_.tolist(),
        "mean": scaler.mean_.tolist(),
        "scale": scaler.scale_.tolist(),
        "W": lr.coef_.tolist(),
        "b": lr.intercept_.tolist(),
        "feature_dim": int(X.shape[1]),
    }

    if model["feature_dim"] != len(model["mean"]):
        print("Internal error: feature_dim mismatch", file=sys.stderr)
        sys.exit(1)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(model, indent=2), encoding="utf-8")
    print(f"Wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
