// core.test.mjs — the arithmetic and contracts everything else trusts (no media, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCuts } from "../engine/resolve.mjs";
import { buildTimeline, coverWindows } from "../engine/timeline.mjs";
import { phrases, assEscape, writeCaptions } from "../engine/captions.mjs";
import { checkLayer, checkCombinations, defaults } from "../engine/schema.mjs";
import { transcriptHash, normaliseWords, validateWords } from "../engine/transcribe.mjs";
import { musicRequest, MUSIC_MAX_MS } from "../engine/music.mjs";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const W = (list) => list.map(([text, s, e], i) => ({ i, text, start_ms: s, end_ms: e }));
const words = W([["Hello", 100, 400], ["um", 500, 600], ["world.", 700, 1100], ["Second", 1600, 1900], ["line", 1950, 2300], ["here.", 2350, 2800]]);
const sha = transcriptHash(words);

test("resolve: integer ms, handles clamp to neighbours, filler pre-handle suppressed only in English", () => {
  const edit = { transcript_sha256: sha, segments: [{ first_word_i: 0, last_word_i: 0 }, { first_word_i: 2, last_word_i: 5 }] };
  const en = resolveCuts(words, edit, { transcriptSha: sha, mediaDurMs: 3000, language: "eng" });
  assert.deepEqual(en.segments.map((s) => [s.in_ms, s.out_ms]), [[40, 500], [700, 2920]]);
  assert.equal(en.segments[1].pre_handle_suppressed, "um");
  const nl = resolveCuts(words, edit, { transcriptSha: sha, mediaDurMs: 3000, language: "nld" });
  assert.equal(nl.segments[1].in_ms, 640, "Dutch speech: the English filler rule does not apply");
  assert.ok(Number.isInteger(en.expected_duration_ms));
});

test("resolve: refuses an edit written for another transcript (timings count, not just text)", () => {
  const moved = words.map((w) => ({ ...w })); moved[3].start_ms += 40;
  assert.notEqual(transcriptHash(moved), sha);
  assert.throws(() => resolveCuts(moved, { transcript_sha256: sha, segments: [{ first_word_i: 0, last_word_i: 5 }] }, { transcriptSha: transcriptHash(moved), mediaDurMs: 3000 }), /different transcript/);
});

test("resolve: merges touching segments, rejects overlaps and out-of-range words", () => {
  const r = resolveCuts(words, { transcript_sha256: sha, segments: [{ first_word_i: 0, last_word_i: 2 }, { first_word_i: 3, last_word_i: 5 }] }, { transcriptSha: sha, mediaDurMs: 3000 });
  assert.equal(r.segments.length, 1);
  assert.throws(() => resolveCuts(words, { transcript_sha256: sha, segments: [{ first_word_i: 2, last_word_i: 4 }, { first_word_i: 3, last_word_i: 5 }] }, { transcriptSha: sha, mediaDurMs: 3000 }), /overlaps/);
  assert.throws(() => resolveCuts(words, { transcript_sha256: sha, segments: [{ first_word_i: 0, last_word_i: 9 }] }, { transcriptSha: sha, mediaDurMs: 3000 }), /outside/);
});

test("timeline: hook and interlude offsets are applied exactly once", () => {
  const cuts = resolveCuts(words, { transcript_sha256: sha, segments: [{ first_word_i: 0, last_word_i: 5 }] }, { transcriptSha: sha, mediaDurMs: 3000 });
  const tl = buildTimeline(cuts, words, [{ kind: "hook", dur_ms: 2000 }, { kind: "interlude", after_word_i: 2, dur_ms: 3000 }]);
  const p0 = tl.wordPlace(0), p3 = tl.wordPlace(3);
  assert.equal(p0.start, p0.cut_start + 2000);
  assert.equal(p3.start, p3.cut_start + 5000);
  assert.equal(tl.total, cuts.expected_duration_ms + 5000);
  const lines = phrases(tl, words);
  assert.ok(lines.every((l) => !(l.words.some((w) => w.i <= 2) && l.words.some((w) => w.i >= 3))), "no phrase straddles the interlude");
});

test("cover windows: full cover reports real gaps; hold_until_next fills a pause deliberately", () => {
  const cuts = resolveCuts(words, { transcript_sha256: sha, segments: [{ first_word_i: 0, last_word_i: 5 }] }, { transcriptSha: sha, mediaDurMs: 3000 });
  const tl = buildTimeline(cuts, words, []);
  const covers = [{ over_words: [0, 2], media: "a" }, { over_words: [3, 5], media: "b" }];
  const gap = coverWindows(tl, words, covers, { fullCover: true, holdGapMs: 300 });
  assert.equal(gap.gaps.length, 1);
  const held = coverWindows(tl, words, [{ ...covers[0], hold_until_next: true }, covers[1]], { fullCover: true, holdGapMs: 300 });
  assert.equal(held.gaps.length, 0);
  assert.equal(held.windows[0].ws, 0); assert.equal(held.windows.at(-1).we, tl.cutDur);
});

test("captions: ASS escaping, typewriter layout stays identical across states, SRT is plain phrases", () => {
  assert.equal(assEscape("a{b}c\\N"), "a｛b｝c⧵N");
  const cuts = resolveCuts(words, { transcript_sha256: sha, segments: [{ first_word_i: 0, last_word_i: 5 }] }, { transcriptSha: sha, mediaDurMs: 3000 });
  const tl = buildTimeline(cuts, words, []);
  const cfg = defaults(); cfg.captions.preset = "typewriter-highlight";
  const dir = mkdtempSync(join(tmpdir(), "vl-cap-"));
  const r = writeCaptions({ tl, words, fixes: { 2: "wörld{x}." }, cfg, assPath: join(dir, "c.ass"), srtPath: join(dir, "c.srt") });
  const ass = readFileSync(join(dir, "c.ass"), "utf8"); const srt = readFileSync(join(dir, "c.srt"), "utf8");
  assert.ok(!/wörld\{x\}/.test(ass) && /wörld｛x｝/.test(ass), "user braces cannot open an override block");
  const visibleText = (line) => line.split(",,").slice(1).join(",,").replace(/\{[^}]*\}/g, "");
  const states = ass.split("\n").filter((l) => l.startsWith("Dialogue: 1"));
  const first = r.lines[0]; const st = states.filter((l) => visibleText(l) === visibleText(states[0]));
  assert.ok(st.length >= first.words.length, "every state of a phrase carries the same full text (no re-layout)");
  assert.match(ass, /\\3c&H000000&/); assert.match(srt, /wörld\{x\}\./); assert.ok(!/\\/.test(srt));
});

test("settings: unknown keys and bad combinations are refused, secrets never belong in TOML", () => {
  assert.match(checkLayer({ music: { volume: 3 } }, "x")[0], /unknown setting "music.volume"/);
  assert.match(checkLayer({ captions: { preset: "karaoke" } }, "x")[0], /must be one of/);
  const c = defaults(); c.narration.source = "a.m4a"; c.narration.kind = "recorded-audio"; c.editorial.full_cover = false;
  assert.ok(checkCombinations(c).some((p) => /full_cover must be true/.test(p)));
  c.editorial.full_cover = true; c.music.source = "elevenlabs";
  assert.ok(checkCombinations(c).some((p) => /music.prompt/.test(p)));
});

test("transcripts: provider words normalised to integer ms; bad timings rejected", () => {
  const n = normaliseWords({ words: [{ text: "Hoi", start: 0.1, end: 0.4, type: "word" }, { text: " ", type: "spacing", start: 0.4, end: 0.5 }, { text: "één", start: 0.5, end: 0.9, type: "word" }] });
  assert.deepEqual(n, [{ i: 0, text: "Hoi", start_ms: 100, end_ms: 400 }, { i: 1, text: "één", start_ms: 500, end_ms: 900 }]);
  assert.ok(validateWords([{ i: 0, text: "x", start_ms: 500, end_ms: 400 }], 1000).length);
  assert.ok(validateWords(n, 600).some((p) => /after the narration ends/.test(p)));
});

test("music requests: sized to the film plus a tail, bounded by the provider limits", () => {
  const cfg = defaults(); cfg.music.prompt = " soft piano "; const r = musicRequest(cfg, 23820);
  assert.deepEqual(r, { prompt: "soft piano", music_length_ms: 26000, model_id: "music_v1", force_instrumental: true });
  assert.ok(musicRequest(cfg, 700000).music_length_ms > MUSIC_MAX_MS);
});
