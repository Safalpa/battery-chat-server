/** Live test ghost: pairs with the app under test, exchanges messages, then dies abruptly. */
const WebSocket = require("ws");

const URL = process.argv[2] || "wss://battery-chat-server.onrender.com";
const LIFETIME = parseInt(process.argv[3] || "120000", 10);

const ws = new WebSocket(URL);
const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

ws.on("open", () => log("connected"));
ws.on("message", (raw) => {
  const o = JSON.parse(raw);
  if (o.type === "welcome") log(`I am "${o.name}"`);
  if (o.type === "waiting") log("queued, waiting for the app…");
  if (o.type === "matched") {
    log(`MATCHED with "${o.partner}" — sending greeting`);
    setTimeout(() => ws.send(JSON.stringify({ type: "msg", text: "hi from the test ghost — can you hear me?" })), 800);
  }
  if (o.type === "chat") log(`RECEIVED from ${o.from}: ${o.text}`);
  if (o.type === "system") log(`system: ${o.text}`);
});
ws.on("close", () => log("connection closed"));
ws.on("error", (e) => log("error: " + e.message));

setTimeout(() => {
  log("dying abruptly (terminate/RST) now");
  ws.terminate();
  setTimeout(() => process.exit(0), 500);
}, LIFETIME);
