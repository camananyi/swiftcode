// LLM normalizer/disambiguator. Only ever called for utterances rules.js didn't resolve.
// Never blocks the real-time loop: a 2s timeout, malformed JSON, or a schema violation
// all fall back to logging a `note` with the raw text, so audio is never dropped silently.

import { getConfig, endpointFetch } from "../config.js";
import { EVENT_TYPES } from "./events.js";

const ALLOWED_EXTRACT_TYPES = new Set([...EVENT_TYPES, "none"]);

export const SYSTEM_PROMPT =
  "You convert utterances from a resuscitation room into JSON events. Output ONLY a JSON object " +
  'matching this schema: {"event_type": string, "drug"?: string, "dose"?: string, "route"?: string, ' +
  '"energy_joules"?: number, "rhythm_reported"?: string, "airway_type"?: string, "confidence": number ' +
  '(0-1), "verbatim": string}. event_type must be one of: ' +
  [...EVENT_TYPES].join(", ") +
  ', or "none" if the utterance is not a clinical event. Never infer a rhythm interpretation; only ' +
  "record rhythm words verbatim as spoken. Never invent doses. Output ONLY the JSON object, no other text.";

const STRING_FIELDS = ["drug", "dose", "route", "rhythm_reported", "airway_type"];

// Hand-rolled validator (no schema-validation dependency) — rejects anything that doesn't
// exactly match the extraction contract rather than coercing or guessing at intent.
export function validateSchema(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!ALLOWED_EXTRACT_TYPES.has(obj.event_type)) return null;
  if (obj.event_type === "none") return { event_type: "none" };

  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) return null;
  if (typeof obj.verbatim !== "string") return null;

  const result = { event_type: obj.event_type, confidence: obj.confidence, verbatim: obj.verbatim };

  for (const field of STRING_FIELDS) {
    if (obj[field] === undefined) continue;
    if (typeof obj[field] !== "string") return null;
    result[field] = obj[field];
  }

  if (obj.energy_joules !== undefined) {
    if (typeof obj.energy_joules !== "number") return null;
    result.energy_joules = obj.energy_joules;
  }

  return result;
}

function parseJsonLoose(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function callLLM(text, config) {
  const res = await endpointFetch("llm", "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.models.llm,
      stream: false,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(config.extraction.timeout_ms),
  });

  if (!res.ok) throw new Error(`LLM endpoint returned HTTP ${res.status}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response missing message content");
  return content;
}

function notePath(text, timestamp, reason) {
  return { event_type: "note", timestamp, verbatim: text, source: "llm", confidence: 0, extraction_error: reason };
}

// Returns a candidate event shaped for events.js#ingest, or null when the utterance
// isn't a clinical event at all (event_type: "none").
export async function extractEvent(text, timestamp, config = getConfig()) {
  let raw;
  try {
    raw = await callLLM(text, config);
  } catch (err) {
    return notePath(text, timestamp, err.name === "TimeoutError" ? "timeout" : err.message);
  }

  const validated = validateSchema(parseJsonLoose(raw));
  if (!validated) return notePath(text, timestamp, "schema_validation_failed");
  if (validated.event_type === "none") return null;

  return { ...validated, timestamp, source: "llm" };
}
