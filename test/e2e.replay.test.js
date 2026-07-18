// End-to-end pipeline test: a scripted transcript (real STT skipped — segments are
// injected directly) run through the exact same orchestration server.js uses
// (rules.js first, extract.js fallback, events.js gating, timers.js, export.js),
// asserting the final event log matches the expected sequence and the export validates.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { matchRules } from "../src/pipeline/rules.js";
import { extractEvent } from "../src/pipeline/extract.js";
import { EventStore } from "../src/pipeline/events.js";
import { reduceEvents, computeDisplay, DEFAULT_TIMER_CONFIG } from "../src/pipeline/timers.js";
import { buildStructuredExport, buildMarkdownExport } from "../src/pipeline/export.js";
import { getConfig } from "../src/config.js";

const T0 = Date.parse("2026-07-18T15:00:00Z");
const sec = (n) => n * 1000;

// Mirrors server.js#handleTranscriptSegment without the WS broadcast/chunker plumbing.
async function processSegment(store, text, timestamp, config) {
  const ruleMatch = matchRules(text, timestamp);
  if (ruleMatch) {
    store.ingest(ruleMatch);
    return;
  }
  const extracted = await extractEvent(text, timestamp, config);
  if (extracted) store.ingest(extracted);
}

const SCRIPT = [
  "code blue, room four",
  "starting compressions",
  "got an IV in the right AC",
  "pushing another round of epi",
  "think I heard someone mention lido", // rules miss -> extract.js, low confidence -> pending
  "totally unintelligible garble", // rules miss -> extract.js times out -> note
  "king airway is in",
  "let's hold compressions, checking pulse",
  "asystole on the monitor",
  "resume compressions",
  "amiodarone 300 milligrams pushed",
  "we have ROSC",
];

function llmResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe("e2e scripted transcript replay", () => {
  let originalFetch;
  let store;
  let config;

  beforeEach(async () => {
    originalFetch = global.fetch;
    global.fetch = mock((url, init) => {
      const body = JSON.parse(init.body);
      const userText = body.messages[1].content;
      if (userText === "think I heard someone mention lido") {
        return Promise.resolve(
          llmResponse(
            JSON.stringify({
              event_type: "med_administered",
              drug: "lidocaine",
              confidence: 0.4,
              verbatim: userText,
            })
          )
        );
      }
      // "totally unintelligible garble" — simulate an LLM timeout.
      return Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    });

    store = new EventStore({ confidence_threshold: 0.7 });
    config = getConfig();

    for (let i = 0; i < SCRIPT.length; i++) {
      await processSegment(store, SCRIPT[i], T0 + sec(i * 20), config);
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("logs the expected event sequence in order", () => {
    const log = store.getLog();
    expect(log.map((e) => e.event_type)).toEqual([
      "code_started",
      "cpr_started",
      "access_established",
      "med_administered",
      "note",
      "airway_placed",
      "cpr_paused",
      "rhythm_check",
      "cpr_resumed",
      "med_administered",
      "rosc_achieved",
    ]);
  });

  test("rules-resolved events are logged with source rules and high confidence", () => {
    const codeStarted = store.getLog().find((e) => e.event_type === "code_started");
    expect(codeStarted.source).toBe("rules");
    expect(codeStarted.confidence).toBe("high");
  });

  test("the low-confidence LLM candidate sits in the pending confirm queue, not the log", () => {
    const pending = store.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].drug).toBe("lidocaine");
    expect(store.getLog().some((e) => e.drug === "lidocaine")).toBe(false);
  });

  test("the LLM timeout never drops the audio — it becomes a note with the raw text", () => {
    const note = store.getLog().find((e) => e.event_type === "note");
    expect(note.verbatim).toBe("totally unintelligible garble");
    expect(note.extraction_error).toBe("timeout");
  });

  test("confirming the pending candidate appends it to the log with source human-confirmed", () => {
    const [pending] = store.getPending();
    const confirmed = store.confirmPending(pending.id);
    expect(confirmed.source).toBe("human-confirmed");
    expect(store.getLog().length).toBe(12);
    expect(store.getPending().length).toBe(0);
  });

  test("rhythm is recorded verbatim, never interpreted", () => {
    const rhythm = store.getLog().find((e) => e.event_type === "rhythm_check");
    expect(rhythm.rhythm_reported).toBe("asystole");
  });

  test("ROSC stops the timers and freezes elapsed/epi/cpr displays", () => {
    const timerState = reduceEvents(store.getLog());
    expect(timerState.stopped).toBe(true);

    const display = computeDisplay(timerState, T0 + sec(9999), DEFAULT_TIMER_CONFIG);
    expect(display.epi.active).toBe(false);
    expect(display.cpr.active).toBe(false);
    expect(display.elapsedCodeSeconds).toBe(220); // 11 segments * 20s apart
  });

  test("the structured export validates: correct outcome, JSON round-trips cleanly", () => {
    store.confirmPending(store.getPending()[0].id);
    const exported = buildStructuredExport(store.getLog(), { profileName: "test" });

    expect(exported.outcome.status).toBe("rosc_achieved");
    expect(exported.events.length).toBe(12);
    expect(exported.epinephrineIntervals.length).toBe(1); // only one true epinephrine dose

    const roundTripped = JSON.parse(JSON.stringify(exported));
    expect(roundTripped.outcome.status).toBe("rosc_achieved");
    expect(roundTripped.events.length).toBe(12);
  });

  test("the markdown export contains the full timestamped table and outcome", () => {
    const md = buildMarkdownExport(store.getLog(), { profileName: "test" });
    expect(md).toContain("Outcome: rosc_achieved");
    expect(md).toContain("Code started");
    expect(md).toContain("ROSC achieved");
    expect((md.match(/\n\|/g) || []).length).toBeGreaterThanOrEqual(11); // header + 11 rows minimum
  });
});
