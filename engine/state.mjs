// state.mjs — where a project keeps its working records, and how revisions are numbered.
// Plain English: each video project has a hidden ".video-loop" folder next to its project.toml.
// It holds the media inventory, the decoded narration, the transcript, cached music and one
// folder per revision (r001, r002, …) with that revision's edit plan, board, approval, feedback
// and render records. Nothing here is shared between projects, and the user's original media
// files are never written to.

import { existsSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJsonOpt, writeJson, Failure } from "./util.mjs";

export function statePaths(stateDir) {
  return {
    root: stateDir,
    sources: join(stateDir, "sources.json"),
    narrationDir: join(stateDir, "narration"),
    original: join(stateDir, "narration", "original.json"),
    selection: join(stateDir, "narration", "selection.json"),
    cleanupDir: join(stateDir, "narration", "cleanup"),
    transcriptDir: join(stateDir, "transcript"),
    words: join(stateDir, "transcript", "words.json"),
    transcriptRaw: join(stateDir, "transcript", "provider-response.json"),
    provenance: join(stateDir, "transcript", "provenance.json"),
    cache: join(stateDir, "cache"),
    musicCache: join(stateDir, "cache", "music"),
    music: join(stateDir, "music.json"),
    revisions: join(stateDir, "revisions"),
    pointer: join(stateDir, "state.json"),
  };
}

const revName = (n) => `r${String(n).padStart(3, "0")}`;

export function listRevisions(stateDir) {
  const d = join(stateDir, "revisions");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((x) => /^r\d{3}$/.test(x)).sort();
}

/** The current revision's id and folder; creates r001 the first time. */
export function currentRevision(stateDir, { create = true } = {}) {
  const sp = statePaths(stateDir);
  const ptr = readJsonOpt(sp.pointer);
  let id = ptr?.current;
  if (!id) {
    if (!create) return null;
    id = revName(1);
    ensureDir(join(sp.revisions, id));
    writeJson(sp.pointer, { current: id });
  }
  return revisionPaths(stateDir, id);
}

export function revisionPaths(stateDir, id) {
  const dir = join(stateDir, "revisions", id);
  return {
    id, dir,
    edit: join(dir, "edit.json"),
    cuts: join(dir, "cuts.json"),
    timeline: join(dir, "timeline.json"),
    board: join(dir, "board.json"),
    approval: join(dir, "approval.json"),
    config: join(dir, "effective-config.json"),
    feedbackDir: join(dir, "feedback"),
    changes: join(dir, "changes.md"),
    previewManifest: join(dir, "preview-manifest.json"),
    masterManifest: join(dir, "master-manifest.json"),
  };
}

/**
 * Start the next revision: copy the edit plan forward, file the feedback that prompted it, and
 * leave every earlier revision (and its renders) untouched so it stays recoverable.
 */
export function nextRevision(stateDir, { notes = null } = {}) {
  const cur = currentRevision(stateDir, { create: false });
  if (!cur) throw new Failure("this project has no revision yet — run ingest and write the first edit plan");
  const n = Number(cur.id.slice(1)) + 1;
  const next = revisionPaths(stateDir, revName(n));
  if (existsSync(next.dir)) throw new Failure(`${next.id} already exists`);
  ensureDir(next.feedbackDir);
  if (existsSync(cur.edit)) copyFileSync(cur.edit, next.edit);
  if (notes) writeJson(join(next.feedbackDir, "incoming.json"), notes);
  writeJson(statePaths(stateDir).pointer, { current: next.id, previous: cur.id });
  return { prev: cur, next };
}
