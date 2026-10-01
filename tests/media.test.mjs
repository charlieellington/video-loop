// media.test.mjs — checks that need real (tiny, synthetic) media: placeholder detection, b-roll
// sound placement, and the review server's range/traversal/feedback handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ff, ROOT } from "./helpers.mjs";
import { placeholderFrames } from "../engine/evidence.mjs";
import { ambienceStem } from "../engine/covers.mjs";
import { probeMedia } from "../engine/probe.mjs";
import { defaults } from "../engine/schema.mjs";
import { pcmFloat } from "../engine/util.mjs";
import { startReviewServer } from "../engine/server.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "vl-media-"));

test("evidence: frames showing the internal placeholder are found; normal pictures are not", () => {
  const d = tmp(); const f = join(d, "p.mp4");
  ff("-f", "lavfi", "-i", "color=c=0x3a6ea5:s=180x320:r=30:d=1", "-f", "lavfi", "-i", "color=c=0xFF00FF:s=180x320:r=30:d=0.5", "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-pix_fmt", "yuv420p", f);
  const hits = placeholderFrames(f);
  assert.ok(hits.length >= 12 && hits.every((h) => h.t_s >= 0.95), `found ${hits.length}`);
});

test("b-roll sound: a kept clip's sound lands only inside its window (regression: atrim after adelay)", () => {
  const d = tmp(); const clip = join(ROOT, "examples", "fictional-book", "media", "clips", "sketching.mp4");
  const cfg = defaults(); const resolved = [{ cover: { media: "x", sound: "keep", start_s: 2 }, file: clip, media: probeMedia(clip) }];
  const out = join(d, "amb.wav");
  ambienceStem({ windows: [{ cover: 0, ws: 12027, we: 13734, local_ms: 0 }, { cover: 0, ws: 13734, we: 15307, local_ms: 1707 }], resolved, cfg, cutDurMs: 23820, voiceLufs: -14, out });
  const x = pcmFloat(out, { rate: 8000 }); const rms = (a, b) => { let s = 0; for (let i = a * 8; i < b * 8; i++) s += x[i] * x[i]; return Math.sqrt(s / ((b - a) * 8)); };
  assert.ok(rms(0, 11900) < 1e-4, "silent before its window"); assert.ok(rms(12300, 15000) > 1e-3, "audible inside it"); assert.ok(rms(15400, 23800) < 1e-4, "silent after it");
});

test("review server: ranges, no escape from the project, feedback saved only for a real revision", async () => {
  const p = tmp(); mkdirSync(join(p, "output", "r001"), { recursive: true }); mkdirSync(join(p, ".video-loop", "revisions", "r001"), { recursive: true });
  writeFileSync(join(p, ".video-loop", "state.json"), JSON.stringify({ current: "r001" })); writeFileSync(join(p, "output", "r001", "review.html"), "<p>hi</p>");
  writeFileSync(join(p, "output", "r001", "v.mp4"), Buffer.alloc(5000, 7)); writeFileSync(join(p, ".env"), "ELEVENLABS_API_KEY=secret");
  const { server, url } = await startReviewServer({ projectDir: p, stateDir: join(p, ".video-loop"), outputDir: join(p, "output") });
  try {
    const r = await fetch(`${url}output/r001/v.mp4`, { headers: { range: "bytes=10-19" } });
    assert.equal(r.status, 206); assert.equal(r.headers.get("content-range"), "bytes 10-19/5000"); assert.equal((await r.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${url}.env`)).status, 403);
    assert.notEqual((await fetch(`${url}%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status, 200);
    const home = await fetch(url, { redirect: "manual" }); assert.equal(home.headers.get("location"), "/output/r001/review.html");
    const bad = await fetch(`${url}api/feedback`, { method: "POST", body: JSON.stringify({ contract: "video-loop/feedback@1", revision: "r009", notes: [] }) }); assert.equal(bad.status, 400);
    const ok = await fetch(`${url}api/feedback`, { method: "POST", body: JSON.stringify({ contract: "video-loop/feedback@1", revision: "r001", notes: [{ t_ms: 1000, timecode: "0:01.0", text: "louder" }] }) });
    assert.equal(ok.status, 200); assert.equal(readdirSync(join(p, ".video-loop", "revisions", "r001", "feedback")).length, 1);
  } finally { server.close(); }
});
