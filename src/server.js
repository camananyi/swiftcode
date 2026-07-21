// Bun.serve: one process owns HTTP (UI + REST), WebSocket broadcast, and the pipeline.
// Multi-session: every browser tab gets an isolated session (event store, audio
// chunker, timers, summary state) keyed by a client-generated sid passed on the WS
// url and every API call. Clients that send no sid share the "default" session.

import { getConfig } from "./config.js";
import { EventStore } from "./pipeline/events.js";
import { reduceEvents, computeDisplay } from "./pipeline/timers.js";
import { seedDemoEvents } from "./pipeline/demo-seed.js";
import { AudioChunker } from "./pipeline/stt.js";
import { matchRules } from "./pipeline/rules.js";
import { extractEvent } from "./pipeline/extract.js";
import { runPostEventSummary, SummaryQueue, answerJudgeQuestion } from "./pipeline/summary.js";
import { buildStructuredExport, buildMarkdownExport } from "./pipeline/export.js";
import { replayWavFile } from "./pipeline/replay.js";

const config = getConfig();

const SESSION_IDLE_EVICT_MS = 60 * 60 * 1000;
const sessions = new Map();

// A raw binary WS frame arrives as a Buffer/Uint8Array whose underlying ArrayBuffer may
// not be 2-byte aligned at byteOffset — read through a DataView instead of casting directly.
function bufferToInt16Array(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const samples = new Int16Array(raw.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

// Segment handling is shared by the live mic feed and file-replay mode so both run the
// identical code path: broadcast the transcript, then let rules.js try first, falling
// back to the LLM only for what rules.js didn't resolve. Not awaited by the chunker —
// extraction latency must never block the next audio window from processing.
async function handleTranscriptSegment(session, segment) {
  session.broadcast({ type: "transcript", segment });

  const ruleMatch = matchRules(segment.text, segment.timestamp);
  if (ruleMatch) {
    session.store.ingest(ruleMatch);
    session.broadcast({ type: "latency", sttMs: segment.latencyMs, eventMs: Date.now() - segment.timestamp, stage: "rules", profile: config.profileName });
    return;
  }

  const extracted = await extractEvent(segment.text, segment.timestamp, config);
  if (extracted) session.store.ingest(extracted);
  session.broadcast({ type: "latency", sttMs: segment.latencyMs, eventMs: Date.now() - segment.timestamp, stage: "llm", profile: config.profileName });
}

function timersMessage(session) {
  return { type: "timers", timers: computeDisplay(reduceEvents(session.store.getLog()), Date.now(), config.timers) };
}

function snapshotMessage(session) {
  return {
    type: "snapshot",
    profile: config.profileName,
    log: session.store.getLog(),
    pending: session.store.getPending(),
    timers: computeDisplay(reduceEvents(session.store.getLog()), Date.now(), config.timers),
    summary: session.summaryResults,
  };
}

function setSummaryResult(session, name, result) {
  session.summaryResults[name] = result;
  session.broadcast({ type: "summary", name, ...result });
}

// ROSC/termination triggers the two Claude call sites exactly once per session's code.
// Never called anywhere in the real-time loop.
async function triggerPostEventSummary(session) {
  const results = await runPostEventSummary(session.store.getLog(), session.summaryQueue, config);
  for (const [name, result] of Object.entries(results)) {
    setSummaryResult(session, name, result);
  }
}

function createSession(sid) {
  const session = {
    sid,
    store: new EventStore({ confidence_threshold: config.extraction.confidence_threshold }),
    sockets: new Set(),
    summaryResults: {},
    summaryTriggered: false,
    replayInProgress: false,
    lastActive: Date.now(),
  };

  session.broadcast = (message) => {
    const payload = JSON.stringify(message);
    for (const ws of session.sockets) ws.send(payload);
  };

  session.summaryQueue = new SummaryQueue({
    onStatusChange: ({ status, job, text, error }) => setSummaryResult(session, job.name, { status, text, error }),
  });

  session.chunker = new AudioChunker({ config, onSegment: (segment) => handleTranscriptSegment(session, segment) });

  session.store.onChange((kind, payload) => {
    session.broadcast({ type: "event", kind, payload });
    session.broadcast(timersMessage(session));

    if (kind === "logged" && !session.summaryTriggered && (payload.event_type === "rosc_achieved" || payload.event_type === "code_terminated")) {
      session.summaryTriggered = true;
      triggerPostEventSummary(session);
    }
  });

  return session;
}

function getSession(sid) {
  let session = sessions.get(sid);
  if (!session) {
    session = createSession(sid);
    sessions.set(sid, session);
  }
  session.lastActive = Date.now();
  return session;
}

function resetSession(session) {
  session.store.reset();
  session.summaryTriggered = false;
  session.summaryQueue.jobs.length = 0;
  for (const key of Object.keys(session.summaryResults)) delete session.summaryResults[key];
  session.broadcast({ type: "reset" });
  session.broadcast(snapshotMessage(session));
}

// Timers advance on wall-clock time, so the UI needs a heartbeat independent of new
// events. One interval serves every session that still has a viewer.
setInterval(() => {
  for (const session of sessions.values()) {
    if (session.sockets.size > 0) session.broadcast(timersMessage(session));
  }
}, 1000);

// Evict idle, viewerless sessions so a long-running public demo doesn't accumulate state.
setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (session.sockets.size === 0 && now - session.lastActive > SESSION_IDLE_EVICT_MS) {
      if (session.summaryQueue.timer) clearInterval(session.summaryQueue.timer);
      sessions.delete(sid);
    }
  }
}, 5 * 60 * 1000);

if (process.env.SWIFTCODE_SEED_DEMO === "1") {
  seedDemoEvents(getSession("default").store);
}

const uiIndexPath = new URL("./ui/index.html", import.meta.url);
const uiAgentPath = new URL("./ui/agent.html", import.meta.url);
const AUDIO_DIR = new URL("../audio/", import.meta.url);
const REPLAY_FILENAME_PATTERN = /^[\w.-]+\.wav$/i;

// Feeds a canned WAV through the session's chunker.pushChunk() at 1x speed — the
// identical code path live mic audio uses. Triggered by POST /api/replay.
async function startReplay(session, filename) {
  if (session.replayInProgress) return;
  if (!REPLAY_FILENAME_PATTERN.test(filename)) {
    session.broadcast({ type: "replay", status: "error", error: "Invalid replay filename" });
    return;
  }

  const filePath = new URL(filename, AUDIO_DIR).pathname;
  if (!(await Bun.file(filePath).exists())) {
    session.broadcast({ type: "replay", status: "error", error: `Audio file not found: ${filename}` });
    return;
  }

  session.replayInProgress = true;
  session.broadcast({ type: "replay", status: "started", filename });
  try {
    await replayWavFile(filePath, session.chunker, { chunkMs: config.audio.chunk_ms, targetSampleRate: config.audio.sample_rate });
    session.broadcast({ type: "replay", status: "finished", filename });
  } catch (err) {
    session.broadcast({ type: "replay", status: "error", error: err.message });
  } finally {
    session.replayInProgress = false;
  }
}

const server = Bun.serve({
  port: config.server.port,
  async fetch(req, server) {
    const url = new URL(req.url);
    const sid = url.searchParams.get("sid") || "default";

    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { sid } })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(uiIndexPath), { headers: { "Content-Type": "text/html" } });
    }

    // Agent-first view: same pipeline and WS protocol, rendered as the agent's
    // chronological perceive/reason/act stream rather than a mission-control layout.
    if (url.pathname === "/agent") {
      return new Response(Bun.file(uiAgentPath), { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      return Response.json({
        profile: config.profileName,
        host: new URL(config.profile.stt_base_url).host,
        connectivity: config.connectivity,
        timers: config.timers,
      });
    }

    // Replay is requested by the client (which knows its sid) rather than as a
    // page-load query, so the canned audio feeds the right session's chunker.
    if (url.pathname === "/api/replay" && req.method === "POST") {
      const { filename } = await req.json();
      startReplay(getSession(sid), String(filename || "")); // fire-and-forget; status arrives over WS
      return Response.json({ ok: true });
    }

    // Manual code-start (spec: code_started comes from a manual button OR the first
    // detected callout). Logged directly with source "manual", never routed through
    // ingest's rules/llm gating.
    if (url.pathname === "/api/code-started" && req.method === "POST") {
      const session = getSession(sid);
      if (session.store.getLog().some((e) => e.event_type === "code_started")) {
        return Response.json({ ok: false, error: "Code already started" }, { status: 409 });
      }
      const event = session.store.logEvent({ event_type: "code_started", timestamp: Date.now(), source: "manual" });
      return Response.json({ ok: true, event });
    }

    // Demo-console reset: clears this session only and pushes a fresh snapshot to
    // every client viewing it.
    if (url.pathname === "/api/reset" && req.method === "POST") {
      resetSession(getSession(sid));
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/confirm" && req.method === "POST") {
      const { id } = await req.json();
      const event = getSession(sid).store.confirmPending(id);
      return Response.json({ ok: Boolean(event), event });
    }

    if (url.pathname === "/api/reject" && req.method === "POST") {
      const { id } = await req.json();
      const event = getSession(sid).store.rejectPending(id);
      return Response.json({ ok: Boolean(event), event });
    }

    if (url.pathname === "/api/export.json" && req.method === "GET") {
      const body = buildStructuredExport(getSession(sid).store.getLog(), { profileName: config.profileName });
      return new Response(JSON.stringify(body, null, 2), {
        headers: { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=swiftcode-record.json" },
      });
    }

    // Optional call site: ask a factual question about the completed code, grounded
    // only in the structured event log. Never used in the real-time loop.
    if (url.pathname === "/api/judge-qa" && req.method === "POST") {
      const { question } = await req.json();
      try {
        const answer = await answerJudgeQuestion(question, getSession(sid).store.getLog(), config);
        return Response.json({ ok: true, answer });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 502 });
      }
    }

    if (url.pathname === "/api/export.md" && req.method === "GET") {
      const session = getSession(sid);
      const body = buildMarkdownExport(session.store.getLog(), {
        profileName: config.profileName,
        narrativeText: session.summaryResults.code_record?.text,
        debriefText: session.summaryResults.debrief?.text,
      });
      return new Response(body, {
        headers: { "Content-Type": "text/markdown", "Content-Disposition": "attachment; filename=swiftcode-record.md" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const session = getSession(ws.data.sid);
      session.sockets.add(ws);
      ws.send(JSON.stringify(snapshotMessage(session)));
    },
    close(ws) {
      const session = sessions.get(ws.data.sid);
      if (session) session.sockets.delete(ws);
    },
    message(ws, raw) {
      if (typeof raw === "string") return; // reserved for future JSON control messages
      getSession(ws.data.sid).chunker.pushChunk(bufferToInt16Array(raw));
    },
  },
});

console.log(`SwiftCode listening on http://localhost:${server.port} (profile: ${config.profileName})`);

export { server, config, sessions, getSession };
