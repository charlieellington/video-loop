// plan.mjs — loads a project and turns the current revision's edit plan into a checked timeline.
// Plain English: "the plan" is everything decided so far — which narration, its transcript, the
// words kept, the pictures over them, inserts, captions and music settings. This file gathers it,
// checks it fits together (every second covered when the format needs it, no word that does not
// exist), and computes the fingerprints an approval is bound to. If anything changes after an
// approval — media, timing, profile, settings or plan — the approval no longer matches.

import { existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { loadConfig, configFingerprint } from "./config.mjs";
import { statePaths, currentRevision } from "./state.mjs";
import { selectedNarration, buildSpine } from "./narration.mjs";
import { resolveCuts } from "./resolve.mjs";
import { buildTimeline, coverWindows } from "./timeline.mjs";
import { insertSpecs } from "./inserts.mjs";
import { checkCoverMedia } from "./covers.mjs";
import { readJsonOpt, writeJson, sha256File, sha256, stableJson, Failure, Pending, NeedsApproval } from "./util.mjs";
import { durationMs } from "./probe.mjs";

/** Load a project from a folder or a project.toml path. */
export function loadProject(arg, { overrides = [] } = {}) {
  if (!arg) throw new Failure("give the project folder, e.g. video-loop board ~/Videos/my-video");
  let file = resolve(arg);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "project.toml");
  const c = loadConfig(file, overrides);
  return { ...c, sp: statePaths(c.paths.state), overrides };
}

export const EDIT_CONTRACT = "video-loop/edit@1";

/** Everything needed to board, approve or render the current revision. */
export async function preparePlan(ctx, { needEdit = true } = {}) {
  const { cfg, sp } = ctx;
  const narr = selectedNarration(ctx);
  const prov = readJsonOpt(sp.provenance); const wordsDoc = readJsonOpt(sp.words);
  if (!prov || prov.audio_sha256 !== narr.asset_sha256 || !wordsDoc)
    throw new Pending(`there is no transcript for the ${narr.which} narration yet`, ["video-loop ingest <project>"]);
  const words = wordsDoc.words; const rev = currentRevision(sp.root);
  const edit = readJsonOpt(rev.edit);
  if (!edit) {
    if (!needEdit) return { narr, prov, words, rev, edit: null };
    throw new Pending(`revision ${rev.id} has no edit plan yet`, [`the agent writes ${rev.edit} (prompts/editorial-plan.md), using transcript_sha256 ${prov.transcript_sha256}`]);
  }
  if (edit.contract && edit.contract !== EDIT_CONTRACT) throw new Failure(`edit.json contract "${edit.contract}" is not ${EDIT_CONTRACT}`);
  const spine = buildSpine(ctx, narr);
  const cuts = resolveCuts(words, edit, { transcriptSha: prov.transcript_sha256, mediaDurMs: durationMs(spine.file), language: prov.language,
    reel: spine.reel, preHandle: cfg.editorial.pre_handle_ms, postHandle: cfg.editorial.post_handle_ms, fps: cfg.canvas.fps });
  const { specs: inserts, notes: insertNotes } = insertSpecs(edit, cfg);
  const tl = buildTimeline(cuts, words, inserts, { fps: cfg.canvas.fps });
  const covers = edit.covers ?? [];
  const resolvedCovers = checkCoverMedia(covers, ctx.paths);
  const cov = coverWindows(tl, words, covers, { holdGapMs: cfg.editorial.hold_gap_ms, fullCover: cfg.editorial.full_cover || !spine.hasOwnPicture });
  const problems = cov.gaps.map((g) => `${(g.ms / 1000).toFixed(2)}s with no picture at ${(tl.toFinal(g.from) / 1000).toFixed(2)}s (${g.where}) — add a cover over those words, extend a neighbour, or plan a deliberate hold/still`);
  for (const k of Object.keys(edit.caption_fixes ?? {})) if (!words[+k]) problems.push(`caption_fixes: word ${k} does not exist`);
  writeJson(rev.cuts, cuts);
  writeJson(rev.timeline, { total_ms: tl.total, cut_ms: tl.cutDur, inserts: tl.inserts.map(({ spec, clips, ...x }) => x), windows: cov.windows, coverage_problems: problems });
  writeJson(rev.config, { profile: ctx.profileName, fingerprint: configFingerprint(cfg), settings: cfg });
  return { narr, prov, words, rev, edit, spine, cuts, tl, covers, resolvedCovers, cov, problems, notes: [...insertNotes, ...cov.notes] };
}

/** The fingerprints an approval is bound to. */
export async function bindingFor(ctx, plan) {
  const { cfg, sp } = ctx;
  const media = {};
  for (const r of plan.resolvedCovers) media[r.cover.media] ??= await sha256File(r.file);
  for (const x of plan.tl.inserts) for (const m of [...(x.clips ?? []).map((c) => c.media), ...(x.spec?.shots ?? []).map((s) => s.media)]) media[m] ??= await sha256File(ctx.paths.abs(m));
  let music = null;
  if (cfg.music.source === "file" && existsSync(ctx.paths.musicFile)) music = await sha256File(ctx.paths.musicFile);
  if (cfg.music.source === "elevenlabs") music = readJsonOpt(sp.music)?.sha256 ?? null;
  return {
    narration: { which: plan.narr.which, sha256: plan.narr.asset_sha256 },
    transcript_sha256: plan.prov.transcript_sha256,
    edit_sha256: await sha256File(plan.rev.edit),
    profile: ctx.profileName,
    config_fingerprint: configFingerprint(cfg),
    music_sha256: music,
    media_sha256: sha256(stableJson(media)),
  };
}

const LABELS = { narration: "the narration recording or its selected version", transcript_sha256: "the transcript (words or timings)", edit_sha256: "the edit plan",
  profile: "the style profile", config_fingerprint: "the project settings", music_sha256: "the music track", media_sha256: "a b-roll/still file" };

/** Throw NeedsApproval unless an approval exists for exactly this plan. */
export async function checkApproval(ctx, plan) {
  const ap = readJsonOpt(plan.rev.approval);
  if (!ap) throw new NeedsApproval(`revision ${plan.rev.id} has not been approved`, ["review the board: video-loop review <project>", "then: video-loop approve <project>"]);
  const now = await bindingFor(ctx, plan);
  const changed = Object.keys(now).filter((k) => stableJson(now[k]) !== stableJson(ap.binding[k]));
  if (changed.length) throw new NeedsApproval(`the approval of ${plan.rev.id} no longer matches — changed since approval: ${changed.map((k) => LABELS[k]).join(", ")}`, ["video-loop board <project>", "video-loop approve <project>"]);
  return { approval: ap, binding: now };
}

export const describeNarration = (n) => `${n.which} narration (${basename(n.wav)})`;
