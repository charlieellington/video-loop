// util.mjs — small shared helpers: running FFmpeg, hashing files, writing files safely.
// Plain English: every other part of the engine needs to run ffmpeg, fingerprint a file, or save
// a JSON record without leaving a half-written file behind if something crashes. Those jobs live
// here once, so there is exactly one copy of each rule.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** A step that is waiting for the user or the agent (not a failure). Exit code 2. */
export class Pending extends Error {
  constructor(message, next = []) { super(message); this.exitCode = 2; this.next = next; }
}
/** The plan has not been approved, or the approval no longer matches. Exit code 3. */
export class NeedsApproval extends Error {
  constructor(message, next = []) { super(message); this.exitCode = 3; this.next = next; }
}
/** Something went wrong. Exit code 1. */
export class Failure extends Error {
  constructor(message, next = []) { super(message); this.exitCode = 1; this.next = next; }
}

export const FFMPEG = process.env.VIDEO_LOOP_FFMPEG || "ffmpeg";
export const FFPROBE = process.env.VIDEO_LOOP_FFPROBE || "ffprobe";

/** Run ffmpeg quietly; throw a Failure carrying ffmpeg's own error text. */
export function ffmpeg(args, { quiet = true, cwd } = {}) {
  const r = spawnSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", quiet ? "error" : "info", ...args],
    { encoding: "utf8", maxBuffer: 1 << 26, cwd });
  if (r.error) throw new Failure(`could not run ffmpeg (${FFMPEG}): ${r.error.message}`, ["video-loop doctor"]);
  if (r.status !== 0) throw new Failure(`ffmpeg failed: ${(r.stderr || "").trim().split("\n").slice(-6).join("\n")}`);
  return r;
}
/** Run ffmpeg and return its stderr (for filters such as loudnorm/astats that report there). */
export function ffmpegStderr(args) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 1 << 27 });
  if (r.error) throw new Failure(`could not run ffmpeg (${FFMPEG}): ${r.error.message}`);
  return `${r.stderr ?? ""}${r.stdout ?? ""}`;
}
/** Decode raw samples (mono float32) for analysis. */
export function pcmFloat(file, { rate = 16000, start = 0, dur = null } = {}) {
  const args = ["-v", "error", ...(start ? ["-ss", String(start)] : []), "-i", file,
    ...(dur != null ? ["-t", String(dur)] : []), "-map", "0:a:0", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"];
  const buf = execFileSync(FFMPEG, args, { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

/** sha256 of a file's bytes (streamed, so a large video does not fill memory). */
export async function sha256File(path) {
  const h = createHash("sha256");
  await new Promise((res, rej) => createReadStream(path).on("data", (d) => h.update(d)).on("end", res).on("error", rej));
  return h.digest("hex");
}
/** Synchronous sha256 for small files. */
export function sha256FileSync(path) {
  const h = createHash("sha256"); const fd = openSync(path, "r"); const buf = Buffer.alloc(1 << 20);
  try { let n; while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest("hex");
}
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
/** Stable JSON (sorted keys) so the same content always hashes the same. */
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Write a file atomically: write a sibling temp file, then rename over the target. */
export function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
export const writeJson = (path, obj) => writeAtomic(path, `${JSON.stringify(obj, null, 1)}\n`);
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const readJsonOpt = (path) => (existsSync(path) ? readJson(path) : null);
export const ensureDir = (p) => { mkdirSync(p, { recursive: true }); return p; };
export const rmrf = (p) => rmSync(p, { recursive: true, force: true });
export const fileSize = (p) => statSync(p).size;

/** A per-run scratch directory inside the project (never a shared /tmp path). */
export function scratchDir(stateDir, label) {
  return ensureDir(join(stateDir, "tmp", `${label}-${process.pid}-${Date.now()}`));
}

/** Seconds with millisecond precision, for ffmpeg arguments. Input is integer milliseconds. */
export const sec = (ms) => (ms / 1000).toFixed(3);

/** Timecode for people: 0:12.3 */
export const tc = (ms) => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };

export const log = (...a) => console.log(...a);
