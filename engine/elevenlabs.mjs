// elevenlabs.mjs — the one place that talks to ElevenLabs (voice cleanup, transcription, music).
// Plain English: finds the API key the user supplied, sends one request, and turns every way it
// can go wrong (no key, no access, too many requests, a timeout, a reply that is not audio) into a
// clear message. Paid requests leave a "pending" marker while they run: if the connection drops
// mid-request we cannot know whether ElevenLabs charged for it, so the tool refuses to quietly send
// it again — the user decides, with --retry.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Failure, writeJson, readJsonOpt } from "./util.mjs";

export const BASE_URL = () => (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/$/, "");
export const PRICING_URL = "https://elevenlabs.io/pricing/api";

/** Parse a .env file (KEY=value lines). Values are never logged. */
function readDotEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * The key, from (1) the process environment, (2) an --env-file the user named, or (3) the
 * project's own .env. Never from the home directory.
 */
export function findKey({ projectDir, envFile } = {}) {
  if (process.env.ELEVENLABS_API_KEY) return { key: process.env.ELEVENLABS_API_KEY, from: "environment" };
  for (const [p, label] of [[envFile, "--env-file"], [projectDir && join(projectDir, ".env"), "project .env"]]) {
    if (p && existsSync(p)) { const v = readDotEnv(p).ELEVENLABS_API_KEY; if (v && !v.startsWith("<")) return { key: v, from: label }; }
  }
  return null;
}

export function requireKey(opts, what) {
  const k = findKey(opts);
  if (!k) throw new Failure(`${what} needs an ElevenLabs API key, and none was found.`, [
    "set ELEVENLABS_API_KEY in your shell, or put ELEVENLABS_API_KEY=… in this project's .env (see .env.example)",
    `API access and usage are billed by ElevenLabs — current prices: ${PRICING_URL}`]);
  return k.key;
}

/** Refuse to resend a paid request whose previous attempt ended without a clear answer. */
export function beginPaid(markerPath, info, { retry = false } = {}) {
  const prev = readJsonOpt(markerPath);
  if (prev && !retry) throw new Failure(
    `a previous ${prev.what} request (started ${prev.started_at}) ended without a clear result — it may or may not have been charged.`,
    ["check your ElevenLabs usage/history page", "then run the same command with --retry to send it again, deliberately"]);
  writeJson(markerPath, { ...info, started_at: new Date().toISOString() });
}
export const endPaid = (markerPath) => rmSync(markerPath, { force: true });

/**
 * One request. Returns {status, headers, bytes, contentType, ids}.
 * A timeout throws with .ambiguous = true (the caller keeps the pending marker in place).
 */
export async function request({ key, path, form, json, query, timeoutMs = 180000, what }) {
  const url = new URL(BASE_URL() + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const headers = { "xi-api-key": key };
  let body;
  if (form) body = form;
  else if (json) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
  timeoutMs = Number(process.env.VIDEO_LOOP_TIMEOUT_MS) || timeoutMs;   // tests shorten it
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    const err = new Failure(e.name === "AbortError"
      ? `${what}: no answer from ElevenLabs within ${Math.round(timeoutMs / 1000)}s (timeout). The request may still have been processed.`
      : `${what}: could not reach ElevenLabs (${e.cause?.code ?? e.message}).`);
    err.ambiguous = e.name === "AbortError";
    throw err;
  }
  let bytes;
  try { bytes = Buffer.from(await res.arrayBuffer()); }
  catch (e) { clearTimeout(timer); const err = new Failure(`${what}: the reply was cut off (${e.name === "AbortError" ? "timeout" : e.message}).`); err.ambiguous = true; throw err; }
  clearTimeout(timer);
  const contentType = res.headers.get("content-type") ?? "";
  const ids = {};
  for (const [k, v] of res.headers) if (/(^|-)id$|request|history|song|generation|transcription/i.test(k)) ids[k] = v;
  if (!res.ok) throw new Failure(describeHttpError(what, res.status, bytes, contentType));
  return { status: res.status, headers: res.headers, bytes, contentType, ids };
}

function describeHttpError(what, status, bytes, contentType) {
  let detail = "";
  if (/json/.test(contentType)) {
    try { const j = JSON.parse(bytes.toString("utf8")); detail = j.detail?.message ?? j.detail?.status ?? (typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j)).slice(0, 300); } catch {}
  } else detail = bytes.toString("utf8").slice(0, 200);
  const perm = detail.match(/missing the permission (\w+)/i)?.[1];
  // The live Music endpoint can return HTTP 401 for exhausted credits too.
  // Its stated quota error takes precedence over the generic authentication hint.
  const credits = /insufficient credits|quota[_ -]exceeded|(?:out of|not enough) credits/i.test(detail);
  const hint = perm ? `this API key is valid but lacks the "${perm}" permission — enable it for the key in ElevenLabs (Developers → API keys), or use a key that has it`
    : credits ? "the account or key has insufficient credits — check your ElevenLabs credit balance and key usage limit, or use a funded key"
    : status === 401 ? "the API key was rejected — check ELEVENLABS_API_KEY"
    : status === 403 ? "this account or key does not have access to this feature (plan or key permissions)"
    : status === 402 ? "the account is out of credits or this feature needs a paid plan"
    : status === 429 ? "rate limited or too many concurrent requests — wait a minute and run the command again"
    : status === 422 || status === 400 ? "ElevenLabs rejected the request parameters"
    : status >= 500 ? "ElevenLabs had a server problem — try again later" : "unexpected reply";
  return `${what}: ElevenLabs answered HTTP ${status} — ${hint}${detail ? ` (${detail})` : ""}`;
}

/** Build a multipart form with one file. */
export function formWithFile(field, filePath, filename, fields = {}) {
  const fd = new FormData();
  fd.append(field, new Blob([readFileSync(filePath)]), filename);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, String(v));
  return fd;
}
