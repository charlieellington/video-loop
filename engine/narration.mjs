// narration.mjs — turns the recorded narration into the working track everything else is cut from.
// Plain English: the narration can be a voice recording (.m4a/.wav/.mp3) or a talking-head video.
// This checks it really has sound, keeps the original file untouched, and decodes a lossless
// working copy. It then decides which version is in use (original, or the cleaned-up one the user
// chose) and builds the "spine" the editor cuts: for a voice recording that is an internal
// placeholder picture carrying the voice (always fully covered by b-roll before anyone sees it);
// for a talking-head video it is the original picture with the chosen soundtrack laid back in sync.

import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { probeMedia, audioDurationMs } from "./probe.mjs";
import { peakDb } from "./inventory.mjs";
import { ffmpeg, sha256File, sha256, writeJson, readJsonOpt, ensureDir, Failure, Pending, log, sec } from "./util.mjs";

/** The internal placeholder colour. It must never reach a preview or master (checked by evidence). */
export const PLACEHOLDER_HEX = "0xFF00FF";

function checkNarrationFile(f) {
  if (!existsSync(f)) throw new Failure(`narration file not found: ${f}`, ["fix narration.source in project.toml"]);
  const m = probeMedia(f);
  if (m.kind === "none") throw new Failure(`narration ${basename(f)} is not readable media: ${m.error}`);
  if (!m.has_audio) throw new Failure(`narration ${basename(f)} has no audio stream — record or export it with sound`);
  const dur = m.audio.duration_s || m.duration_s;
  if (!(dur >= 1)) throw new Failure(`narration ${basename(f)} is too short (${(dur ?? 0).toFixed(2)}s)`);
  const peak = peakDb(f);
  if (peak == null || peak < -50) throw new Failure(`narration ${basename(f)} is silent or nearly silent (peak ${peak} dBFS)`);
  return m;
}

/** Glue several talking-head takes into one reel with short black, silent gaps (from make-reel.sh). */
function buildReel(ctx, takes) {
  const { cfg, sp } = ctx; const gap = cfg.narration.take_gap_s;
  const key = sha256(takes.map((t) => t.sha).join(",") + `|${cfg.canvas.width}x${cfg.canvas.height}@${cfg.canvas.fps}|${gap}`).slice(0, 16);
  const out = join(ensureDir(sp.cache), `reel-${key}.mkv`), meta = join(sp.cache, `reel-${key}.json`);
  if (existsSync(out) && existsSync(meta)) return { file: out, reel: readJsonOpt(meta) };
  const { width: W, height: H, fps } = cfg.canvas;
  const ins = [], parts = [], seq = []; let nIn = 0;
  takes.forEach((t, k) => {
    if (k) { // a fresh black + silent input per gap keeps the graph simple
      const g = nIn; nIn += 2;
      ins.push("-f", "lavfi", "-t", String(gap), "-i", `color=c=black:s=${W}x${H}:r=${fps}`);
      ins.push("-f", "lavfi", "-t", String(gap), "-i", "anullsrc=r=48000:cl=mono");
      parts.push(`[${g}:v]format=yuv420p,setsar=1[gv${k}];[${g + 1}:a]anull[ga${k}]`);
      seq.push(`[gv${k}][ga${k}]`);
    }
    const n = nIn++;
    ins.push("-i", t.file);
    parts.push(`[${n}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setsar=1[v${k}];[${n}:a]aresample=48000,aformat=channel_layouts=mono[a${k}]`);
    seq.push(`[v${k}][a${k}]`);
  });
  const graph = `${parts.join(";")};${seq.join("")}concat=n=${seq.length}:v=1:a=1[v][a]`;
  ffmpeg([...ins, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-c:a", "pcm_s16le", out]);
  let t = 0; const reel = { separator_s: gap, takes: [] };
  takes.forEach((tk, k) => { const d = audioDurationMs(tk.file) / 1000; reel.takes.push({ file: basename(tk.file), reel_start_s: +t.toFixed(3), duration_s: +d.toFixed(3) }); t += d + gap; });
  writeJson(meta, reel);
  return { file: out, reel };
}

/** Validate the narration, decode the lossless working copy, record original.json. */
export async function prepareOriginal(ctx) {
  const { cfg, paths, sp } = ctx;
  const files = cfg.narration.takes.length ? paths.takes : [paths.narration];
  const takes = [];
  for (const f of files) { const m = checkNarrationFile(f); takes.push({ file: f, m, sha: await sha256File(f) }); }
  if (cfg.narration.kind === "recorded-video" && takes.some((t) => !t.m.has_video || t.m.kind !== "video"))
    throw new Failure("narration.kind = \"recorded-video\" but the narration has no moving picture — use \"recorded-audio\" for a voice recording");
  if (cfg.narration.kind === "recorded-audio" && takes[0].m.kind === "video")
    log("NOTE: narration is a video file used as recorded-audio — only its sound is used; its picture is ignored");
  const assetSha = takes.length > 1 ? sha256(takes.map((t) => t.sha).join(",")) : takes[0].sha;
  const prev = readJsonOpt(sp.original);
  if (prev?.asset_sha256 === assetSha && existsSync(prev.working)) return prev;
  let pictureSource = null, reel = null, src = takes[0].file, m = takes[0].m;
  if (takes.length > 1) { const r = buildReel(ctx, takes); src = r.file; reel = r.reel; m = probeMedia(src); }
  if (cfg.narration.kind === "recorded-video") pictureSource = src;
  const working = join(ensureDir(sp.narrationDir), `original-${assetSha.slice(0, 16)}.wav`);
  // keep the soundtrack on the PICTURE's clock: a video's audio stream can start a few ms after
  // its picture; pad (or trim) so sample 0 of the working copy = frame 0 of the video.
  let shiftMs = 0;
  if (m.has_video && m.kind === "video") {
    const j = probeMedia(src); shiftMs = Math.round(((j.audio?.start_s ?? 0)) * 1000);
  }
  const af = [shiftMs > 0 ? `adelay=${shiftMs}:all=1` : null, shiftMs < 0 ? `atrim=start=${sec(-shiftMs)}` : null, "aresample=48000"].filter(Boolean).join(",");
  ffmpeg(["-i", src, "-map", "0:a:0", "-ac", "1", "-af", af, "-c:a", "pcm_s16le", working]);
  const rec = { asset_sha256: assetSha, sources: takes.map((t) => ({ file: t.file, sha256: t.sha })), kind: cfg.narration.kind,
    picture_source: pictureSource, reel, working, working_sha256: await sha256File(working),
    duration_ms: audioDurationMs(working), sample_rate: 48000, audio_start_shift_ms: shiftMs };
  writeJson(sp.original, rec);
  log(`NARRATION: ${takes.length > 1 ? `${takes.length} takes as one reel` : basename(src)} → working copy ${(rec.duration_ms / 1000).toFixed(2)}s (original untouched)`);
  return rec;
}

/** Which narration is in use. Throws Pending when the user still has to choose. */
export function selectedNarration(ctx) {
  const { cfg, sp } = ctx;
  const orig = readJsonOpt(sp.original);
  if (!orig) throw new Pending("the narration has not been prepared yet", ["video-loop ingest <project>"]);
  const original = { which: "original", asset_sha256: orig.asset_sha256, wav: orig.working, duration_ms: orig.duration_ms, offset_ms: 0 };
  if (cfg.voice_cleanup.source === "none") return original;
  const sel = readJsonOpt(sp.selection);
  if (!sel) throw new Pending("voice cleanup is switched on: clean the narration, compare, then choose which version to use",
    ["video-loop voice clean <project>", "listen to output/voice-compare.html", "video-loop voice select <project> original|cleaned"]);
  if (sel.which === "original") {
    if (sel.asset_sha256 !== orig.asset_sha256) throw new Pending("the narration recording changed since you chose a version — choose again", ["video-loop voice clean <project>", "video-loop voice select <project> original|cleaned"]);
    return { ...original, chosen_explicitly: true };
  }
  if (sel.original_sha256 !== orig.asset_sha256 || !existsSync(sel.wav))
    throw new Pending("the cleaned narration no longer matches the current recording — clean and choose again", ["video-loop voice clean <project>"]);
  return { which: "cleaned", asset_sha256: sel.asset_sha256, wav: sel.wav, duration_ms: sel.duration_ms, offset_ms: sel.offset_ms ?? 0 };
}

/**
 * The spine the editor cuts: picture + the chosen narration, both starting at 0.
 * recorded-audio: placeholder canvas (never shown — full cover is enforced) + narration.
 */
export function buildSpine(ctx, narr) {
  const { cfg, sp } = ctx; const orig = readJsonOpt(sp.original);
  const { width: W, height: H, fps } = cfg.canvas;
  const key = sha256(`${narr.asset_sha256}|${orig.picture_source ?? "proxy"}|${W}x${H}@${fps}`).slice(0, 16);
  const out = join(ensureDir(sp.cache), `spine-${key}.mkv`);
  if (!existsSync(out)) {
    if (orig.picture_source) {
      ffmpeg(["-i", orig.picture_source, "-i", narr.wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "pcm_s16le", out]);
    } else {
      const d = sec(narr.duration_ms);
      ffmpeg(["-f", "lavfi", "-i", `color=c=${PLACEHOLDER_HEX}:s=${W}x${H}:r=${fps}:d=${d}`, "-i", narr.wav,
        "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-t", d, out]);
    }
  }
  // the proxy/spine must start with the narration and last as long as it (±1 frame)
  const m = probeMedia(out); const aMs = Math.round(m.audio.duration_s * 1000);
  if (Math.abs(aMs - narr.duration_ms) > Math.ceil(1000 / fps) + 25 || Math.abs(m.audio.start_s) > 0.05)
    throw new Failure(`internal spine does not match the narration (audio ${aMs}ms vs ${narr.duration_ms}ms, start ${m.audio.start_s}s)`);
  return { file: out, reel: orig.reel, hasOwnPicture: !!orig.picture_source };
}
