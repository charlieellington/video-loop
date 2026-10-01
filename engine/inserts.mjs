// inserts.mjs — the pieces slotted INTO the narration timeline: a typed opening and music interludes.
// Plain English: a hook plays before the first word; an interlude is a few seconds of b-roll with
// no narration, placed after a chosen word. Both are switched on by settings, not by whether an
// old render happens to exist on disk: turn the hook off and it is gone, even if a hook file is
// still in the cache. Their lengths are known before rendering, so the shared timeline can place
// captions and review timecodes correctly.

import { join } from "node:path";
import { probeMedia, durationMs } from "./probe.mjs";
import { measureLoudness } from "./loudness.mjs";
import { ffmpeg, ensureDir, sec, Failure, Pending, log } from "./util.mjs";
import { fitChain, BT709 } from "./render-cut.mjs";

const HOOK_FPS = 30;

/** Which inserts this revision has, from settings + edit plan. */
export function insertSpecs(edit, cfg) {
  const out = []; const notes = []; const fr = (s) => Math.round(Math.round(s * cfg.canvas.fps) * 1000 / cfg.canvas.fps);   // durations in whole frames
  if (cfg.presentation.hook === "typed") {
    if (!edit.hook) throw new Pending("presentation.hook = \"typed\" but the edit plan has no \"hook\" block", ["add a hook block to edit.json (see docs/configuration.md), or set presentation.hook = \"none\""]);
    out.push({ kind: "hook", dur_ms: Math.round(Math.round(edit.hook.duration_s * HOOK_FPS) / HOOK_FPS * 1000), spec: edit.hook });
  } else if (edit.hook) notes.push("edit plan has a hook block but presentation.hook = \"none\" — no hook");
  const il = edit.interludes ?? [];
  if (cfg.presentation.interludes) il.forEach((x, k) => {
    if (!Array.isArray(x.clips) || !x.clips.length) throw new Failure(`edit plan problem: interlude ${k} has no clips`);
    const clips = x.clips.map((c) => ({ ...c, dur_ms: fr(c.dur_s) }));
    out.push({ kind: "interlude", after_word_i: x.after_word_i, dur_ms: clips.reduce((t, c) => t + c.dur_ms, 0), clips, why: x.why ?? "" });
  });
  else if (il.length) notes.push(`edit plan lists ${il.length} interlude(s) but presentation.interludes = false — none used`);
  return { specs: out, notes };
}

/** Render every insert's picture (W×H, canvas fps) and its sound (levelled relative to the voice target). */
export async function renderInserts({ inserts, ctx, W, H, dir, voiceTarget }) {
  const { cfg, paths } = ctx; const fps = cfg.canvas.fps; const out = [];
  for (const [k, x] of inserts.entries()) {
    const d = ensureDir(join(dir, `insert-${k}-${x.kind}`));
    if (x.kind === "hook") {
      const { renderHook } = await import("./hook/hook.mjs");   // loaded only when a hook is switched on
      const h = await renderHook({ spec: x.spec, paths, outDir: d, W, H });
      const pic = join(d, "picture.mp4");
      ffmpeg(["-i", h.video, "-vf", `fps=${fps},format=yuv420p,setsar=1`, "-t", sec(x.dur_ms), "-c:v", "libx264", "-preset", "fast", "-crf", "18", pic]);
      out.push({ picture: pic, audio: levelTo(h.audio, voiceTarget - 6, join(d, "audio-levelled.wav")) });
      continue;
    }
    const pics = [], auds = [];
    for (const [j, c] of x.clips.entries()) {
      const f = paths.abs(c.media); const m = probeMedia(f); const ms = c.dur_ms;
      if (m.kind !== "video" && m.kind !== "image") throw new Failure(`interlude clip not usable: ${c.media}`);
      const pic = join(d, `clip-${j}.mp4`);
      const src = m.kind === "image" ? ["-loop", "1", "-framerate", String(fps), "-t", sec(ms + 300), "-i", f] : ["-ss", String(c.start_s ?? 0), "-t", sec(ms + 500), "-i", f];
      ffmpeg([...src, "-filter_complex", `[0:v]fps=${fps}[s];${fitChain("s", W, H, c.fit && c.fit !== "auto" ? c.fit : cfg.canvas.fit, "p")};[p]tpad=stop_mode=clone:stop_duration=30,trim=duration=${sec(ms)},format=yuv420p,setsar=1[v]`,
        "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", pic]);
      pics.push(pic);
      const keep = (c.sound ?? "keep") === "keep" && m.has_audio && m.kind === "video";
      const a = join(d, `clip-${j}.wav`);
      if (keep) {
        ffmpeg(["-ss", String(c.start_s ?? 0), "-t", sec(ms), "-i", f, "-map", "0:a:0", "-af", `aresample=48000,apad=whole_dur=${sec(ms)},afade=t=in:d=0.2,afade=t=out:st=${Math.max(0, ms / 1000 - 0.25).toFixed(3)}:d=0.25`, "-ac", "1", "-c:a", "pcm_s16le", a]);
        auds.push(levelTo(a, voiceTarget + (c.sound_gain_db ?? -8), join(d, `clip-${j}-lev.wav`)));
      } else { ffmpeg(["-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono`, "-t", sec(ms), "-c:a", "pcm_s16le", a]); auds.push(a); }
    }
    const pic = join(d, "picture.mp4"), aud = join(d, "audio.wav");
    ffmpeg([...pics.flatMap((p) => ["-i", p]), "-filter_complex", `${pics.map((_, j) => `[${j}:v]`).join("")}concat=n=${pics.length}:v=1:a=0[v]`, "-map", "[v]", "-c:v", "libx264", "-preset", "fast", "-crf", "18", pic]);
    ffmpeg([...auds.flatMap((p) => ["-i", p]), "-filter_complex", `${auds.map((_, j) => `[${j}:a]`).join("")}concat=n=${auds.length}:v=0:a=1[a]`, "-map", "[a]", "-c:a", "pcm_s16le", aud]);
    const got = durationMs(pic); if (Math.abs(got - x.dur_ms) > 100) throw new Failure(`interlude ${k} rendered ${got} ms, planned ${x.dur_ms} ms`);
    log(`INTERLUDE ${inserts.slice(0, k + 1).filter((y) => y.kind === "interlude").length}: ${x.clips.length} clip(s), ${(x.dur_ms / 1000).toFixed(1)}s after word ${x.after_word_i}`);
    out.push({ picture: pic, audio: aud });
  }
  return out;
}

function levelTo(src, targetI, out) {
  let I = -Infinity; try { I = measureLoudness(src).I; } catch {}
  if (!Number.isFinite(I)) return src;
  ffmpeg(["-i", src, "-af", `volume=${(targetI - I).toFixed(2)}dB`, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]);
  return out;
}

/** Final picture: [hook] + cut-with-covers split at interlude points + interlude pictures. */
export function assemblePicture({ coveredCut, tl, insertMedia, W, H, fps, out }) {
  if (!tl.inserts.length) return coveredCut;
  const inputs = ["-i", coveredCut]; const parts = []; const seq = []; let cursor = 0;
  const pieces = tl.inserts.length + 1; parts.push(`[0:v]fps=${fps},split=${pieces}${Array.from({ length: pieces }, (_, k) => `[c${k}]`).join("")}`);
  tl.inserts.forEach((x, k) => {
    const f0 = Math.round(cursor * fps / 1000), f1 = Math.round(x.at_cut_ms * fps / 1000);   // cut by frame number, like the cut itself
    if (f1 > f0) { parts.push(`[c${k}]trim=start_frame=${f0}:end_frame=${f1},setpts=PTS-STARTPTS[p${k}]`); seq.push(`[p${k}]`); } else parts.push(`[c${k}]nullsink`);
    inputs.push("-i", insertMedia[k].picture);
    parts.push(`[${k + 1}:v]scale=${W}:${H},fps=${fps},format=yuv420p,setsar=1[i${k}]`); seq.push(`[i${k}]`);
    cursor = x.at_cut_ms;
  });
  parts.push(`[c${tl.inserts.length}]trim=start_frame=${Math.round(cursor * fps / 1000)},setpts=PTS-STARTPTS[tail]`); seq.push("[tail]");
  ffmpeg([...inputs, "-filter_complex", `${parts.join(";")};${seq.join("")}concat=n=${seq.length}:v=1:a=0,format=yuv420p,${BT709}[v]`, "-map", "[v]",
    "-c:v", "libx264", "-preset", W < 1000 ? "veryfast" : "fast", "-crf", W < 1000 ? "23" : "17", "-r", String(fps), out]);
  const got = durationMs(out); if (Math.abs(got - tl.total) > 150) throw new Failure(`assembled picture is ${got} ms, timeline says ${tl.total} ms`);
  return out;
}
