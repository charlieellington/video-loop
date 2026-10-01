// captions.mjs — burned-in captions (.ass) and a plain subtitle sidecar (.srt) from the timeline.
// Plain English: words are placed on the finished video's clock by timeline.mjs, grouped into short
// readable phrases, and written in one of three looks:
//   mono-box              cream monospace phrases on a soft ink box (Charlie's look)
//   outline-phrase        white sans phrases with a dark outline, no box
//   typewriter-highlight  black typewriter text on a white box; words appear as they are spoken
//                         and the word being spoken is white on black
// For the highlight look every state of a phrase uses the SAME text (only colours change), so
// libass lays it out once and nothing jumps as words appear. Corrections ("caption_fixes") change
// what is displayed only — never which words are cut. The .srt carries plain phrases.
// Adapted from the away-loop lab's make-captions.mjs (phrase grouping, caption-only fixes, the cream/ink style).

import { writeFileSync } from "node:fs";

const TAIL_MS = 120, MAX_GAP_MS = 400;

export const PRESETS = {
  "mono-box": { font: "Geist Mono", bold: -1, size: 0.028, primary: "&H00F3F8FF", outlineC: "&H66383C41", backC: "&H66383C41", border: 3, outline: 6, shadow: 0 },
  "outline-phrase": { font: "Lato", bold: -1, size: 0.036, primary: "&H00FFFFFF", outlineC: "&H00141414", backC: "&H80000000", border: 1, outline: 4, shadow: 0 },
  "typewriter-highlight": { font: "Courier Prime", bold: -1, size: 0.036, primary: "&H00000000", outlineC: "&H00FFFFFF", backC: "&H00FFFFFF", border: 3, outline: 14, shadow: 0 },
};
export const PRESET_FONTS = { "mono-box": ["GeistMono-Bold.ttf"], "outline-phrase": ["Lato-Black.ttf"], "typewriter-highlight": ["CourierPrime-Bold.ttf"] };

/** Make arbitrary text safe inside an ASS Dialogue line (braces open override blocks, \ is a command). */
export function assEscape(s) {
  return String(s).replace(/\\/g, "⧵").replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/[\r\n]+/g, " ");
}

/** Group placed words into phrases; never across an insert (hook/interlude) point. */
export function phrases(tl, words, { fixes = {}, maxWords = 5, maxSpanMs = 1800 } = {}) {
  const placed = words.map((w) => tl.wordPlace(w.i)).filter(Boolean).map((p) => ({ ...p, text: String(fixes[p.i] ?? words[p.i].text) }));
  const cutsAt = tl.inserts.filter((x) => x.kind !== "hook").map((x) => x.at_cut_ms);
  const out = []; let cur = [];
  placed.forEach((w, k) => {
    cur.push(w); const nx = placed[k + 1];
    const brk = !nx || /[.?!…]$/.test(w.text) || cur.length >= maxWords || nx.end - cur[0].start >= maxSpanMs
      || nx.start - w.end >= MAX_GAP_MS || cutsAt.some((c) => w.cut_end <= c && nx.cut_start >= c);
    if (brk) { out.push(cur); cur = []; }
  });
  const lines = out.map((p) => ({ start: p[0].start, end: p.at(-1).end + TAIL_MS, words: p, text: p.map((w) => w.text).join(" ") }));
  lines.forEach((l, k) => { if (lines[k + 1]) l.end = Math.min(l.end, lines[k + 1].start - 1); });
  return lines.filter((l) => l.end > l.start);
}

const assTime = (ms) => { const c = Math.max(0, Math.round(ms)); const h = Math.floor(c / 3600000), m = Math.floor(c / 60000) % 60, s = Math.floor(c / 1000) % 60; return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(Math.floor((c % 1000) / 10)).padStart(2, "0")}`; };
const srtTime = (ms) => { const c = Math.max(0, Math.round(ms)); const h = Math.floor(c / 3600000), m = Math.floor(c / 60000) % 60, s = Math.floor(c / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(c % 1000).padStart(3, "0")}`; };

function placement(position, H) {
  if (position === "center") return { align: 5, marginV: 0 };
  if (position === "upper") return { align: 8, marginV: Math.round(H * 0.12) };
  return { align: 2, marginV: Math.round(H * 0.24) };   // lower: clear of the platform's own buttons
}

/** The typewriter states for one phrase: one event per word-onset, identical text, colours change. */
function typewriterEvents(l) {
  const ev = []; const ws = l.words;
  const base = ws.map((w) => assEscape(w.text)).join(" ");
  ev.push(`Dialogue: 0,${assTime(l.start)},${assTime(l.end)},TW,,0,0,0,,{\\1a&HFF&}${base}`);   // the white box for the whole phrase
  ws.forEach((w, k) => {
    const t0 = w.start, t1 = k + 1 < ws.length ? ws[k + 1].start : l.end;
    if (t1 <= t0) return;
    const parts = ws.map((x, j) => {
      const tx = assEscape(x.text);
      if (j < k) return `{\\1a&H00&\\1c&H000000&\\3a&HFF&}${tx}`;                 // spoken: black on the box
      if (j === k && w.end > t0) return `{\\1a&H00&\\1c&HFFFFFF&\\3a&H00&\\3c&H000000&}${tx}`; // speaking: white on black
      if (j === k) return `{\\1a&H00&\\1c&H000000&\\3a&HFF&}${tx}`;
      return `{\\1a&HFF&\\3a&HFF&}${tx}`;                                           // not yet spoken: invisible, same layout
    });
    // the gaps between words carry no box of their own on this layer
    ev.push(`Dialogue: 1,${assTime(t0)},${assTime(t1)},TW,,0,0,0,,${parts.join("{\\3a&HFF&} ")}`);
    if (w.end < t1) { // after the word ends and before the next starts: no inverted word
      ev[ev.length - 1] = ev.at(-1).replace(`,${assTime(t1)},TW`, `,${assTime(w.end)},TW`);
      ev.push(`Dialogue: 1,${assTime(w.end)},${assTime(t1)},TW,,0,0,0,,${ws.map((x, j) => `{\\1a&H${j <= k ? "00" : "FF"}&\\1c&H000000&\\3a&HFF&}${assEscape(x.text)}`).join("{\\3a&HFF&} ")}`);
    }
  });
  return ev;
}

/** Write captions.ass (+ captions.srt). Returns a summary. */
export function writeCaptions({ tl, words, fixes, cfg, assPath, srtPath }) {
  const c = cfg.captions; const W = cfg.canvas.width, H = cfg.canvas.height;
  const lines = phrases(tl, words, { fixes, maxWords: c.max_words, maxSpanMs: c.max_span_ms });
  if (srtPath) writeFileSync(srtPath, lines.map((l, k) => `${k + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}\n`).join("\n"));
  if (c.preset === "none" || !assPath) return { lines, preset: c.preset };
  const p = PRESETS[c.preset]; const fs = Math.round(H * p.size * c.size); const { align, marginV } = placement(c.position, H);
  const outline = Math.max(1, Math.round(p.outline * (H / 1920) * c.size));
  const margin = Math.round(W * 0.08);
  const style = (name) => `Style: ${name},${p.font},${fs},${p.primary},${p.primary},${p.outlineC},${p.backC},${p.bold},0,0,0,100,100,0,0,${p.border},${outline},${p.shadow},${align},${margin},${margin},${marginV},1`;
  const events = c.preset === "typewriter-highlight" ? lines.flatMap(typewriterEvents)
    : lines.map((l) => `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},${c.preset === "mono-box" ? "MB" : "OP"},,0,0,0,,${assEscape(l.text)}`);
  const name = { "mono-box": "MB", "outline-phrase": "OP", "typewriter-highlight": "TW" }[c.preset];
  writeFileSync(assPath, `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${style(name)}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`);
  return { lines, preset: c.preset, font: p.font, font_px: fs, events: events.length };
}
