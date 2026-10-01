// inventory.mjs — looks at every file in the project's media folder and writes down what it is.
// Plain English: for each photo, clip or recording this records its fingerprint (so we can prove
// later that it was never changed), whether it is a picture, a video or sound only, its shape
// (portrait/landscape, rotation), whether its sound is silent, whether it is HDR, and makes a small
// contact sheet so the agent and the user can see it without opening every file.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { probeMedia } from "./probe.mjs";
import { ffmpeg, ffmpegStderr, sha256File, writeJson, ensureDir, log } from "./util.mjs";

const SKIP = /^\.|\.(toml|json|md|txt|srt|ass|html)$/i;

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.test(name)) continue;
    const p = join(dir, name); const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p)); else if (st.size > 0) out.push(p);
  }
  return out;
}

/** Peak level in dBFS (−91 = digital silence). */
export function peakDb(file) {
  const txt = ffmpegStderr(["-i", file, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
  const m = txt.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  return m ? (m[1] === "-inf" ? -91 : +m[1]) : null;
}

function contactSheet(entry, file, thumbsDir) {
  const out = join(thumbsDir, `${entry.sha256.slice(0, 16)}.jpg`);
  if (existsSync(out)) return out;
  if (entry.kind === "image") {
    ffmpeg(["-i", file, "-frames:v", "1", "-vf", "scale=360:360:force_original_aspect_ratio=decrease", out]);
  } else {
    const n = 6, d = Math.max(entry.duration_ms / 1000, 0.1);
    // one frame at the middle of each sixth: fps=n/d picks evenly spaced frames, tile lays them out
    ffmpeg(["-i", file, "-vf", `fps=${(n / d).toFixed(4)},scale=180:180:force_original_aspect_ratio=decrease,pad=180:180:(ow-iw)/2:(oh-ih)/2:color=0x222222,tile=3x2`,
      "-frames:v", "1", out]);
  }
  return out;
}

/** Inventory the media folder (plus the narration source if it lives elsewhere). */
export async function inventory({ paths, statePaths: sp, narrationFiles = [] }) {
  const files = [...new Set([...walk(paths.media), ...narrationFiles])];
  const thumbs = ensureDir(join(sp.cache, "thumbs"));
  const entries = [];
  for (const f of files) {
    const m = probeMedia(f);
    const st = statSync(f);
    const e = { path: f, rel: relative(paths.project, f), ext: extname(f).toLowerCase(), bytes: st.size,
      mtime_ms: Math.round(st.mtimeMs), sha256: await sha256File(f), kind: m.kind, role: narrationFiles.includes(f) ? "narration" : "picture" };
    if (m.kind === "none") { e.problem = m.error ?? "no audio or picture stream"; entries.push(e); continue; }
    if (m.duration_s != null) e.duration_ms = Math.round(m.duration_s * 1000);
    if (m.video) Object.assign(e, { width: m.video.W, height: m.video.H, rotation: m.video.rot, fps: +m.video.fps.toFixed(3), hdr: m.video.hdr, transfer: m.video.transfer });
    e.has_audio = m.has_audio;
    if (m.has_audio && m.kind !== "image") { e.peak_db = peakDb(f); e.silent = e.peak_db <= -60; }
    else e.silent = true;
    const notes = [];
    if (e.width && Math.min(e.width, e.height) < 720) notes.push(`low resolution (${e.width}×${e.height}) — fine on a phone, soft when enlarged`);
    if (e.rotation) notes.push(`stored rotated ${e.rotation}° — shown upright`);
    if (e.hdr) notes.push(`HDR (${e.transfer}) — converted to standard colour when used`);
    if (e.kind === "video" && e.silent) notes.push(e.has_audio ? "its sound track is silent" : "no sound track");
    if (e.width && e.height) e.shape = e.width === e.height ? "square" : e.width > e.height ? "landscape" : "portrait";
    e.notes = notes;
    if (m.kind === "video" || m.kind === "image") {
      try { e.thumb = relative(paths.project, contactSheet(e, f, thumbs)); } catch (err) { e.notes.push(`no contact sheet (${err.message.split("\n")[0]})`); }
    }
    entries.push(e);
  }
  writeJson(sp.sources, { created_at: new Date().toISOString(), media_dir: relative(paths.project, paths.media) || ".", files: entries });
  const by = (k) => entries.filter((x) => x.kind === k).length;
  log(`INVENTORY: ${entries.length} file(s) — ${by("video")} video, ${by("image")} image, ${by("audio")} audio${entries.some((x) => x.problem) ? `, ${entries.filter((x) => x.problem).length} unreadable` : ""}`);
  for (const e of entries) log(`  ${e.kind.padEnd(5)} ${e.rel}${e.duration_ms ? ` ${(e.duration_ms / 1000).toFixed(1)}s` : ""}${e.width ? ` ${e.width}×${e.height}` : ""}${e.problem ? ` — ${e.problem}` : ""}${e.notes?.length ? ` — ${e.notes.join("; ")}` : ""}`);
  return entries;
}
