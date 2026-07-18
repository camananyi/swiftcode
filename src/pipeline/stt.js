// Audio chunker + SwiftInference STT client. Source-agnostic: both the live mic feed
// and file-replay mode push raw PCM16 samples through the same pushChunk() entry point,
// so they run the identical code path per the demo requirement.

import { getConfig, endpointFetch } from "../config.js";

export const ACLS_LEXICON = [
  "epinephrine",
  "epi",
  "amiodarone",
  "lidocaine",
  "atropine",
  "adenosine",
  "calcium chloride",
  "sodium bicarbonate",
  "magnesium",
  "naloxone",
  "milligram",
  "milligrams",
  "IV push",
  "IO",
  "intubated",
  "king airway",
  "LMA",
  "bag valve mask",
  "compressions",
  "CPR",
  "pulse check",
  "rhythm check",
  "asystole",
  "PEA",
  "v-fib",
  "ventricular fibrillation",
  "v-tach",
  "pulseless v-tach",
  "charging",
  "clear",
  "shock delivered",
  "defibrillate",
  "200 joules",
  "ROSC",
  "return of spontaneous circulation",
  "time of death",
  "code blue",
  "rapid response",
  "end tidal",
  "capnography",
].join(", ");

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// Wraps raw PCM16 mono samples in a minimal WAV header so any OpenAI-compatible
// /v1/audio/transcriptions endpoint can accept it as a standard file upload.
export function encodeWav(int16Samples, sampleRate) {
  const blockAlign = 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = int16Samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < int16Samples.length; i++, offset += 2) {
    view.setInt16(offset, int16Samples[i], true);
  }
  return buffer;
}

export async function transcribeChunk(wavBuffer, config = getConfig()) {
  const form = new FormData();
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "chunk.wav");
  form.append("model", config.models.stt);
  form.append("initial_prompt", ACLS_LEXICON);

  const res = await endpointFetch("stt", "/v1/audio/transcriptions", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(config.extraction.timeout_ms * 3),
  });

  if (!res.ok) {
    throw new Error(`STT endpoint returned HTTP ${res.status}`);
  }
  return res.json();
}

// Buffers incoming PCM16 into overlapping windows (audio.window_seconds, with
// audio.overlap_seconds carried into the next window) and transcribes each in turn.
export class AudioChunker {
  constructor({ config = getConfig(), onSegment, onError } = {}) {
    this.config = config;
    this.sampleRate = config.audio.sample_rate;
    this.windowSamples = Math.round(config.audio.window_seconds * this.sampleRate);
    this.overlapSamples = Math.round(config.audio.overlap_seconds * this.sampleRate);
    this.onSegment = onSegment;
    this.onError = onError ?? ((err) => console.error("[stt] error:", err.message));
    this.buffer = new Int16Array(0);
    this.inFlight = false;
  }

  pushChunk(int16Chunk) {
    const merged = new Int16Array(this.buffer.length + int16Chunk.length);
    merged.set(this.buffer);
    merged.set(int16Chunk, this.buffer.length);
    this.buffer = merged;

    if (this.buffer.length >= this.windowSamples && !this.inFlight) {
      const windowSamples = this.buffer.slice(0, this.windowSamples);
      this.buffer = this.buffer.slice(this.windowSamples - this.overlapSamples);
      this._transcribe(windowSamples);
    }
  }

  async _transcribe(int16Samples) {
    this.inFlight = true;
    const start = performance.now();
    try {
      const wavBuffer = encodeWav(int16Samples, this.sampleRate);
      const result = await transcribeChunk(wavBuffer, this.config);
      const latencyMs = Math.round(performance.now() - start);
      const text = (result && result.text ? result.text : "").trim();
      if (text) {
        this.onSegment({ text, timestamp: Date.now(), latencyMs });
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.inFlight = false;
    }
  }

  reset() {
    this.buffer = new Int16Array(0);
  }
}
