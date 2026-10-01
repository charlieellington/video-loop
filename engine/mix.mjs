// mix.mjs — combines narration, b-roll sound, insert sound and music into the final soundtrack.
// Plain English: the voice is levelled FIRST (to the project's loudness target, −14 LUFS by default),
// then everything else is set relative to it: the music bed sits a chosen number of dB under the
// voice and dips further whenever the narration speaks (the dip is driven by the narration track
// itself, never by an already-mixed track). Fades at the start and end. The finished mix is
// measured; one corrective pass lands it on target; true peaks stay under the ceiling.
// Adapted from the away-loop lab's produce-v2.mjs and finalize-master.sh (voice-first levelling,
// sidechain ducking, measured gain + limiter instead of loudnorm's dynamic squashing).

import { ffmpeg, sec, Failure, log } from "./util.mjs";
import { measureLoudness } from "./loudness.mjs";

/** Lay a cut-timeline stem onto the final timeline: pieces between inserts, insert audio (or silence) in the gaps. */
export function spliceStem({ stem, tl, insertAudio = [], out }) {
  const ins = tl.inserts; const inputs = []; const parts = []; const seq = []; let n = 0;
  const silence = (ms, label) => { parts.push(`aevalsrc=0:s=48000:d=${sec(ms)},aformat=channel_layouts=mono[${label}]`); seq.push(`[${label}]`); };
  let stemIdx = null; if (stem) { inputs.push("-i", stem); stemIdx = n++; }
  const piece = (from, to, label) => {
    if (to <= from) return;
    if (stemIdx == null) return silence(to - from, label);
    parts.push(`[${stemIdx}:a]atrim=start=${sec(from)}:end=${sec(to)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=mono[${label}]`); seq.push(`[${label}]`);
  };
  let cursor = 0;
  // a stem input can only be read once per filter pad: split it for each piece
  ins.forEach((x, k) => {
    piece(cursor, x.at_cut_ms, `p${k}`); cursor = x.at_cut_ms;
    const a = insertAudio[k];
    if (a) { inputs.push("-i", a); const i = n++; parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,apad=whole_dur=${sec(x.dur_ms)},atrim=end=${sec(x.dur_ms)}[i${k}]`); seq.push(`[i${k}]`); }
    else silence(x.dur_ms, `i${k}`);
  });
  piece(cursor, tl.cutDur, "tail");
  const uses = parts.filter((p) => p.startsWith(`[${stemIdx}:a]`)).length;
  let graph = parts.join(";");
  if (stemIdx != null && uses > 1) {
    const labels = Array.from({ length: uses }, (_, k) => `[st${k}]`); let k = 0;
    graph = `[${stemIdx}:a]asplit=${uses}${labels.join("")};` + parts.map((p) => (p.startsWith(`[${stemIdx}:a]`) ? p.replace(`[${stemIdx}:a]`, labels[k++]) : p)).join(";");
  }
  graph += `;${seq.join("")}concat=n=${seq.length}:v=0:a=1[a]`;
  ffmpeg([...inputs, "-filter_complex", graph, "-map", "[a]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  return out;
}

/** The music envelope: "through" = everywhere; "moments" = under the hook and the interludes only. */
function momentsEnvelope(tl) {
  const ramp = (a, b, rIn, rOut) => `min(1\\,max(0\\,min((t-(${a.toFixed(2)}))/${rIn}\\,((${b.toFixed(2)})-t)/${rOut})))`;
  const m = tl.inserts.map((x) => x.kind === "hook" ? ramp(-1, (x.dur_ms / 1000) + 2.5, 0.5, 2.5) : ramp(x.at_final_ms / 1000 - 1, (x.at_final_ms + x.dur_ms) / 1000 + 2, 1, 2));
  return m.length ? m.reduce((a, b) => `max(${a}\\,${b})`) : "0";
}

/**
 * Mix the final soundtrack. Stems are final-timeline mono wavs (ambience/inserts already set
 * relative to a voice at the target). music = {file, duration_ms} or null.
 */
export function mixSoundtrack({ voice, ambience, inserts, music, cfg, tl, out, master = false }) {
  const target = cfg.export.loudness_lufs, ceil = cfg.export.true_peak_db, total = tl.total;
  const vI = measureLoudness(voice).I;
  if (!Number.isFinite(vI)) throw new Failure("the narration is silent after cutting — nothing to level");
  const gv = target - vI;
  let gm = null, musicI = null;
  if (music) { musicI = measureLoudness(music.file).I; gm = target + cfg.music.level_db - musicI; }
  // alimiter limits SAMPLE peaks; true (inter-sample) peaks can overshoot, so the limit is lowered until the measured TP fits
  const build = (corr, limitDb) => { const limit = Math.pow(10, limitDb / 20);
    const inputs = ["-i", voice]; const p = [`[0:a]volume=${(gv + corr).toFixed(2)}dB,aformat=channel_layouts=stereo,asplit=2[key][vo]`]; const mixIn = ["[vo]"]; let n = 1;
    for (const s of [ambience, inserts]) if (s) { inputs.push("-i", s); p.push(`[${n}:a]volume=${corr.toFixed(2)}dB,aformat=channel_layouts=stereo[s${n}]`); mixIn.push(`[s${n}]`); n++; }
    if (music) {
      if (cfg.music.loop) inputs.push("-stream_loop", "-1");
      inputs.push("-i", music.file);
      const env = cfg.music.placement === "moments" ? `volume='${momentsEnvelope(tl)}':eval=frame,` : "";
      p.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=end=${sec(total)},asetpts=PTS-STARTPTS,${env}volume=${(gm + corr).toFixed(2)}dB,afade=t=in:d=${cfg.music.fade_in_s},afade=t=out:st=${Math.max(0, total / 1000 - cfg.music.fade_out_s).toFixed(3)}:d=${cfg.music.fade_out_s}[mu]`);
      if (cfg.music.ducking) p.push(`[mu][key]sidechaincompress=threshold=0.03:ratio=${cfg.music.duck_ratio}:attack=${cfg.music.attack_ms}:release=${cfg.music.release_ms}:makeup=1[md]`);
      else p.push("[key]anullsink");
      mixIn.push(cfg.music.ducking ? "[md]" : "[mu]");
    } else p.push("[key]anullsink");
    p.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=first,alimiter=limit=${limit.toFixed(3)}:attack=5:release=50:level=disabled[a]`);
    ffmpeg([...inputs, "-filter_complex", p.join(";"), "-map", "[a]", "-ar", "48000", "-c:a", "pcm_s24le", "-t", sec(total), out]);
    return measureLoudness(out);
  };
  // measured gain, then up to three corrective passes (limiting shaves loudness off peaky speech)
  let corr = 0, limitDb = ceil - 1.5, L = build(corr, limitDb);
  for (let pass = 0; pass < 5; pass++) {
    const loud = Math.abs(L.I - target) > 0.3, peak = L.TP > ceil - 0.5;   // 0.5 dB margin for the AAC encode
    if (!loud && !peak) break;
    if (peak) limitDb -= L.TP - (ceil - 0.5) + 0.2;
    corr += target - L.I; L = build(corr, limitDb);
  }
  const res = { voice_lufs_raw: vI, voice_gain_db: +(gv + corr).toFixed(2), music_lufs_raw: musicI, music_gain_db: gm == null ? null : +(gm + corr).toFixed(2),
    music_level_vs_voice_db: music ? cfg.music.level_db : null, ducking: music ? cfg.music.ducking : null, placement: music ? cfg.music.placement : null,
    mix_lufs: L.I, mix_true_peak_db: L.TP, mix_lra: L.LRA, target_lufs: target, ceiling_dbtp: ceil, limiter_dbfs: +limitDb.toFixed(2) };
  log(`MIX: voice ${vI.toFixed(1)} LUFS raw → ${res.voice_gain_db >= 0 ? "+" : ""}${res.voice_gain_db} dB${music ? ` · music ${cfg.music.level_db} dB under the voice (${cfg.music.placement}${cfg.music.ducking ? ", ducked" : ""})` : " · no music"} → ${L.I} LUFS, ${L.TP} dBTP`);
  const problems = [];
  if (Math.abs(L.I - target) > 1) problems.push(`mix is ${L.I} LUFS, more than 1 LU from ${target}`);
  if (L.TP > ceil) problems.push(`true peak ${L.TP} dBTP is above the ${ceil} dBTP ceiling`);
  if (problems.length && master) throw new Failure(`soundtrack check failed: ${problems.join("; ")}`);
  res.problems = problems;
  return res;
}
