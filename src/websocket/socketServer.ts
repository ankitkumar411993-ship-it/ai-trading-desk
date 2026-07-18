import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";

/**
 * Broadcasts scanner events (scan_update, binance_status, etc.) to every connected
 * dashboard client. One message type per event, JSON-encoded: { event, payload }.
 */
export function createSocketServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ event: "hello", payload: { message: "connected to AI trading desk" } }));

    ws.on("error", (err) => console.error("[ws-client] error", err));
  });

  function broadcast(event: string, payload: any) {
    const msg = JSON.stringify({ event, payload });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  }

  return { wss, broadcast };
}
