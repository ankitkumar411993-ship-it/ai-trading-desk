import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";

/**
 * Broadcasts scanner events (scan_update, binance_status, etc.) to every connected
 * dashboard client. One message type per event, JSON-encoded: { event, payload }.
 *
 * Also runs a ping/pong heartbeat every 25s. Two reasons this matters for a mobile client
 * specifically:
 *   1. Cloud hosts commonly sit behind a reverse proxy with an idle-connection timeout (often
 *      60-120s) — if a client's network briefly stalls (e.g. a phone's radio going into a
 *      low-power state) long enough to miss a scan_update broadcast, the proxy can silently
 *      drop the "idle" connection even though the client thinks it's still open. A ping every
 *      25s keeps traffic flowing well under any such timeout.
 *   2. It lets the server detect and clean up connections that went dead without a clean close
 *      (very common on mobile — the app gets backgrounded/network drops without a proper
 *      WebSocket close handshake) rather than continuing to hold and broadcast to them forever.
 */
export function createSocketServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    (ws as any).isAlive = true;
    ws.on("pong", () => {
      (ws as any).isAlive = true;
    });

    ws.send(JSON.stringify({ event: "hello", payload: { message: "connected to AI trading desk" } }));

    ws.on("error", (err) => console.error("[ws-client] error", err));
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        return ws.terminate(); // didn't respond to the last ping — assume dead, clean it up
      }
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, 25000);

  wss.on("close", () => clearInterval(heartbeat));

  function broadcast(event: string, payload: any) {
    const msg = JSON.stringify({ event, payload });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  }

  return { wss, broadcast };
}
