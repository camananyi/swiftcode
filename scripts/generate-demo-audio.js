// One-off dev tool: synthesizes the audio/ demo fixtures via macOS `say` + `afconvert`.
// Not part of the runtime pipeline. Run with: bun scripts/generate-demo-audio.js

import { parseWav } from "../src/pipeline/replay.js";

const SAMPLE_RATE = 16000;
const OUT_DIR = new URL("../audio/", import.meta.url);
const TMP_DIR = new URL("../.audio-gen-tmp/", import.meta.url);

const TAKES = {
  clean_take_1: [
    ["Code blue, room four.", 2],
    ["Starting compressions.", 5],
    ["Got an IV in the right AC.", 5],
    ["Pushing one milligram epinephrine IV push.", 5],
    ["King airway is in.", 5],
    ["Let's hold compressions, checking pulse.", 2],
    ["Asystole on the monitor.", 1],
    ["Resume compressions.", 8],
    ["Amiodarone three hundred milligrams pushed.", 5],
    ["We have ROSC.", 0],
  ],
  messy_take_1: [
    ["Code blue, room four.", 2],
    ["Okay let's start compressions.", 4],
    ["Somebody get IV access, right AC.", 4],
    ["Pushing another round of epi.", 5],
    ["King airway's in.", 5],
    ["Let's hold compressions, checking pulse.", 2],
    ["Looks like v-fib on the monitor.", 1],
    ["Charging to two hundred... everybody clear... shock delivered.", 3],
    ["Resume compressions.", 6],
    ["Epi's in.", 4],
    ["We have ROSC, pulse is back.", 0],
  ],
};

function silence(seconds) {
  return new Int16Array(Math.round(seconds * SAMPLE_RATE));
}

function concatInt16(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function writeWav(samples, sampleRate, path) {
  const blockAlign = 2;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) view.setInt16(offset, samples[i], true);
  return Bun.write(path, buffer);
}

async function synthesizeLine(text, outPath) {
  const aiffPath = outPath.replace(/\.wav$/, ".aiff");
  const say = Bun.spawnSync(["say", "-v", "Samantha", "-r", "185", "-o", aiffPath, text]);
  if (say.exitCode !== 0) throw new Error(`say failed for "${text}": ${say.stderr.toString()}`);

  const convert = Bun.spawnSync(["afconvert", "-f", "WAVE", "-d", "LEI16@" + SAMPLE_RATE, "-c", "1", aiffPath, outPath]);
  if (convert.exitCode !== 0) throw new Error(`afconvert failed for "${text}": ${convert.stderr.toString()}`);
}

async function buildTake(name, lines) {
  console.log(`Building ${name}...`);
  const chunks = [];
  for (let i = 0; i < lines.length; i++) {
    const [text, gapSeconds] = lines[i];
    const linePath = new URL(`${name}_line_${i}.wav`, TMP_DIR).pathname;
    await synthesizeLine(text, linePath);
    const parsed = parseWav(await Bun.file(linePath).arrayBuffer());
    const resampled = parsed.sampleRate === SAMPLE_RATE ? parsed.samples : parsed.samples; // afconvert already resampled
    chunks.push(resampled);
    if (gapSeconds > 0) chunks.push(silence(gapSeconds));
  }
  const full = concatInt16(chunks);
  const outPath = new URL(`${name}.wav`, OUT_DIR).pathname;
  await writeWav(full, SAMPLE_RATE, outPath);
  console.log(`  wrote ${outPath} (${(full.length / SAMPLE_RATE).toFixed(1)}s)`);
}

await Bun.$`mkdir -p ${TMP_DIR.pathname}`.quiet();
for (const [name, lines] of Object.entries(TAKES)) {
  await buildTake(name, lines);
}
await Bun.$`rm -rf ${TMP_DIR.pathname}`.quiet();
console.log("Done.");
