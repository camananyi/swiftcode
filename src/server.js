// Bun.serve: one process owns HTTP (UI + REST), WebSocket broadcast, and the pipeline.
// Other pipeline modules are wired in here rather than reaching back into this file,
// so this stays the single composition root.

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
const store = new EventStore({ confidence_threshold: config.extraction.confidence_threshold });

const sockets = new Set();

// A raw binary WS frame arrives as a Buffer/Uint8Array whose underlying ArrayBuffer may
// not be 2-byte aligned at byteOffset — read through a DataView instead of casting directly.
function bufferToInt16Array(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const samples = new Int16Array(raw.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

// Segment handling is shared by the live mic feed and file-replay mode (task 11) so both
// run the identical code path: broadcast the transcript, then let rules.js try first,
// falling back to the LLM only for what rules.js didn't resolve. Not awaited by the
// chunker — extraction latency must never block the next audio window from processing.
async function handleTranscriptSegment(segment) {
  broadcast({ type: "transcript", segment });

  const ruleMatch = matchRules(segment.text, segment.timestamp);
  if (ruleMatch) {
    store.ingest(ruleMatch);
    broadcast({ type: "latency", sttMs: segment.latencyMs, eventMs: Date.now() - segment.timestamp, stage: "rules", profile: config.profileName });
    return;
  }

  const extracted = await extractEvent(segment.text, segment.timestamp, config);
  if (extracted) store.ingest(extracted);
  broadcast({ type: "latency", sttMs: segment.latencyMs, eventMs: Date.now() - segment.timestamp, stage: "llm", profile: config.profileName });
}

const chunker = new AudioChunker({ config, onSegment: handleTranscriptSegment });

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
    summary: summaryResults,
  };
}

// Latest known status per job name, kept so a client that joins (or reconnects) after
// ROSC/termination still sees the record instead of missing the broadcast entirely.
const summaryResults = {};

function setSummaryResult(name, result) {
  summaryResults[name] = result;
  broadcast({ type: "summary", name, ...result });
}

const summaryQueue = new SummaryQueue({
  onStatusChange: ({ status, job, text, error }) => setSummaryResult(job.name, { status, text, error }),
});

// ROSC/termination triggers the two Claude call sites exactly once per code. Never
// called anywhere in the real-time loop.
let summaryTriggered = false;
async function triggerPostEventSummary() {
  const results = await runPostEventSummary(store.getLog(), summaryQueue, config);
  for (const [name, result] of Object.entries(results)) {
    setSummaryResult(name, result);
  }
}

store.onChange((kind, payload) => {
  broadcast({ type: "event", kind, payload });
  broadcast(timersMessage());

  if (kind === "logged" && !summaryTriggered && (payload.event_type === "rosc_achieved" || payload.event_type === "code_terminated")) {
    summaryTriggered = true;
    triggerPostEventSummary();
  }
});

// Timers advance on wall-clock time, so the UI needs a heartbeat independent of new events.
setInterval(() => broadcast(timersMessage()), 1000);

if (process.env.SWIFTCODE_SEED_DEMO === "1") {
  seedDemoEvents(store);
}

const uiIndexPath = new URL("./ui/index.html", import.meta.url);
const AUDIO_DIR = new URL("../audio/", import.meta.url);
const REPLAY_FILENAME_PATTERN = /^[\w.-]+\.wav$/i;

// Feeds a canned WAV through chunker.pushChunk() at 1x speed — the identical code path
// live mic uses. Triggered by loading the page with ?replay=filename.wav.
let replayInProgress = false;
async function startReplay(filename) {
  if (replayInProgress) return;
  if (!REPLAY_FILENAME_PATTERN.test(filename)) {
    broadcast({ type: "replay", status: "error", error: "Invalid replay filename" });
    return;
  }

  const filePath = new URL(filename, AUDIO_DIR).pathname;
  if (!(await Bun.file(filePath).exists())) {
    broadcast({ type: "replay", status: "error", error: `Audio file not found: ${filename}` });
    return;
  }

  replayInProgress = true;
  broadcast({ type: "replay", status: "started", filename });
  try {
    await replayWavFile(filePath, chunker, { chunkMs: config.audio.chunk_ms, targetSampleRate: config.audio.sample_rate });
    broadcast({ type: "replay", status: "finished", filename });
  } catch (err) {
    broadcast({ type: "replay", status: "error", error: err.message });
  } finally {
    replayInProgress = false;
  }
}

const server = Bun.serve({
  port: config.server.port,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const replayFile = url.searchParams.get("replay");
      if (replayFile) startReplay(replayFile); // fire-and-forget; page loads immediately
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

    if (url.pathname === "/api/export.json" && req.method === "GET") {
      const body = buildStructuredExport(store.getLog(), { profileName: config.profileName });
      return new Response(JSON.stringify(body, null, 2), {
        headers: { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=swiftcode-record.json" },
      });
    }

    // Optional call site: ask a factual question about the completed code, grounded
    // only in the structured event log. Never used in the real-time loop.
    if (url.pathname === "/api/judge-qa" && req.method === "POST") {
      const { question } = await req.json();
      try {
        const answer = await answerJudgeQuestion(question, store.getLog(), config);
        return Response.json({ ok: true, answer });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 502 });
      }
    }

    if (url.pathname === "/api/export.md" && req.method === "GET") {
      const body = buildMarkdownExport(store.getLog(), {
        profileName: config.profileName,
        narrativeText: summaryResults.code_record?.text,
        debriefText: summaryResults.debrief?.text,
      });
      return new Response(body, {
        headers: { "Content-Type": "text/markdown", "Content-Disposition": "attachment; filename=swiftcode-record.md" },
      });
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
    message(_ws, raw) {
      if (typeof raw === "string") return; // reserved for future JSON control messages
      chunker.pushChunk(bufferToInt16Array(raw));
    },
  },
});

console.log(`SwiftCode listening on http://localhost:${server.port} (profile: ${config.profileName})`);

export { store, server, config, broadcast, chunker, handleTranscriptSegment, summaryQueue, startReplay };
