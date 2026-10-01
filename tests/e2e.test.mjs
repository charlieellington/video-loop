// e2e.test.mjs — the fictional example end to end, twice AT THE SAME TIME, from outside the repo,
// with no API key: proves the offline path, that two projects share no state or temp files, and
// that the user's original media is never modified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { cli } from "./helpers.mjs";

const hashes = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true }).filter((f) => /\.(mp4|png|m4a)$/.test(f)).map((f) => [f, createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")]));

test("two example projects render concurrently, offline, without touching their originals", { timeout: 300000 }, async () => {
  const a = join(mkdtempSync(join(tmpdir(), "vl e2e ä-")), "project one"), b = join(mkdtempSync(join(tmpdir(), "vl e2e ö-")), "project two");
  const [ra, rb] = await Promise.all([cli(["example", a]), cli(["example", b])]);
  assert.equal(ra.code, 0, ra.out); assert.equal(rb.code, 0, rb.out);
  for (const p of [a, b]) {
    const m = JSON.parse(readFileSync(join(p, "output", "r001", "preview-manifest.json"), "utf8"));
    assert.deepEqual(m.evidence.problems, []); assert.equal(m.evidence.facts.placeholder_frames, 0);
    assert.ok(Math.abs(m.evidence.facts.lufs + 14) <= 1);
    assert.ok(m.files.video.startsWith(p), "outputs stay inside their own project");
    assert.deepEqual(readdirSync(join(p, ".video-loop", "tmp")), [], "per-run scratch folders are cleaned up");
  }
  const before = hashes(join(a, "media")); await cli(["preview", a]); assert.deepEqual(hashes(join(a, "media")), before, "original media unchanged");
  const src = JSON.parse(readFileSync(join(a, ".video-loop", "sources.json"), "utf8")).files;
  for (const f of src) assert.equal(createHash("sha256").update(readFileSync(f.path)).digest("hex"), f.sha256, `${f.rel} unchanged since inventory`);
  assert.ok(!existsSync(join(a, ".env")));
});
