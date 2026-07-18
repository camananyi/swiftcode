// Endpoint health check. Run before starting stt.js work against a new profile:
//   bun run preflight
// Informational only — SwiftCode's real-time loop must survive every one of these failing.

import { getConfig, endpointFetch } from "./config.js";

async function timed(fn) {
  const start = performance.now();
  try {
    const result = await fn();
    return { ok: true, ms: Math.round(performance.now() - start), result };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - start), error: err.message };
  }
}

export async function checkInference(kind) {
  return timed(async () => {
    const res = await endpointFetch(kind, "/v1/models", { method: "GET", signal: AbortSignal.timeout(3000) });
    return { status: res.status };
  });
}

export async function checkClaude() {
  return timed(async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(3000),
    });
    return { status: res.status };
  });
}

export async function checkAll() {
  const { profileName, profile } = getConfig();
  const [stt, llm, claude] = await Promise.all([checkInference("stt"), checkInference("llm"), checkClaude()]);
  return {
    profileName,
    stt_base_url: profile.stt_base_url,
    llm_base_url: profile.llm_base_url,
    swift_api_key_set: Boolean(process.env.SWIFT_API_KEY),
    stt,
    llm,
    claude,
  };
}

function report(label, check) {
  const status = check.ok ? "UP" : "DOWN";
  const detail = check.ok ? `HTTP ${check.result.status}` : check.error;
  console.log(`  ${status.padEnd(4)} ${label.padEnd(24)} ${check.ms}ms  ${detail}`);
}

if (import.meta.main) {
  const results = await checkAll();
  console.log(`SwiftCode preflight: profile "${results.profileName}"`);
  console.log(`  SWIFT_API_KEY set: ${results.swift_api_key_set}`);
  report(`STT (${results.stt_base_url})`, results.stt);
  report(`LLM (${results.llm_base_url})`, results.llm);
  report("Claude API", results.claude);
  console.log("\nRules layer + timers work regardless of the above. This is diagnostic only.");
}
