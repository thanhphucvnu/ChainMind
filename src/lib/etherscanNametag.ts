export type EtherscanNametagRow = {
  nametag: string;
  labels: string[];
  url?: string;
};

/**
 * Etherscan API v2 — module=nametag&action=getaddresstag.
 * Requires Pro Plus on many keys; free keys typically return NOTOK (caller should ignore).
 */
export async function fetchEtherscanAddressNametag(args: {
  apiBase: string;
  chainId: string;
  apiKey: string;
  address: string;
}): Promise<{ ok: true; row: EtherscanNametagRow } | { ok: false; reason: string }> {
  const url = new URL(args.apiBase);
  url.searchParams.set("chainid", args.chainId);
  url.searchParams.set("module", "nametag");
  url.searchParams.set("action", "getaddresstag");
  url.searchParams.set("address", args.address);
  url.searchParams.set("apikey", args.apiKey);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    return { ok: false, reason: `http_${res.status}` };
  }

  type R = { status?: string; message?: string; result?: unknown };
  const data = (await res.json().catch(() => null)) as R | null;
  if (!data || data.status !== "1") {
    const msg =
      typeof data?.message === "string"
        ? data.message
        : typeof data?.result === "string"
          ? data.result
          : "notok";
    return { ok: false, reason: msg };
  }

  const raw = data.result;
  const first = Array.isArray(raw) && raw.length > 0 && raw[0] && typeof raw[0] === "object" ? raw[0] : null;
  if (!first) {
    return { ok: false, reason: "empty_result" };
  }

  const obj = first as Record<string, unknown>;
  const nametag = typeof obj.nametag === "string" ? obj.nametag.trim() : "";
  const labels = Array.isArray(obj.labels)
    ? obj.labels.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];

  if (!nametag && labels.length === 0) {
    return { ok: false, reason: "no_nametag" };
  }

  return {
    ok: true,
    row: {
      nametag: nametag || labels[0] || "unknown",
      labels,
      url: typeof obj.url === "string" ? obj.url : undefined,
    },
  };
}
