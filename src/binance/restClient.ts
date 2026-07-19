import axios from "axios";
import { config } from "../config";

const http = axios.create({ baseURL: config.binance.restBase, timeout: 10000 });

/**
 * Wraps a Binance REST call with retry + exponential backoff, and logs the ACTUAL failure
 * reason (HTTP status + response body) rather than just axios's generic error code. This
 * matters because axios's default error message (e.g. "ERR_BAD_REQUEST") tells you a 4xx
 * happened but not which one — a 429 (rate limited, should back off and retry), a 418
 * (Binance's "you've been temporarily banned" code), and a 451 (blocked region, retrying is
 * pointless) all need different handling, and previously all three looked identical in the logs.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  { retries = 5, baseDelayMs = 2000 }: { retries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err.response?.status;
      const body = err.response?.data;
      console.error(
        `[binance] ${label} failed (attempt ${attempt}/${retries})` +
          (status ? ` — HTTP ${status}` : "") +
          (body ? `: ${JSON.stringify(body).slice(0, 300)}` : `: ${err.message}`)
      );
      if (status === 451) {
        // Blocked region — retrying won't help, this needs a different Railway/host region.
        throw new Error(
          `Binance returned 451 (restricted location) for ${label}. This deployment's region is blocked by ` +
            `Binance's terms — redeploy to a non-US region (see the "Southeast Asia" region fix from earlier).`
        );
      }
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export interface ExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
}

/** Pull the full list of active USDT-margined perpetual contracts. */
export async function getPerpetualSymbols(): Promise<ExchangeSymbol[]> {
  return withRetry("getPerpetualSymbols", async () => {
    const { data } = await http.get("/fapi/v1/exchangeInfo");
    return data.symbols.filter(
      (s: any) =>
        s.contractType === "PERPETUAL" &&
        s.status === "TRADING" &&
        s.quoteAsset === "USDT"
    );
  });
}

/** 24h ticker stats — used to rank symbols by volume so we scan the most liquid universe first. */
export async function get24hTickers(): Promise<any[]> {
  return withRetry("get24hTickers", async () => {
    const { data } = await http.get("/fapi/v1/ticker/24hr");
    return data;
  });
}

/** Historical klines for indicator bootstrapping / on-demand recompute. */
export async function getKlines(symbol: string, interval = "5m", limit = 200) {
  return withRetry(`getKlines(${symbol})`, async () => {
    const { data } = await http.get("/fapi/v1/klines", {
      params: { symbol, interval, limit },
    });
    return data.map((k: any[]) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }));
  }, { retries: 3, baseDelayMs: 1000 }); // fewer retries — this runs once per symbol (~150x)
}

export async function getFundingRate(symbol: string) {
  const { data } = await http.get("/fapi/v1/premiumIndex", { params: { symbol } });
  return {
    symbol,
    fundingRate: parseFloat(data.lastFundingRate),
    nextFundingTime: data.nextFundingTime,
  };
}

export async function getOpenInterest(symbol: string) {
  const { data } = await http.get("/fapi/v1/openInterest", { params: { symbol } });
  return { symbol, openInterest: parseFloat(data.openInterest) };
}
