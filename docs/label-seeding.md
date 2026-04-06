# Label Seeding (Safe / Read-Only)

This project can improve country inference by adding known entity labels in `src/data/entityLabels.json`.

## Safety

- This workflow does **not** access private keys.
- This workflow does **not** sign transactions.
- This workflow does **not** move funds.
- It only merges local JSON files.

## Steps

1. Prepare input JSON using this shape:

```json
[
  {
    "address": "0x...",
    "name": "Binance Hot Wallet",
    "type": "CEX",
    "country": "Unknown",
    "countryHints": ["global", "Singapore"]
  }
]
```

2. Save it anywhere, e.g. `src/data/my-seed.json`.

3. Dry-run merge:

```bash
npm run labels:merge -- --input src/data/my-seed.json --dry-run
```

4. Apply merge:

```bash
npm run labels:merge -- --input src/data/my-seed.json
```

## Notes

- Address is normalized to lowercase `0x` + 40 hex.
- Duplicates are merged by address.
- Unknown `type` is mapped to `OTHER`.
- Prefer `countryHints` for uncertain entities (`["global"]` is acceptable).

