// evidence.mjs — checks a rendered preview or master and keeps the proof.
// Plain English: after every render this measures the actual file — length, picture size, frame
// rate, codecs, loudness and peaks — scans every frame for the internal placeholder colour (which
// would mean a moment with no picture slipped through) and for black holds, and saves still
// frames at caption moments and shot changes so a person can look. It never claims more than it
// measured: listening for clarity, pumping or clipped words is still a human pass.
// Checks adapted from the away-loop lab's glitch-check.mjs (black stops) and laneA/evidence.mjs (join frames).

import { join } from "node:path";
import { probeMedia, durationMs } from "./probe.mjs";
import { measureLoudness } from "./loudness.mjs";
import { ffmpeg, ffmpegStderr, ensureDir, sec, tc } from "./util.mjs";

/** Frames that are mostly the placeholder colour (magenta). Covers always fill the whole frame, so a planning gap shows as a whole placeholder frame; a threshold of 60% ignores real magenta in footage. */
export function placeholderFrames(file) {
  const txt = ffmpegStderr(["-i", file, "-vf", "scale=90:160,format=yuv444p,geq=lum='if(gt(cb(X,Y),190)*gt(cr(X,Y),205),255,0)':cb=128:cr=128,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-an", "-f", "null", "-"]);
  const out = []; let t = null;
  for (const l of txt.split("\n")) {
    const f = l.match(/pts_time:([\d.]+)/); if (f) { t = +f[1]; continue; }
    const y = l.match(/YAVG=([\d.]+)/); if (y && t != null) { const frac = +y[1] / 255; if (frac > 0.6) out.push({ t_s: t, fraction: +frac.toFixed(3) }); }
  }
  return out;
}

export function blackHolds(file) {
  const txt = ffmpegStderr(["-i", file, "-vf", "blackdetect=d=0.25:pix_th=0.10", "-an", "-f", "null", "-"]);
  return [...txt.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ from_s: +m[1], to_s: +m[2] }));
}

/**
 * Measure + inspect a render. Returns {facts, problems, warnings, frames}.
 * expect = {W, H, fps, total_ms, tolerance_ms, lufs, tp, captionMoments:[{label, ms}], cutMoments:[ms]}
 */
export function inspectRender(file, expect, framesDir) {
  const m = probeMedia(file); const problems = [], warnings = [];
  const facts = { duration_ms: durationMs(file), width: m.video?.W, height: m.video?.H, fps: +(m.video?.fps ?? 0).toFixed(3), video_codec: m.video?.codec, audio_codec: m.audio?.codec,
    audio_rate: m.audio?.sample_rate, audio_channels: m.audio?.channels };
  if (facts.width !== expect.W || facts.height !== expect.H) problems.push(`picture is ${facts.width}×${facts.height}, expected ${expect.W}×${expect.H}`);
  if (Math.abs(facts.fps - expect.fps) > 0.05) problems.push(`frame rate is ${facts.fps}, expected ${expect.fps}`);
  if (facts.video_codec !== "h264" || facts.audio_codec !== "aac") problems.push(`codecs are ${facts.video_codec}/${facts.audio_codec}, expected h264/aac`);
  const d = facts.duration_ms - expect.total_ms;
  if (Math.abs(d) > expect.tolerance_ms) problems.push(`length ${facts.duration_ms} ms differs from the timeline (${expect.total_ms} ms) by ${d} ms (tolerance ±${expect.tolerance_ms})`);
  facts.duration_delta_ms = d;
  const L = measureLoudness(file); Object.assign(facts, { lufs: L.I, true_peak_db: L.TP, lra: L.LRA });
  if (Math.abs(L.I - expect.lufs) > 1) (expect.strict ? problems : warnings).push(`loudness ${L.I} LUFS is more than 1 LU from ${expect.lufs}`);
  if (L.TP > expect.tp) (expect.strict ? problems : warnings).push(`true peak ${L.TP} dBTP is above ${expect.tp}`);
  const ph = placeholderFrames(file); facts.placeholder_frames = ph.length;
  if (ph.length) problems.push(`${ph.length} frame(s) show the internal placeholder (no picture planned), first at ${ph[0].t_s.toFixed(2)}s`);
  const blacks = blackHolds(file).filter((b) => b.to_s < facts.duration_ms / 1000 - 0.3); facts.black_holds = blacks;
  if (blacks.length) warnings.push(`${blacks.length} dark/black hold(s): ${blacks.map((b) => `${b.from_s.toFixed(1)}–${b.to_s.toFixed(1)}s`).join(", ")} — check they are intended`);
  const frames = [];
  if (framesDir) {
    ensureDir(framesDir);
    const grab = (ms, name) => { const f = join(framesDir, `${name}.jpg`); try { ffmpeg(["-ss", sec(Math.max(0, ms)), "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", f]); frames.push({ at: tc(ms), ms, file: f, label: name }); } catch {} };
    grab(200, "00-open");
    (expect.captionMoments ?? []).forEach((c, k) => grab(c.ms, `cap-${String(k).padStart(2, "0")}-${c.label}`));
    (expect.cutMoments ?? []).slice(0, 6).forEach((ms, k) => { grab(ms - 60, `cut-${k}-before`); grab(ms + 60, `cut-${k}-after`); });
    grab(facts.duration_ms - 300, "99-end");
  }
  return { facts, problems, warnings, frames };
}

/** Caption moments worth a still: for the highlight look, before / within / after one word; else phrase middles. */
export function captionMoments(lines, preset) {
  if (!lines.length) return [];
  const pick = [lines[0], lines[Math.floor(lines.length / 2)], lines.at(-1)];
  if (preset === "typewriter-highlight") {
    const l = lines.find((x) => x.words.length >= 3) ?? lines[0]; const w = l.words[1] ?? l.words[0];
    return [{ label: "word-before", ms: w.start - 40 }, { label: "word-within", ms: Math.round((w.start + w.end) / 2) }, { label: "word-after", ms: Math.min(w.end + 40, l.end - 20) },
      ...pick.map((p, k) => ({ label: `phrase-${k}`, ms: Math.round((p.start + p.end) / 2) }))];
  }
  return pick.map((p, k) => ({ label: `phrase-${k}`, ms: Math.round((p.start + p.end) / 2) }));
}
