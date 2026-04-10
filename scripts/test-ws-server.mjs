#!/usr/bin/env node
// Synthetic WebSocket server for manual testing of peer geo + globe rendering.
// Usage: node scripts/test-ws-server.mjs
// Then open http://localhost:8082 — it will connect to ws://localhost:8080/ws

import { createServer } from "node:http";

const server = createServer();
const port = 8085;

// Minimal WebSocket handshake (no external deps)
import { createHash } from "node:crypto";

function wsHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsFrame(data) {
  const payload = Buffer.from(data, "utf8");
  const len = payload.length;
  const header = len < 126
    ? Buffer.from([0x81, len])
    : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([header, payload]);
}

function send(socket, obj) {
  try { socket.write(wsFrame(JSON.stringify(obj))); } catch {}
}

const PEERS = [
  "preprod-node.play.dev.cardano.org:3001",
  "1.2.3.4:3001",
];

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") { socket.destroy(); return; }
  wsHandshake(req, socket);
  console.log("Client connected");

  let tick = 0;

  // Send accepted event for each peer immediately
  for (const peer of PEERS) {
    send(socket, {
      type: "spans_batch",
      spans: [{
        name: "accepted",
        target: "amaru::protocols::manager",
        attributes: [
          ["peer", peer],
          ["conn_id", `conn-${peer}`]
        ]
      }]
    });
  }

  // Send live arcs periodically (without blinking — just new arc events)
  const interval = setInterval(() => {
    tick++;
    const peer = PEERS[tick % PEERS.length];
    send(socket, {
      type: "spans_batch",
      spans: [{
        name: "accepted",
        target: "amaru::protocols::manager",
        attributes: [
          ["peer", peer],
          ["conn_id", `conn-${tick}`]
        ]
      }]
    });

    // Also send a metrics_batch to stress-test that it doesn't cause blinking
    send(socket, {
      type: "metrics_batch",
      metrics: [{ name: "test_metric", value: tick, description: "test" }]
    });
  }, 3000);

  socket.on("close", () => { clearInterval(interval); console.log("Client disconnected"); });
  socket.on("error", () => clearInterval(interval));
});

server.listen(port, () => {
  console.log(`Test WS server running on ws://localhost:${port}/ws`);
  console.log("Open http://localhost:8082 and watch peers appear on the globe");
});
