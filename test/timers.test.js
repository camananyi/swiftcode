import { describe, test, expect } from "bun:test";
import {
  createTimerState,
  applyEvent,
  reduceEvents,
  computeDisplay,
  DEFAULT_TIMER_CONFIG,
} from "../src/pipeline/timers.js";

const T0 = Date.parse("2026-07-18T10:00:00Z");
const sec = (n) => n * 1000;

describe("epi interval warning/alert firing", () => {
  const state = applyEvent(createTimerState(), {
    event_type: "med_administered",
    drug: "epinephrine",
    timestamp: T0,
  });

  test("ok before warning lead", () => {
    const display = computeDisplay(state, T0 + sec(60), DEFAULT_TIMER_CONFIG);
    expect(display.epi.status).toBe("ok");
  });

  test("warning at interval - lead", () => {
    const display = computeDisplay(state, T0 + sec(150), DEFAULT_TIMER_CONFIG);
    expect(display.epi.status).toBe("warning");
  });

  test("alert at interval", () => {
    const display = computeDisplay(state, T0 + sec(180), DEFAULT_TIMER_CONFIG);
    expect(display.epi.status).toBe("alert");
    expect(display.epi.message).toContain("Epinephrine interval reached per ACLS");
  });

  test("advisory phrasing only, never imperative", () => {
    const display = computeDisplay(state, T0 + sec(200), DEFAULT_TIMER_CONFIG);
    expect(display.epi.message.toLowerCase()).not.toContain("give");
    expect(display.epi.message.toLowerCase()).not.toContain("now");
  });
});

describe("CPR cycle reset on resume", () => {
  test("cycle timer resets when cpr_resumed fires", () => {
    let state = createTimerState();
    state = applyEvent(state, { event_type: "cpr_started", timestamp: T0 });

    const midCycle = computeDisplay(state, T0 + sec(90), DEFAULT_TIMER_CONFIG);
    expect(midCycle.cpr.status).toBe("ok");

    state = applyEvent(state, { event_type: "cpr_paused", timestamp: T0 + sec(95) });
    state = applyEvent(state, { event_type: "cpr_resumed", timestamp: T0 + sec(100) });

    // 110s after original start would have been past 120s only if not reset; confirm reset.
    const afterResume = computeDisplay(state, T0 + sec(110), DEFAULT_TIMER_CONFIG);
    expect(afterResume.cpr.status).toBe("ok");
    expect(afterResume.cpr.secondsSinceCycleStart).toBeCloseTo(10, 0);
  });

  test("alert fires once cycle exceeds cpr_cycle_seconds", () => {
    let state = createTimerState();
    state = applyEvent(state, { event_type: "cpr_started", timestamp: T0 });
    const display = computeDisplay(state, T0 + sec(121), DEFAULT_TIMER_CONFIG);
    expect(display.cpr.status).toBe("alert");
    expect(display.cpr.message).toContain("rhythm check per ACLS");
  });

  test("pausing does not itself reset the cycle", () => {
    let state = createTimerState();
    state = applyEvent(state, { event_type: "cpr_started", timestamp: T0 });
    state = applyEvent(state, { event_type: "cpr_paused", timestamp: T0 + sec(130) });
    const display = computeDisplay(state, T0 + sec(130), DEFAULT_TIMER_CONFIG);
    expect(display.cpr.status).toBe("alert");
  });
});

describe("timers unaffected by unconfirmed events", () => {
  test("pending-status event is ignored entirely", () => {
    const confirmed = applyEvent(createTimerState(), {
      event_type: "med_administered",
      drug: "epinephrine",
      timestamp: T0,
    });

    const withPending = applyEvent(confirmed, {
      event_type: "med_administered",
      drug: "epinephrine",
      timestamp: T0 + sec(50),
      status: "pending",
    });

    expect(withPending).toEqual(confirmed);
  });

  test("reduceEvents skips every pending event in a mixed log", () => {
    const events = [
      { event_type: "code_started", timestamp: T0 },
      { event_type: "med_administered", drug: "epinephrine", timestamp: T0 + sec(10), status: "pending" },
      { event_type: "cpr_started", timestamp: T0 + sec(20) },
    ];
    const state = reduceEvents(events);
    expect(state.epiLastDoseAt).toBeNull();
    expect(state.cprCycleStartedAt).toBe(T0 + sec(20));
  });
});

describe("ROSC stops all timers", () => {
  test("rosc_achieved freezes elapsed/epi/cpr and marks stopped", () => {
    const events = [
      { event_type: "code_started", timestamp: T0 },
      { event_type: "cpr_started", timestamp: T0 + sec(5) },
      { event_type: "med_administered", drug: "epinephrine", timestamp: T0 + sec(30) },
      { event_type: "rosc_achieved", timestamp: T0 + sec(300) },
    ];
    const state = reduceEvents(events);
    expect(state.stopped).toBe(true);

    const atStop = computeDisplay(state, T0 + sec(300), DEFAULT_TIMER_CONFIG);
    const longAfter = computeDisplay(state, T0 + sec(9000), DEFAULT_TIMER_CONFIG);

    expect(atStop).toEqual(longAfter);
    expect(atStop.epi.active).toBe(false);
    expect(atStop.cpr.active).toBe(false);
    expect(atStop.elapsedCodeSeconds).toBe(300);
  });

  test("code_terminated also stops timers", () => {
    const events = [
      { event_type: "code_started", timestamp: T0 },
      { event_type: "code_terminated", timestamp: T0 + sec(600) },
    ];
    const state = reduceEvents(events);
    expect(state.stopped).toBe(true);
    expect(state.codeEndedAt).toBe(T0 + sec(600));
  });
});
