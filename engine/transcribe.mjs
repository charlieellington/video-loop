// transcribe.mjs — the word-timed transcript of the chosen narration (ElevenLabs Scribe, or imported).
// Plain English: every edit is written as "keep words 12 to 40", so each word needs an exact start
// and end time. This gets them from ElevenLabs Scribe, or validates a transcript you already have,
// and binds the result to the exact narration recording by fingerprint. Change the narration (for
// example switch from original to cleaned) and the old transcript is no longer accepted. Changing
// captions or music never transcribes again.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireKey, request, formWithFile, beginPaid, endPaid } from "./elevenlabs.mjs";
import { envelope } from "./align.mjs";
import { ffmpeg, sha256, stableJson, writeJson, readJsonOpt, ensureDir, scratchDir, rmrf, Failure, log } from "./util.mjs";

export const WORDS_CONTRACT = "video-loop/words@1";
export const transcriptHash = (words) => sha256(stableJson(words.map((w) => [w.text, w.start_ms, w.end_ms])));

/** Normalise a provider/imported word list to {i, text, start_ms, end_ms}. */
export function normaliseWords(raw) {
  const list = Array.isArray(raw) ? raw : raw.words ?? raw.transcripts?.[0]?.words;
  if (!Array.isArray(list)) throw new Failure("transcript has no words[] list");
  const ms = (w, k) => (w[`${k}_ms`] != null ? Math.round(w[`${k}_ms`]) : Math.round(Number(w[k]) * 1000));
  return list.filter((w) => (w.type ?? "word") === "word")
    .map((w, i) => ({ i, text: String(w.text ?? w.word ?? "").trim(), start_ms: ms(w, "start"), end_ms: ms(w, "end") }));
}

/** Contract checks shared by provider and import paths. */
export function validateWords(words, durationMs) {
  const p = [];
  if (!words.length) p.push("no words");
  words.forEach((w, k) => {
    if (!w.text) p.push(`word ${k} is empty`);
    if (!Number.isInteger(w.start_ms) || !Number.isInteger(w.end_ms)) p.push(`word ${k} has non-numeric timing`);
    if (w.end_ms < w.start_ms) p.push(`word ${k} "${w.text}" ends before it starts`);
    if (k && w.start_ms < words[k - 1].start_ms) p.push(`word ${k} "${w.text}" starts before the previous word`);
    if (w.end_ms > durationMs + 50) p.push(`word ${k} "${w.text}" ends at ${w.end_ms} ms, after the narration ends (${durationMs} ms)`);
  });
  return p.slice(0, 12);
}

/** Do the imported timings actually sit on speech in THIS recording? (median word energy vs background) */
function timingsSitOnSpeech(words, wav) {
  const env = envelope(wav); const at = (ms) => env[Math.min(env.length - 1, Math.floor(ms / 10))];
  const sorted = Array.from(env).sort((a, b) => a - b); const floor = sorted[Math.floor(sorted.length * 0.15)];
  const wordDb = words.map((w) => { let m = -100; for (let t = w.start_ms; t <= w.end_ms; t += 10) m = Math.max(m, at(t)); return m; }).sort((a, b) => a - b);
  const median = wordDb[Math.floor(wordDb.length / 2)];
  return { floor_db: +floor.toFixed(1), median_word_peak_db: +median.toFixed(1), ok: median > floor + 6 };
}

function save(sp, { words, language, raw, prov }) {
  ensureDir(sp.transcriptDir);
  if (raw) writeJson(sp.transcriptRaw, raw);
  writeJson(sp.words, { contract: WORDS_CONTRACT, audio_sha256: prov.audio_sha256, language, words });
  writeJson(sp.provenance, { ...prov, transcript_sha256: transcriptHash(words), word_count: words.length, language, created_at: new Date().toISOString() });
}

/**
 * Make sure a transcript bound to the selected narration exists. Returns {words, provenance}.
 * opts.bindImport: explicitly accept an imported transcript after validating its timings.
 */
export async function ensureTranscript(ctx, narr, { bindImport = false, retry = false, envFile } = {}) {
  const { cfg, paths, sp } = ctx; const t = cfg.transcription;
  const prov = readJsonOpt(sp.provenance);
  const want = { source: t.source, model: t.source === "import" ? "import" : t.model, language_setting: t.language };
  if (prov && prov.audio_sha256 === narr.asset_sha256 && prov.source === want.source && prov.model === want.model && prov.language_setting === want.language_setting && existsSync(sp.words)) {
    log(`TRANSCRIPT: reusing the transcript bound to this narration (${prov.word_count} words, ${prov.language}) — not transcribed again`);
    return { words: readJsonOpt(sp.words).words, provenance: prov };
  }
  if (t.source === "import") {
    if (!existsSync(paths.transcript)) throw new Failure(`imported transcript not found: ${paths.transcript}`);
    const raw = JSON.parse(readFileSync(paths.transcript, "utf8"));
    const words = normaliseWords(raw);
    const problems = validateWords(words, narr.duration_ms);
    if (problems.length) throw new Failure(`imported transcript does not fit the word-timing contract:\n  - ${problems.join("\n  - ")}`);
    const declared = raw.audio_sha256;
    if (declared !== narr.asset_sha256) {
      if (!bindImport) throw new Failure(`the imported transcript is not bound to the selected narration (${narr.which}).\n  transcript says: ${declared ?? "(no audio_sha256)"}\n  narration is   : ${narr.asset_sha256}`,
        ["if these timings really belong to this recording: video-loop ingest <project> --bind-import (checks the timings land on speech first)", "otherwise transcribe with transcription.source = \"elevenlabs\""]);
      const chk = timingsSitOnSpeech(words, narr.wav);
      if (!chk.ok) throw new Failure(`refusing to bind: the imported word times do not land on speech in this recording (median word peak ${chk.median_word_peak_db} dB vs background ${chk.floor_db} dB)`);
      log(`TRANSCRIPT: imported timings checked against the recording (word peaks ${chk.median_word_peak_db} dB vs background ${chk.floor_db} dB) and bound explicitly`);
    }
    save(sp, { words, language: raw.language ?? raw.language_code ?? t.language, prov: { ...want, audio_sha256: narr.asset_sha256, narration: narr.which, imported_from: paths.transcript, bound_by: declared === narr.asset_sha256 ? "declared audio_sha256" : "explicit --bind-import" } });
    log(`TRANSCRIPT: imported ${words.length} words`);
    return { words, provenance: readJsonOpt(sp.provenance) };
  }
  // ElevenLabs Scribe on the selected narration (a 16 kHz mono derivative keeps the upload small; timing is unchanged)
  const key = requireKey({ projectDir: paths.project, envFile }, "transcription");
  const tmp = scratchDir(sp.root, "stt"); const up = join(tmp, "narration-16k.wav");
  ffmpeg(["-i", narr.wav, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", up]);
  const marker = join(ensureDir(sp.transcriptDir), "pending-request.json");
  beginPaid(marker, { what: "transcription", audio_sha256: narr.asset_sha256 }, { retry });
  log(`TRANSCRIBE: sending the ${narr.which} narration (${(narr.duration_ms / 1000).toFixed(1)}s) to ElevenLabs Scribe (${t.model}, language ${t.language})…`);
  let res;
  try {
    res = await request({ key, path: "/v1/speech-to-text", what: "transcription", timeoutMs: Math.max(120000, narr.duration_ms * 4),
      form: formWithFile("file", up, "narration.wav", { model_id: t.model, timestamps_granularity: "word", tag_audio_events: "false", diarize: "false", ...(t.language !== "auto" ? { language_code: t.language } : {}) }) });
  } catch (e) { if (!e.ambiguous) endPaid(marker); rmrf(tmp); throw e; }
  endPaid(marker); rmrf(tmp);
  let raw;
  try { raw = JSON.parse(res.bytes.toString("utf8")); } catch { throw new Failure("transcription: ElevenLabs replied with something that is not JSON"); }
  const words = normaliseWords(raw);
  const problems = validateWords(words, narr.duration_ms);
  if (problems.length) throw new Failure(`transcription came back unusable:\n  - ${problems.join("\n  - ")}`);
  save(sp, { words, raw, language: raw.language_code ?? t.language, prov: { ...want, audio_sha256: narr.asset_sha256, narration: narr.which, provider: "elevenlabs", endpoint: "/v1/speech-to-text", request_ids: res.ids, transcription_id: raw.transcription_id ?? null, language_probability: raw.language_probability ?? null } });
  log(`TRANSCRIBE OK: ${words.length} words, language ${raw.language_code} (p=${raw.language_probability}) — "${(raw.text ?? "").slice(0, 100)}…"`);
  return { words, provenance: readJsonOpt(sp.provenance) };
}
