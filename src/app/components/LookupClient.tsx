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
  const [activeTab, setActiveTab] = useState<"summary" | "txs">("summary");

  const canSubmit = useMemo(() => {
    const v = address.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(v);
  }, [address]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setActiveTab("summary");

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
            placeholder="0xhsfsl*****ufs345"
            className="h-11 rounded-xl bg-zinc-50 dark:bg-black/30 ring-1 ring-zinc-200/70 dark:ring-white/10 px-4 text-sm text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-400 outline-none focus:ring-indigo-500/40"
          />
          <div className="text-xs text-zinc-600 dark:text-zinc-400">
            Mô hình heuristic: lấy giao dịch Ethereum (normal/internal/token),
            phân loại wallet type, trộn tín hiệu timezone + counterparty để suy
            ra quốc gia khả dĩ (không phải định danh chắc chắn).
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
              {loading ? "Đang phân tích..." : "Dự đoán quốc gia"}
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
          <div className="inline-flex rounded-xl bg-zinc-100 dark:bg-white/10 p-1 w-fit">
            <button
              type="button"
              onClick={() => setActiveTab("summary")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                activeTab === "summary"
                  ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-600 dark:text-zinc-400"
              }`}
            >
              Summary
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("txs")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                activeTab === "txs"
                  ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-600 dark:text-zinc-400"
              }`}
            >
              Transactions ({result.totalTxFetched})
            </button>
          </div>

          {activeTab === "summary" ? (
            <>
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
              {result.bestCountry ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                        Quốc gia khả dĩ nhất (heuristic)
                      </div>
                      <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                        {result.bestCountry.country}
                      </div>
                      <div className="text-sm text-zinc-600 dark:text-zinc-400">
                        Proxy score: {result.bestCountry.percent.toFixed(0)}% · dựa
                        trên {result.bestCountry.timezoneLabel}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                        Confidence
                      </div>
                      <div className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">
                        {((result.confidence ?? 0) * 100).toFixed(0)} / 100
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 h-2 rounded-full bg-zinc-100 dark:bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-indigo-600"
                      style={{ width: `${result.bestCountry.percent}%` }}
                    />
                  </div>

                  {result.message ? (
                    <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                      {result.message}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-2">
                  {result.message ?? "Không đủ dữ liệu để suy đoán."}
                </div>
              )}
            </div>
          </div>

          {result.countryCandidates?.length ? (
            <div className="rounded-2xl bg-white dark:bg-black/20 ring-1 ring-zinc-200/70 dark:ring-white/10 p-4">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Các quốc gia khả dĩ (top)
              </div>
              <div className="mt-3 grid gap-3">
                {result.countryCandidates.slice(0, 5).map((c) => (
                  <div
                    key={c.country + c.offsetHours}
                    className="rounded-xl bg-zinc-50 dark:bg-white/5 ring-1 ring-zinc-200/60 dark:ring-white/10 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                          {c.country}
                        </div>
                        <div className="text-xs text-zinc-600 dark:text-zinc-400">
                          Confidence: {c.percent.toFixed(0)}% · {c.timezoneLabel}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {(result.walletType || result.signalBreakdown || result.diagnostics) ? (
            <div className="rounded-2xl bg-white dark:bg-black/20 ring-1 ring-zinc-200/70 dark:ring-white/10 p-4">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Giải thích dự đoán
              </div>
              <div className="mt-3 grid gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                {result.walletType ? (
                  <div>
                    Wallet type: <span className="font-semibold uppercase">{result.walletType}</span>
                  </div>
                ) : null}
                {result.signalBreakdown ? (
                  <div>
                    Weights - timezone {(result.signalBreakdown.timezone * 100).toFixed(0)}%,
                    counterparty {(result.signalBreakdown.counterparty * 100).toFixed(0)}%,
                    token {(result.signalBreakdown.token * 100).toFixed(0)}%,
                    protocol {(result.signalBreakdown.protocol * 100).toFixed(0)}%
                  </div>
                ) : null}
                {result.diagnostics ? (
                  <div>
                    Entropy {result.diagnostics.timezoneEntropy.toFixed(2)} · tzReliability{" "}
                    {result.diagnostics.timezoneReliability.toFixed(2)} · counterparties{" "}
                    {result.diagnostics.uniqueCounterparties} · fallback{" "}
                    {result.diagnostics.fallbackUsed ? "yes" : "no"}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
            </>
          ) : (
            <div className="rounded-2xl bg-white dark:bg-black/20 ring-1 ring-zinc-200/70 dark:ring-white/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Transactions scanned
                </div>
                <div className="text-xs text-zinc-600 dark:text-zinc-400">
                  Total scanned: <span className="font-semibold">{result.totalTxFetched}</span>
                </div>
              </div>
              {result.scannedTransactions?.length ? (
                <div className="mt-3 grid gap-2 max-h-[420px] overflow-auto pr-1">
                  {result.scannedTransactions.map((tx) => (
                    <div
                      key={`${tx.source}-${tx.hash}`}
                      className="rounded-xl bg-zinc-50 dark:bg-white/5 ring-1 ring-zinc-200/60 dark:ring-white/10 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-mono text-zinc-700 dark:text-zinc-300 truncate">
                          {tx.hash}
                        </div>
                        <div className="text-[11px] text-zinc-600 dark:text-zinc-400 shrink-0">
                          {tx.source}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                        {tx.timeStamp
                          ? new Date(tx.timeStamp * 1000).toLocaleString()
                          : "No timestamp"}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
                  Không có transaction nào trong response hiện tại.
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Message shown inline when bestCountry is available / missing. */}
    </div>
  );
}

