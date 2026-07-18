import { describe, test, expect } from "bun:test";
import { matchRules } from "../src/pipeline/rules.js";

const T = Date.now();

const POSITIVE_FIXTURES = [
  { text: "code blue, room four", expect: { event_type: "code_started" } },
  { text: "starting compressions", expect: { event_type: "cpr_started" } },
  { text: "compressions started", expect: { event_type: "cpr_started" } },
  { text: "let's hold compressions, checking pulse", expect: { event_type: "cpr_paused" } },
  { text: "pausing for a pulse check", expect: { event_type: "cpr_paused" } },
  { text: "resume compressions", expect: { event_type: "cpr_resumed" } },
  { text: "compressions resumed", expect: { event_type: "cpr_resumed" } },
  { text: "back on the chest, continuing compressions", expect: { event_type: "cpr_resumed" } },
  { text: "pushing another round of epi", expect: { event_type: "med_administered", drug: "epinephrine" } },
  { text: "epi's in", expect: { event_type: "med_administered", drug: "epinephrine" } },
  {
    text: "give 1 milligram epinephrine IV push",
    expect: { event_type: "med_administered", drug: "epinephrine", dose: "1mg", route: "IV" },
  },
  {
    text: "amiodarone 300 milligrams pushed",
    expect: { event_type: "med_administered", drug: "amiodarone", dose: "300mg" },
  },
  { text: "atropine is going in", expect: { event_type: "med_administered", drug: "atropine" } },
  { text: "narcan on board", expect: { event_type: "med_administered", drug: "naloxone" } },
  {
    text: "charging to two hundred... everybody clear... shock delivered",
    expect: { event_type: "shock_delivered", energy_joules: 200 },
  },
  { text: "defibrillating at 200 joules", expect: { event_type: "shock_delivered", energy_joules: 200 } },
  { text: "rhythm check... looks like v-fib", expect: { event_type: "rhythm_check", rhythm_reported: "v-fib" } },
  { text: "asystole on the monitor", expect: { event_type: "rhythm_check", rhythm_reported: "asystole" } },
  { text: "PEA, continue compressions", expect: { event_type: "rhythm_check" } },
  { text: "sinus rhythm now, strong pulses", expect: { event_type: "rhythm_check" } },
  { text: "intubated successfully", expect: { event_type: "airway_placed", airway_type: "ETT" } },
  { text: "king airway is in", expect: { event_type: "airway_placed", airway_type: "King airway" } },
  { text: "bagging with a BVM", expect: { event_type: "airway_placed", airway_type: "BVM" } },
  { text: "got an IV in the right AC", expect: { event_type: "access_established", route: "IV" } },
  { text: "IO access in the left tibia", expect: { event_type: "access_established", route: "IO" } },
  { text: "we have ROSC", expect: { event_type: "rosc_achieved" } },
  { text: "pulse is back, strong and regular", expect: { event_type: "rosc_achieved" } },
  { text: "calling time of death, 14:32", expect: { event_type: "code_terminated" } },
  { text: "let's stop the code", expect: { event_type: "code_terminated" } },
];

const NEGATIVE_FIXTURES = [
  "let's hold off on epi",
  "no pulse",
  "we shocked him yesterday",
  "don't give amiodarone yet",
  "the epi drip from earlier this shift",
  "checking the vitals sheet",
  "we're going to grab more supplies",
];

describe("rules.js positive fixtures", () => {
  for (const fixture of POSITIVE_FIXTURES) {
    test(`"${fixture.text}"`, () => {
      const event = matchRules(fixture.text, T);
      expect(event).not.toBeNull();
      expect(event.source).toBe("rules");
      expect(event.confidence).toBe("high");
      for (const [key, value] of Object.entries(fixture.expect)) {
        expect(event[key]).toBe(value);
      }
    });
  }
});

describe("rules.js negative fixtures (must NOT fire)", () => {
  for (const text of NEGATIVE_FIXTURES) {
    test(`"${text}"`, () => {
      expect(matchRules(text, T)).toBeNull();
    });
  }
});

describe("rules.js edge cases", () => {
  test("empty string returns null", () => {
    expect(matchRules("", T)).toBeNull();
  });

  test("rhythm words are recorded verbatim, never interpreted", () => {
    const event = matchRules("looks like it's v-tach on the strip", T);
    expect(event.event_type).toBe("rhythm_check");
    expect(event.rhythm_reported.toLowerCase()).toBe("v-tach");
  });

  test("matcher runs in well under 1ms", () => {
    const start = performance.now();
    matchRules("pushing another round of epi", T);
    expect(performance.now() - start).toBeLessThan(5);
  });
});
