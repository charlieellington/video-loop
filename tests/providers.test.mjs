// providers.test.mjs — voice cleanup, transcription and music against a FAKE ElevenLabs.
// Every failure the plan names: missing key, missing permission, rate limit, timeout (and the
// refusal to silently resend a paid request), replies that are not audio, empty audio, misaligned
// or word-dropping cleanup, unsupported music length, cache reuse, and stale approvals when the
// chosen narration changes. These are fixture-backed checks, NOT live provider passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, cpSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tempProject, cli, fakeElevenLabs, ff, FIX, ROOT } from "./helpers.mjs";
import { generateMusic } from "../engine/music.mjs";
import { defaults } from "../engine/schema.mjs";

const EX = join(ROOT, "examples", "fictional-book");
const CLEAN = join(EX, "media", "narration.m4a");
const exWords = JSON.parse(readFileSync(join(EX, "plan", "transcript.json"), "utf8")).words;
const sttReply = JSON.stringify({ language_code: "eng", language_probability: 0.97, text: exWords.map((w) => w.text).join(" "), transcription_id: "fake-1",
  words: exWords.flatMap((w) => [{ text: w.text, start: w.start_ms / 1000, end: w.end_ms / 1000, type: "word" }, { text: " ", start: w.end_ms / 1000, end: w.end_ms / 1000, type: "spacing" }]) });
const variant = (name, af) => { const out = join(FIX, "..", `.tmp-${name}.m4a`); if (!existsSync(out)) ff("-i", CLEAN, "-af", af, "-c:a", "aac", out); return readFileSync(out); };
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const cleanupProject = () => tempProject(`[project]\nprofile = "bene"\n[narration]\nsource = "media/noisy narration.m4a"\n[voice_cleanup]\nsource = "elevenlabs"\n`, { "media/noisy narration.m4a": join(FIX, "noisy-narration.m4a") });
const env = (fake, extra = {}) => ({ ELEVENLABS_BASE_URL: fake.url, ELEVENLABS_API_KEY: "test-key", VIDEO_LOOP_TIMEOUT_MS: "1500", ...extra });

test("cleanup: no key → clear message, nothing sent, original untouched and still selectable", async () => {
  const p = cleanupProject(); const before = sha(join(p, "media", "noisy narration.m4a"));
  const r = await cli(["voice", "clean", p]);
  assert.equal(r.code, 1); assert.match(r.out, /needs an ElevenLabs API key/);
  assert.equal((await cli(["voice", "select", p, "original"])).code, 0);
  assert.equal(sha(join(p, "media", "noisy narration.m4a")), before);
});

test("cleanup: missing permission, rate limit, non-audio and empty replies fail clearly and resumably", async () => {
  const replies = [{ status: 401, body: JSON.stringify({ detail: { message: "The API key you used is missing the permission audio_isolation to execute this operation." } }) },
    { status: 429, body: JSON.stringify({ detail: { message: "too many concurrent requests" } }) }, { status: 200, type: "application/json", body: "{}" }, { status: 200, type: "audio/mpeg", body: "" }];
  let k = 0; const fake = await fakeElevenLabs(() => replies[k++]);
  try {
    const p = cleanupProject();
    const a = await cli(["voice", "clean", p], env(fake)); assert.equal(a.code, 1); assert.match(a.out, /lacks the "audio_isolation" permission/);
    const b = await cli(["voice", "clean", p], env(fake)); assert.equal(b.code, 1); assert.match(b.out, /rate limited/);
    const c = await cli(["voice", "clean", p], env(fake)); assert.equal(c.code, 1); assert.match(c.out, /not audio/);
    const d = await cli(["voice", "clean", p], env(fake)); assert.equal(d.code, 1); assert.match(d.out, /empty reply/);
    assert.match((await cli(["voice", "select", p, "cleaned"])).out, /no cleaned version|failed its checks/);
    assert.equal(fake.seen.length, 4); assert.equal(fake.seen[0].key, "test-key");
  } finally { fake.close(); }
});

test("cleanup: an ambiguous timeout is never silently resent; --retry sends it deliberately", async () => {
  let k = 0; const fake = await fakeElevenLabs(() => (k++ === 0 ? { hang: true } : { status: 200, type: "audio/mpeg", body: readFileSync(CLEAN) }));
  try {
    const p = cleanupProject();
    const a = await cli(["voice", "clean", p], env(fake)); assert.equal(a.code, 1); assert.match(a.out, /timeout/);
    const b = await cli(["voice", "clean", p], env(fake)); assert.equal(b.code, 1); assert.match(b.out, /may or may not have been charged/);
    assert.equal(fake.seen.length, 1, "no automatic resubmission");
    const c = await cli(["voice", "clean", p, "--retry"], env(fake)); assert.equal(c.code, 2); assert.match(c.out, /cleaned narration ready/);
  } finally { fake.close(); }
});

test("cleanup: shifted, drifting or word-dropping output is refused; the original stays usable", async () => {
  const outs = { shifted: variant("shifted", "adelay=400:all=1"), drift: variant("drift", "atempo=0.97"), muted: variant("muted", "volume=enable='between(t,6.5,12)':volume=0") };
  for (const [name, body] of Object.entries(outs)) {
    const fake = await fakeElevenLabs(() => ({ status: 200, type: "audio/mpeg", body }));
    try {
      const p = cleanupProject(); const r = await cli(["voice", "clean", p], env(fake));
      assert.equal(r.code, 1, name); assert.match(r.out, { shifted: /shifted by/, drift: /drifts by|length differs/, muted: /speech frames/ }[name]);
      assert.match(r.out, /voice select .* original/);
      assert.equal((await cli(["voice", "select", p, "cleaned"])).code, 1);
    } finally { fake.close(); }
  }
});

test("cleanup → choose → transcribe; cached cleanup is reused; switching narration invalidates the approval", async () => {
  const seen = { iso: 0, stt: 0 };
  const fake = await fakeElevenLabs((req) => req.url.startsWith("/v1/audio-isolation") ? (seen.iso++, { status: 200, type: "audio/mpeg", body: readFileSync(CLEAN) }) : (seen.stt++, { status: 200, body: sttReply }));
  try {
    const p = cleanupProject(); cpSync(join(EX, "media"), join(p, "media"), { recursive: true });
    assert.equal((await cli(["ingest", p], env(fake))).code, 2);
    const c = await cli(["voice", "clean", p], env(fake)); assert.equal(c.code, 2); assert.match(c.out, /background .* dB/);
    const page = readFileSync(join(p, "output", "voice-compare.html"), "utf8"); assert.equal((page.match(/<audio /g) ?? []).length, 2);
    assert.equal((await cli(["voice", "select", p, "cleaned"])).code, 0);
    const i = await cli(["ingest", p], env(fake)); assert.equal(i.code, 2); assert.match(i.out, /needs its edit plan/);
    const prov = JSON.parse(readFileSync(join(p, ".video-loop", "transcript", "provenance.json"), "utf8")); assert.equal(prov.narration, "cleaned");
    mkdirSync(join(p, ".video-loop", "revisions", "r001"), { recursive: true }); copyFileSync(join(EX, "plan", "edit.json"), join(p, ".video-loop", "revisions", "r001", "edit.json"));
    assert.equal((await cli(["board", p])).code, 0); assert.equal((await cli(["approve", p])).code, 0);
    assert.equal((await cli(["voice", "clean", p], env(fake))).code, 2); assert.equal(seen.iso, 1, "cleanup cached by content — no second request");
    assert.equal((await cli(["voice", "select", p, "original"])).code, 0);
    assert.equal((await cli(["preview", p])).code, 2, "no transcript for the newly chosen narration yet");
    await cli(["ingest", p], env(fake)); assert.equal(seen.stt, 2, "the new narration is transcribed again");
    const pv = await cli(["preview", p]); assert.equal(pv.code, 3); assert.match(pv.out, /narration recording or its selected version/);
  } finally { fake.close(); }
});

test("narration input checks: too short, silent, and no audio stream", async () => {
  const short = tempProject(`[narration]\nsource = "media/a.wav"\n[editorial]\nfull_cover = true\n`); ff("-f", "lavfi", "-i", "sine=d=0.5", join(short, "media", "a.wav"));
  assert.match((await cli(["ingest", short])).out, /too short/);
  const silent = tempProject(`[narration]\nsource = "media/a.wav"\n[editorial]\nfull_cover = true\n`); ff("-f", "lavfi", "-i", "anullsrc=d=3", "-t", "3", join(silent, "media", "a.wav"));
  assert.match((await cli(["ingest", silent])).out, /silent/);
  const pic = tempProject(`[narration]\nsource = "media/a.png"\n[editorial]\nfull_cover = true\n`); ff("-f", "lavfi", "-i", "color=d=1", "-frames:v", "1", join(pic, "media", "a.png"));
  assert.match((await cli(["ingest", pic])).out, /no audio stream/);
});

test("music: unsupported length is refused before any request; non-audio reply fails; a generated track is reused", async () => {
  const cfg = defaults(); cfg.music.source = "elevenlabs"; cfg.music.prompt = "soft piano";
  const ctx = { cfg, paths: { project: "/nonexistent" }, sp: { musicCache: "/nonexistent/x", music: "/nonexistent/m.json" } };
  await assert.rejects(generateMusic(ctx, { filmMs: 700000 }), /3–600s/);
  let n = 0; const fake = await fakeElevenLabs(() => (n++ === 0 ? { status: 200, type: "text/html", body: "<html>oops</html>" } : { status: 200, type: "audio/mpeg", body: readFileSync(join(EX, "media", "demo-music-bed.m4a")), headers: { "song-id": "fake-song" } }));
  try {
    const p = tempProject(readFileSync(join(EX, "project.toml"), "utf8").replace(/^schema_version = 1\n/m, "").replace('source = "file"\nfile = "media/demo-music-bed.m4a"', 'source = "elevenlabs"\nprompt = "soft piano, no drums"'));
    cpSync(join(EX, "media"), join(p, "media"), { recursive: true }); cpSync(join(EX, "plan"), join(p, "plan"), { recursive: true });
    await cli(["ingest", p]); mkdirSync(join(p, ".video-loop", "revisions", "r001"), { recursive: true }); copyFileSync(join(EX, "plan", "edit.json"), join(p, ".video-loop", "revisions", "r001", "edit.json"));
    assert.equal((await cli(["approve", p])).code, 2, "cannot approve before the track exists");
    assert.match((await cli(["music", "generate", p], env(fake))).out, /not audio/);
    const g = await cli(["music", "generate", p], env(fake)); assert.equal(g.code, 0); assert.match(g.out, /song-id fake-song/);
    assert.match((await cli(["music", "generate", p], env(fake))).out, /reusing it \(no new request\)/);
    assert.equal(fake.seen.length, 2);
    const m = JSON.parse(readFileSync(join(p, ".video-loop", "music.json"), "utf8")); assert.equal(m.request.music_length_ms, 26000); assert.equal(m.ids["song-id"], "fake-song");
  } finally { fake.close(); }
});

test("music: HTTP 401 credit exhaustion names the funding issue; invalid keys still name authentication", async () => {
  let n = 0;
  const fake = await fakeElevenLabs(() => ({ status: 401, body: JSON.stringify({ detail: { message: n++ === 0
    ? "You have insufficient credits to generate this song. Please upgrade your plan to continue."
    : "Invalid API key" } }) }));
  try {
    const p = tempProject(readFileSync(join(EX, "project.toml"), "utf8").replace(/^schema_version = 1\n/m, "")
      .replace('source = "file"\nfile = "media/demo-music-bed.m4a"', 'source = "elevenlabs"\nprompt = "soft piano, no drums"'));
    cpSync(join(EX, "media"), join(p, "media"), { recursive: true });
    cpSync(join(EX, "plan"), join(p, "plan"), { recursive: true });
    await cli(["ingest", p]);
    copyFileSync(join(EX, "plan", "edit.json"), join(p, ".video-loop", "revisions", "r001", "edit.json"));
    const quota = await cli(["music", "generate", p], env(fake));
    assert.equal(quota.code, 1);
    assert.match(quota.out, /insufficient credits.*credit balance and key usage limit/s);
    assert.doesNotMatch(quota.out, /the API key was rejected/);
    assert.equal(fake.seen.length, 1, "a refusal is not automatically resent");
    const invalid = await cli(["music", "generate", p], env(fake));
    assert.equal(invalid.code, 1);
    assert.match(invalid.out, /the API key was rejected/);
  } finally { fake.close(); }
});
