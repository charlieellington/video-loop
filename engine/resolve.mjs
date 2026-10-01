// resolve.mjs — turns the agent's word-index edit into exact millisecond in/out points.
// Plain English: the agent only says WHICH WORDS to keep ("words 0–20, then 31–58"). This looks up
// each word's clock time, pads the edges slightly so words are not clipped, refuses anything odd
// (out of order, overlapping, too short, outside the recording) and writes the cut list the renderer
// trusts. No model ever writes a timestamp. Extracted from the away-loop lab's laneA/resolve.mjs:
// integer-millisecond arithmetic, segment merging and take-boundary splitting are unchanged; the
// transcript binding now covers timings as well as text, and filler handling is language-aware.

import { Failure } from "./util.mjs";

const MIN_SEG_MS = 400;
// Fillers whose tail we refuse to give breathing room to (the pre-handle would reach back into the
// sound we just removed). Per language — never apply English rules to Dutch speech.
const FILLERS = {
  en: /^(uh|um|erm|ah|er|hmm|mm)[,.!?]*$/i,
  nl: /^(eh|ehm|uh|uhm|hm|hmm)[,.!?]*$/i,
};

/**
 * @param words  [{i,text,start_ms,end_ms}]
 * @param edit   {transcript_sha256, segments:[{first_word_i,last_word_i,reason}]}
 * @param opts   {transcriptSha, mediaDurMs, language, reel, preHandle, postHandle, fps (snap cuts to frames)}
 */
export function resolveCuts(words, edit, { transcriptSha, mediaDurMs, language = "", reel = null, preHandle = 60, postHandle = 120, fps = null }) {
  const fail = (m) => { throw new Failure(`edit plan problem: ${m}`, ["fix edit.json in the current revision, then run board again"]); };
  if (edit.transcript_sha256 !== transcriptSha) fail(
    `edit.json was written against a different transcript.\n  edit expects : ${edit.transcript_sha256}\n  transcript is: ${transcriptSha}\n  Word numbers no longer point at the same words (or the timings moved). Re-read the transcript and rewrite the segments.`);
  if (!Array.isArray(edit.segments) || !edit.segments.length) fail("no segments — list the words to keep");
  const filler = FILLERS[(language || "").slice(0, 2).toLowerCase()] ?? null;
  const wStart = words.map((w) => w.start_ms), wEnd = words.map((w) => w.end_ms);

  // merge segments that are not separated by a cut (continuous speech described in two pieces)
  const merged = [];
  for (const seg of edit.segments) {
    const prev = merged.at(-1);
    if (prev && prev.last_word_i + 1 === seg.first_word_i) { prev.last_word_i = seg.last_word_i; prev.reason = `${prev.reason} + ${seg.reason ?? ""}`.trim(); continue; }
    merged.push({ ...seg, reason: seg.reason ?? "" });
  }
  // a take boundary (black gap between reel takes) is always a cut
  if (reel?.takes?.length > 1) {
    const seps = reel.takes.slice(1).map((t) => ({ start: Math.round((t.reel_start_s - reel.separator_s) * 1000), end: Math.round(t.reel_start_s * 1000) }));
    const split = [];
    for (const seg of merged) {
      let a = seg.first_word_i;
      for (let i = seg.first_word_i; i < seg.last_word_i; i++) {
        if (seps.some((x) => x.start >= wEnd[i] && x.end <= wStart[i + 1])) { split.push({ ...seg, first_word_i: a, last_word_i: i, reason: `${seg.reason} [take boundary]` }); a = i + 1; }
      }
      split.push({ ...seg, first_word_i: a });
    }
    merged.splice(0, merged.length, ...split);
  }
  const out = [];
  merged.forEach((seg, k) => {
    const { first_word_i: a, last_word_i: b } = seg;
    if (!Number.isInteger(a) || !Number.isInteger(b)) fail(`segment ${k}: word numbers must be whole numbers`);
    if (a < 0 || b >= words.length) fail(`segment ${k}: words [${a},${b}] outside 0..${words.length - 1}`);
    if (a > b) fail(`segment ${k}: first_word_i ${a} > last_word_i ${b}`);
    if (k > 0 && a <= merged[k - 1].last_word_i) fail(`segment ${k}: overlaps or goes back before segment ${k - 1}`);
    const prevKept = k > 0 ? merged[k - 1].last_word_i : -1;
    const afterCutFiller = !!filler && a > 0 && a - 1 > prevKept && filler.test(words[a - 1].text);
    const inMs = Math.max(wStart[a] - (afterCutFiller ? 0 : preHandle), a > 0 ? wEnd[a - 1] : 0, 0);
    const outMs = Math.min(wEnd[b] + postHandle, b < words.length - 1 ? wStart[b + 1] : mediaDurMs, mediaDurMs);
    out.push({ in_ms: inMs, out_ms: outMs, first_word_i: a, last_word_i: b, reason: seg.reason, ...(afterCutFiller ? { pre_handle_suppressed: words[a - 1].text } : {}) });
  });
  out.forEach((s, k) => {
    if (s.in_ms >= s.out_ms) fail(`segment ${k}: in ${s.in_ms} >= out ${s.out_ms}`);
    if (s.out_ms - s.in_ms < MIN_SEG_MS) fail(`segment ${k}: ${s.out_ms - s.in_ms} ms is shorter than ${MIN_SEG_MS} ms`);
    if (s.in_ms < 0 || s.out_ms > mediaDurMs) fail(`segment ${k}: [${s.in_ms},${s.out_ms}] outside the recording 0..${mediaDurMs}`);
    if (k > 0 && s.in_ms < out[k - 1].out_ms) fail(`segment ${k}: starts before segment ${k - 1} ends`);
  });
  // Snap every cut to the picture's frame grid, so sound and picture are cut at the SAME instants.
  // (Picture trims can only start on a frame; cutting the sound between frames slid the two apart
  // by up to a frame per segment — measured 33–67 ms on the talking-head fixture.)
  if (fps) out.forEach((s) => {
    s.in_frame = Math.round(s.in_ms * fps / 1000); s.out_frame = Math.round(s.out_ms * fps / 1000);
    s.in_ms = Math.round(s.in_frame * 1000 / fps); s.out_ms = Math.min(Math.round(s.out_frame * 1000 / fps), mediaDurMs);
  });
  const expected = out.reduce((t, s) => t + (s.out_ms - s.in_ms), 0);
  return { transcript_sha256: transcriptSha, media_duration_ms: mediaDurMs, expected_duration_ms: expected, segments: out };
}
