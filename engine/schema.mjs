// schema.mjs — every setting a video project can have, with its default and allowed values.
// Plain English: this is the single list of knobs. Defaults come first, then a profile (Charlie's
// or Bene's starting style), then the project's own project.toml, then anything typed on the
// command line. A misspelt or unknown setting is an error, never silently ignored.

const e = (values, def) => ({ type: "enum", values, default: def });
const n = (def, min = -Infinity, max = Infinity) => ({ type: "number", default: def, min, max });
const i = (def, min = -Infinity, max = Infinity) => ({ type: "integer", default: def, min, max });
const s = (def = "") => ({ type: "string", default: def });
const b = (def) => ({ type: "boolean", default: def });

export const SCHEMA_VERSION = 1;

export const SCHEMA = {
  schema_version: i(SCHEMA_VERSION, 1, 1),
  project: {
    title: s("Untitled video"),
    profile: s(""),
    media_dir: s("media"),
    output_dir: s("output"),
  },
  canvas: {
    width: i(1080, 64, 4096),
    height: i(1920, 64, 4096),
    fps: n(30, 1, 120),
    fit: e(["blur", "crop", "contain"], "blur"),
  },
  narration: {
    kind: e(["recorded-audio", "recorded-video"], "recorded-audio"),
    source: s(""),
    takes: { type: "array", of: "string", default: [] },
    take_gap_s: n(0.3, 0, 2),
  },
  voice_cleanup: {
    source: e(["none", "elevenlabs"], "none"),
    max_offset_ms: i(250, 0, 2000),
    max_drift_ms: i(30, 0, 500),
    max_duration_delta_ms: i(120, 0, 2000),
    min_speech_retained: n(0.9, 0, 1),
  },
  transcription: {
    source: e(["elevenlabs", "import"], "elevenlabs"),
    model: s("scribe_v2"),
    language: s("auto"),
    transcript: s(""),
  },
  editorial: {
    shot_target_s: n(2.5, 0.5, 30),
    face_policy: e(["none", "allowed", "preferred"], "allowed"),
    full_cover: b(false),
    punch_in: b(false),
    pre_handle_ms: i(60, 0, 1000),
    post_handle_ms: i(120, 0, 2000),
    hold_gap_ms: i(500, 0, 3000),
  },
  presentation: {
    hook: e(["none", "typed"], "none"),
    interludes: b(false),
    grade: e(["natural", "warm"], "natural"),
    touchup: b(false),
  },
  captions: {
    preset: e(["none", "mono-box", "outline-phrase", "typewriter-highlight"], "outline-phrase"),
    position: e(["lower", "center", "upper"], "lower"),
    size: n(1, 0.5, 2),
    max_words: i(5, 1, 12),
    max_span_ms: i(1800, 500, 6000),
    srt: b(true),
  },
  music: {
    source: e(["none", "file", "elevenlabs"], "none"),
    file: s(""),
    prompt: s(""),
    model: s("music_v1"),
    instrumental: b(true),
    placement: e(["through", "moments"], "through"),
    level_db: n(-18, -60, 6),
    ducking: b(true),
    duck_ratio: n(4, 1, 20),
    attack_ms: i(60, 1, 2000),
    release_ms: i(600, 10, 5000),
    fade_in_s: n(1.0, 0, 10),
    fade_out_s: n(2.5, 0, 15),
    loop: b(false),
  },
  source_sound: {
    broll_default: e(["mute", "keep"], "mute"),
    broll_gain_db: n(-14, -60, 6),
  },
  voice_synthesis: {
    enabled: b(false),
    provider: e(["elevenlabs"], "elevenlabs"),
    voice_id: s(""),
    model: s("eleven_multilingual_v2"),
  },
  review: {
    port: i(0, 0, 65535),
  },
  export: {
    loudness_lufs: n(-14, -40, -5),
    true_peak_db: n(-1.5, -9, 0),
    small_variant: b(false),
    preview_scale: n(0.5, 0.25, 1),
  },
};

/** Defaults as a plain object. */
export function defaults(node = SCHEMA) {
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = v.type ? structuredClone(v.default) : defaults(v);
  return out;
}

/** Check one layer (profile, project file or overrides) against the schema. Returns problems. */
export function checkLayer(layer, where, node = SCHEMA, path = []) {
  const problems = [];
  for (const [k, val] of Object.entries(layer ?? {})) {
    const spec = node[k]; const key = [...path, k].join(".");
    if (!spec) { problems.push(`${where}: unknown setting "${key}"`); continue; }
    if (!spec.type) {
      if (typeof val !== "object" || Array.isArray(val) || val === null) problems.push(`${where}: "${key}" must be a [${key}] table`);
      else problems.push(...checkLayer(val, where, spec, [...path, k]));
      continue;
    }
    const bad = (why) => problems.push(`${where}: "${key}" ${why} (got ${JSON.stringify(val)})`);
    if (spec.type === "enum" && !spec.values.includes(val)) bad(`must be one of ${spec.values.join(" | ")}`);
    if (spec.type === "string" && typeof val !== "string") bad("must be text");
    if (spec.type === "boolean" && typeof val !== "boolean") bad("must be true or false");
    if (spec.type === "array" && !(Array.isArray(val) && val.every((x) => typeof x === "string"))) bad("must be a list of text values");
    if (spec.type === "number" || spec.type === "integer") {
      if (typeof val !== "number" || !Number.isFinite(val)) bad("must be a number");
      else if (spec.type === "integer" && !Number.isInteger(val)) bad("must be a whole number");
      else if (val < spec.min || val > spec.max) bad(`must be between ${spec.min} and ${spec.max}`);
    }
  }
  return problems;
}

/** Combinations that are individually valid but make no sense together. */
export function checkCombinations(c) {
  const p = [];
  if (!c.narration.source && !c.narration.takes.length) p.push("narration.source is empty — point it at the recorded narration (audio or video)");
  if (c.narration.takes.length && c.narration.kind !== "recorded-video") p.push("narration.takes is only for narration.kind = \"recorded-video\"");
  if (c.narration.source && c.narration.takes.length) p.push("use either narration.source or narration.takes, not both");
  if (c.narration.kind === "recorded-audio" && !c.editorial.full_cover) p.push("recorded-audio narration has no picture of its own: editorial.full_cover must be true");
  if (c.narration.kind === "recorded-audio" && c.editorial.punch_in) p.push("editorial.punch_in needs recorded-video narration");
  if (c.transcription.source === "import" && !c.transcription.transcript) p.push("transcription.source = \"import\" needs transcription.transcript (a word-timed JSON file)");
  if (c.transcription.source === "elevenlabs" && c.transcription.transcript) p.push("transcription.transcript is only used when transcription.source = \"import\"");
  if (!/^(auto|[a-z]{2,3})$/.test(c.transcription.language)) p.push("transcription.language must be \"auto\" or a 2–3 letter language code such as \"en\" or \"nl\"");
  if (c.music.source === "file" && !c.music.file) p.push("music.source = \"file\" needs music.file");
  if (c.music.source === "elevenlabs" && !c.music.prompt.trim()) p.push("music.source = \"elevenlabs\" needs music.prompt (the agreed music brief)");
  if (c.voice_synthesis.enabled && !c.voice_synthesis.voice_id) p.push("voice_synthesis.enabled needs an explicit voice_synthesis.voice_id");
  if (c.presentation.touchup) p.push("presentation.touchup is not available in this release (the private touch-up module was not extracted)");
  if (c.presentation.interludes && c.narration.kind === "recorded-audio" && c.music.source === "none") p.push("presentation.interludes are music moments: choose a music source or turn interludes off");
  if (c.canvas.width % 2 || c.canvas.height % 2) p.push("canvas.width and canvas.height must be even numbers (H.264 requirement)");
  return p;
}
