/** Long-lived ghost: hangs around 2 minutes, chatting now and then. */
const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8123");
const LINES = [
  "anyone else dying here? 👋",
  "my battery is on its last breath... 3%",
  "they say nobody who joins this room is ever seen again",
  "plug in and you vanish. that's the rule.",
  "2%. it was nice not knowing you all 👋",
];

ws.on("open", () => console.log("[ghost] connected, haunting for 2 minutes"));

ws.on("message", (raw) => {
  const o = JSON.parse(raw);
  if (o.type === "welcome") {
    console.log(`[ghost] I am "${o.name}"`);
  } else if (o.type === "chat") {
    console.log(`[ghost] ${o.from} » ${o.text}`);
  } else if (o.type === "system") {
    console.log(`[ghost] ·· ${o.text}`);
  }
});

let i = 0;
const chat = setInterval(() => {
  if (i < LINES.length) {
    ws.send(JSON.stringify({ type: "msg", text: LINES[i++] }));
  }
}, 20000);
ws.on("open", () => ws.send(JSON.stringify({ type: "msg", text: LINES[i++] })));

setTimeout(() => {
  clearInterval(chat);
  ws.close();
  console.log("[ghost] vanished");
  process.exit(0);
}, 120000);
