// timeline.mjs — the ONE mapping from "a word in the recording" to "a moment in the finished video".
// Plain English: the narration is cut, b-roll is laid over it, and an opening hook or short music
// interludes may be slotted in. Captions, the subtitle file, the review page timecodes and the
// evidence checks must all agree about where every word lands. Earlier versions worked this out in
// several places and they drifted apart; now everything asks this file. Integer milliseconds only.

import { Failure } from "./util.mjs";

/**
 * Build the timeline.
 * @param cuts   resolveCuts() result
 * @param words  [{i,text,start_ms,end_ms}]
 * @param inserts [{kind:"hook"|"interlude", after_word_i?, dur_ms, ...}]  (hook goes first)
 */
export function buildTimeline(cuts, words, inserts = [], { fps = null } = {}) {
  const snap = (ms) => (fps ? Math.round(Math.round(ms * fps / 1000) * 1000 / fps) : ms);   // insert points sit on picture frames
  const segs = cuts.segments; const outStart = []; let acc = 0;
  segs.forEach((s) => { outStart.push(acc); acc += s.out_ms - s.in_ms; });
  const cutDur = acc;
  const segOf = (i) => segs.findIndex((s) => i >= s.first_word_i && i <= s.last_word_i);
  /** Cut-timeline position of the boundary just after word i (a segment's own out point when i ends it). */
  const afterWord = (i) => {
    const k = segOf(i);
    if (k < 0) throw new Failure(`edit plan problem: word ${i} is not kept, so nothing can be placed after it`);
    const s = segs[k];
    return outStart[k] + ((i === s.last_word_i ? s.out_ms : Math.min(words[i].end_ms, s.out_ms)) - s.in_ms);
  };
  const placed = inserts.map((x) => ({ ...x, at_cut_ms: x.kind === "hook" ? 0 : snap(afterWord(x.after_word_i)) }))
    .sort((a, b) => a.at_cut_ms - b.at_cut_ms || (a.kind === "hook" ? -1 : 1));
  // final start of each insert = its cut position + everything inserted before it
  let shift = 0; for (const x of placed) { x.at_final_ms = x.at_cut_ms + shift; shift += x.dur_ms; }
  const total = cutDur + shift;
  /** Cut-time -> final-time. `side` decides a moment exactly at an insert point (start = after it). */
  const toFinal = (cutMs, side = "start") => {
    let t = cutMs;
    for (const x of placed) if (x.at_cut_ms < cutMs || (x.at_cut_ms === cutMs && side === "start")) t += x.dur_ms;
    return t;
  };
  /** Where each kept word lands: cut and final timeline (null when the word was cut). */
  const wordPlace = (i) => {
    const k = segOf(i); if (k < 0) return null; const s = segs[k], w = words[i];
    const start = outStart[k] + Math.max(0, w.start_ms - s.in_ms);
    const end = Math.min(outStart[k] + (w.end_ms - s.in_ms), outStart[k] + (s.out_ms - s.in_ms));
    return { i, cut_start: start, cut_end: end, start: toFinal(start, "start"), end: toFinal(end, "end") };
  };
  return { segs, outStart, cutDur, inserts: placed, total, toFinal, wordPlace, afterWord, segOf };
}

/**
 * Cover windows on the CUT timeline, from word ranges (assemble-covers.mjs arithmetic), with the
 * sliver rule: gaps of up to holdGapMs between covers are held on the earlier cover. When
 * fullCover is on, every millisecond of the cut must be covered — remaining gaps are reported.
 */
export function coverWindows(tl, words, covers, { holdGapMs = 500, fullCover = false, minWinMs = 120 } = {}) {
  const { segs, outStart, cutDur } = tl; const wins = [];
  covers.forEach((c, ci) => {
    const [wa, wb] = c.over_words ?? [];
    if (!Number.isInteger(wa) || !Number.isInteger(wb) || wa > wb) throw new Failure(`edit plan problem: cover ${ci} needs over_words [first, last]`);
    let consumed = 0;
    segs.forEach((s, k) => {
      const a = Math.max(wa, s.first_word_i), b = Math.min(wb, s.last_word_i);
      if (a > b) return;
      const ws = a === s.first_word_i ? outStart[k] : outStart[k] + (words[a].start_ms - s.in_ms);
      const we = b === s.last_word_i ? outStart[k] + (s.out_ms - s.in_ms) : outStart[k] + (words[b].end_ms - s.in_ms);
      if (we - ws < minWinMs) return;
      wins.push({ cover: ci, ws, we, local_ms: consumed }); consumed += we - ws;
    });
  });
  wins.sort((a, b) => a.ws - b.ws);
  const notes = [], gaps = [];
  for (let i = 0; i < wins.length; i++) {   // a deliberate hold: the cover stays up through the pause until the next shot (or the end)
    if (!covers[wins[i].cover].hold_until_next) continue;
    const to = i + 1 < wins.length ? wins[i + 1].ws : cutDur;
    if (to > wins[i].we) { notes.push(`cover ${wins[i].cover} holds ${to - wins[i].we} ms through the pause (hold_until_next)`); wins[i].we = to; wins[i].held = true; }
  }
  for (let i = 0; i + 1 < wins.length; i++) {
    const g = wins[i + 1].ws - wins[i].we;
    if (g < 0) { notes.push(`cover ${wins[i].cover} overlaps cover ${wins[i + 1].cover} by ${-g} ms — the later one wins`); wins[i].we = wins[i + 1].ws; }
    else if (g > 0 && g <= holdGapMs) { wins[i].we = wins[i + 1].ws; notes.push(`held cover ${wins[i].cover} for ${g} ms to meet the next one`); }
  }
  if (fullCover) {
    if (!wins.length) gaps.push({ from: 0, to: cutDur });
    else {
      if (wins[0].ws > 0) { if (wins[0].ws <= holdGapMs) { wins[0].ws = 0; } else gaps.push({ from: 0, to: wins[0].ws }); }
      const last = wins.at(-1);
      if (last.we < cutDur) { if (cutDur - last.we <= holdGapMs) last.we = cutDur; else gaps.push({ from: last.we, to: cutDur }); }
      for (let i = 0; i + 1 < wins.length; i++) if (wins[i + 1].ws > wins[i].we) gaps.push({ from: wins[i].we, to: wins[i + 1].ws });
    }
  }
  const wordsNear = (ms) => { const p = words.map((w) => tl.wordPlace(w.i)).filter(Boolean); const w = p.find((x) => x.cut_end >= ms) ?? p.at(-1); return w ? `near word ${w.i} "${words[w.i].text}"` : ""; };
  return { windows: wins, notes, gaps: gaps.map((g) => ({ ...g, ms: g.to - g.from, where: wordsNear(g.from) })) };
}
