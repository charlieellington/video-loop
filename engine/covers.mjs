// covers.mjs — lays the planned b-roll and stills over the cut picture, and builds the b-roll sound.
// Plain English: the edit plan says which picture shows while which words are spoken. This turns
// those word ranges into exact windows (timeline.mjs), fits each clip or photo to the canvas
// (blurred copy behind, crop, or bars), gives photos a slow push-in, continues a clip across a cut
// instead of restarting it, and holds a clip's last frame if it runs out. B-roll sound is muted
// unless a cover asks to keep it, at its own level; it is a separate track, never mixed into the
// narration. Adapted from the away-loop lab's assemble-covers.mjs (window arithmetic, overrun +
// repeat-last-frame belts against face flashes, HDR normalisation); brand-cream rules removed.

import { existsSync } from "node:fs";
import { probeMedia, durationMs } from "./probe.mjs";
import { measureLoudness } from "./loudness.mjs";
import { ffmpeg, ffmpegStderr, sec, Failure, log } from "./util.mjs";
import { fitChain, HDR_TONEMAP, BT709 } from "./render-cut.mjs";

/** Resolve the effective sound choice of a cover. */
export const coverSound = (c, cfg) => (c.sound && c.sound !== "default" ? c.sound : cfg.source_sound.broll_default);

/** Check every cover's media exists and is usable; returns [{cover, file, media}] or throws. */
export function checkCoverMedia(covers, paths) {
  return covers.map((c, i) => {
    if (!c.media) throw new Failure(`edit plan problem: cover ${i} has no media`);
    const file = paths.abs(c.media);
    if (!existsSync(file)) throw new Failure(`edit plan problem: cover ${i} media not found: ${c.media}`);
    const m = probeMedia(file);
    if (m.kind !== "video" && m.kind !== "image") throw new Failure(`edit plan problem: cover ${i} (${c.media}) is not a picture or video`);
    return { cover: c, file, media: m };
  });
}

/**
 * Overlay the windows onto the picture. windows come from timeline.coverWindows().
 * Returns {file, windows:[…with hold notes]}.
 */
export function assembleCovers({ base, out, windows, resolved, cfg, W, H, hasOwnPicture, zscaleAvailable }) {
  const fps = cfg.canvas.fps; const inputs = ["-i", base]; const chains = []; const report = [];
  windows.forEach((w, n) => {
    const { cover, file, media } = resolved[w.cover];
    const durS = (w.we - w.ws) / 1000, overS = durS + 0.2; const fit = cover.fit && cover.fit !== "auto" ? cover.fit : cfg.canvas.fit;
    const idx = n + 1; let pre = "", note = "";
    if (media.kind === "image") {
      inputs.push("-loop", "1", "-framerate", String(fps), "-t", (overS + 0.3).toFixed(3), "-i", file);
      // fitted at 2× then a slow push-in back down to the canvas (smooth sub-pixel motion)
      chains.push(`${fitChain(`${idx}:v`, 2 * W, 2 * H, fit, `p${n}`)};[p${n}]zoompan=z='min(zoom+0.0006,1.10)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}[z${n}]`);
      pre = `[z${n}]`;
    } else {
      if (media.video.hdr && !zscaleAvailable) throw new Failure(`cover ${cover.media} is HDR (${media.video.transfer}) and this ffmpeg has no zscale/tonemap filter — it would look washed out`, ["video-loop doctor", "use an SDR export of the clip, or an ffmpeg build with zimg (zscale)"]);
      const srcMs = durationMs(file); let from = Math.round((cover.start_s ?? 0) * 1000) + w.local_ms;
      if (from > srcMs - 200) { note = `clip is ${(srcMs / 1000).toFixed(1)}s; holds its last frame`; from = Math.max(0, srcMs - 200); }
      else if (from + w.we - w.ws > srcMs) note = `clip runs out after ${((srcMs - from) / 1000).toFixed(1)}s; holds its last frame for ${((from + w.we - w.ws - srcMs) / 1000).toFixed(1)}s`;
      inputs.push("-ss", sec(from), "-t", (overS + 0.3).toFixed(3), "-i", file);
      chains.push(`[${idx}:v]${media.video.hdr ? `${HDR_TONEMAP},` : ""}fps=${fps}[s${n}];${fitChain(`s${n}`, W, H, fit, `p${n}`)}`);
      pre = `[p${n}]`; w.from_ms = from;
    }
    chains.push(`${pre}tpad=stop_mode=clone:stop_duration=60,trim=duration=${overS.toFixed(3)},format=yuv420p,setsar=1,setpts=PTS-STARTPTS+${sec(w.ws)}/TB[c${n}]`);
    report.push({ cover: w.cover, media: cover.media, ws_ms: w.ws, we_ms: w.we, fit, kind: media.kind, ...(w.from_ms != null ? { from_ms: w.from_ms } : {}), ...(note ? { note } : {}) });
  });
  let cur = "0:v";
  windows.forEach((w, n) => { const nx = n === windows.length - 1 ? "vout" : `b${n}`; chains.push(`[${cur}][c${n}]overlay=0:0:enable='between(t,${sec(w.ws)},${sec(w.we)})':eof_action=repeat[${nx}]`); cur = nx; });
  if (!windows.length) { log("COVERS: none"); return { file: base, windows: [] }; }
  const baseMs = durationMs(base);
  ffmpeg([...inputs, "-filter_complex", `${chains.join(";")};[vout]trim=duration=${sec(baseMs)},format=yuv420p,${BT709}[v]`, "-map", "[v]", "-an",
    "-c:v", "libx264", "-preset", W < 1000 ? "veryfast" : "fast", "-crf", W < 1000 ? "23" : "17", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", out]);
  const din = baseMs, dout = durationMs(out);
  if (Math.abs(dout - din) > 100) throw new Failure(`covers changed the picture length (${din} → ${dout} ms)`);
  if (hasOwnPicture) for (const r of report) {   // a cover over real footage must visibly change the frame
    const t = sec((r.ws_ms + r.we_ms) / 2);
    const txt = ffmpegStderr(["-ss", t, "-i", out, "-ss", t, "-i", base, "-frames:v", "1", "-lavfi", "[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];[a][b]ssim", "-f", "null", "-"]);
    r.ssim_vs_face = parseFloat(txt.match(/All:([\d.]+)/)?.[1] ?? "1");
    if (r.ssim_vs_face > 0.9) throw new Failure(`cover ${r.media} is not visible at ${t}s (SSIM ${r.ssim_vs_face})`);
  }
  log(`COVERS: ${report.length} window(s) laid over the cut`);
  report.forEach((r) => log(`  ${sec(r.ws_ms).padStart(7)}–${sec(r.we_ms).padEnd(7)}s ${r.kind.padEnd(5)} ${r.fit.padEnd(7)} ${r.media}${r.note ? ` — ${r.note}` : ""}`));
  return { file: out, windows: report };
}

/** B-roll sound: only covers whose sound is "keep", each at its own level relative to the voice. */
export function ambienceStem({ windows, resolved, cfg, cutDurMs, voiceLufs, out }) {
  const keep = windows.map((w, n) => ({ w, n, r: resolved[w.cover] })).filter(({ r }) => coverSound(r.cover, cfg) === "keep" && r.media.kind === "video" && r.media.has_audio);
  if (!keep.length) return null;
  const inputs = [], chains = [], used = [];
  keep.forEach(({ w, r }, k) => {
    const from = w.from_ms ?? Math.round((r.cover.start_s ?? 0) * 1000) + w.local_ms; const d = w.we - w.ws;
    let I = -Infinity; try { I = measureLoudness(r.file, { filter: `atrim=start=${sec(from)}:end=${sec(from + d)}` }).I; } catch {}
    const rel = r.cover.sound_gain_db ?? cfg.source_sound.broll_gain_db;
    const gain = Number.isFinite(I) ? voiceLufs + rel - I : rel;
    inputs.push("-ss", sec(from), "-t", sec(d), "-i", r.file);
    chains.push(`[${k}:a]aresample=48000,aformat=channel_layouts=mono,volume=${gain.toFixed(2)}dB,afade=t=in:d=0.15,afade=t=out:st=${Math.max(0, d / 1000 - 0.2).toFixed(3)}:d=0.2,adelay=${w.ws}:all=1[m${k}]`);
    used.push({ media: r.cover.media, at_ms: w.ws, dur_ms: d, measured_lufs: Number.isFinite(I) ? I : null, gain_db: +gain.toFixed(2), relative_db: rel });
  });
  chains.push(`${keep.map((_, k) => `[m${k}]`).join("")}amix=inputs=${keep.length}:normalize=0:duration=longest,asetpts=N/SR/TB,apad=whole_dur=${sec(cutDurMs)}[a]`);
  // NOTE: no atrim after adelay/amix — it misreads the shifted timestamps and moved kept sound to the start (found in the r002 check); cut with -t instead
  ffmpeg([...inputs, "-filter_complex", chains.join(";"), "-map", "[a]", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-t", sec(cutDurMs), out]);
  log(`B-ROLL SOUND: kept on ${used.length} cover(s); everything else muted`);
  return { file: out, used };
}
