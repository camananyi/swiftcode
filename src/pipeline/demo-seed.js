// Dev-only fake event feed so the UI can be built/tested before stt.js and extract.js
// are wired up. Enabled with SWIFTCODE_SEED_DEMO=1. Never imported by the real pipeline.

import { matchRules } from "./rules.js";

const SCRIPT_OFFSETS_SECONDS = [
  [0, "code blue, room four"],
  [5, "starting compressions"],
  [20, "got an IV in the right AC"],
  [45, "pushing another round of epi"],
  [70, "king airway is in"],
  [130, "let's hold compressions, checking pulse"],
  [132, "asystole on the monitor"],
  [135, "resume compressions"],
  [225, "amiodarone 300 milligrams pushed"],
];

export function seedDemoEvents(store) {
  const now = Date.now();
  const codeStartedAt = now - 240_000;

  for (const [offsetSeconds, text] of SCRIPT_OFFSETS_SECONDS) {
    const timestamp = codeStartedAt + offsetSeconds * 1000;
    const event = matchRules(text, timestamp);
    if (event) store.ingest(event);
  }

  // One low-confidence LLM candidate, to demonstrate the one-tap confirm queue.
  store.ingest({
    event_type: "med_administered",
    drug: "lidocaine",
    timestamp: codeStartedAt + 180_000,
    verbatim: "think I heard someone mention lido",
    source: "llm",
    confidence: 0.42,
  });

  // One unclassifiable utterance, to demonstrate the note fallback path.
  store.ingest({
    event_type: "note",
    timestamp: codeStartedAt + 200_000,
    verbatim: "someone call the attending, tell them we need another set of hands",
    source: "llm",
    confidence: 0.3,
  });

  // Only end the code (and trigger post-event summary generation) when explicitly asked
  // — the default seed leaves timers running so the live-ticking demo is visible.
  if (process.env.SWIFTCODE_SEED_ROSC === "1") {
    const roscEvent = matchRules("we have ROSC", codeStartedAt + 260_000);
    if (roscEvent) store.ingest(roscEvent);
  }

  console.log(`[demo-seed] seeded ${store.getLog().length} logged events, ${store.getPending().length} pending`);
}
