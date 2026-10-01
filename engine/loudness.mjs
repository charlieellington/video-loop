// loudness.mjs — the one place that asks "how loud is this, really?" (EBU R128).
// Plain English: loudness is how loud something FEELS over time, which is what video platforms
// measure when they turn your video up or down. ffmpeg's loudnorm filter reports it as JSON buried
// in its log; this digs it out. Extracted from the away-loop lab's loudness.mjs, now a function.

import { ffmpegStderr, Failure } from "./util.mjs";

/** {I, TP, LRA, thresh} of a file's (first) audio, or of a filtered stream with `filter`. */
export function measureLoudness(file, { filter = "" } = {}) {
  const log = ffmpegStderr(["-i", file, "-map", "0:a:0", "-af", `${filter ? `${filter},` : ""}loudnorm=print_format=json`, "-f", "null", "-"]);
  const blocks = log.match(/\{[^{}]*"input_i"[\s\S]*?\}/g);
  if (!blocks) throw new Failure(`could not measure loudness of ${file}`);
  const m = JSON.parse(blocks.at(-1));
  const num = (x) => (x === "-inf" ? -Infinity : +x);
  return { I: num(m.input_i), TP: num(m.input_tp), LRA: num(m.input_lra), thresh: num(m.input_thresh) };
}
