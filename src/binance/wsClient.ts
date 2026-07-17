import WebSocket from "ws";
import { EventEmitter } from "events";
import { config } from "../config";

/**
 * Maintains a single combined-stream connection to Binance Futures for a set of symbols.
 * Emits: 'kline', 'trade', 'markPrice' events.
 * Auto-reconnects with exponential backoff and resubscribes on reconnect.
 * Binance also drops streams after 24h — this client transparently reconnects.
 */
export class BinanceStreamClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private symbols: string[];
  private reconnectAttempt = 0;
  private closedByUser = false;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(symbols: string[]) {
    super();
    this.symbols = symbols.map((s) => s.toLowerCase());
  }

  private buildStreamPath(): string {
    const streams: string[] = [];
    for (const s of this.symbols) {
      streams.push(`${s}@kline_1m`);
      streams.push(`${s}@kline_5m`);
      streams.push(`${s}@aggTrade`);
      streams.push(`${s}@markPrice@1s`);
    }
    return `${config.binance.wsBase}/stream?streams=${streams.join("/")}`;
  }

  connect() {
    this.closedByUser = false;
    const url = this.buildStreamPath();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.emit("connected");
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      }, 30000);
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        const stream: string = msg.stream;
        const payload = msg.data;
        if (stream.includes("@kline")) {
          this.emit("kline", {
            symbol: payload.s,
            interval: payload.k.i,
            openTime: payload.k.t,
            open: parseFloat(payload.k.o),
            high: parseFloat(payload.k.h),
            low: parseFloat(payload.k.l),
            close: parseFloat(payload.k.c),
            volume: parseFloat(payload.k.v),
            isClosed: payload.k.x,
          });
        } else if (stream.includes("@aggTrade")) {
          this.emit("trade", {
            symbol: payload.s,
            price: parseFloat(payload.p),
            qty: parseFloat(payload.q),
            isBuyerMaker: payload.m,
            time: payload.T,
          });
        } else if (stream.includes("@markPrice")) {
          this.emit("markPrice", {
            symbol: payload.s,
            markPrice: parseFloat(payload.p),
            fundingRate: parseFloat(payload.r),
            nextFundingTime: payload.T,
          });
        }
      } catch (err) {
        this.emit("error", err);
      }
    });

    this.ws.on("close", () => {
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.emit("disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.emit("error", err);
      this.ws?.close();
    });
  }

  private scheduleReconnect() {
    this.reconnectAttempt++;
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    setTimeout(() => this.connect(), delay);
  }

  updateSymbols(symbols: string[]) {
    this.symbols = symbols.map((s) => s.toLowerCase());
    this.ws?.close(); // triggers reconnect with new stream list
  }

  close() {
    this.closedByUser = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.ws?.close();
  }
}
