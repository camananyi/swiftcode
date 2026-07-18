// File-replay mode. Reads a WAV from disk and feeds it into the exact same
// chunker.pushChunk() the live mic feed uses, paced at 1x real-time speed — the
// identical code path as live mic, just a different audio source.

function findChunk(view, tag, searchFrom = 12) {
  let offset = searchFrom;
  while (offset + 8 <= view.byteLength) {
    const chunkId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === tag) return { offset: offset + 8, size: chunkSize };
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

// Minimal PCM WAV parser: supports 16-bit and 8-bit PCM, mono or stereo (downmixed).
export function parseWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== "RIFF") throw new Error("Not a RIFF/WAV file");

  const fmt = findChunk(view, "fmt ");
  const data = findChunk(view, "data");
  if (!fmt || !data) throw new Error("WAV file missing fmt or data chunk");

  const numChannels = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const bitsPerSample = view.getUint16(fmt.offset + 14, true);

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(data.size / (bytesPerSample * numChannels));
  const mono = new Int16Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const byteOffset = data.offset + (i * numChannels + ch) * bytesPerSample;
      if (bitsPerSample === 16) {
        sum += view.getInt16(byteOffset, true);
      } else if (bitsPerSample === 8) {
        sum += (view.getUint8(byteOffset) - 128) * 256;
      } else {
        throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
      }
    }
    mono[i] = Math.round(sum / numChannels);
  }

  return { sampleRate, samples: mono };
}

function resampleTo(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(samples.length / ratio);
  const result = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcIndex - i0;
    result[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return result;
}

// Feeds the file into chunker.pushChunk() in chunk_ms-sized slices, paced with real
// setTimeout delays so it arrives at the same cadence live mic audio would.
export async function replayWavFile(filePath, chunker, { chunkMs, targetSampleRate }) {
  const arrayBuffer = await Bun.file(filePath).arrayBuffer();
  const parsed = parseWav(arrayBuffer);
  const samples = resampleTo(parsed.samples, parsed.sampleRate, targetSampleRate);

  const samplesPerChunk = Math.round((chunkMs / 1000) * targetSampleRate);
  let offset = 0;

  while (offset < samples.length) {
    const slice = samples.subarray(offset, offset + samplesPerChunk);
    chunker.pushChunk(slice);
    offset += samplesPerChunk;
    if (offset < samples.length) {
      await new Promise((resolve) => setTimeout(resolve, chunkMs));
    }
  }
}
