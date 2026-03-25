import LookupClient from "./components/LookupClient";

export default function Home() {
  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-zinc-50 to-white dark:from-black dark:to-black font-sans">
      <header className="mx-auto max-w-5xl px-6 pt-10">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600/10 ring-1 ring-indigo-600/20 flex items-center justify-center">
              <span className="text-indigo-700 dark:text-indigo-300 font-semibold">
                CM
              </span>
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                ChainMind
              </h1>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Heuristic lookup: đoán “quốc gia” của ví dựa trên nhãn đối tác.
              </p>
            </div>
          </div>
          <a
            className="text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:underline"
            href="https://etherscan.io/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Powered by Etherscan
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-16 pt-8">
        <LookupClient />

        <section className="mt-10 rounded-2xl bg-white dark:bg-zinc-900/40 ring-1 ring-zinc-200/70 dark:ring-white/10 p-5 sm:p-6">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Lưu ý quan trọng
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Địa chỉ ví blockchain không tự cung cấp “quốc gia”. Công cụ này
            chỉ suy đoán dựa trên danh sách nhãn `entities.json` bạn cung cấp
            (thường là địa chỉ sàn/đối tác đã biết country).
          </p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Nếu bạn thấy kết quả “không đủ dữ liệu”, hãy cập nhật file nhãn
            và/hoặc bổ sung nguồn dữ liệu KYC/label.
          </p>
        </section>
      </main>
    </div>
  );
}
