// board.mjs — the storyboard: the whole proposed video as one page, before anything is rendered.
// Plain English: one card per shot, in order, each with a picture of the clip or photo, a play
// button for the real file, the exact words spoken over it (separate from the agent's editorial
// note), and its sound choice. Then the words that were cut, the caption look (a real sample
// frame), the planned soundtrack and any coverage problems. The same page later carries the
// rendered preview and the feedback box (review-page.mjs). Adapted from the away-loop lab's
// make-storyboard.mjs card-per-shot idea, with Charlie-specific gaze/hook/email parts removed.

import { existsSync, copyFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ffmpeg, ensureDir, sha256, sec, tc, scratchDir, rmrf } from "./util.mjs";
import { writeCaptions, PRESET_FONTS } from "./captions.mjs";
import { coverSound } from "./covers.mjs";
import { TOOL_ROOT } from "./config.mjs";

/** A still for (file, ms), cached by content. */
function still(ctx, file, ms, kind) {
  const out = join(ensureDir(join(ctx.sp.cache, "frames")), `${sha256(`${file}|${ms}`).slice(0, 16)}.jpg`);
  if (!existsSync(out)) {
    try { ffmpeg([...(kind === "image" ? [] : ["-ss", sec(ms)]), "-i", file, "-frames:v", "1", "-vf", "scale=360:640:force_original_aspect_ratio=decrease", out]); } catch { return null; }
  }
  return out;
}

/** A link from the page (in outDir) to a project file; null when it lives outside the project folder. */
export const linkFrom = (outDir, projectDir) => (file) => {
  const r = relative(projectDir, file);
  if (r.startsWith("..") || r.startsWith(sep)) return null;
  return relative(outDir, file).split(sep).map(encodeURIComponent).join("/");
};

/** Render one frame of the chosen caption look over a card's picture. */
function captionSample(ctx, plan, bg, outDir) {
  if (ctx.cfg.captions.preset === "none" || !bg) return null;
  const tmp = scratchDir(ctx.sp.root, "capsample");
  try {
    const ass = join(tmp, "c.ass"); const fonts = ensureDir(join(tmp, "fonts"));
    for (const f of PRESET_FONTS[ctx.cfg.captions.preset]) copyFileSync(join(TOOL_ROOT, "assets", "fonts", f), join(fonts, f));
    const { lines } = writeCaptions({ tl: plan.tl, words: plan.words, fixes: plan.edit.caption_fixes ?? {}, cfg: ctx.cfg, assPath: ass });
    const l = lines.find((x) => x.words.length >= 3) ?? lines[0]; if (!l) return null;
    const w = l.words[Math.floor(l.words.length / 2)]; const t = (w.start + w.end) / 2;   // mid-phrase: shows the highlight state too
    const out = join(outDir, "caption-sample.jpg"); const { width: W, height: H } = ctx.cfg.canvas;
    ffmpeg(["-loop", "1", "-t", "0.1", "-i", bg, "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setpts=PTS+${(t / 1000).toFixed(3)}/TB,ass=c.ass:fontsdir=fonts,scale=360:-2`, "-frames:v", "1", out], { cwd: tmp });
    return { file: out, text: l.text, at_ms: t };
  } finally { rmrf(tmp); }
}

/** Board data: cards on the FINAL timeline + cut words + soundtrack. */
export function boardData(ctx, plan, outDir) {
  const { cfg, paths } = ctx; const link = linkFrom(outDir, paths.project); const { tl, words, edit } = plan;
  const fixes = edit.caption_fixes ?? {}; const text = (i) => fixes[i] ?? words[i].text;
  const placed = words.map((w) => tl.wordPlace(w.i)).filter(Boolean);
  const spokenIn = (a, b) => placed.filter((p) => p.cut_start < b && p.cut_end > a).map((p) => text(p.i)).join(" ");
  const cards = [];
  const wins = plan.cov.windows;
  let cursor = 0;
  const faceCard = (a, b) => { if (b - a < 150) return; const s = tl.segs.find((x, k) => a >= tl.outStart[k] && a < tl.outStart[k] + (x.out_ms - x.in_ms)); const k = tl.segs.indexOf(s);
    const srcMs = s ? s.in_ms + (a - tl.outStart[k]) : 0; const img = plan.spine.hasOwnPicture ? still(ctx, plan.spine.file, srcMs + 200, "video") : null;
    cards.push({ kind: plan.spine.hasOwnPicture ? "face" : "gap", start: tl.toFinal(a), end: tl.toFinal(b, "end"), said: spokenIn(a, b), img: img && link(img), note: plan.spine.hasOwnPicture ? "your own picture (no cover)" : "NO PICTURE — must be covered", play: null }); };
  for (const w of wins) {
    if (w.ws > cursor) faceCard(cursor, w.ws);
    const r = plan.resolvedCovers[w.cover]; const c = r.cover; const from = Math.round((c.start_s ?? 0) * 1000) + w.local_ms;
    const img = still(ctx, r.file, r.media.kind === "image" ? 0 : from, r.media.kind);
    cards.push({ kind: "cover", start: tl.toFinal(w.ws), end: tl.toFinal(w.we, "end"), said: spokenIn(w.ws, w.we), note: c.why ?? "", media: c.media, mediaKind: r.media.kind,
      img: img && link(img), play: r.media.kind === "video" && link(r.file) ? { src: link(r.file), t0: from / 1000, t1: (from + w.we - w.ws) / 1000 } : null,
      sound: r.media.kind === "video" ? (coverSound(c, cfg) === "keep" ? `keeps its own sound (${c.sound_gain_db ?? cfg.source_sound.broll_gain_db} dB vs voice)` : "muted") : "", lowres: r.media.video && Math.min(r.media.video.W, r.media.video.H) < 720 ? `${r.media.video.W}×${r.media.video.H}` : null });
    cursor = Math.max(cursor, w.we);
  }
  if (cursor < tl.cutDur) faceCard(cursor, tl.cutDur);
  for (const x of tl.inserts) cards.push({ kind: x.kind, start: x.at_final_ms, end: x.at_final_ms + x.dur_ms, said: x.kind === "hook" ? x.spec.lines.map((l) => l.text).join(" / ") : "(no narration)", note: x.why ?? (x.kind === "hook" ? "typed opening" : ""), media: (x.clips ?? x.spec?.shots ?? []).map((c) => c.media).join(", ") });
  cards.sort((a, b) => a.start - b.start);
  const kept = new Set(placed.map((p) => p.i));
  const transcript = words.map((w) => ({ i: w.i, text: text(w.i), kept: kept.has(w.i), fixed: fixes[w.i] != null ? w.text : null }));
  const segReasons = plan.cuts.segments.map((s) => ({ words: `${s.first_word_i}–${s.last_word_i}`, reason: s.reason, start: tl.toFinal(tl.outStart[plan.cuts.segments.indexOf(s)]) }));
  const firstImg = cards.find((c) => c.kind === "cover" && c.img) ?? cards.find((c) => c.img);
  const imgAbs = firstImg ? join(outDir, decodeURIComponent(firstImg.img)) : null;
  const sample = captionSample(ctx, plan, imgAbs, outDir);
  return { title: cfg.project.title, revision: plan.rev.id, profile: ctx.profileName, total_ms: tl.total, cards, transcript, segReasons, problems: plan.problems, notes: plan.notes,
    narration: { which: plan.narr.which, language: plan.prov.language, words: words.length },
    captions: { preset: cfg.captions.preset, position: cfg.captions.position, sample: sample && { img: "caption-sample.jpg", text: sample.text } },
    music: { source: cfg.music.source, prompt: cfg.music.prompt, file: cfg.music.file, placement: cfg.music.placement, level_db: cfg.music.level_db, ducking: cfg.music.ducking },
    presentation: { ...cfg.presentation }, editorial_notes: edit.notes ?? "", canvas: `${cfg.canvas.width}×${cfg.canvas.height} @ ${cfg.canvas.fps} fps` };
}

export const timeLabel = (ms) => tc(ms);
