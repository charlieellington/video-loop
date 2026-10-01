// align.mjs — checks that a cleaned-up recording still lines up with the original, word for word.
// Plain English: noise removal must not move, stretch or drop speech. Equal length is not proof,
// so this compares the loudness "shape" of both recordings near the start and near the end: the
// shift that lines them up should be the same at both ends (no drift) and small. It also checks
// that every place the original had clear speech still has speech after cleaning, and measures
// how much quieter the background became.

import { pcmFloat } from "./util.mjs";

const HOP_MS = 10, RATE = 16000;

/** Loudness envelope in dB, one value per 10 ms. */
export function envelope(file) {
  const x = pcmFloat(file, { rate: RATE }); const hop = RATE * HOP_MS / 1000; const n = Math.floor(x.length / hop);
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * hop; j < (i + 1) * hop; j++) s += x[j] * x[j]; env[i] = 10 * Math.log10(s / hop + 1e-10); }
  return env;
}
const pct = (a, p) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Best lag (ms) of b against a in frames [from, to): positive = b is later than a. */
export function bestLag(a, b, from, to, maxLagMs = 500) {
  const L = Math.round(maxLagMs / HOP_MS); let best = { lag: 0, r: -Infinity };
  const seg = (arr, s, e) => { const v = []; for (let i = s; i < e; i++) v.push(i >= 0 && i < arr.length ? Math.max(arr[i], -70) : -70); return v; };
  const A = seg(a, from, to); const ma = A.reduce((x, y) => x + y, 0) / A.length; const sa = Math.sqrt(A.reduce((x, y) => x + (y - ma) ** 2, 0)) || 1;
  for (let lag = -L; lag <= L; lag++) {
    const B = seg(b, from + lag, to + lag); const mb = B.reduce((x, y) => x + y, 0) / B.length;
    const sb = Math.sqrt(B.reduce((x, y) => x + (y - mb) ** 2, 0)) || 1;
    let c = 0; for (let i = 0; i < A.length; i++) c += (A[i] - ma) * (B[i] - mb);
    const r = c / (sa * sb); if (r > best.r) best = { lag, r };
  }
  return { lag_ms: best.lag * HOP_MS, r: +best.r.toFixed(3) };
}

/**
 * Compare original vs cleaned. Returns measurements plus pass/fail reasons against limits.
 * @param limits {max_offset_ms, max_drift_ms, max_duration_delta_ms, min_speech_retained}
 */
export function compareRecordings(origFile, cleanFile, limits) {
  const a = envelope(origFile), b = envelope(cleanFile);
  const winFrames = Math.min(Math.round(8000 / HOP_MS), Math.floor(a.length * 0.4));
  const start = bestLag(a, b, 0, winFrames, limits.max_offset_ms + 200);
  const end = bestLag(a, b, a.length - winFrames, a.length, limits.max_offset_ms + 200);
  const offset = Math.round((start.lag_ms + end.lag_ms) / 2);
  const drift = Math.abs(end.lag_ms - start.lag_ms);
  // speech: frames clearly above the original's background (its 20th percentile + 10 dB)
  const floorA = pct(a, 0.2), floorB = pct(b, 0.2), lagF = Math.round(offset / HOP_MS);
  const speech = []; for (let i = 0; i < a.length; i++) if (a[i] > floorA + 10 && a[i] > -50) speech.push(i);
  const activeB = (i) => { for (let d = -3; d <= 3; d++) { const j = i + lagF + d; if (j >= 0 && j < b.length && b[j] > Math.max(floorB + 10, -55)) return true; } return false; };
  const retained = speech.length ? speech.filter(activeB).length / speech.length : 0;
  const quietA = [], quietB = []; for (let i = 0; i < a.length; i++) if (a[i] <= floorA + 3) { quietA.push(a[i]); const j = i + lagF; if (j >= 0 && j < b.length) quietB.push(b[j]); }
  const mean = (v) => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN);
  const noiseA = mean(quietA), noiseB = Math.max(mean(quietB), -90);
  const durA = a.length * HOP_MS, durB = b.length * HOP_MS;
  const problems = [];
  if (Math.abs(durB - durA) > limits.max_duration_delta_ms) problems.push(`length differs by ${durB - durA} ms (limit ${limits.max_duration_delta_ms})`);
  if (start.r < 0.5 || end.r < 0.5) problems.push(`speech shape does not match the original (correlation start ${start.r}, end ${end.r})`);
  if (Math.abs(offset) > limits.max_offset_ms) problems.push(`shifted by ${offset} ms (limit ${limits.max_offset_ms})`);
  if (drift > limits.max_drift_ms) problems.push(`drifts by ${drift} ms between start and end (limit ${limits.max_drift_ms}) — not fixable by a single shift`);
  if (retained < limits.min_speech_retained) problems.push(`only ${(retained * 100).toFixed(1)}% of the original's speech frames still have speech (limit ${(limits.min_speech_retained * 100).toFixed(0)}%) — words may be missing`);
  return { duration_ms: { original: durA, cleaned: durB }, start, end, offset_ms: offset, drift_ms: drift,
    speech_frames: speech.length, speech_retained: +retained.toFixed(3),
    background_db: { original: +noiseA.toFixed(1), cleaned: +noiseB.toFixed(1), reduction: +(noiseA - noiseB).toFixed(1) }, problems };
}
