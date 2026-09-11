/**
 * battery-chat server — random 1-on-1 matching edition
 * ----------------------------------------------------
 * Every connection (battery rules enforced on-device) enters a
 * matchmaking queue. Two waiting strangers get paired. When one
 * vanishes (battery died / plugged in / left), the survivor is
 * thrown straight back into the queue and matched with the next
 * dying stranger.
 *
 *  - Unique random name per user, freed on disconnect.
 *  - NOTHING is persisted. No sessions, no history, no logs.
 *  - Messages only travel between the two current partners.
 */
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8123; // moved off 8080: something else squats on 8080 here
const MAX_TEXT = 500;

const ADJECTIVES = [
  "Silent", "Fading", "Hollow", "Electric", "Midnight", "Dying", "Ghost",
  "Phantom", "Broken", "Last", "Dark", "Low", "Cold", "Static", "Wired",
  "Unplugged", "Final", "Pale", "Restless", "Withering",
];

const NOUNS = [
  "Panda", "Volt", "Signal", "Battery", "Circuit", "Echo", "Wraith",
  "Socket", "Current", "Shadow", "Pixel", "Spark", "Cable", "Pulse",
  "Charger", "Nurse", "Whisper", "Nectar", "Fossil", "Radio",
];

// Plain-HTTP front so Render's health checks (and browsers) can see the service is alive.
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("battery-chat server is running. connect via websocket.");
});

const wss = new WebSocketServer({ server });
server.listen(PORT);

const usedNames = new Set();   // names in use right now (RAM only)
const waitingQueue = [];      // sockets without a partner

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateName() {
  let name;
  do {
    name = `${pick(ADJECTIVES)}${pick(NOUNS)}${Math.floor(10 + Math.random() * 90)}`;
  } while (usedNames.has(name));
  return name;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function matchmake(ws) {
  if (ws.partner) return; // already paired
  if (waitingQueue.length > 0) {
    const other = waitingQueue.shift();
    pairUp(ws, other);
  } else {
    waitingQueue.push(ws);
    send(ws, {
      type: "waiting",
      text: "Waiting for another dying stranger… (connecting)",
    });
  }
}

function pairUp(a, b) {
  a.partner = b;
  b.partner = a;
  send(a, { type: "matched", partner: b.name });
  send(b, { type: "matched", partner: a.name });
  send(a, {
    type: "system",
    text: `You're now alone with ${b.name}. Say hi before one of you dies.`,
  });
  send(b, {
    type: "system",
    text: `You're now alone with ${a.name}. Say hi before one of you dies.`,
  });
}

function handleLeave(ws) {
  usedNames.delete(ws.name); // name dies with the connection

  const partner = ws.partner;
  if (partner) {
    partner.partner = null;
    send(partner, {
      type: "system",
      text: `${ws.name} vanished without a trace. (battery died? plugged in?)`,
    });
    // Survivor goes straight back into the queue for the next stranger.
    matchmake(partner);
  } else {
    const idx = waitingQueue.indexOf(ws);
    if (idx !== -1) waitingQueue.splice(idx, 1);
  }
}

wss.on("connection", (ws) => {
  ws.name = generateName();
  ws.partner = null;
  usedNames.add(ws.name);

  // Identity assigned. No accounts, no history, nothing kept.
  send(ws, {
    type: "welcome",
    name: ws.name,
    text: "You're in. 5% and falling. Do not plug in.",
  });

  matchmake(ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "msg" && typeof msg.text === "string" && ws.partner) {
      const text = msg.text.trim().slice(0, MAX_TEXT);
      if (!text) return;
      // 1-on-1: only the current partner ever sees it. No storage anywhere.
      send(ws.partner, { type: "chat", from: ws.name, text });
    }
  });

  ws.on("close", () => handleLeave(ws));
  ws.on("error", () => ws.terminate());
});

console.log(`battery-chat (1-on-1 matchmaking) running on ws://0.0.0.0:${PORT}`);
console.log("No database. No logs. No mercy.");
