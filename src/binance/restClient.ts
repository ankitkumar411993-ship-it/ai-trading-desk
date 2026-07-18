import axios from "axios";
import { config } from "../config";

const http = axios.create({ baseURL: config.binance.restBase, timeout: 10000 });

export interface ExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
}

/** Pull the full list of active USDT-margined perpetual contracts. */
export async function getPerpetualSymbols(): Promise<ExchangeSymbol[]> {
  const { data } = await http.get("/fapi/v1/exchangeInfo");
  return data.symbols.filter(
    (s: any) =>
      s.contractType === "PERPETUAL" &&
      s.status === "TRADING" &&
      s.quoteAsset === "USDT"
  );
}

/** 24h ticker stats — used to rank symbols by volume so we scan the most liquid universe first. */
export async function get24hTickers(): Promise<any[]> {
  const { data } = await http.get("/fapi/v1/ticker/24hr");
  return data;
}

/** Historical klines for indicator bootstrapping / on-demand recompute. */
export async function getKlines(symbol: string, interval = "5m", limit = 200) {
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
