#!/usr/bin/env node
// measure-sync.mjs — measures whether speech and picture line up in a rendered video (verification).
// Plain English: the fictional talking-head fixture's picture IS a drawing of its own voice, so its
// brightness rises and falls with the speech. This compares the picture's brightness per frame with
// the sound's loudness per frame over chosen time ranges and reports the shift that lines them up
// best (5 ms steps). Compare a processed file with its source: equal lag = sync preserved. Used by docs/verification.md; not part of a user's flow.
//   node tools/measure-sync.mjs <video> <from_s>-<to_s> [<from_s>-<to_s> …] [--crop w:h:x:y]
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2); const file = args[0];
const ci = args.indexOf("--crop"); const crop = ci > -1 ? args[ci + 1] : null;
const ranges = args.slice(1).filter((a, k) => /^[\d.]+-[\d.]+$/.test(a) && args[k] !== "--crop").map((r) => r.split("-").map(Number));
if (!file || !ranges.length) { console.error("usage: node tools/measure-sync.mjs <video> <from_s>-<to_s> … [--crop w:h:x:y]"); process.exit(64); }

const fps = (() => { const r = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", file]).toString().trim().split("/").map(Number); return r[0] / (r[1] || 1); })();
const out = [];
for (const [a, b] of ranges) {
  const vf = `${crop ? `crop=${crop},` : ""}scale=64:64,format=gray`;
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(a), "-t", String(b - a), "-i", file, "-vf", vf, "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const n = Math.floor(raw.length / 4096); const luma = []; for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < 4096; j++) s += raw[i * 4096 + j]; luma.push(s / 4096); }
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-ss", String(a), "-t", String(b - a), "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4); const per = 48000 / fps;
  // sound loudness over each frame's span, shifted by `lag` ms — searched in 5 ms steps (sub-frame)
  const rmsAt = (lagMs) => luma.map((_, i) => { const a0 = Math.round(i * per + lagMs * 48); let s = 0, c = 0; for (let j = a0; j < a0 + per; j++) if (j >= 0 && j < x.length) { s += x[j] * x[j]; c++; } return Math.sqrt(s / (c || 1)); });
  const z = (v) => { const m = v.reduce((p, q) => p + q, 0) / v.length; const sd = Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / v.length) || 1; return v.map((q) => (q - m) / sd); };
  const L = z(luma); let best = { lag: 0, r: -2 };
  for (let lag = -200; lag <= 200; lag += 5) { const R = z(rmsAt(lag)); let s = 0; for (let i = 0; i < n; i++) s += L[i] * R[i]; const r = s / n; if (r > best.r) best = { lag, r }; }
  out.push({ range_s: [a, b], frames: n, lag_ms: best.lag, correlation: +best.r.toFixed(3) });
}
console.log(JSON.stringify({ file, fps: +fps.toFixed(3), ranges: out }, null, 1));
