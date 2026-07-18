// Bun.serve: one process owns HTTP (UI + REST), WebSocket broadcast, and the pipeline.
// Other pipeline modules are wired in here rather than reaching back into this file,
// so this stays the single composition root.

import { getConfig } from "./config.js";
import { EventStore } from "./pipeline/events.js";
import { reduceEvents, computeDisplay } from "./pipeline/timers.js";
import { seedDemoEvents } from "./pipeline/demo-seed.js";

const config = getConfig();
const store = new EventStore({ confidence_threshold: config.extraction.confidence_threshold });

const sockets = new Set();

function currentTimerState() {
  return reduceEvents(store.getLog());
}

function timersMessage() {
  return { type: "timers", timers: computeDisplay(currentTimerState(), Date.now(), config.timers) };
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of sockets) ws.send(payload);
}

function snapshotMessage() {
  return {
    type: "snapshot",
    profile: config.profileName,
    log: store.getLog(),
    pending: store.getPending(),
    timers: computeDisplay(currentTimerState(), Date.now(), config.timers),
  };
}

store.onChange((kind, payload) => {
  broadcast({ type: "event", kind, payload });
  broadcast(timersMessage());
});

// Timers advance on wall-clock time, so the UI needs a heartbeat independent of new events.
setInterval(() => broadcast(timersMessage()), 1000);

if (process.env.SWIFTCODE_SEED_DEMO === "1") {
  seedDemoEvents(store);
}

const uiIndexPath = new URL("./ui/index.html", import.meta.url);

const server = Bun.serve({
  port: config.server.port,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(uiIndexPath), { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      return Response.json({ profile: config.profileName, connectivity: config.connectivity });
    }

    if (url.pathname === "/api/confirm" && req.method === "POST") {
      const { id } = await req.json();
      const event = store.confirmPending(id);
      return Response.json({ ok: Boolean(event), event });
    }

    if (url.pathname === "/api/reject" && req.method === "POST") {
      const { id } = await req.json();
      const event = store.rejectPending(id);
      return Response.json({ ok: Boolean(event), event });
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      ws.send(JSON.stringify(snapshotMessage()));
    },
    close(ws) {
      sockets.delete(ws);
    },
    message(_ws, _raw) {
      // Reserved: client->server messages if we move confirm/reject off REST later.
    },
  },
});

console.log(`SwiftCode listening on http://localhost:${server.port} (profile: ${config.profileName})`);

export { store, server, config, broadcast };
