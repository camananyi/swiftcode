// ACLS timer engine. Pure logic, zero deps, zero AI. Timers advance on wall-clock time
// (the `now` passed into computeDisplay), never on transcription — a stalled or wrong
// transcript cannot desync a running timer.

export const DEFAULT_TIMER_CONFIG = {
  epi_interval_seconds: 180,
  epi_warning_lead_seconds: 30,
  cpr_cycle_seconds: 120,
};

export function createTimerState() {
  return {
    codeStartedAt: null,
    codeEndedAt: null,
    epiLastDoseAt: null,
    cprCycleStartedAt: null,
    cprActive: false,
    stopped: false,
  };
}

// Timers recompute on confirmed events only — an event with status:"pending" (still sitting
// in the one-tap confirm queue) must never move a timer. This is the timer engine's own
// invariant, independent of whatever gating events.js already did upstream.
export function isEventConfirmed(event) {
  return event.status !== "pending";
}

export function applyEvent(state, event) {
  if (!isEventConfirmed(event)) return state;
  const ts = event.timestamp;

  switch (event.event_type) {
    case "code_started":
      return { ...state, codeStartedAt: ts, codeEndedAt: null, stopped: false };
    case "med_administered":
      if (event.drug !== "epinephrine") return state;
      return { ...state, epiLastDoseAt: ts };
    case "cpr_started":
    case "cpr_resumed":
      return { ...state, cprCycleStartedAt: ts, cprActive: true };
    case "cpr_paused":
      return { ...state, cprActive: false };
    case "rosc_achieved":
    case "code_terminated":
      return { ...state, stopped: true, codeEndedAt: ts, cprActive: false };
    default:
      return state;
  }
}

export function reduceEvents(events, initialState = createTimerState()) {
  return events.reduce(applyEvent, initialState);
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

// now: epoch ms. Once state.stopped, the clock freezes at codeEndedAt so no further
// alerts fire and displayed durations stop advancing, even if `now` keeps moving forward.
export function computeDisplay(state, now, config = DEFAULT_TIMER_CONFIG) {
  const clock = state.stopped ? state.codeEndedAt : now;

  const elapsedCodeSeconds = state.codeStartedAt != null ? (clock - state.codeStartedAt) / 1000 : null;

  let epi = { active: false, secondsSinceLastDose: null, status: "none", message: null };
  if (state.epiLastDoseAt != null) {
    const secondsSince = (clock - state.epiLastDoseAt) / 1000;
    let status = "ok";
    if (secondsSince >= config.epi_interval_seconds) status = "alert";
    else if (secondsSince >= config.epi_interval_seconds - config.epi_warning_lead_seconds) status = "warning";
    epi = {
      active: !state.stopped,
      secondsSinceLastDose: secondsSince,
      status,
      message:
        status === "alert"
          ? `Epinephrine interval reached per ACLS (${formatMMSS(secondsSince)} since last dose)`
          : `Epi: ${formatMMSS(secondsSince)} since last dose`,
    };
  }

  let cpr = { active: false, secondsSinceCycleStart: null, status: "none", message: null };
  if (state.cprCycleStartedAt != null) {
    const secondsSince = (clock - state.cprCycleStartedAt) / 1000;
    const status = secondsSince >= config.cpr_cycle_seconds ? "alert" : "ok";
    cpr = {
      active: !state.stopped,
      secondsSinceCycleStart: secondsSince,
      status,
      message:
        status === "alert"
          ? "2-minute cycle complete: rhythm check per ACLS"
          : `CPR cycle: ${formatMMSS(secondsSince)}`,
    };
  }

  return {
    stopped: state.stopped,
    elapsedCodeSeconds,
    elapsedCodeDisplay: elapsedCodeSeconds != null ? formatMMSS(elapsedCodeSeconds) : null,
    epi,
    cpr,
  };
}
