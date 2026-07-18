import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { extractEvent, validateSchema } from "../src/pipeline/extract.js";
import { getConfig } from "../src/config.js";

function llmResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateSchema", () => {
  test("accepts a valid med_administered payload", () => {
    const result = validateSchema({
      event_type: "med_administered",
      drug: "epinephrine",
      dose: "1mg",
      route: "IV",
      confidence: 0.9,
      verbatim: "give one of epi",
    });
    expect(result).toEqual({
      event_type: "med_administered",
      drug: "epinephrine",
      dose: "1mg",
      route: "IV",
      confidence: 0.9,
      verbatim: "give one of epi",
    });
  });

  test("accepts the none sentinel with no other fields required", () => {
    expect(validateSchema({ event_type: "none" })).toEqual({ event_type: "none" });
  });

  test("accepts a rhythm_check with rhythm_reported verbatim only", () => {
    const result = validateSchema({
      event_type: "rhythm_check",
      rhythm_reported: "v-fib",
      confidence: 0.8,
      verbatim: "looks like v-fib",
    });
    expect(result.rhythm_reported).toBe("v-fib");
  });

  test("rejects an event_type outside the closed list", () => {
    expect(validateSchema({ event_type: "diagnose_patient", confidence: 0.9, verbatim: "x" })).toBeNull();
  });

  test("rejects a missing confidence", () => {
    expect(validateSchema({ event_type: "cpr_started", verbatim: "x" })).toBeNull();
  });

  test("rejects a confidence outside 0-1", () => {
    expect(validateSchema({ event_type: "cpr_started", confidence: 1.5, verbatim: "x" })).toBeNull();
    expect(validateSchema({ event_type: "cpr_started", confidence: -0.1, verbatim: "x" })).toBeNull();
  });

  test("rejects a missing verbatim", () => {
    expect(validateSchema({ event_type: "cpr_started", confidence: 0.9 })).toBeNull();
  });

  test("rejects wrong field types instead of coercing them", () => {
    expect(
      validateSchema({ event_type: "shock_delivered", energy_joules: "200", confidence: 0.8, verbatim: "x" })
    ).toBeNull();
    expect(
      validateSchema({ event_type: "med_administered", drug: 42, confidence: 0.8, verbatim: "x" })
    ).toBeNull();
  });

  test("rejects non-object input", () => {
    expect(validateSchema(null)).toBeNull();
    expect(validateSchema(undefined)).toBeNull();
    expect(validateSchema("hello")).toBeNull();
    expect(validateSchema(42)).toBeNull();
  });
});

describe("extractEvent timeout and malformed-response fallback", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("LLM timeout falls back to the note path, never dropping audio", async () => {
    global.fetch = mock(() => Promise.reject(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })));
    const event = await extractEvent("something garbled over the radio", Date.now(), getConfig());
    expect(event.event_type).toBe("note");
    expect(event.verbatim).toBe("something garbled over the radio");
    expect(event.source).toBe("llm");
    expect(event.extraction_error).toBe("timeout");
  });

  test("network failure falls back to the note path", async () => {
    global.fetch = mock(() => Promise.reject(new Error("connect ECONNREFUSED")));
    const event = await extractEvent("mumble mumble", Date.now(), getConfig());
    expect(event.event_type).toBe("note");
  });

  test("non-2xx HTTP response falls back to the note path", async () => {
    global.fetch = mock(() => Promise.resolve(new Response("Internal Server Error", { status: 500 })));
    const event = await extractEvent("mumble mumble", Date.now(), getConfig());
    expect(event.event_type).toBe("note");
  });

  test("non-JSON LLM content falls back to the note path", async () => {
    global.fetch = mock(() => Promise.resolve(llmResponse("I'm not sure what that means")));
    const event = await extractEvent("mumble mumble", Date.now(), getConfig());
    expect(event.event_type).toBe("note");
    expect(event.extraction_error).toBe("schema_validation_failed");
  });

  test("schema-invalid JSON content falls back to the note path", async () => {
    global.fetch = mock(() => Promise.resolve(llmResponse(JSON.stringify({ event_type: "not_a_real_type" }))));
    const event = await extractEvent("mumble mumble", Date.now(), getConfig());
    expect(event.event_type).toBe("note");
  });

  test("a valid extraction returns an ingest-shaped event with source llm", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        llmResponse(
          JSON.stringify({
            event_type: "med_administered",
            drug: "amiodarone",
            confidence: 0.55,
            verbatim: "think that was amio going in",
          })
        )
      )
    );
    const event = await extractEvent("think that was amio going in", Date.now(), getConfig());
    expect(event.event_type).toBe("med_administered");
    expect(event.source).toBe("llm");
    expect(event.confidence).toBe(0.55);
  });

  test("the none sentinel returns null, logging nothing", async () => {
    global.fetch = mock(() => Promise.resolve(llmResponse(JSON.stringify({ event_type: "none" }))));
    const event = await extractEvent("just chatting near the bed", Date.now(), getConfig());
    expect(event).toBeNull();
  });
});
