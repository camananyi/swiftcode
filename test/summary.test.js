import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { formatEventLog, formatEpiIntervals, runPostEventSummary, SummaryQueue, isNetworkError } from "../src/pipeline/summary.js";
import { getConfig } from "../src/config.js";

const T0 = Date.parse("2026-07-18T14:00:00Z");
const sec = (n) => n * 1000;

const SAMPLE_EVENTS = [
  { event_type: "code_started", timestamp: T0, source: "rules" },
  {
    event_type: "med_administered",
    drug: "epinephrine",
    timestamp: T0 + sec(60),
    source: "rules",
    verbatim: "pushing epi",
  },
  {
    event_type: "med_administered",
    drug: "epinephrine",
    timestamp: T0 + sec(300),
    source: "rules",
    verbatim: "another round of epi",
  },
  { event_type: "rosc_achieved", timestamp: T0 + sec(600), source: "rules" },
];

describe("isNetworkError", () => {
  test("transient transport failures are classified as network errors so they queue and retry", () => {
    for (const message of [
      "fetch failed",
      "ECONNREFUSED",
      "ECONNRESET",
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      "Unable to connect. Is the computer able to access the url?",
    ]) {
      expect(isNetworkError(new Error(message))).toBe(true);
    }
    expect(isNetworkError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
  });

  test("non-network failures surface immediately instead of retrying forever", () => {
    expect(isNetworkError(new Error("ANTHROPIC_API_KEY not set"))).toBe(false);
    expect(isNetworkError(new Error("Claude API returned HTTP 401: invalid x-api-key"))).toBe(false);
  });
});

describe("formatEventLog", () => {
  test("renders events chronologically regardless of input order", () => {
    const shuffled = [SAMPLE_EVENTS[2], SAMPLE_EVENTS[0], SAMPLE_EVENTS[3], SAMPLE_EVENTS[1]];
    const log = formatEventLog(shuffled);
    const lines = log.split("\n");
    expect(lines[0]).toContain("Code started");
    expect(lines[lines.length - 1]).toContain("ROSC achieved");
  });

  test("never fabricates content beyond what's in the event", () => {
    const log = formatEventLog([SAMPLE_EVENTS[1]]);
    expect(log).toContain("epinephrine");
    expect(log).toContain("source: rules");
  });
});

describe("formatEpiIntervals", () => {
  test("computes real gaps between doses, doesn't invent them", () => {
    const text = formatEpiIntervals(SAMPLE_EVENTS);
    expect(text).toContain("dose 1");
    expect(text).toContain("4m00s since previous dose");
  });

  test("reports plainly when no doses were given", () => {
    expect(formatEpiIntervals([SAMPLE_EVENTS[0]])).toBe("No epinephrine doses recorded.");
  });
});

describe("runPostEventSummary offline queue behavior", () => {
  let originalFetch;
  let originalKey;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  test("a network failure with defer_when_offline queues rather than failing", async () => {
    global.fetch = mock(() => Promise.reject(new Error("fetch failed")));
    const queue = new SummaryQueue();
    const config = { ...getConfig(), claude: { ...getConfig().claude, defer_when_offline: true } };

    const results = await runPostEventSummary(SAMPLE_EVENTS, queue, config);

    expect(results.code_record.status).toBe("queued");
    expect(results.debrief.status).toBe("queued");
    expect(queue.jobs.length).toBe(2);
  });

  test("a non-network failure (bad API key) fails immediately, does not queue", async () => {
    global.fetch = mock(() => Promise.resolve(new Response("Unauthorized", { status: 401 })));
    const queue = new SummaryQueue();
    const config = getConfig();

    const results = await runPostEventSummary(SAMPLE_EVENTS, queue, config);

    expect(results.code_record.status).toBe("failed");
    expect(queue.jobs.length).toBe(0);
  });

  test("a successful call returns completed status with generated text", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ content: [{ type: "text", text: "Chronological record here." }] }), { status: 200 })
      )
    );
    const queue = new SummaryQueue();
    const results = await runPostEventSummary(SAMPLE_EVENTS, queue, getConfig());

    expect(results.code_record.status).toBe("completed");
    expect(results.code_record.text).toBe("Chronological record here.");
  });
});

describe("SummaryQueue retry-until-success", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("a queued job succeeds on a later drain once connectivity returns", async () => {
    let callCount = 0;
    global.fetch = mock(() => {
      callCount += 1;
      // First two calls are the initial code_record + debrief attempts (both offline);
      // every call after that (the retries) succeeds.
      if (callCount <= 2) return Promise.reject(new Error("fetch failed"));
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: "Recovered." }] }), { status: 200 }));
    });

    const statuses = [];
    const queue = new SummaryQueue({
      retryIntervalMs: 1_000_000, // never auto-fires; we drain manually below
      onStatusChange: (evt) => statuses.push(evt.status),
    });

    const config = { ...getConfig(), claude: { ...getConfig().claude, defer_when_offline: true } };
    const results = await runPostEventSummary([SAMPLE_EVENTS[0]], queue, config);
    expect(results.code_record.status).toBe("queued");
    expect(queue.jobs.length).toBe(2);

    await queue._drain();
    await queue._drain();

    expect(statuses).toContain("completed");
    expect(queue.jobs.length).toBe(0);
    clearInterval(queue.timer);
  });
});
