/** One-shot ghost user: joins, says hi, leaves. Test client only. */
const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8123");

ws.on("open", () => console.log("[ghost] connected"));

ws.on("message", (raw) => {
  const o = JSON.parse(raw);
  if (o.type === "welcome") {
    console.log(`[ghost] I am "${o.name}" (${o.online} online)`);
    ws.send(JSON.stringify({ type: "msg", text: "anyone else dying here? 👋" }));
  } else if (o.type === "chat" || o.type === "system") {
    console.log(`[ghost] ${o.from ? o.from + " » " : ""}${o.text}`);
  }
});

setTimeout(() => {
  ws.close();
  console.log("[ghost] vanished");
  process.exit(0);
}, 6000);
