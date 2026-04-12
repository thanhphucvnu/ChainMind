/**
 * Thu thập địa chỉ Ethereum từ block mới nhất lùi dần (full transactions),
 * dừng khi đủ số địa chỉ duy nhất (mặc định 50k).
 *
 * Env:
 *   ETH_RPC_URL — bắt buộc (HTTP(S) JSON-RPC). Nếu node chỉ trả hash trong block,
 *   script tự gọi getTransaction theo lô (xem --tx-fetch-concurrency).
 *
 * Usage:
 *   npx tsx scripts/crawl-recent-addresses.ts
 *   npx tsx scripts/crawl-recent-addresses.ts --target 50000 --concurrency 16
 *   npx tsx scripts/crawl-recent-addresses.ts --out src/data/source-addresses.txt
 *   npx tsx scripts/crawl-recent-addresses.ts --fresh  (bỏ checkpoint, bắt đầu lại)
 *   npx tsx scripts/crawl-recent-addresses.ts --no-checkpoint
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, type Block, type TransactionResponse } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULT_OUT = path.join(ROOT, "src", "data", "source-addresses.txt");
const DEFAULT_CHECKPOINT = path.join(ROOT, "src", "data", ".crawl-recent-addresses.checkpoint.json");

type Checkpoint = {
  nextBlock: number;
  addresses: string[];
};

function parseArgs(): {
  target: number;
  concurrency: number;
  txFetchConcurrency: number;
  outPath: string;
  checkpointPath: string | null;
  fresh: boolean;
} {
  const argv = process.argv.slice(2);
  let target = 50000;
  let concurrency = 12;
  let txFetchConcurrency = 40;
  let outPath = DEFAULT_OUT;
  let checkpointPath: string | null = DEFAULT_CHECKPOINT;
  let fresh = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--target" && argv[i + 1]) {
      target = Math.max(1, parseInt(argv[++i], 10) || target);
    } else if (a === "--concurrency" && argv[i + 1]) {
      concurrency = Math.max(1, Math.min(64, parseInt(argv[++i], 10) || concurrency));
    } else if (a === "--tx-fetch-concurrency" && argv[i + 1]) {
      txFetchConcurrency = Math.max(
        4,
        Math.min(128, parseInt(argv[++i], 10) || txFetchConcurrency)
      );
    } else if (a === "--out" && argv[i + 1]) {
      outPath = path.resolve(ROOT, argv[++i]);
    } else if (a === "--checkpoint" && argv[i + 1]) {
      checkpointPath = path.resolve(ROOT, argv[++i]);
    } else if (a === "--no-checkpoint") {
      checkpointPath = null;
    } else if (a === "--fresh") {
      fresh = true;
    }
  }
  return { target, concurrency, txFetchConcurrency, outPath, checkpointPath, fresh };
}

function loadCheckpoint(p: string, fresh: boolean): Checkpoint | null {
  if (fresh || !p) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw) as Checkpoint;
    if (
      typeof j.nextBlock === "number" &&
      Number.isFinite(j.nextBlock) &&
      Array.isArray(j.addresses)
    ) {
      return {
        nextBlock: j.nextBlock,
        addresses: j.addresses.filter((x) => typeof x === "string"),
      };
    }
  } catch {
    /* empty */
  }
  return null;
}

function saveCheckpoint(p: string | null, data: Checkpoint) {
  if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data)}\n`, "utf8");
}

function addTxAddresses(
  addresses: Set<string>,
  from: string | null | undefined,
  to: string | null | undefined
) {
  if (from) addresses.add(from.toLowerCase());
  if (to) addresses.add(to.toLowerCase());
}

/** Nhiều RPC public chỉ trả tx hash trong block; khi đó tải từng tx qua eth_getTransactionByHash. */
async function ingestBlockTransactions(
  provider: JsonRpcProvider,
  block: Block,
  addresses: Set<string>,
  txFetchConcurrency: number
) {
  if (!block.transactions?.length) return;
  const first = block.transactions[0];
  if (typeof first !== "string") {
    for (const tx of block.transactions) {
      if (typeof tx === "string") continue;
      const full = tx as TransactionResponse;
      addTxAddresses(addresses, full.from ?? null, full.to ?? null);
    }
    return;
  }
  const hashes = block.transactions.filter((h): h is string => typeof h === "string");
  for (let i = 0; i < hashes.length; i += txFetchConcurrency) {
    const chunk = hashes.slice(i, i + txFetchConcurrency);
    const txs = await Promise.all(
      chunk.map((h) => provider.getTransaction(h).catch(() => null))
    );
    for (const t of txs) {
      if (!t) continue;
      addTxAddresses(addresses, t.from ?? null, t.to ?? null);
    }
  }
}

async function main() {
  const { target, concurrency, txFetchConcurrency, outPath, checkpointPath, fresh } =
    parseArgs();
  const rpcUrl = process.env.ETH_RPC_URL?.trim();
  if (!rpcUrl) {
    console.error("Thiếu ETH_RPC_URL trong môi trường.");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const addresses = new Set<string>();
  let nextBlock: number;

  const loaded = checkpointPath ? loadCheckpoint(checkpointPath, fresh) : null;
  if (loaded && loaded.addresses.length > 0) {
    for (const a of loaded.addresses) addresses.add(a.toLowerCase());
    nextBlock = loaded.nextBlock;
    console.log(
      `Resume checkpoint: ${addresses.size} địa chỉ, nextBlock=${nextBlock}`
    );
  } else {
    const latest = await provider.getBlockNumber();
    nextBlock = latest;
    console.log(
      `Bắt đầu từ block ${nextBlock}, target=${target}, blockConcurrency=${concurrency}, txFetchConcurrency=${txFetchConcurrency}`
    );
  }

  while (addresses.size < target && nextBlock >= 0) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && nextBlock - i >= 0; i += 1) {
      batch.push(nextBlock - i);
    }
    if (batch.length === 0) break;

    const blocks = await Promise.all(
      batch.map((bn) => provider.getBlock(bn, true).catch(() => null))
    );

    for (const block of blocks) {
      if (!block) continue;
      await ingestBlockTransactions(provider, block, addresses, txFetchConcurrency);
    }

    nextBlock -= batch.length;

    if (checkpointPath) {
      saveCheckpoint(checkpointPath, {
        nextBlock,
        addresses: Array.from(addresses),
      });
    }

    console.log(`nextBlock=${nextBlock} unique=${addresses.size}/${target}`);

    if (addresses.size >= target) break;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const list = Array.from(addresses).slice(0, target).sort();
  fs.writeFileSync(outPath, `${list.join("\n")}\n`, "utf8");
  console.log(`Đã ghi ${list.length} địa chỉ → ${outPath}`);

  if (checkpointPath) {
    try {
      fs.unlinkSync(checkpointPath);
    } catch {
      /* ok */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
