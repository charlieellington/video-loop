// helpers.mjs — shared test fixtures: temp projects, synthetic audio, and a fake ElevenLabs.
// Plain English: tests must never call the real (paid) service. This starts a tiny local server
// that behaves like ElevenLabs in whichever way a test needs — good audio, an error, a stall, a
// reply that is not audio — so every failure path can be checked for free and offline.
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIX = join(ROOT, "tests", "fixtures");
export const CLI = join(ROOT, "bin", "video-loop.mjs");
export const ff = (...a) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...a]);

export function tempProject(toml, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vl test ü-"));   // space + non-ASCII on purpose
  mkdirSync(join(dir, "media"), { recursive: true });
  writeFileSync(join(dir, "project.toml"), `schema_version = 1\n${toml}`);
  for (const [rel, src] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), readFileSync(src)); }
  return dir;
}

/** Run the CLI in a child process (async, so an in-process fake server can answer); returns {code, out}. */
export function cli(args, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ELEVENLABS_API_KEY: "", ...env } });
    let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => ok({ code, out }));
  });
}

/** A fake ElevenLabs. handler(req, body) => {status, type, body, delayMs}. Records requests. */
export async function fakeElevenLabs(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = []; req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const body = Buffer.concat(chunks); seen.push({ path: req.url, key: req.headers["xi-api-key"], bytes: body.length, body });
      const r = await handler(req, body);
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (r.hang) return;   // never answers: the client must time out
      res.writeHead(r.status ?? 200, { "content-type": r.type ?? "application/json", ...(r.headers ?? {}) }); res.end(r.body ?? "");
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections?.(); server.close(); } };
}
