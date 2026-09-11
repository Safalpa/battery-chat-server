/**
 * Demo: two ghosts in sequence, to show 1-on-1 matching.
 *  - Ghost A joins, talks with you, then "dies" (disconnects).
 *  - 3s later Ghost B joins and gets matched with you.
 */
const WebSocket = require("ws");

const URL = "ws://localhost:8123";

function spawnGhost(lines, lifetimeMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let name = "?";
    ws.on("message", (raw) => {
      const o = JSON.parse(raw);
      if (o.type === "welcome") {
        name = o.name;
        console.log(`[ghost] ${name} connected`);
      } else if (o.type === "matched") {
        console.log(`[ghost] ${name} matched with ${o.partner}`);
        lines.forEach((l, i) =>
          setTimeout(() => ws.send(JSON.stringify({ type: "msg", text: l })), 1200 + i * 2500)
        );
      } else if (o.type === "chat") {
        console.log(`[ghost] ${name} sees: ${o.from} » ${o.text}`);
      } else if (o.type === "system") {
        console.log(`[ghost] ${name} ·· ${o.text}`);
      }
    });
    setTimeout(() => {
      ws.close();
      console.log(`[ghost] ${name} died (disconnected)`);
      resolve();
    }, lifetimeMs);
  });
}

(async () => {
  await spawnGhost(
    ["hi... I'm at 3% 😭 how much left on yours?", "crazy that we can only talk while dying"],
    14000
  );
  console.log("[demo] 3s gap — you should see 'connecting…' …");
  await new Promise((r) => setTimeout(r, 3000));
  await spawnGhost(
    ["did the last one die on you? I'm at 4%", "new stranger, same fate 👋"],
    60000
  );
  console.log("[demo] done");
  process.exit(0);
})();
