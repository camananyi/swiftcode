# SwiftCode

A hands-free, edge-native agent for code blue and rapid response events. It listens to a
resuscitation room, transcribes speech in real time, extracts and timestamps every
intervention, runs ACLS protocol timers, prompts the team when actions are due, and
generates a timestamped code record and debrief at ROSC or termination.

SwiftCode is a documentation and protocol-timing support tool with humans in the loop. It
never interprets ECG rhythms and never directs therapy autonomously. It supports data
locality requirements relevant to healthcare; it does not claim regulatory compliance, and
it makes no claim of survival benefit or clinical outcome.

Built for the Abridge x Anthropic x Lightspeed hackathon (SwiftInference, July 18 2026).
See [CLAUDE.md](CLAUDE.md) for the full build specification.

## Architecture

The real-time loop (speech-to-text, event extraction, timers, prompts) runs entirely on
the local/edge node with zero internet dependency. A deterministic rules layer
(`src/pipeline/rules.js`) catches clean ACLS callouts in under a millisecond; a local LLM
via the SwiftInference API runs behind it only to disambiguate messy speech, and the
real-time loop survives total LLM or network failure. Claude is used only for the
post-event summary (narrative code record + plus/delta debrief), never in the real-time
loop, and its calls queue automatically when offline.

## Setup

Requires [Bun](https://bun.sh).

```
cp .env.example .env
# fill in SWIFT_API_KEY and ANTHROPIC_API_KEY in .env
bun run start        # http://localhost:3000
```

`SWIFTCODE_PROFILE` (env var, or `active_profile` in `config/profiles.json`) selects which
inference endpoints to hit: `cloud`, `lan`, or `localhost`. See `config/profiles.json` for
each profile's endpoints and `src/config.js` for the loader every inference call goes
through.

## Development

```
bun run dev                # watch mode
bun run preflight          # check STT/LLM/Claude endpoint reachability for the active profile
bun test                   # full test suite
bun run generate-audio     # regenerate audio/*.wav demo fixtures (macOS `say` + `afconvert`)
```

Two dev-only env flags seed fake events for UI work without a live mic or STT endpoint:

```
SWIFTCODE_SEED_DEMO=1 bun run dev            # seeds a live in-progress code
SWIFTCODE_SEED_DEMO=1 SWIFTCODE_SEED_ROSC=1 bun run dev   # ...and ends it at ROSC, triggering the summary
```

## File-replay mode

Load the app with `?replay=<filename>.wav` (a file in `audio/`) to stream a canned
recording through the real pipeline at 1x speed: the identical code path live mic audio
uses.

```
http://localhost:3000/?replay=clean_take_1.wav
http://localhost:3000/?replay=messy_take_1.wav
```

## Repo layout

```
config/profiles.json        inference endpoint profiles (cloud / lan / localhost)
src/config.js                config loader + endpointFetch helper
src/preflight.js             endpoint health check
src/server.js                Bun.serve: HTTP + WS, serves the UI, owns the pipeline
src/pipeline/stt.js           audio chunker + SwiftInference STT client
src/pipeline/rules.js         deterministic ACLS event matcher
src/pipeline/extract.js       LLM normalizer/disambiguator
src/pipeline/events.js        append-only event log, confidence gating
src/pipeline/timers.js        ACLS timer engine (pure logic)
src/pipeline/summary.js       Claude post-event record + debrief, offline queue
src/pipeline/export.js        Abridge-ready handoff export (JSON + markdown)
src/pipeline/replay.js        file-replay mode
src/ui/index.html             single-page mission-control UI
audio/                        scripted mock-code WAVs (clean + messy takes)
scripts/generate-demo-audio.js  regenerates the audio/ fixtures
test/                         bun test suite
```
