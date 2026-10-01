// cleanup.mjs — optional voice cleanup with ElevenLabs Audio Isolation, before transcription.
// Plain English: sends ONLY the narration recording (never music, never the b-roll's own sound) to
// ElevenLabs to remove background noise. The original is kept; the cleaned version is saved next to
// it, checked for timing (no shift, drift or missing words) and offered side by side at matched
// loudness so the user can choose by ear. The result is cached by content: changing captions or
// music never sends the recording again. A failed or doubtful cleanup never pretends to be clean.

import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { requireKey, request, formWithFile, beginPaid, endPaid } from "./elevenlabs.mjs";
import { compareRecordings } from "./align.mjs";
import { measureLoudness } from "./loudness.mjs";
import { probeMedia, audioDurationMs } from "./probe.mjs";
import { ffmpeg, sha256, sha256File, writeJson, writeAtomic, readJsonOpt, ensureDir, Failure, Pending, log, sec } from "./util.mjs";
import { prepareOriginal } from "./narration.mjs";
import { comparePage } from "./compare-page.mjs";

const ENDPOINT = "/v1/audio-isolation";
const EXT = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac", "audio/ogg": "ogg", "audio/aac": "aac", "audio/mp4": "m4a", "application/octet-stream": "bin" };

export function cleanupKey(orig) { return sha256(`${orig.asset_sha256}|${ENDPOINT}|upload=wav-48k-mono-s16`).slice(0, 16); }

/** `video-loop voice clean` — run (or reuse) the isolation, check it, build the comparison. */
export async function voiceClean(ctx, { retry = false, envFile } = {}) {
  const { cfg, paths, sp } = ctx;
  if (cfg.voice_cleanup.source !== "elevenlabs")
    throw new Failure("voice cleanup is off for this project (voice_cleanup.source = \"none\")", ["set voice_cleanup.source = \"elevenlabs\" in project.toml to use it"]);
  const orig = await prepareOriginal(ctx);
  const key = cleanupKey(orig), dir = ensureDir(join(sp.cleanupDir, key));
  const resultP = join(dir, "result.json"), marker = join(dir, "pending-request.json");
  let result = readJsonOpt(resultP);
  if (result?.status === "ok" || result?.status === "failed-checks") {
    log(`VOICE CLEAN: using the cached result for this recording (${result.status}) — no new request sent`);
  } else {
    const apiKey = requireKey({ projectDir: paths.project, envFile }, "voice cleanup");
    beginPaid(marker, { what: "audio isolation", input_sha256: orig.asset_sha256 }, { retry });
    log(`VOICE CLEAN: sending the narration only (${(orig.duration_ms / 1000).toFixed(1)}s) to ElevenLabs Audio Isolation…`);
    let res;
    try {
      res = await request({ key: apiKey, path: ENDPOINT, what: "voice cleanup", timeoutMs: Math.max(120000, orig.duration_ms * 6),
        form: formWithFile("audio", orig.working, "narration.wav") });
    } catch (e) {
      if (!e.ambiguous) { endPaid(marker); writeJson(join(sp.cleanupDir, "status.json"), { key, status: "failed", error: e.message, at: new Date().toISOString() }); }
      throw Object.assign(e, { next: [...(e.next ?? []), "the original recording is untouched; to go on without cleanup: video-loop voice select <project> original"] });
    }
    endPaid(marker);
    result = await acceptOutput(ctx, { orig, dir, res, key });
    writeJson(resultP, result);
  }
  writeJson(join(sp.cleanupDir, "status.json"), { key, status: result.status, at: new Date().toISOString(), problems: result.checks?.problems ?? [result.error].filter(Boolean) });
  const page = await buildComparison(ctx, orig, result, dir);
  if (result.status !== "ok") throw new Failure(`the cleaned narration failed its checks:\n  - ${(result.checks?.problems ?? [result.error]).join("\n  - ")}`,
    ["the original is untouched and still usable: video-loop voice select <project> original", `details: ${relative(paths.project, page)}`]);
  throw new Pending(`cleaned narration ready: background ${result.checks.background_db.original} → ${result.checks.background_db.cleaned} dB, speech retained ${(result.checks.speech_retained * 100).toFixed(1)}%, shift ${result.checks.offset_ms} ms, drift ${result.checks.drift_ms} ms.\nListen to both and choose.`,
    [`open ${relative(paths.project, page)} (or run video-loop review <project>)`, "video-loop voice select <project> cleaned   (or: original)"]);
}

/** Validate the provider reply, decode, check timing, compensate a measured fixed offset. */
async function acceptOutput(ctx, { orig, dir, res, key }) {
  const { cfg } = ctx;
  const base = { key, input_sha256: orig.asset_sha256, input_duration_ms: orig.duration_ms, input_sample_rate: orig.sample_rate,
    provider: "elevenlabs", endpoint: ENDPOINT, request_ids: res.ids, content_type: res.contentType, created_at: new Date().toISOString() };
  const ct = res.contentType.split(";")[0].trim();
  if (!res.bytes.length) return { ...base, status: "invalid-response", error: "ElevenLabs returned an empty reply" };
  if (/json|text|html/.test(ct)) return { ...base, status: "invalid-response", error: `ElevenLabs returned ${ct}, not audio: ${res.bytes.toString("utf8").slice(0, 160)}` };
  const raw = join(dir, `provider-output.${EXT[ct] ?? "bin"}`);
  writeAtomic(raw, res.bytes);
  const m = probeMedia(raw);
  if (!m.has_audio || !(m.audio.duration_s > 0)) return { ...base, status: "invalid-response", provider_output: raw, error: "the reply is not playable audio (empty or corrupt)" };
  const decoded = join(dir, "cleaned-decoded.wav");
  ffmpeg(["-i", raw, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", decoded]);
  const checks = compareRecordings(orig.working, decoded, cfg.voice_cleanup);
  const out = { ...base, provider_output: raw, provider_output_sha256: await sha256File(raw), provider_sample_rate: m.audio.sample_rate,
    provider_duration_ms: Math.round(m.audio.duration_s * 1000), checks };
  if (checks.problems.length) return { ...out, status: "failed-checks" };
  // compensate ONLY a measured, fixed shift; then match the original's exact length
  const off = checks.offset_ms, cleaned = join(dir, "cleaned.wav");
  const af = [off > 0 ? `atrim=start=${sec(off)},asetpts=PTS-STARTPTS` : null, off < 0 ? `adelay=${-off}:all=1` : null,
    `apad=whole_dur=${sec(orig.duration_ms)}`, `atrim=end=${sec(orig.duration_ms)}`].filter(Boolean).join(",");
  ffmpeg(["-i", decoded, "-af", af, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", cleaned]);
  return { ...out, status: "ok", compensated_offset_ms: off, cleaned_wav: cleaned, cleaned_sha256: await sha256File(cleaned), cleaned_duration_ms: audioDurationMs(cleaned) };
}

/** Loudness-matched copies of both versions + the comparison page. */
async function buildComparison(ctx, orig, result, dir) {
  const { paths } = ctx; const outDir = ensureDir(join(paths.output, "voice-compare"));
  const target = -20; const items = [];
  for (const [label, file] of [["original", orig.working], ["cleaned", result.cleaned_wav ?? (existsSync(join(dir, "cleaned-decoded.wav")) ? join(dir, "cleaned-decoded.wav") : null)]]) {
    if (!file) continue;
    const L = measureLoudness(file); const g = Number.isFinite(L.I) ? (target - L.I).toFixed(2) : "0";
    const out = join(outDir, `${label}.m4a`);
    ffmpeg(["-i", file, "-af", `volume=${g}dB,alimiter=limit=0.89:level=disabled`, "-c:a", "aac", "-b:a", "160k", out]);
    items.push({ label, file: relative(outDir, out), measured_lufs: L.I, gain_db: +g });
  }
  const page = join(paths.output, "voice-compare.html");
  writeFileSync(page, comparePage({ title: ctx.cfg.project.title, items: items.map((x) => ({ ...x, file: `voice-compare/${x.file}` })), result }));
  return page;
}

/** `video-loop voice select original|cleaned` */
export async function voiceSelect(ctx, which) {
  const { sp, cfg } = ctx;
  if (!["original", "cleaned"].includes(which)) throw new Failure("choose `original` or `cleaned`");
  const orig = await prepareOriginal(ctx);
  const prev = readJsonOpt(sp.selection);
  let sel;
  if (which === "original") sel = { which, asset_sha256: orig.asset_sha256, wav: orig.working, duration_ms: orig.duration_ms };
  else {
    if (cfg.voice_cleanup.source !== "elevenlabs") throw new Failure("voice cleanup is off for this project; only the original can be used");
    const r = readJsonOpt(join(sp.cleanupDir, cleanupKey(orig), "result.json"));
    if (!r) throw new Pending("there is no cleaned version of this recording yet", ["video-loop voice clean <project>"]);
    if (r.status !== "ok") throw new Failure(`the cleaned version failed its checks and cannot be used (${(r.checks?.problems ?? [r.error]).join("; ")})`, ["video-loop voice select <project> original"]);
    sel = { which, asset_sha256: r.provider_output_sha256, original_sha256: orig.asset_sha256, wav: r.cleaned_wav, wav_sha256: r.cleaned_sha256, duration_ms: r.cleaned_duration_ms, offset_ms: r.compensated_offset_ms };
  }
  writeJson(sp.selection, { ...sel, chosen_at: new Date().toISOString() });
  log(`VOICE: using the ${which} narration`);
  const prov = readJsonOpt(sp.provenance);
  if (prev && prev.asset_sha256 !== sel.asset_sha256 && prov)
    log("NOTE: you switched narration. The transcript belongs to the other version, so the next ingest transcribes again,\n      and any approved edit must be reviewed and approved again (its word timings may move).");
  return sel;
}
