"use client";

import { useMemo, useState } from "react";
import type { LookupResponse } from "@/lib/lookupTypes";

function shortAddress(addr: string) {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function LookupClient() {
  const [address, setAddress] = useState("");
  const [maxTx, setMaxTx] = useState(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResponse | null>(null);

  const canSubmit = useMemo(() => {
    const v = address.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(v);
  }, [address]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const v = address.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(v)) {
      setError("Nhập địa chỉ Ethereum dạng 0x + 40 ký tự hex.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: v, maxTx }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          (json && (json.error as string)) ||
          "Tra cứu thất bại. Kiểm tra console hoặc thử lại sau.";
        setError(msg);
        return;
      }
      setResult(json as LookupResponse);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Tra cứu thất bại (lỗi mạng/unknown)."
      );
    } finally {
      setLoading(false);
    }
  }

    return (
    <div className="rounded-2xl bg-white/80 dark:bg-zinc-900/40 ring-1 ring-zinc-200/70 dark:ring-white/10 p-5 sm:p-6">
      <form onSubmit={onSubmit} className="grid gap-4">
        <div className="grid gap-2">
          <label className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Địa chỉ ví (EVM 0x…)
          </label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            inputMode="text"
            placeholder="0xfb9b259def14317DDF9deE0b02f61c22d3891C95"
            className="h-11 rounded-xl bg-zinc-50 dark:bg-black/30 ring-1 ring-zinc-200/70 dark:ring-white/10 px-4 text-sm text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-400 outline-none focus:ring-indigo-500/40"
          />
          <div className="text-xs text-zinc-600 dark:text-zinc-400">
            Công cụ sẽ ước lượng timezone dựa trên “giờ hoạt động” (UTC histogram)
            từ lịch sử giao dịch đa-chain (Ethereum/BSC/Polygon/Arbitrum/Base).
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_180px] sm:items-end">
          <div className="grid gap-2">
            <label className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              Giới hạn số tx để phân tích
            </label>
            <input
              type="number"
              min={20}
              max={2000}
              step={20}
              value={maxTx}
              onChange={(e) => setMaxTx(Number(e.target.value))}
              className="h-11 rounded-xl bg-zinc-50 dark:bg-black/30 ring-1 ring-zinc-200/70 dark:ring-white/10 px-4 text-sm text-zinc-900 dark:text-zinc-50 outline-none focus:ring-indigo-500/40"
            />
          </div>

          <button
            type="submit"
            disabled={!canSubmit || loading}
            className="h-11 w-full sm:w-auto rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600"
          >
            <span className="inline-flex items-center justify-center gap-2">
              {loading ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-white" />
              ) : null}
              {loading ? "Đang phân tích..." : "Dự đoán timezone"}
            </span>
          </button>
        </div>
      </form>

      {error ? (
        <div className="mt-4 rounded-xl bg-rose-50 dark:bg-rose-900/20 ring-1 ring-rose-200/80 dark:ring-rose-500/30 p-4 text-sm text-rose-800 dark:text-rose-200">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-6 grid gap-4">
          <div className="rounded-2xl bg-white dark:bg-black/20 ring-1 ring-zinc-200/70 dark:ring-white/10 p-4">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                  Kết quả cho
                </div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                  <span>{shortAddress(result.address)}</span>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(result.address);
                    }}
                    className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:underline"
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="text-xs text-zinc-600 dark:text-zinc-400">
                Tx phân tích: <span className="font-semibold">{result.totalTxFetched}</span>
              </div>
            </div>

            <div className="mt-4">
              {result.timezoneCandidates?.length ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                        Timezone khả dĩ nhất
                      </div>
                      <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                        {result.timezoneCandidates[0]!.label}
                      </div>
                      <div className="text-sm text-zinc-600 dark:text-zinc-400">
                        Score: {result.timezoneCandidates[0]!.score.toFixed(3)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                        Độ tin cậy (heuristic)
                      </div>
                      <div className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                        {result.timezoneCandidates[0]!.percent.toFixed(0)} / 100
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 h-2 rounded-full bg-zinc-100 dark:bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-indigo-600"
                      style={{ width: `${result.timezoneCandidates[0]!.percent}%` }}
                    />
                  </div>
                </>
              ) : (
                <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-2">
                  {result.message ?? "Không đủ dữ liệu để suy đoán."}
                </div>
              )}
            </div>
          </div>

          {result.timezoneCandidates?.length ? (
            <div className="rounded-2xl bg-white dark:bg-black/20 ring-1 ring-zinc-200/70 dark:ring-white/10 p-4">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Timezone candidates (top)
              </div>
              <div className="mt-3 grid gap-3">
                {result.timezoneCandidates.slice(0, 5).map((c) => (
                  <div
                    key={c.label}
                    className="rounded-xl bg-zinc-50 dark:bg-white/5 ring-1 ring-zinc-200/60 dark:ring-white/10 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                          {c.label}
                        </div>
                        <div className="text-xs text-zinc-600 dark:text-zinc-400">
                          Score: {c.score.toFixed(3)} · {c.percent.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {result.unlabeledCounterparties?.length ? (
            <div className="rounded-2xl bg-white dark:bg-black/20 ring-1 ring-zinc-200/70 dark:ring-white/10 p-4">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Đối tác chưa gắn nhãn
              </div>
              <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                Các địa chỉ dưới đây xuất hiện trong tx (from/to) nhưng không có trong `entities.json`.
                Bạn có thể thêm chúng kèm `country` vào `src/data/entities.json`, rồi deploy lại.
              </div>
              <div className="mt-3 grid gap-2">
                {result.unlabeledCounterparties.slice(0, 10).map((addr) => (
                  <div
                    key={addr}
                    className="flex items-center justify-between gap-3 rounded-xl bg-zinc-50 dark:bg-white/5 ring-1 ring-zinc-200/60 dark:ring-white/10 p-2"
                  >
                    <div className="text-xs text-zinc-800 dark:text-zinc-200 font-mono">
                      {addr}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(addr);
                      }}
                      className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:underline"
                    >
                      Copy
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Message already shown above when bestCandidate is missing. */}
    </div>
  );
}

