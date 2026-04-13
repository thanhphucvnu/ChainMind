"use client";

import { useMemo, useState } from "react";
import type { LookupResponse } from "@/lib/lookupTypes";

type LabelType = "CEX" | "DEX" | "BRIDGE" | "MIXER" | "LENDING" | "GAMING" | "PAYMENT" | "OTHER";
const LABEL_TYPES: LabelType[] = ["CEX", "DEX", "BRIDGE", "MIXER", "LENDING", "GAMING", "PAYMENT", "OTHER"];

function shortAddress(addr: string) {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function LookupClient() {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResponse | null>(null);
  const [activeTab, setActiveTab] = useState<"summary" | "txs">("summary");
  const [labelAddr, setLabelAddr] = useState<string>("");
  const [labelName, setLabelName] = useState<string>("");
  const [labelType, setLabelType] = useState<LabelType>("OTHER");
  const [labelCountry, setLabelCountry] = useState<string>("");
  const [labelHints, setLabelHints] = useState<string>(""); // comma-separated

  const canSubmit = useMemo(() => {
    const v = address.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(v);
  }, [address]);

  const labelSnippet = useMemo(() => {
    if (!labelAddr.trim()) return "";
    const hints = labelHints
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const countryHints = hints.length ? hints : labelCountry.trim() ? [labelCountry.trim()] : [];

    const obj: Record<string, unknown> = {
      address: labelAddr.trim(),
      name: labelName.trim() || undefined,
      type: labelType,
      country: labelCountry.trim() || undefined,
      countryHints: countryHints.length ? countryHints : undefined,
    };

    return JSON.stringify(obj, null, 2);
  }, [labelAddr, labelName, labelType, labelCountry, labelHints]);

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
        body: JSON.stringify({ address: v }),
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

        <div className="grid gap-2">
          <button
            type="submit"
            disabled={!canSubmit || loading}
            className="h-11 w-auto self-start rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600"
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
          {result.firstTransaction ? (
            <div className="rounded-2xl bg-indigo-50/90 dark:bg-indigo-950/35 ring-1 ring-indigo-200/80 dark:ring-indigo-500/25 p-4">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Đối tác có nhãn (quét từ giao dịch sớm → muộn trong batch)
              </div>
              {typeof result.firstTransaction.chronologicalIndex === "number" &&
              typeof result.firstTransaction.chronologicalTotalCount === "number" ? (
                <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  Vị trí: giao dịch thứ{" "}
                  <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                    {result.firstTransaction.chronologicalIndex}
                  </span>
                  {" / "}
                  {result.firstTransaction.chronologicalTotalCount} (đếm từ cũ nhất trong dữ liệu đã tải)
                  {result.firstTransaction.namedCounterpartyResolved === false ? (
                    <span className="block mt-1 text-amber-700 dark:text-amber-300">
                      Chưa tìm được tên sàn từ nhãn explorer — đang hiển thị giao dịch sớm nhất.
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-3 grid gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                <div>
                  <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                    Hướng
                  </span>
                  <div className="font-medium">
                    {result.firstTransaction.direction === "in"
                      ? "Nhận vào ví"
                      : "Gửi từ ví"}
                  </div>
                </div>
                <div>
                  <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                    Tên sàn / đối tác
                  </span>
                  <div className="font-semibold text-indigo-900 dark:text-indigo-100">
                    {result.firstTransaction.exchangeOrEntityName ?? (
                      <span className="font-normal text-zinc-600 dark:text-zinc-400">
                        Chưa có nhãn công khai (chỉ địa chỉ)
                      </span>
                    )}
                  </div>
                  {result.firstTransaction.exchangePrimaryCountry ? (
                    <div className="mt-2 rounded-lg bg-white/60 dark:bg-black/20 px-2 py-1.5 text-xs text-zinc-700 dark:text-zinc-300">
                      <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                        Ưu tiên dự đoán quốc gia từ đối tác này:{" "}
                      </span>
                      {result.firstTransaction.exchangePrimaryCountry}
                      {result.diagnostics?.firstTxCountryPriorityApplied &&
                      typeof result.diagnostics.firstTxCountryBlendAlpha === "number" ? (
                        <span className="text-zinc-500 dark:text-zinc-400">
                          {" "}
                          (đã trộn vào kết quả:{" "}
                          {(result.diagnostics.firstTxCountryBlendAlpha * 100).toFixed(0)}% ưu tiên
                          CEX đầu, {(100 - result.diagnostics.firstTxCountryBlendAlpha * 100).toFixed(0)}%
                          tín hiệu khác)
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                    <code className="rounded bg-white/70 dark:bg-black/30 px-1.5 py-0.5">
                      {result.firstTransaction.counterparty}
                    </code>
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(
                          result.firstTransaction!.counterparty
                        );
                      }}
                      className="font-semibold text-indigo-700 dark:text-indigo-300 hover:underline"
                    >
                      Copy
                    </button>
                    {result.firstTransaction.entityType ? (
                      <span className="rounded-full bg-white/80 dark:bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase">
                        {result.firstTransaction.entityType}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="grid gap-1 sm:grid-cols-2">
                  <div>
                    <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                      Thời điểm (UTC)
                    </span>
                    <div>
                      {result.firstTransaction.timeStamp != null
                        ? new Date(
                            result.firstTransaction.timeStamp * 1000
                          ).toLocaleString("vi-VN", { timeZone: "UTC" }) + " UTC"
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                      Loại ghi nhận
                    </span>
                    <div>
                      {result.firstTransaction.source === "txlist"
                        ? "Giao dịch ETH thường"
                        : result.firstTransaction.source === "txlistinternal"
                          ? "Giao dịch nội bộ"
                          : "Chuyển token"}
                    </div>
                  </div>
                </div>
                <div>
                  <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                    Tx hash
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="break-all text-xs">{result.firstTransaction.hash}</code>
                    {result.network === "ethereum" ? (
                      <a
                        href={`https://etherscan.io/tx/${result.firstTransaction.hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:underline shrink-0"
                      >
                        Etherscan
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
              {result.firstTransaction.note ? (
                <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {result.firstTransaction.note}
                </p>
              ) : null}
            </div>
          ) : null}

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
                        {result.groundTruth
                          ? "Quốc gia (nhãn tin cậy)"
                          : "Quốc gia khả dĩ nhất (heuristic)"}
                      </div>
                      <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                        {result.bestCountry.country}
                      </div>
                      <div className="text-sm text-zinc-600 dark:text-zinc-400">
                        {result.groundTruth ? (
                          <>
                            Khớp dataset nội bộ (SHA256+salt index) ·{" "}
                            {result.bestCountry.percent.toFixed(0)}% theo nguồn đã gắn nhãn
                          </>
                        ) : (
                          <>
                            Proxy score: {result.bestCountry.percent.toFixed(0)}% · dựa trên{" "}
                            {result.bestCountry.timezoneLabel}
                          </>
                        )}
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
                    {result.diagnostics.verifiedGroundTruth ? (
                      <span>
                        Kết quả từ nhãn đã xác minh — không phân tích histogram / graph on-chain cho bước
                        quốc gia.
                      </span>
                    ) : (
                      <>
                        Entropy {result.diagnostics.timezoneEntropy.toFixed(2)} · tzReliability{" "}
                        {result.diagnostics.timezoneReliability.toFixed(2)} · counterparties{" "}
                        {result.diagnostics.uniqueCounterparties} · fallback{" "}
                        {result.diagnostics.fallbackUsed ? "yes" : "no"}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {(result.graph?.topCounterparties?.length || result.unlabeledCounterparties?.length) ? (
            <div className="rounded-2xl bg-white dark:bg-black/20 ring-1 ring-zinc-200/70 dark:ring-white/10 p-4">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Gợi ý thêm label (tự build dataset)
              </div>
              <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                Hiện chưa có nguồn data label sẵn thì vẫn làm được: app sẽ liệt kê các counterparty “đáng
                label” từ graph 1-hop. Bạn chỉ cần copy JSON bên dưới và dán vào{" "}
                <span className="font-semibold">src/data/entityLabels.json</span>.
              </div>

              {typeof result.graph?.twoHopScanned === "number" ? (
                <div className="mt-3 rounded-xl bg-zinc-50 dark:bg-white/5 ring-1 ring-zinc-200/60 dark:ring-white/10 p-3">
                  <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                    2-hop graph (A→B→C)
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                    Neighbors scanned:{" "}
                    <span className="font-semibold">{result.graph.twoHopScanned}</span>
                    {" · "}
                    status:{" "}
                    <span className="font-semibold">
                      {result.graph.twoHopUsed ? "used" : "skipped"}
                    </span>
                  </div>
                  {result.graph.twoHopSkippedReason ? (
                    <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                      {result.graph.twoHopSkippedReason}
                    </div>
                  ) : null}
                  {result.graph.twoHopTopEntities?.length ? (
                    <div className="mt-2 grid gap-2">
                      {result.graph.twoHopTopEntities.slice(0, 6).map((e) => (
                        <div
                          key={e.address}
                          className="rounded-lg bg-white/70 dark:bg-black/20 ring-1 ring-zinc-200/60 dark:ring-white/10 p-2"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-mono text-zinc-800 dark:text-zinc-100 truncate">
                                {e.name ?? shortAddress(e.address)}
                              </div>
                              <div className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                                {e.type ?? "—"} · score{" "}
                                <span className="font-semibold">{e.score.toFixed(1)}</span>
                                {e.countryHints?.length ? (
                                  <>
                                    {" "}
                                    · hints:{" "}
                                    <span className="font-semibold">
                                      {e.countryHints.slice(0, 3).join(", ")}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={async () => {
                                await navigator.clipboard.writeText(e.address);
                              }}
                              className="shrink-0 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 hover:underline"
                            >
                              Copy addr
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-zinc-600 dark:text-zinc-400">
                      Chưa tìm thấy entity label mạnh ở hop-2 (hoặc API bị rate limit).
                    </div>
                  )}
                </div>
              ) : null}

              {result.graph?.topCounterparties?.length ? (
                <div className="mt-3 grid gap-2">
                  <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                    Top counterparties (graph 1-hop)
                  </div>
                  <div className="grid gap-2">
                    {result.graph.topCounterparties.slice(0, 12).map((cp) => {
                      const hasLabel = Boolean(cp.entity?.countryHints?.length || cp.entity?.name);
                      return (
                        <button
                          key={cp.address}
                          type="button"
                          onClick={() => {
                            setLabelAddr(cp.address);
                            setLabelName(cp.entity?.name ?? "");
                            setLabelType((cp.entity?.type as LabelType | undefined) ?? "OTHER");
                            setLabelCountry(cp.entity?.countryHints?.[0] ?? "");
                            setLabelHints(cp.entity?.countryHints?.join(", ") ?? "");
                          }}
                          className="text-left rounded-xl bg-zinc-50 dark:bg-white/5 ring-1 ring-zinc-200/60 dark:ring-white/10 p-3 hover:bg-zinc-100/70 dark:hover:bg-white/10 transition"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xs font-mono text-zinc-800 dark:text-zinc-100 truncate">
                                {cp.address}
                              </div>
                              <div className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                                txCount <span className="font-semibold">{cp.txCount}</span> · weight{" "}
                                <span className="font-semibold">{cp.weight.toFixed(0)}</span>{" "}
                                {hasLabel ? "· labeled" : "· unlabeled"}
                              </div>
                            </div>
                            <div className="shrink-0 text-[11px] text-zinc-600 dark:text-zinc-400">
                              {cp.entity?.type ?? "—"}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {result.unlabeledCounterparties?.length ? (
                <div className="mt-4">
                  <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                    Unlabeled counterparties (từ tx endpoints)
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {result.unlabeledCounterparties.slice(0, 15).map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => setLabelAddr(a)}
                        className="rounded-lg bg-zinc-50 dark:bg-white/5 ring-1 ring-zinc-200/60 dark:ring-white/10 px-2 py-1 text-[11px] font-mono text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100/70 dark:hover:bg-white/10"
                        title="Click để tạo label template"
                      >
                        {shortAddress(a)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                    Address
                  </label>
                  <input
                    value={labelAddr}
                    onChange={(e) => setLabelAddr(e.target.value)}
                    spellCheck={false}
                    placeholder="0x..."
                    className="h-10 rounded-xl bg-zinc-50 dark:bg-black/30 ring-1 ring-zinc-200/70 dark:ring-white/10 px-3 text-xs font-mono text-zinc-900 dark:text-zinc-50 outline-none focus:ring-indigo-500/40"
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                    Name (tuỳ chọn)
                  </label>
                  <input
                    value={labelName}
                    onChange={(e) => setLabelName(e.target.value)}
                    placeholder="Binance / Uniswap / ... "
                    className="h-10 rounded-xl bg-zinc-50 dark:bg-black/30 ring-1 ring-zinc-200/70 dark:ring-white/10 px-3 text-xs text-zinc-900 dark:text-zinc-50 outline-none focus:ring-indigo-500/40"
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                    Type
                  </label>
                  <select
                    value={labelType}
                    onChange={(e) => setLabelType(e.target.value as LabelType)}
                    className="h-10 rounded-xl bg-zinc-50 dark:bg-black/30 ring-1 ring-zinc-200/70 dark:ring-white/10 px-3 text-xs text-zinc-900 dark:text-zinc-50 outline-none focus:ring-indigo-500/40"
                  >
                    {LABEL_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                    Country (fallback)
                  </label>
                  <input
                    value={labelCountry}
                    onChange={(e) => setLabelCountry(e.target.value)}
                    placeholder='VD: "Vietnam"'
                    className="h-10 rounded-xl bg-zinc-50 dark:bg-black/30 ring-1 ring-zinc-200/70 dark:ring-white/10 px-3 text-xs text-zinc-900 dark:text-zinc-50 outline-none focus:ring-indigo-500/40"
                  />
                </div>
              </div>

              <div className="mt-3 grid gap-2">
                <label className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                  Country hints (comma-separated, ưu tiên hơn country)
                </label>
                <input
                  value={labelHints}
                  onChange={(e) => setLabelHints(e.target.value)}
                  placeholder='VD: "Vietnam, Thailand" hoặc "global, Singapore"'
                  className="h-10 rounded-xl bg-zinc-50 dark:bg-black/30 ring-1 ring-zinc-200/70 dark:ring-white/10 px-3 text-xs text-zinc-900 dark:text-zinc-50 outline-none focus:ring-indigo-500/40"
                />
              </div>

              <div className="mt-3 grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                    JSON snippet để dán vào `entityLabels.json`
                  </div>
                  <button
                    type="button"
                    disabled={!labelSnippet}
                    onClick={async () => {
                      if (!labelSnippet) return;
                      await navigator.clipboard.writeText(labelSnippet);
                    }}
                    className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:underline disabled:opacity-50"
                  >
                    Copy JSON
                  </button>
                </div>
                <pre className="rounded-xl bg-zinc-950 text-zinc-100 p-3 text-[11px] overflow-auto ring-1 ring-black/20 dark:ring-white/10">
                  {labelSnippet || "{\n  \"address\": \"0x...\",\n  \"name\": \"...\",\n  \"type\": \"CEX\",\n  \"country\": \"...\",\n  \"countryHints\": [\"...\"]\n}"}
                </pre>
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

