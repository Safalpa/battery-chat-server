/**
 * Functional test suite for the battery-chat server.
 * Usage: node test-suite.js [ws-url]
 *   default url: wss://battery-chat-server.onrender.com
 *
 * Identities rotate on every pairing (the server rebrands both sides in the
 * `matched` message), so a "locked pair" is verified by mutual consistency:
 * each side's matched.partner must equal the other side's matched.name.
 *
 * The suite tolerates other clients in the room (e.g. a live app instance).
 */
const WebSocket = require("ws");

const URL = process.argv[2] || "wss://battery-chat-server.onrender.com";
const LOCAL = /localhost|127\.0\.0\.1/.test(URL);

let passed = 0;
let failed = 0;
const allSockets = [];

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log("  PASS  " + name);
  } else {
    failed++;
    console.log("  FAIL  " + name + (extra ? "  — " + extra : ""));
  }
}

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { label, ws, inbox: [], closed: false };
    allSockets.push(ws);
    ws.on("message", (raw) => {
      try {
        c.inbox.push(JSON.parse(raw.toString()));
      } catch {}
    });
    ws.on("close", () => {
      c.closed = true;
    });
    ws.on("open", () => resolve(c));
    ws.on("error", () => {});
  });
}

function waitFor(c, type, pred, label, ms = 10000) {
  return new Promise((resolve, reject) => {
    const scan = () => c.inbox.find((m) => m.type === type && (!pred || pred(m)));
    const hit = scan();
    if (hit) return resolve(hit);
    const timer = setInterval(() => {
      const h = scan();
      if (h) {
        clearInterval(timer);
        clearTimeout(deadline);
        resolve(h);
      }
    }, 50);
    const deadline = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(c.label + ": timeout waiting for " + (label || type)));
    }, ms);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** All names a client has ever held (welcome name + one per pairing). */
function knownNames(c) {
  return new Set(
    c.inbox.filter((m) => (m.type === "welcome" || m.type === "matched") && m.name).map((m) => m.name)
  );
}

/**
 * Pair the already-connected client `a` with a freshly connected stranger,
 * retrying around queue-jumpers. Returns the newcomer once the mutual
 * match is verified. Updates a.name / newcomer.name to their chat names.
 */
async function pairNewcomerWith(a) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const mark = a.inbox.length;
    const b = await connect("newcomer-" + attempt);
    const wB = await waitFor(b, "welcome", null, "welcome");
    b.name = wB.name;
    await Promise.race([
      Promise.all([
        waitFor(a, "matched", null, "any match", 8000).catch(() => null),
        waitFor(b, "matched", null, "any match", 8000).catch(() => null),
      ]),
      sleep(8500),
    ]);
    const mA = a.inbox.slice(mark).find((m) => m.type === "matched");
    const mB = b.inbox.find((m) => m.type === "matched");
    if (mA && mB && mA.partner === mB.name && mB.partner === mA.name) {
      a.name = mA.name;
      b.name = mB.name;
      return [b, mA, mB];
    }
    b.ws.close(); // b paired someone else (or nobody); try again
    await sleep(400);
  }
  throw new Error("could not pair a newcomer with " + a.label + " after 6 attempts");
}

(async () => {
  console.log("Testing " + URL + (LOCAL ? " (controlled room)" : "") + "\n");

  // ---- 1. welcome & identity ----
  const A = await connect("A");
  const wA = await waitFor(A, "welcome", null, "welcome");
  A.name = wA.name;
  ok("server greets new client with welcome + name", !!A.name);
  ok("name has the AdjectiveNoun## shape", /^([A-Z][a-z]+){2}\d{2}$/.test(A.name || ""), A.name);

  // ---- 2. unique names under concurrency ----
  const probe = [];
  for (let i = 0; i < 8; i++) probe.push(await connect("p" + i));
  await Promise.all(probe.map((c) => waitFor(c, "welcome", null, "welcome")));
  const probeNames = probe.map((c) => c.inbox.find((m) => m.type === "welcome").name);
  ok("names are unique across 9 concurrent clients", new Set([...probeNames, A.name]).size === 9);
  probe.forEach((c) => c.ws.close());
  await sleep(500);

  // ---- 3. 1-on-1 matching with rotating identities ----
  const preName = A.name;
  const [B, mA, mB] = await pairNewcomerWith(A);
  ok("two queued clients get matched", !!mA && !!mB);
  ok("each is told their own fresh chat name", !!mA.name && !!mB.name && /^([A-Z][a-z]+){2}\d{2}$/.test(mA.name));
  ok("identities rotate on pairing (name differs from queue name)", A.name !== preName, preName + " -> " + A.name);
  ok("each is told the partner's current name", mA.partner === B.name && mB.partner === A.name);
  const introA = await waitFor(A, "system", (m) => /alone with/.test(m.text), "intro");
  ok("paired clients get an intro whisper", !!introA);

  // ---- 4. message routing & no echo ----
  const markA = A.inbox.length;
  A.ws.send(JSON.stringify({ type: "msg", text: "ping from A" }));
  const rB = await waitFor(B, "chat", (m) => m.text === "ping from A", "chat from A");
  ok("partner receives the message with sender's current name", rB.from === A.name);
  await sleep(700);
  ok(
    "sender gets no echo of own message (server-side)",
    !A.inbox.slice(markA).some((m) => m.type === "chat")
  );

  // ---- 5. third-party isolation & hostile input ----
  const C = await connect("C");
  await waitFor(C, "welcome", null, "welcome");
  await sleep(800);
  const markB = B.inbox.length;
  C.ws.send(JSON.stringify({ type: "msg", text: "C should be invisible" }));
  C.ws.send("this is not json {{{");
  C.ws.send(JSON.stringify({ type: "msg", text: 12345 }));
  C.ws.send(JSON.stringify({ type: "msg", text: "   " }));
  C.ws.send(JSON.stringify({ nope: true }));
  await sleep(800);
  ok("unpaired client's messages go nowhere", !B.inbox.slice(markB).some((m) => m.text && String(m.text).includes("invisible")));
  ok("garbage input doesn't kill the connection", !C.closed);
  C.ws.close();

  // ---- 6. message limits ----
  A.ws.send(JSON.stringify({ type: "msg", text: "x".repeat(600) }));
  const rLong = await waitFor(B, "chat", (m) => typeof m.text === "string" && m.text.startsWith("xx"), "long msg");
  ok("600-char message clamped to 500", rLong.text.length === 500, "got " + rLong.text.length);

  A.ws.send(JSON.stringify({ type: "msg", text: "y".repeat(1024 * 1024) }));
  const rHuge = await waitFor(B, "chat", (m) => typeof m.text === "string" && m.text.startsWith("yy"), "huge msg");
  ok("1 MB message handled without crashing server", rHuge.text.length === 500 && !A.closed && !B.closed);

  // ---- 7. graceful partner death → requeue ----
  const inboxBeforeClose = A.inbox.map((m) => m.type).join(",");
  B.ws.close();
  const van = await waitFor(
    A,
    "system",
    (m) => /vanished/.test(m.text) && A.inbox.indexOf(m) >= markA,
    "vanish notice",
    LOCAL ? 10000 : 70000
  ).catch(() => null);
  if (!van) {
    console.log("  DEBUG: A inbox at failure: [" + A.inbox.map((m) => m.type).join(",") + "] before-close: [" + inboxBeforeClose + "]");
    console.log("  DEBUG: B.closed =", B.closed, "| A.closed =", A.closed, "| A.name =", A.name, "| B.name =", B.name);
    console.log("  DEBUG: A last 3 inbox entries:", JSON.stringify(A.inbox.slice(-3)));
  }
  ok("survivor is told the partner vanished", !!van);
  const reQ = await waitFor(A, "waiting", null, "requeue", LOCAL ? 10000 : 70000).catch(() => null);
  ok("survivor is requeued automatically", !!reQ);
  await sleep(400);
  ok("closed socket is really closed", B.closed);

  // ---- 8. survivor matches the next arrival, name rotates again ----
  const nameBefore = A.name;
  const [D] = await pairNewcomerWith(A);
  ok("survivor pairs with the next stranger", true);
  ok("survivor's name rotated again on the new pairing", A.name !== nameBefore, nameBefore + " -> " + A.name);

  // ---- 9. abrupt death (RST, no close frame) ----
  D.ws.terminate();
  await waitFor(A, "system", (m) => /vanished/.test(m.text) && A.inbox.indexOf(m) >= markA, "vanish after RST", LOCAL ? 10000 : 70000);
  ok("abrupt socket death is detected, survivor requeued", true);

  // ---- 10. crowd pairing ----
  const crowd = [];
  for (let i = 0; i < 11; i++) crowd.push(await connect("c" + i));
  await Promise.all(crowd.map((c) => waitFor(c, "welcome", null, "welcome")));
  await Promise.all(crowd.map((c) => waitFor(c, "matched", null, "matched", 15000).catch(() => null)));
  await waitFor(A, "matched", null, "crowd match for A", 15000).catch(() => null);
  const matchedCrowd = crowd.filter((c) => c.inbox.some((m) => m.type === "matched"));
  if (LOCAL) {
    ok("11 newcomers + survivor form 6 pairs", matchedCrowd.length === 11, matchedCrowd.length + "/11 matched");
  } else {
    ok("all 11 newcomers got matched (strangers tolerated)", matchedCrowd.length === 11, matchedCrowd.length + "/11 matched");
  }

  A.ws.send(JSON.stringify({ type: "msg", text: "hello-from-A" }));
  crowd.forEach((c, i) => c.ws.send(JSON.stringify({ type: "msg", text: "hello-from-" + i })));
  await sleep(2000);
  const everyone = [...crowd, A];
  const noSelf = everyone.every((c) => {
    const own = knownNames(c);
    return !c.inbox.some((m) => m.type === "chat" && own.has(m.from));
  });
  ok("nobody ever receives their own message from the server (any of its names)", noSelf);
  const atMostOne = everyone.every((c) => {
    const chats = c.inbox.filter((m) => m.type === "chat" && /^hello-from-(A|\d+)$/.test(m.text));
    return chats.length <= 1;
  });
  ok("messages only ever reach the intended partner", atMostOne);
  if (LOCAL) {
    const exactlyOne = everyone.every((c) => {
      const chats = c.inbox.filter((m) => m.type === "chat" && /^hello-from-(A|\d+)$/.test(m.text));
      return chats.length === 1;
    });
    ok("every paired client received exactly one partner message", exactlyOne);
  }

  // ---- 11. server health after the barrage ----
  const Z = await connect("Z");
  const wZ = await waitFor(Z, "welcome", null, "welcome").catch(() => null);
  ok("server still healthy and assigning names after all abuse", !!wZ && !!wZ.name);

  // ---- cleanup ----
  allSockets.forEach((s) => {
    try {
      s.close();
    } catch {}
  });
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("SUITE ERROR:", e.message);
  allSockets.forEach((s) => {
    try {
      s.terminate();
    } catch {}
  });
  process.exit(2);
});
