// Config loader + endpointFetch helper for all real-time inference calls (STT + extraction LLM).
// Every inference URL in the codebase must be resolved through this file — never hardcode one elsewhere.

import profiles from "../config/profiles.json";

function resolveActiveProfileName() {
  return process.env.SWIFTCODE_PROFILE || profiles.active_profile;
}

export function getConfig() {
  const profileName = resolveActiveProfileName();
  const profile = profiles.profiles[profileName];
  if (!profile) {
    throw new Error(
      `Unknown SwiftCode profile "${profileName}". Known profiles: ${Object.keys(profiles.profiles).join(", ")}`
    );
  }
  return {
    profileName,
    profile,
    models: profiles.models,
    claude: profiles.claude,
    timers: profiles.timers,
    audio: profiles.audio,
    extraction: profiles.extraction,
    connectivity: profiles.connectivity,
    server: profiles.server,
  };
}

// kind: "stt" | "llm". path: e.g. "/v1/audio/transcriptions".
export async function endpointFetch(kind, path, options = {}) {
  const { profile } = getConfig();
  const baseUrlKey = kind === "stt" ? "stt_base_url" : "llm_base_url";
  const baseUrl = profile[baseUrlKey];
  if (!baseUrl) {
    throw new Error(`Profile has no ${baseUrlKey} configured`);
  }

  const url = new URL(path, baseUrl);
  const headers = new Headers(options.headers || {});
  if (process.env.SWIFT_API_KEY) {
    headers.set("Authorization", `Bearer ${process.env.SWIFT_API_KEY}`);
  }

  const fetchOptions = { ...options, headers };

  // "lan" profile connects to the travel router by IP, but the TLS cert (and any
  // vhost routing behind it) is issued for the cloud hostname — so we pin both the
  // TLS SNI and the HTTP Host header to that name while dialing the IP.
  if (profile.sni_host) {
    headers.set("Host", profile.sni_host);
    fetchOptions.tls = { ...(options.tls || {}), serverName: profile.sni_host };
  }

  return fetch(url, fetchOptions);
}
