// Post-event Claude calls only. Never used in the real-time loop. Exactly two required
// call sites (narrative code record, plus/delta debrief) plus one optional one (judge
// Q&A). The Claude endpoint is fixed (not profile-driven) per the spec's explicit
// exception for post-event summary work.

import { getConfig } from "../config.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const EVENT_LABELS = {
  code_started: "Code started",
  cpr_started: "CPR started",
  cpr_resumed: "CPR resumed",
  cpr_paused: "CPR paused",
  rhythm_check: "Rhythm check",
  shock_delivered: "Shock delivered",
  med_administered: "Medication administered",
  airway_placed: "Airway placed",
  access_established: "Access established",
  rosc_achieved: "ROSC achieved",
  code_terminated: "Code terminated",
  note: "Note",
};

function isNetworkError(err) {
  if (!err) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const message = String(err.message || "").toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("unable to connect") ||
    message.includes("network")
  );
}

function eventDetail(e) {
  switch (e.event_type) {
    case "med_administered":
      return [e.drug, e.dose, e.route].filter(Boolean).join(" ");
    case "rhythm_check":
      return e.rhythm_reported ? `reported as "${e.rhythm_reported}"` : "";
    case "shock_delivered":
      return e.energy_joules != null ? `${e.energy_joules} J` : "";
    case "airway_placed":
      return e.airway_type || "";
    case "access_established":
      return [e.route, e.site].filter(Boolean).join(" ");
    default:
      return "";
  }
}

export function formatEventLog(events) {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  return sorted
    .map((e) => {
      const time = new Date(e.timestamp).toISOString().slice(11, 19);
      const label = EVENT_LABELS[e.event_type] || e.event_type;
      const detail = eventDetail(e);
      const verbatim = e.verbatim ? ` (verbatim: "${e.verbatim}")` : "";
      return `[${time}] ${label}${detail ? ": " + detail : ""}${verbatim} [source: ${e.source || "unknown"}]`;
    })
    .join("\n");
}

export function formatEpiIntervals(events) {
  const doses = events
    .filter((e) => e.event_type === "med_administered" && e.drug === "epinephrine")
    .sort((a, b) => a.timestamp - b.timestamp);

  if (doses.length === 0) return "No epinephrine doses recorded.";

  const lines = doses.map((dose, i) => {
    const time = new Date(dose.timestamp).toISOString().slice(11, 19);
    if (i === 0) return `[${time}] dose 1`;
    const intervalSeconds = Math.round((dose.timestamp - doses[i - 1].timestamp) / 1000);
    const m = Math.floor(intervalSeconds / 60);
    const s = intervalSeconds % 60;
    return `[${time}] dose ${i + 1} (${m}m${String(s).padStart(2, "0")}s since previous dose)`;
  });
  return lines.join("\n");
}

async function callClaude({ system, messages, maxTokens = 1024 }, config) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.claude.model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

// Call site 1: narrative code record.
export async function generateCodeRecord(events, config = getConfig()) {
  const system =
    "You write clinical code records from a structured resuscitation event log. Produce a " +
    "chronological, professional narrative. Note documentation gaps factually (for example, no " +
    "rhythm check recorded between two timestamps more than two minutes apart) without speculating " +
    "about clinical causes. Never interpret a rhythm beyond what was verbatim reported. Never claim " +
    "any survival benefit or clinical outcome. This is documentation support with a human in the loop.";
  const user = `Event log:\n${formatEventLog(events)}\n\nWrite the code record narrative.`;
  return callClaude({ system, messages: [{ role: "user", content: user }] }, config);
}

// Call site 2: plus/delta debrief.
export async function generateDebrief(events, config = getConfig()) {
  const system =
    "You write a plus/delta debrief (what went well, what to improve) for a resuscitation team from " +
    "a structured event log. Reference epinephrine interval adherence against the ACLS 3-5 minute " +
    "window using the computed intervals provided. Be specific and factual, never judgmental of " +
    "individuals. Never claim any survival benefit or clinical outcome.";
  const user =
    `Event log:\n${formatEventLog(events)}\n\n` +
    `Computed epinephrine intervals:\n${formatEpiIntervals(events)}\n\n` +
    "Write the plus/delta debrief.";
  return callClaude({ system, messages: [{ role: "user", content: user }] }, config);
}

// Optional call site: judge Q&A over the completed code.
export async function answerJudgeQuestion(question, events, config = getConfig()) {
  const system =
    "You answer factual questions about a completed resuscitation event using only the structured " +
    "event log provided. If the answer isn't in the log, say so plainly. Never speculate about " +
    "clinical outcomes or interpret a rhythm beyond what was verbatim reported.";
  const user = `Event log:\n${formatEventLog(events)}\n\nQuestion: ${question}`;
  return callClaude({ system, messages: [{ role: "user", content: user }] }, config);
}

// Retries queued jobs on a fixed interval until they succeed or fail non-network-side.
export class SummaryQueue {
  constructor({ retryIntervalMs = 15000, onStatusChange = () => {} } = {}) {
    this.retryIntervalMs = retryIntervalMs;
    this.onStatusChange = onStatusChange;
    this.jobs = [];
    this.timer = null;
  }

  // Caller already knows the job is queued (it's in the return value of
  // runPostEventSummary) — onStatusChange only fires for later drain outcomes, so each
  // status transition is broadcast exactly once.
  enqueue(job) {
    this.jobs.push(job);
    if (!this.timer) {
      this.timer = setInterval(() => this._drain(), this.retryIntervalMs);
    }
  }

  async _drain() {
    if (this.jobs.length === 0) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    const [job] = this.jobs;
    try {
      const text = await job.run();
      this.jobs.shift();
      this.onStatusChange({ status: "completed", job, text });
    } catch (err) {
      if (!isNetworkError(err)) {
        this.jobs.shift();
        this.onStatusChange({ status: "failed", job, error: err.message });
      }
      // else: still offline, stays queued for the next retry tick
    }
  }
}

// Runs both required call sites at ROSC/termination. Anything that fails for network
// reasons while claude.defer_when_offline is true gets queued instead of surfacing as
// an error — everything else (bad API key, etc.) surfaces immediately as failed.
export async function runPostEventSummary(events, queue, config = getConfig()) {
  const jobs = [
    { name: "code_record", run: () => generateCodeRecord(events, config) },
    { name: "debrief", run: () => generateDebrief(events, config) },
  ];

  const results = {};
  for (const job of jobs) {
    try {
      results[job.name] = { status: "completed", text: await job.run() };
    } catch (err) {
      if (config.claude.defer_when_offline && isNetworkError(err)) {
        results[job.name] = { status: "queued" };
        queue.enqueue(job);
      } else {
        results[job.name] = { status: "failed", error: err.message };
      }
    }
  }
  return results;
}

export { isNetworkError };
