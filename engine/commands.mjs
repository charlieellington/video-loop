// commands.mjs — what each `video-loop <command>` does, in the order a video is made.
// Plain English: init → doctor → ingest (inventory, narration, optional cleanup choice, transcript)
// → the agent writes the edit plan → board → (music generate) → approve → preview → review and
// feedback → revise → … → finish. Each command says what happened and what comes next. Waiting for
// a person or the agent exits with code 2, a missing/stale approval with 3, a real failure with 1.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { TOOL_ROOT } from "./config.mjs";
import { loadProject, preparePlan, bindingFor } from "./plan.mjs";
import { currentRevision, nextRevision } from "./state.mjs";
import { inventory } from "./inventory.mjs";
import { prepareOriginal, selectedNarration } from "./narration.mjs";
import { ensureTranscript } from "./transcribe.mjs";
import { voiceClean, voiceSelect } from "./cleanup.mjs";
import { generateMusic, musicForRender } from "./music.mjs";
import { boardData } from "./board.mjs";
import { reviewHtml } from "./review-page.mjs";
import { render } from "./pipeline.mjs";
import { runDoctor } from "./doctor.mjs";
import { startReviewServer } from "./server.mjs";
import { ensureDir, writeJson, writeAtomic, readJsonOpt, Failure, Pending, log, tc } from "./util.mjs";

export async function cmdInit(folder, opts) {
  if (!folder) throw new Failure("usage: video-loop init <new-project-folder> [--profile bene|charlie] [--narration <file>] [--title <text>]");
  const dir = resolve(folder); const file = join(dir, "project.toml");
  if (existsSync(file)) throw new Failure(`${file} already exists — not overwriting it`);
  ensureDir(join(dir, "media"));
  let t = readFileSync(join(TOOL_ROOT, "templates", "project.toml"), "utf8");
  const profile = opts.profile ?? "bene";
  t = t.replace('profile = "bene"', `profile = "${profile}"`).replace('title = "My video"', `title = ${JSON.stringify(opts.title ?? basename(dir))}`);
  if (opts.narration) t = t.replace('source = "media/narration.m4a"', `source = ${JSON.stringify(opts.narration)}`);
  if (profile === "charlie") t = t.replace('kind = "recorded-audio"', 'kind = "recorded-video"').replace('source = "media/narration.m4a"', opts.narration ? `source = ${JSON.stringify(opts.narration)}` : 'source = "media/talking-head.mp4"');
  writeFileSync(file, t);
  log(`CREATED ${file}\n  put your narration and b-roll in ${join(dir, "media")}, check project.toml, then:\n  video-loop doctor ${folder}\n  video-loop ingest ${folder}`);
}

export async function cmdDoctor(folder) {
  const ctx = folder ? loadProject(folder) : null;
  const rows = await runDoctor(ctx);
  for (const r of rows) log(`${r.status === "ok" ? " ok " : r.status === "warn" ? "warn" : "FAIL"}  ${r.what.padEnd(28)} ${r.detail}`);
  const fails = rows.filter((r) => r.status === "fail");
  if (fails.length) throw new Failure(`${fails.length} required check(s) failed — see docs/setup.md`);
  log("DOCTOR OK — the base video path works on this machine" + (rows.some((r) => r.status === "warn") ? " (warnings are optional features)" : ""));
}

export async function cmdIngest(folder, opts) {
  const ctx = loadProject(folder, opts);
  const orig = await prepareOriginal(ctx);
  await inventory({ paths: ctx.paths, statePaths: ctx.sp, narrationFiles: orig.sources.map((s) => s.file) });
  const narr = selectedNarration(ctx);   // Pending here when cleanup is on and no version is chosen yet
  const { words, provenance } = await ensureTranscript(ctx, narr, opts);
  const rev = currentRevision(ctx.sp.root);
  const txt = join(ensureDir(ctx.paths.output), "transcript.txt");
  writeFileSync(txt, `# ${ctx.cfg.project.title} — ${narr.which} narration · language ${provenance.language} · ${words.length} words\n# transcript_sha256 ${provenance.transcript_sha256}\n# word  start–end (s)  text\n${words.map((w) => `${String(w.i).padStart(4)}  ${(w.start_ms / 1000).toFixed(2)}–${(w.end_ms / 1000).toFixed(2)}  ${w.text}`).join("\n")}\n`);
  log(`WORDS: ${relative(ctx.paths.project, txt)} (${words.length} words, transcript_sha256 ${provenance.transcript_sha256.slice(0, 16)}…)`);
  if (!existsSync(rev.edit)) throw new Pending(`ingest done — revision ${rev.id} needs its edit plan`, [`agent: follow prompts/editorial-plan.md and write ${relative(ctx.paths.project, rev.edit)}`, `then: video-loop board ${folder}`]);
  log(`INGEST OK — ${rev.id} already has an edit plan; next: video-loop board ${folder}`);
}

async function writeBoard(ctx, plan) {
  const outDir = ensureDir(join(ctx.paths.output, plan.rev.id));
  const d = boardData(ctx, plan, outDir); writeJson(plan.rev.board, d);
  const approved = !!readJsonOpt(plan.rev.approval);
  const pm = readJsonOpt(plan.rev.previewManifest);
  const preview = pm && existsSync(pm.files.video) ? { src: "preview.mp4", name: `${plan.rev.id}/preview.mp4`, features: pm.features.join(" · ") } : null;
  writeAtomic(join(outDir, "review.html"), reviewHtml(d, { preview, approved }));
  return { d, page: join(outDir, "review.html") };
}

export async function cmdBoard(folder, opts) {
  const ctx = loadProject(folder, opts); const plan = await preparePlan(ctx);
  const { d, page } = await writeBoard(ctx, plan);
  log(`BOARD ${plan.rev.id}: ${d.cards.length} shot(s), ${tc(plan.tl.total)} · ${relative(ctx.paths.project, page)}`);
  for (const n of plan.notes) log(`  note  ${n}`);
  if (plan.problems.length) throw new Pending(`the board has ${plan.problems.length} problem(s) to fix:\n  - ${plan.problems.join("\n  - ")}`, ["fix edit.json, then run board again"]);
  const next = [`look at it: video-loop review ${folder}`];
  if (ctx.cfg.music.source === "elevenlabs") { try { await musicForRender(ctx, plan.tl.total); } catch (e) { if (e instanceof Pending) next.push(`once the music brief is agreed: video-loop music generate ${folder}`); else throw e; } }
  next.push(`when the user approves: video-loop approve ${folder}`);
  log(`NEXT:\n  - ${next.join("\n  - ")}`);
}

export async function cmdApprove(folder, opts) {
  const ctx = loadProject(folder, opts); const plan = await preparePlan(ctx);
  if (plan.problems.length) throw new Failure(`cannot approve: the board has problems:\n  - ${plan.problems.join("\n  - ")}`);
  await musicForRender(ctx, plan.tl.total);   // the music track must exist before it can be approved
  const binding = await bindingFor(ctx, plan);
  writeJson(plan.rev.approval, { revision: plan.rev.id, binding, approved_at: new Date().toISOString(), note: opts.note ?? "approved by the user (recorded by their agent)" });
  await writeBoard(ctx, plan);
  log(`APPROVED ${plan.rev.id} — bound to the narration, transcript, edit plan, settings, music and media as they are now.\nNEXT: video-loop preview ${folder}`);
}

export const cmdPreview = async (folder, opts) => { const ctx = loadProject(folder, opts); await render(ctx, { keepTemp: !!opts["keep-temp"] }); log(`NEXT: video-loop review ${folder}  (watch, leave notes)`); };
export const cmdFinish = async (folder, opts) => { const ctx = loadProject(folder, opts); const r = await render(ctx, { master: true, keepTemp: !!opts["keep-temp"] }); log(`FINISHED ${r.manifest.revision}: ${r.file}\n  nothing was uploaded or published.`); };

export async function cmdReview(folder, opts) {
  const ctx = loadProject(folder, opts);
  const rev = currentRevision(ctx.sp.root, { create: false });
  if (!rev || !existsSync(join(ctx.paths.output, rev.id, "review.html"))) throw new Pending("there is no board yet", [`video-loop board ${folder}`]);
  const { url, server } = await startReviewServer({ projectDir: ctx.paths.project, stateDir: ctx.sp.root, outputDir: ctx.paths.output, port: Number(opts.port ?? ctx.cfg.review.port) });
  log(`REVIEW: ${url}  (this computer only · Ctrl-C to stop)`);
  if (opts.open) { const { spawn } = await import("node:child_process"); spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref(); }
  if (opts["exit-after"]) setTimeout(() => server.close(), Number(opts["exit-after"]) * 1000);
  await new Promise((r) => server.on("close", r));
}

export async function cmdVoice(sub, folder, opts) {
  const ctx = loadProject(folder, opts);
  if (sub === "clean") return voiceClean(ctx, { retry: !!opts.retry, envFile: opts["env-file"] });
  if (sub === "select") { await voiceSelect(ctx, opts._[0]); log(`NEXT: video-loop ingest ${folder}`); return; }
  throw new Failure("usage: video-loop voice clean <project> | video-loop voice select <project> original|cleaned");
}

export async function cmdMusic(sub, folder, opts) {
  if (sub !== "generate") throw new Failure("usage: video-loop music generate <project> [--regenerate] [--retry]");
  const ctx = loadProject(folder, opts); const plan = await preparePlan(ctx);
  await generateMusic(ctx, { filmMs: plan.tl.total, retry: !!opts.retry, regenerate: !!opts.regenerate, envFile: opts["env-file"] });
  log(`NEXT: listen in the review page, then video-loop approve ${folder}`);
}

export async function cmdRevise(folder, opts) {
  const ctx = loadProject(folder, opts); const cur = currentRevision(ctx.sp.root, { create: false });
  let notes = null;
  if (opts.notes) notes = JSON.parse(readFileSync(resolve(opts.notes), "utf8"));
  else if (cur && existsSync(cur.feedbackDir)) {
    const saved = readdirSync(cur.feedbackDir).filter((f) => f.startsWith("feedback-")).sort();
    if (saved.length) notes = readJsonOpt(join(cur.feedbackDir, saved.at(-1)));
  }
  const { prev, next } = nextRevision(ctx.sp.root, { notes });
  writeAtomic(next.changes, `# Changes in ${next.id} (from ${prev.id})\n\nFeedback received:\n${(notes?.notes ?? []).map((n) => `- ${n.timecode} ${n.text}`).join("\n") || "- (none filed — feedback arrived in chat)"}\n\nChanges made (agent fills this in):\n- \n`);
  log(`REVISION ${next.id} started from ${prev.id} (${prev.id} and its renders are kept).`);
  if (notes?.notes?.length) log(`FEEDBACK:\n${notes.notes.map((n) => `  ${n.timecode}  ${n.text}`).join("\n")}`);
  throw new Pending(`${next.id} is open for changes`, [`agent: apply the feedback to ${relative(ctx.paths.project, next.edit)} and/or project.toml, record it in ${relative(ctx.paths.project, next.changes)} (prompts/feedback-revision.md)`, `then: video-loop board ${folder} → approve → preview`]);
}

export async function cmdExample(dest, opts) {
  const target = resolve(dest ?? "video-loop-example");
  if (existsSync(join(target, "project.toml")) && !opts.force) throw new Failure(`${target} already has a project — choose another folder or pass --force`);
  mkdirSync(target, { recursive: true });
  cpSync(join(TOOL_ROOT, "examples", "fictional-book"), target, { recursive: true, filter: (s) => !/[/\\](\.video-loop|output)([/\\]|$)/.test(s) });
  log(`EXAMPLE copied to ${target} — running it offline (no API key needed)…`);
  await cmdIngest(target, { ...opts, _: [] }).catch((e) => { if (!(e instanceof Pending)) throw e; });
  const rev = currentRevision(join(target, ".video-loop"));
  if (!existsSync(rev.edit)) cpSync(join(target, "plan", "edit.json"), rev.edit);
  await cmdBoard(target, opts);
  await cmdApprove(target, { ...opts, note: "the example approves its own included plan" });
  await cmdPreview(target, opts);
  log(`EXAMPLE DONE — open ${join(target, "output", rev.id, "review.html")} or run: video-loop review ${target}`);
}

