// pipeline.mjs — renders an approved revision: the preview (smaller, fast) or the final master.
// Plain English: both use exactly the same steps — cut, covers, inserts, captions, the real music
// mix — the preview just renders smaller and faster. Every optional feature is included because
// the settings say so, never because an old file is lying around. The output folder for each
// revision is separate (output/r001, output/r002 …) so earlier versions stay watchable. A manifest
// records exactly which approval, media and settings produced each file.

import { existsSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { preparePlan, checkApproval } from "./plan.mjs";
import { renderPicture, renderVoice, renderSize, tolerance, BT709 } from "./render-cut.mjs";
import { assembleCovers, ambienceStem } from "./covers.mjs";
import { renderInserts, assemblePicture } from "./inserts.mjs";
import { spliceStem, mixSoundtrack } from "./mix.mjs";
import { writeCaptions, PRESET_FONTS } from "./captions.mjs";
import { musicForRender } from "./music.mjs";
import { inspectRender, captionMoments } from "./evidence.mjs";
import { boardData } from "./board.mjs";
import { reviewHtml } from "./review-page.mjs";
import { featureCheck } from "./doctor.mjs";
import { TOOL_ROOT } from "./config.mjs";
import { ffmpeg, ensureDir, scratchDir, rmrf, sha256File, writeJson, readJsonOpt, writeAtomic, Failure, log } from "./util.mjs";

export async function render(ctx, { master = false, keepTemp = false } = {}) {
  const { cfg, paths } = ctx; const t0 = Date.now();
  const plan = await preparePlan(ctx);
  if (plan.problems.length) throw new Failure(`the plan has problems to fix first:\n  - ${plan.problems.join("\n  - ")}`, ["edit edit.json, then video-loop board <project>"]);
  const { approval, binding } = await checkApproval(ctx, plan);
  if (master) {
    const pm = readJsonOpt(plan.rev.previewManifest);
    if (!pm || JSON.stringify(pm.binding) !== JSON.stringify(binding)) throw new Failure(`render and watch the preview of ${plan.rev.id} first — the master is made from the accepted preview's exact plan`, ["video-loop preview <project>"]);
  }
  const music = await musicForRender(ctx, plan.tl.total);
  const scale = master ? 1 : cfg.export.preview_scale; const { W, H } = renderSize(cfg, scale); const fps = cfg.canvas.fps;
  const outDir = ensureDir(join(paths.output, plan.rev.id)); const tmp = scratchDir(ctx.sp.root, master ? "master" : "preview");
  const kind = master ? "master" : "preview";
  log(`${kind.toUpperCase()}: ${plan.rev.id} · ${W}×${H} @ ${fps} fps · ${(plan.tl.total / 1000).toFixed(2)}s · captions ${cfg.captions.preset} · music ${cfg.music.source}${cfg.presentation.hook !== "none" ? ` · hook ${cfg.presentation.hook}` : ""}`);
  const fc = featureCheck(); const zscale = fc.filters.zscale && fc.filters.tonemap;
  const hdrSpine = (await import("./probe.mjs")).probeMedia(plan.spine.file).video?.hdr ?? false;
  if (hdrSpine && !zscale) throw new Failure("the talking-head footage is HDR and this ffmpeg has no zscale/tonemap — it would be misrendered", ["video-loop doctor"]);
  // 1. picture + voice from the same cut list
  const pic = renderPicture({ cuts: plan.cuts, spine: plan.spine, cfg, scale, out: join(tmp, "picture-cut.mp4"), hdr: hdrSpine });
  const voiceCut = renderVoice({ cuts: plan.cuts, wav: plan.narr.wav, out: join(tmp, "voice-cut.wav") });
  // 2. covers + b-roll sound
  const covered = assembleCovers({ base: pic.file, out: join(tmp, "covered.mp4"), windows: plan.cov.windows.map((w) => ({ ...w })), resolved: plan.resolvedCovers, cfg, W, H, hasOwnPicture: plan.spine.hasOwnPicture, zscaleAvailable: zscale });
  const winsWithFrom = plan.cov.windows.map((w, k) => ({ ...w, from_ms: covered.windows[k]?.from_ms }));
  const amb = ambienceStem({ windows: winsWithFrom, resolved: plan.resolvedCovers, cfg, cutDurMs: plan.tl.cutDur, voiceLufs: cfg.export.loudness_lufs, out: join(tmp, "ambience-cut.wav") });
  // 3. inserts (only when switched on) → final picture
  const insertMedia = await renderInserts({ inserts: plan.tl.inserts, ctx, W, H, dir: tmp, voiceTarget: cfg.export.loudness_lufs });
  const finalPic = assemblePicture({ coveredCut: covered.file, tl: plan.tl, insertMedia, W, H, fps, out: join(tmp, "picture-final.mp4") });
  // 4. captions on the final timeline
  const fontsDir = ensureDir(join(tmp, "fonts")); for (const f of Object.values(PRESET_FONTS).flat()) copyFileSync(join(TOOL_ROOT, "assets", "fonts", f), join(fontsDir, f));
  const srt = join(outDir, `${kind}.srt`);
  const caps = writeCaptions({ tl: plan.tl, words: plan.words, fixes: plan.edit.caption_fixes ?? {}, cfg, assPath: join(tmp, "captions.ass"), srtPath: cfg.captions.srt ? srt : null });
  let captioned = finalPic;
  if (cfg.captions.preset !== "none") {
    captioned = join(tmp, "picture-captioned.mp4");
    ffmpeg(["-i", basename(finalPic), "-vf", `ass=captions.ass:fontsdir=fonts,${BT709}`, "-c:v", "libx264", "-preset", master ? "slow" : "veryfast", "-crf", master ? "17" : "23", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", basename(captioned)], { cwd: tmp });
    log(`CAPTIONS: ${caps.lines.length} phrase(s), ${caps.preset}${caps.events ? ` (${caps.events} events)` : ""} burned in · SRT sidecar ${cfg.captions.srt ? "written" : "off"}`);
  } else log("CAPTIONS: none burned");
  // 5. soundtrack: stems onto the final timeline, then the mix
  const insertAudio = insertMedia.map((x) => x.audio);
  const voiceFinal = spliceStem({ stem: voiceCut.file, tl: plan.tl, out: join(tmp, "voice-final.wav") });
  const ambFinal = amb ? spliceStem({ stem: amb.file, tl: plan.tl, out: join(tmp, "ambience-final.wav") }) : null;
  const insFinal = insertMedia.length ? spliceStem({ stem: null, tl: plan.tl, insertAudio, out: join(tmp, "inserts-final.wav") }) : null;
  const mix = mixSoundtrack({ voice: voiceFinal, ambience: ambFinal, inserts: insFinal, music, cfg, tl: plan.tl, out: join(tmp, "mix.wav"), master });
  // 6. mux, voice-only comparison, optional small variant
  const file = join(outDir, `${kind}.mp4`);
  ffmpeg(["-i", captioned, "-i", mix.file ?? join(tmp, "mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", master ? "256k" : "160k", "-ar", "48000", "-movflags", "+faststart", "-shortest", file]);
  const voiceOnly = join(outDir, `${kind}-voice-only.m4a`);
  ffmpeg(["-i", voiceFinal, "-af", `volume=${mix.voice_gain_db}dB,alimiter=limit=0.7:level=disabled`, "-c:a", "aac", "-b:a", "128k", voiceOnly]);
  let small = null;
  if (master && cfg.export.small_variant) { small = join(outDir, "master-720.mp4"); ffmpeg(["-i", file, "-vf", "scale=720:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", small]); }
  // 7. evidence + manifest + review page
  const cutMoments = plan.cov.windows.slice(1).map((w) => plan.tl.toFinal(w.ws));
  const ev = inspectRender(file, { W, H, fps, total_ms: plan.tl.total, tolerance_ms: tolerance(plan.cuts.segments.length) + 60, lufs: cfg.export.loudness_lufs, tp: cfg.export.true_peak_db, strict: master,
    captionMoments: captionMoments(caps.lines, cfg.captions.preset), cutMoments }, join(outDir, `${kind}-frames`));
  ev.warnings.push(...mix.problems);
  const features = [`captions ${cfg.captions.preset}`, music ? `music ${music.source} (${cfg.music.placement}, ${cfg.music.level_db} dB under voice${cfg.music.ducking ? ", ducked" : ""})` : "no music",
    `hook ${cfg.presentation.hook}`, `interludes ${plan.tl.inserts.filter((x) => x.kind === "interlude").length}`, `grade ${plan.spine.hasOwnPicture ? cfg.presentation.grade : "n/a"}`, `${plan.narr.which} narration`];
  const manifest = { kind, revision: plan.rev.id, approved_at: approval.approved_at, binding, rendered_at: new Date().toISOString(), seconds_to_render: Math.round((Date.now() - t0) / 1000),
    files: { video: file, video_sha256: await sha256File(file), srt: cfg.captions.srt ? srt : null, voice_only: voiceOnly, small },
    music: music && { source: music.source, sha256: music.sha256, duration_ms: music.duration_ms, request: music.request ?? null }, mix, captions: { preset: caps.preset, phrases: caps.lines.length, font: caps.font, font_px: caps.font_px },
    covers: covered.windows, ambience: amb?.used ?? [], features, evidence: ev };
  writeJson(master ? plan.rev.masterManifest : plan.rev.previewManifest, manifest);
  writeJson(join(outDir, `${kind}-manifest.json`), manifest);
  const d = boardData(ctx, plan, outDir);
  writeAtomic(join(outDir, "review.html"), reviewHtml(d, { preview: { kind, src: `${kind}.mp4`, name: `${plan.rev.id}/${kind}.mp4`, features: features.join(" · ") }, approved: true }));
  if (!keepTemp) rmrf(tmp);
  for (const w of ev.warnings) log(`  WARN  ${w}`);
  if (ev.problems.length) throw new Failure(`${kind} rendered but failed its checks:\n  - ${ev.problems.join("\n  - ")}`, [`see ${join(outDir, `${kind}-manifest.json`)}`]);
  log(`${kind.toUpperCase()} OK → ${file}\n  ${ev.facts.width}×${ev.facts.height} @ ${ev.facts.fps} fps · ${(ev.facts.duration_ms / 1000).toFixed(2)}s (Δ${ev.facts.duration_delta_ms} ms) · ${ev.facts.lufs} LUFS · ${ev.facts.true_peak_db} dBTP · placeholder frames ${ev.facts.placeholder_frames}`);
  return { file, manifest, outDir };
}
