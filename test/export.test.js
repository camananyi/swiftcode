import { describe, test, expect } from "bun:test";
import { buildStructuredExport, buildMarkdownExport } from "../src/pipeline/export.js";

const T0 = Date.parse("2026-07-18T14:00:00Z");
const sec = (n) => n * 1000;

const EVENTS = [
  { id: "evt_1", event_type: "code_started", timestamp: T0, source: "rules", confidence: "high" },
  {
    id: "evt_2",
    event_type: "med_administered",
    drug: "epinephrine",
    dose: "1mg",
    route: "IV",
    timestamp: T0 + sec(60),
    source: "rules",
    confidence: "high",
    verbatim: "pushing epi",
  },
  {
    id: "evt_3",
    event_type: "med_administered",
    drug: "epinephrine",
    timestamp: T0 + sec(300),
    source: "rules",
    confidence: "high",
    verbatim: "another round of epi",
  },
  {
    id: "evt_4",
    event_type: "rhythm_check",
    rhythm_reported: "v-fib",
    timestamp: T0 + sec(310),
    source: "rules",
    confidence: "high",
  },
  {
    id: "evt_5",
    event_type: "note",
    verbatim: "someone grab another set of gloves",
    timestamp: T0 + sec(320),
    source: "llm",
    confidence: 0.3,
  },
  { id: "evt_6", event_type: "rosc_achieved", timestamp: T0 + sec(600), source: "rules", confidence: "high" },
];

describe("buildStructuredExport", () => {
  test("reports outcome from the terminal event, not assumed", () => {
    const result = buildStructuredExport(EVENTS, { profileName: "localhost" });
    expect(result.outcome.status).toBe("rosc_achieved");
    expect(result.outcome.timestamp).toBe(new Date(T0 + sec(600)).toISOString());
  });

  test("reports in_progress outcome when no terminal event exists yet", () => {
    const result = buildStructuredExport(EVENTS.slice(0, 2));
    expect(result.outcome.status).toBe("in_progress");
  });

  test("computes total code duration from start to terminal event", () => {
    const result = buildStructuredExport(EVENTS);
    expect(result.durations.totalCodeSeconds).toBe(600);
  });

  test("computes real epinephrine intervals, first dose has no prior interval", () => {
    const result = buildStructuredExport(EVENTS);
    expect(result.epinephrineIntervals.length).toBe(2);
    expect(result.epinephrineIntervals[0].secondsSincePreviousDose).toBeNull();
    expect(result.epinephrineIntervals[1].secondsSincePreviousDose).toBe(240);
  });

  test("uses RxNorm-style Title Case display names, not the raw drug key", () => {
    const result = buildStructuredExport(EVENTS);
    const medEvent = result.events.find((e) => e.resourceType === "MedicationAdministration" && e.id === "evt_2");
    expect(medEvent.medicationCodeableConcept.text).toBe("Epinephrine");
  });

  test("records rhythm verbatim, never interprets it", () => {
    const result = buildStructuredExport(EVENTS);
    const rhythmEvent = result.events.find((e) => e.id === "evt_4");
    expect(rhythmEvent.valueString).toBe("v-fib");
  });

  test("events are sorted chronologically regardless of input order", () => {
    const shuffled = [EVENTS[3], EVENTS[0], EVENTS[5], EVENTS[1], EVENTS[2], EVENTS[4]];
    const result = buildStructuredExport(shuffled);
    const ids = result.events.map((e) => e.id);
    expect(ids).toEqual(["evt_1", "evt_2", "evt_3", "evt_4", "evt_5", "evt_6"]);
  });
});

describe("buildMarkdownExport", () => {
  test("includes the full event table and computed outcome/duration", () => {
    const md = buildMarkdownExport(EVENTS, { profileName: "localhost" });
    expect(md).toContain("| Time | Event | Detail | Source |");
    expect(md).toContain("Outcome: rosc_achieved");
    expect(md).toContain("Total code duration: 10 min");
  });

  test("includes note verbatim text in the detail column", () => {
    const md = buildMarkdownExport(EVENTS);
    expect(md).toContain("someone grab another set of gloves");
  });

  test("includes narrative and debrief sections only when text is provided", () => {
    const withoutText = buildMarkdownExport(EVENTS);
    expect(withoutText).not.toContain("## Code Record Narrative");

    const withText = buildMarkdownExport(EVENTS, { narrativeText: "Chronological account.", debriefText: "Went well: X." });
    expect(withText).toContain("## Code Record Narrative");
    expect(withText).toContain("Chronological account.");
    expect(withText).toContain("## Plus/Delta Debrief");
    expect(withText).toContain("Went well: X.");
  });

  test("escapes pipe characters in table cells so they can't break the table", () => {
    const eventsWithPipe = [
      EVENTS[0],
      { ...EVENTS[4], verbatim: "note with a | pipe in it" },
    ];
    const md = buildMarkdownExport(eventsWithPipe);
    expect(md).toContain("note with a \\| pipe in it");
  });
});
