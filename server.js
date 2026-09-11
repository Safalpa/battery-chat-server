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
const AVOID_RECENT_CHANCE = 0.7; // odds of refusing to face the same stranger twice in a row
const RECENT_PARTNER_TTL = 3 * 60 * 1000; // how long a face stays familiar (RAM only)
const RETRY_MATCHMAKE_MS = 5000; // re-knock interval when avoidance stalls the queue

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
  res.end("battery-chat server v4 — secure windows, numbers buried on sight.");
});

const wss = new WebSocketServer({ server });
server.listen(PORT);

const usedNames = new Set();   // names in use right now (RAM only)
const waitingQueue = [];      // sockets without a partner

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Numbers are how strangers stop being strangers. These get buried on sight.
const PHONE_LIKE = /\+?\d(?:[\s\-().]*\d)+/g;

function buryNumbers(text) {
  return text.replace(PHONE_LIKE, (m) =>
    m.replace(/\D/g, "").length >= 7 ? "[numbers die here too]" : m
  );
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

const breathing = (ws) => ws.readyState === ws.OPEN;

// A short RAM-only memory of who you just talked to, so the room can avoid
// throwing you back together. It expires and is never written anywhere.
function rememberPair(a, b) {
  const now = Date.now();
  for (const [x, y] of [[a, b], [b, a]]) {
    if (!x.recent) x.recent = new Map();
    x.recent.set(y, now);
  }
}

function isRecentPartner(a, b) {
  const t = a.recent && a.recent.get(b);
  if (!t) return false;
  if (Date.now() - t > RECENT_PARTNER_TTL) {
    a.recent.delete(b);
    if (b.recent) b.recent.delete(a);
    return false;
  }
  return true;
}

// Render's proxy can keep a departed client's socket looking open for
// ~a minute. Before introducing two strangers, make sure the queued one
// still has a living client behind it.
function responds(ws, ms = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    ws.once("pong", () => {
      clearTimeout(timer);
      resolve(true);
    });
    ws.ping();
  });
}

async function matchmake(ws) {
  if (ws.partner || !breathing(ws)) return;
  if (ws.retryTimer) {
    clearTimeout(ws.retryTimer);
    ws.retryTimer = null;
  }
  let i = 0;
  while (i < waitingQueue.length) {
    const other = waitingQueue[i];
    if (other === ws) {
      i++;
      continue;
    }
    if (!breathing(other)) {
      waitingQueue.splice(i, 1);
      continue;
    }
    // 70% of the time, refuse to face the same stranger twice in a row.
    if (isRecentPartner(ws, other) && Math.random() < AVOID_RECENT_CHANCE) {
      i++;
      continue;
    }
    waitingQueue.splice(i, 1);
    if (await responds(other)) {
      pairUp(ws, other);
      return;
    }
    // No pong in time: the stranger was already gone. Loop.
  }
  const alreadyQueued = waitingQueue.includes(ws);
  if (!alreadyQueued) {
    waitingQueue.push(ws);
    send(ws, {
      type: "waiting",
      text: "Waiting for another dying stranger… (connecting)",
    });
  }
  // Two ex-partners alone in the queue can refuse each other into a
  // deadlock — knock again every few seconds until the 30% happens or
  // the memory of each other expires.
  ws.retryTimer = setTimeout(() => {
    ws.retryTimer = null;
    if (!ws.partner && breathing(ws)) matchmake(ws);
  }, RETRY_MATCHMAKE_MS);
}

function rebrand(ws) {
  usedNames.delete(ws.name);
  ws.name = generateName();
  usedNames.add(ws.name);
}

function pairUp(a, b) {
  // Fresh identities for every conversation. Whoever you were while waiting
  // dies here, and the name you chat under dies with the chat.
  rebrand(a);
  rebrand(b);
  a.partner = b;
  b.partner = a;
  send(a, { type: "matched", name: a.name, partner: b.name });
  send(b, { type: "matched", name: b.name, partner: a.name });
  send(a, {
    type: "system",
    text: `You're now alone with ${b.name}. Say hi before one of you dies.`,
  });
  send(b, {
    type: "system",
    text: `You're now alone with ${a.name}. Say hi before one of you dies.`,
  });
}

// A voluntary walk-away. The partner can't tell leaving from dying —
// that's the point.
function breakUp(ws) {
  const partner = ws.partner;
  if (!partner) return;
  rememberPair(ws, partner);
  partner.partner = null;
  ws.partner = null;
  send(partner, {
    type: "system",
    text: `${ws.name} vanished without a trace. (battery died? plugged in?)`,
  });
  matchmake(partner);
  matchmake(ws);
}

function handleLeave(ws) {
  usedNames.delete(ws.name); // name dies with the connection

  const partner = ws.partner;
  if (partner) {
    rememberPair(ws, partner);
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
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
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
    if (msg.type === "leave") {
      breakUp(ws);
      return;
    }
    if (msg.type === "msg" && typeof msg.text === "string" && ws.partner) {
      const buried = buryNumbers(msg.text.trim());
      const text = buried.slice(0, MAX_TEXT).trim();
      if (!text) return;
      // 1-on-1: only the current partner ever sees it. No storage anywhere.
      send(ws.partner, { type: "chat", from: ws.name, text });
      if (buried !== msg.text.trim()) {
        send(ws, {
          type: "system",
          text: "we buried the numbers in that one — nothing here lives long enough to dial",
        });
      }
    }
  });

  ws.on("close", () => handleLeave(ws));
  ws.on("error", () => ws.terminate());
});

// Heartbeat sweep: sockets that stop answering pings get terminated, so a
// client that vanished without a word is dropped in ~15-30s instead of haunting
// the queue until the proxy feels like mentioning it.
const HEARTBEAT_MS = 15000;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

console.log(`battery-chat (1-on-1 matchmaking) running on ws://0.0.0.0:${PORT}`);
console.log("No database. No logs. No mercy.");
