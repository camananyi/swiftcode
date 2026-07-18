# CLAUDE.md — SwiftCode Build Specification

You are building **SwiftCode**: a hands-free, edge-native agent for code blue and rapid response events. It listens to a resuscitation room, transcribes speech in real time, extracts and timestamps every intervention, runs ACLS protocol timers, prompts the team when actions are due, and generates a complete timestamped code record and debrief at ROSC or termination.

This is a hackathon project (Abridge x Anthropic x Lightspeed, July 18, 2026) built by SwiftInference. It must demo flawlessly on unreliable venue networks. **Reliability beats features. Latency beats cleverness.**

---

## 1. Non-Negotiable Architecture Principles

1. **The real-time loop runs entirely on the local/edge node.** STT, event extraction, timers, and prompts must work with ZERO internet connectivity. Cloud (Claude API) is used ONLY for post-event summary/debrief and is queued when offline.
2. **Rules-first, LLM-second.** A deterministic keyword/regex layer catches clean ACLS callouts instantly (<1ms). The local LLM (via SwiftInference API) runs behind it as normalizer/disambiguator for messy speech. If the LLM is slow or down, the rules layer and timers keep working. The demo must survive total LLM failure.
3. **Timers run off the clock, never off transcription.** Once an event is confirmed (epi given at T), the 3-minute epi timer counts wall-clock time. Continued transcription accuracy does not affect running timers.
4. **All inference endpoints come from the flat config file** (`config/profiles.json`, loader in `src/config.js` — both already exist, DO NOT rewrite them, extend only if needed). Profiles: `cloud` (menlo-hq-1.swiftinference.ai over WireGuard), `localhost`, `lan` (192.168.10.10 behind travel router). Switch via `active_profile` or `SWIFTCODE_PROFILE` env var. Never hardcode an inference URL anywhere else.
5. **Human in the loop.** SwiftCode documents and prompts. It NEVER interprets ECG rhythms, never directs therapy autonomously. Prompts are advisory: "Epinephrine interval reached per ACLS (3:00 since last dose)." Low-confidence events surface as one-tap confirm/reject, they do not auto-log.

## 2. Stack (locked)

- **Runtime:** Bun (JavaScript/TypeScript). No Python services. Single repo.
- **Server:** Bun.serve with WebSocket support (one process: audio ingest, pipeline, WS broadcast to UI).
- **UI:** Single-page app, plain HTML/JS/CSS or React via CDN, served by the same Bun process. No build step if avoidable. Dark, high-contrast "mission control" aesthetic: event timeline down the left, big timers top-center, live transcript bottom, network status indicator top-right.
- **STT:** SwiftInference OpenAI-compatible endpoint `POST {stt_base_url}/v1/audio/transcriptions` (faster-whisper, whisper-large-v3). Send rolling audio chunks (config `audio.chunk_ms`, default 500ms buffered into ~2-3s windows with overlap). Include `initial_prompt` biased to the ACLS lexicon (see §4). If the endpoint supports streaming/websocket, prefer it; otherwise chunked REST is fine.
- **Extraction LLM:** SwiftInference OpenAI-compatible `POST {llm_base_url}/v1/chat/completions`, model `llama-3.1-8b`, `stream: false`, `temperature: 0`, strict JSON output (see §5). Timeout 2s; on timeout, fall back to rules-only for that utterance and mark it `source: "rules"`.
- **Claude API (post-event only):** `POST https://api.anthropic.com/v1/messages`, model from config (`claude.model`), key from `ANTHROPIC_API_KEY`. Used for: (a) narrative code record generation, (b) debrief (plus/delta format), (c) optional GWTG-style structured export enrichment. If offline and `claude.defer_when_offline` is true, queue the job and run it when connectivity returns. Show "Debrief queued — will generate when connectivity returns" in UI.
- **Audio capture:** Browser microphone via getUserMedia in the UI, streamed to the Bun server over WebSocket as 16kHz PCM. This avoids native audio dependencies and works on any laptop. Provide a "load audio file" mode that streams a pre-recorded WAV through the identical pipeline at real-time speed (this is the demo insurance policy).

## 3. Repo Layout

```
swiftcode/
  config/profiles.json        # EXISTS — endpoint profiles (do not rewrite)
  src/config.js               # EXISTS — loader + endpointFetch helper (do not rewrite)
  src/preflight.js            # EXISTS — endpoint health check
  src/server.js               # Bun.serve: HTTP + WS, serves UI, owns pipeline
  src/pipeline/stt.js         # chunker + STT client (config-driven endpoint)
  src/pipeline/rules.js       # deterministic ACLS event matcher (regex/keyword)
  src/pipeline/extract.js     # LLM normalizer/disambiguator (config-driven endpoint)
  src/pipeline/events.js      # event store: append-only log, confidence gating
  src/pipeline/timers.js      # ACLS timer engine (pure logic, no AI)
  src/pipeline/summary.js     # Claude post-event record + debrief, offline queue
  src/ui/index.html           # single-page mission-control UI
  audio/                      # scripted mock-code WAVs (clean + messy takes)
  test/                       # see §8
```

## 4. ACLS Domain Knowledge (encode exactly this)

**Lexicon for STT initial_prompt (comma-separated hint string):**
epinephrine, epi, amiodarone, lidocaine, atropine, adenosine, calcium chloride, sodium bicarbonate, magnesium, naloxone, milligram, milligrams, IV push, IO, intubated, king airway, LMA, bag valve mask, compressions, CPR, pulse check, rhythm check, asystole, PEA, v-fib, ventricular fibrillation, v-tach, pulseless v-tach, charging, clear, shock delivered, defibrillate, 200 joules, ROSC, return of spontaneous circulation, time of death, code blue, rapid response, end tidal, capnography

**Event schema (the ONLY event types; keep closed):**

| event_type | key fields | notes |
|---|---|---|
| code_started | timestamp | manual button OR first detected callout |
| cpr_started / cpr_resumed | timestamp | |
| cpr_paused | timestamp | rhythm/pulse check pause |
| rhythm_check | rhythm_reported (string, verbatim ONLY — never interpreted) | e.g. "v-fib" as spoken by team |
| shock_delivered | energy_joules (int, optional) | |
| med_administered | drug, dose, route | drug from closed list above |
| airway_placed | airway_type | |
| access_established | route (IV/IO), site | |
| rosc_achieved | timestamp | ends timers, triggers summary |
| code_terminated | timestamp | ends timers, triggers summary |
| note | free text | anything real but unclassifiable |

**Timer rules (from config `timers` block):**
- **Epinephrine interval:** starts on each confirmed `med_administered` where drug=epinephrine. Alert at `epi_interval_seconds` (default 180s) with a warning at `epi_interval_seconds - epi_warning_lead_seconds`. Display as "Epi: 2:31 since last dose."
- **CPR cycle:** starts on `cpr_started`/`cpr_resumed`, alert at `cpr_cycle_seconds` (default 120s): "2-minute cycle complete — rhythm check per ACLS."
- **Elapsed code time:** from `code_started`, always visible.
- All prompts phrased as advisory-per-ACLS, never imperative-clinical ("consider" / "interval reached", never "give X now").

## 5. Pipeline Contract

```
mic/file → 16kHz PCM chunks → STT (SwiftInference) → transcript segments
  → rules.js (sync, <1ms): high-confidence exact matches → events.js (auto-log, source:"rules", confidence:"high")
  → everything rules didn't fully resolve → extract.js (LLM, ≤2s timeout)
       → valid JSON event, confidence ≥ threshold → auto-log (source:"llm")
       → valid JSON event, low confidence → UI one-tap confirm queue
       → timeout/garbage → log as `note` with raw text, never drop audio silently
events.js → timers.js (recompute on confirmed events only) → WS broadcast to UI
rosc_achieved | code_terminated → summary.js → Claude (or offline queue)
```

**Extraction prompt (extract.js), system message essence:**
"You convert utterances from a resuscitation room into JSON events. Output ONLY a JSON object matching this schema: {event_type, drug?, dose?, route?, energy_joules?, rhythm_reported?, airway_type?, confidence: 0-1, verbatim: string}. event_type must be one of [closed list]. If the utterance is not a clinical event, output {\"event_type\":\"none\"}. Never infer a rhythm interpretation; only record rhythm words verbatim as spoken. Never invent doses."

Validate every LLM response against the schema (hand-rolled validator or zod via CDN-less import); reject malformed JSON to the `note` path.

## 6. External APIs — exact usage boundaries

- **SwiftInference API (PRIMARY — all real-time inference):** STT + extraction as above, endpoints ALWAYS from config profiles. Auth: `Authorization: Bearer $SWIFT_API_KEY` (handled by `endpointFetch` in src/config.js, which also sets the SNI Host header needed in `lan` mode). 
- **Anthropic API (small, post-event only):** exactly two call sites in summary.js: (1) narrative code record from the event log (chronological, professional, flags gaps like "no rhythm check documented between 14:02 and 14:07"); (2) plus/delta debrief (what went well / what to improve, referencing interval adherence: actual epi intervals vs 3-5 min ACLS window). One additional OPTIONAL call site: a "judge Q&A" endpoint that answers questions about the completed code from the event log. Do not use Claude anywhere in the real-time loop.
- **Abridge:** There is NO public Abridge developer API — do not invent one or add speculative HTTP calls. Instead implement `src/pipeline/export.js`: an "Abridge-ready handoff" export — clean structured JSON (FHIR-flavored: event list with ISO timestamps, meds as RxNorm-style display names, outcome, durations) plus a markdown clinical narrative, presented in the UI as "Export to documentation platform." This is the partnership story: SwiftCode captures the moment too fast for the cloud, then hands a structured record forward into platforms like Abridge. Label it exactly that way in the UI.

## 7. Demo Requirements (build these as first-class features)

1. **Network kill switch demo:** UI shows live connectivity status (poll a cloud URL every 5s). When the operator disconnects the network mid-code: banner flips to "EDGE MODE — local pipeline active", transcription/extraction/timers continue uninterrupted, Claude summary queues. On reconnect, queued debrief generates. This is the money moment; it must be bulletproof.
2. **Latency panel:** show live per-stage latency (audio→transcript ms, transcript→event ms) and a running comparison when in cloud vs lan/localhost profile. No fabricated numbers — display only measured values from the current session.
3. **File-replay mode:** `?replay=filename.wav` streams a canned recording through the real pipeline at 1x speed. Identical code path to live mic.
4. **One-tap confirm queue:** low-confidence events appear as cards (verbatim text + proposed event) with Confirm / Reject. Confirmed events enter the log with `source:"human-confirmed"`.
5. **The record:** at ROSC/termination, render the full timestamped event table + Claude narrative + debrief, with a copy/download button (markdown + JSON).

## 8. Testing (write these, run them)

- `test/rules.test.js`: ≥25 utterance fixtures → expected events. Include messy ones: "pushing another round of epi", "epi's in", "let's hold compressions, checking pulse", "charging to two hundred... everybody clear... shock delivered", negatives that must NOT fire: "let's hold off on epi", "no pulse", "we shocked him yesterday".
- `test/timers.test.js`: epi interval warning/alert firing, CPR cycle reset on resume, timers unaffected by unconfirmed events, ROSC stops all timers.
- `test/extract.test.js`: schema validator accepts/rejects fixtures; LLM timeout falls back to note-path (mock the fetch).
- `test/e2e.replay.test.js`: run a scripted transcript (skip real STT; inject segments) end-to-end → assert final event log matches expected sequence and the export JSON validates.

Run: `bun test`. All green before any UI polish.

## 9. Claims & Language Discipline (hard requirements, apply to ALL UI text, prompts, README, demo copy)

- NEVER write "HIPAA-compliant". Approved framing: "supports data locality requirements relevant to healthcare."
- Never claim survival benefit or clinical outcomes. SwiftCode is a documentation and protocol-timing support tool with humans in the loop.
- Never auto-interpret rhythms; rhythm words are recorded verbatim as reported by the team.
- "SwiftInference" is always ONE word. No em dashes in any copy.
- No absolute latency claims without a measured comparison basis in-session; the latency panel shows only live measured numbers.
- No fundraising language anywhere.

## 10. Build Order (do it in this sequence; each step runs before the next)

1. `timers.js` + tests (pure logic, zero deps) 
2. `rules.js` + tests (the demo survives on this alone)
3. `events.js` store + WS broadcast skeleton in `server.js`
4. UI shell: timeline, timers, transcript pane, connectivity banner (fed by fake injected events first)
5. `stt.js` chunker against the configured profile (verify with `preflight.js` first)
6. `extract.js` + confirm queue
7. `summary.js` Claude calls + offline queue
8. `export.js` Abridge-ready handoff
9. File-replay mode + latency panel
10. Polish pass, then full e2e replay test

If anything is ambiguous, choose the option that keeps the real-time loop simpler and more failure-tolerant. Do not add features not in this spec.
