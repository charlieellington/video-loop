// doctor.mjs — checks this computer can make videos, and says exactly what is missing.
// Plain English: finds ffmpeg/ffprobe and Node, checks the encoders and filters the engine uses
// (H.264, AAC, libass captions, ducking, loudness…), then actually encodes a tiny clip and burns a
// caption into it with a bundled font — a filter list can lie, a real render cannot. Optional parts
// (HDR conversion, the typed hook's browser, ElevenLabs credentials) are reported for the features a
// project selects; they never fail the base check. Doctor never calls a paid service.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, accessSync, constants, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FFMPEG, FFPROBE, rmrf, pcmFloat } from "./util.mjs";
import { TOOL_ROOT } from "./config.mjs";
import { PRESET_FONTS } from "./captions.mjs";
import { findKey, PRICING_URL } from "./elevenlabs.mjs";

const NEED_FILTERS = ["ass", "overlay", "concat", "trim", "atrim", "scale", "crop", "pad", "gblur", "zoompan", "tpad", "fps", "afade", "adelay", "amix", "apad", "asplit",
  "sidechaincompress", "alimiter", "loudnorm", "volume", "volumedetect", "signalstats", "blackdetect", "geq", "aevalsrc", "tile", "ssim", "colortemperature", "curves", "eq"];
let cache = null;

const which = (cmd) => { const r = spawnSync("/usr/bin/env", ["which", cmd], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };

/** What this ffmpeg build can do (cached per process). */
export function featureCheck() {
  if (cache) return cache;
  const run = (args) => spawnSync(FFMPEG, ["-hide_banner", ...args], { encoding: "utf8", maxBuffer: 1 << 24 });
  const v = run(["-version"]);
  if (v.error || v.status !== 0) return (cache = { ok: false, error: `ffmpeg not found (${FFMPEG})`, filters: {}, encoders: {} });
  const fl = run(["-filters"]).stdout; const en = run(["-encoders"]).stdout;
  const filters = Object.fromEntries([...NEED_FILTERS, "zscale", "tonemap"].map((f) => [f, new RegExp(`^\\s*\\S+\\s+${f}\\s`, "m").test(fl)]));
  const encoders = { libx264: /\blibx264\b/.test(en), aac: /^\s*A\S*\s+aac\s/m.test(en) };
  return (cache = { ok: true, version: v.stdout.split("\n")[0], filters, encoders, ffmpeg: which(FFMPEG) ?? FFMPEG, ffprobe: which(FFPROBE) ?? FFPROBE });
}

/** Encode 1 s with a burned caption in a bundled font; prove the glyphs are really there. */
function realProbe() {
  const dir = mkdtempSync(join(tmpdir(), "video-loop-doctor-"));
  try {
    const font = PRESET_FONTS["outline-phrase"][0]; copyFileSync(join(TOOL_ROOT, "assets", "fonts", font), join(dir, font));
    writeFileSync(join(dir, "t.ass"), "[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 240\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: T,Lato,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,5,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,T,,0,0,0,,Één\n");
    const r = spawnSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=1", "-f", "lavfi", "-i", "sine=f=440:d=1",
      "-vf", "ass=t.ass:fontsdir=.", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "probe.mp4"], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) return { ok: false, detail: r.stderr.trim().split("\n").slice(-2).join(" ") };
    const y = spawnSync(FFMPEG, ["-hide_banner", "-i", "probe.mp4", "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YMAX", "-frames:v", "1", "-f", "null", "-"], { cwd: dir, encoding: "utf8" }).stderr;
    const ymax = +(y.match(/YMAX=([\d.]+)/)?.[1] ?? 0);
    const audio = pcmFloat(join(dir, "probe.mp4"), { rate: 8000 }); const peak = audio.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    return { ok: ymax > 200 && peak > 0.05, detail: `H.264+AAC encoded; burned caption brightest pixel ${ymax} (a black frame is 16); audio peak ${peak.toFixed(2)}` };
  } finally { rmrf(dir); }
}

/** Full doctor report. ctx is optional (a project): its selected features decide what else is checked. */
export async function runDoctor(ctx = null) {
  const rows = []; const add = (status, what, detail) => rows.push({ status, what, detail });
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
  add(nodeOk ? "ok" : "fail", "Node.js", `${process.versions.node} at ${process.execPath}${nodeOk ? "" : " — needs 20.19 or newer"}`);
  const fc = featureCheck();
  if (!fc.ok) { add("fail", "ffmpeg", fc.error); return rows; }
  add("ok", "ffmpeg", `${fc.version} at ${fc.ffmpeg}`);
  add(which(FFPROBE) ? "ok" : "fail", "ffprobe", fc.ffprobe);
  for (const [k, v] of Object.entries(fc.encoders)) add(v ? "ok" : "fail", `encoder ${k}`, v ? "present" : "missing — install an ffmpeg build with it");
  const missing = NEED_FILTERS.filter((f) => !fc.filters[f]);
  add(missing.length ? "fail" : "ok", "filters", missing.length ? `missing: ${missing.join(", ")}${missing.includes("ass") ? " (libass — captions cannot be burned)" : ""}` : `${NEED_FILTERS.length} required filters present (incl. libass)`);
  const fonts = Object.values(PRESET_FONTS).flat().filter((f) => !existsSync(join(TOOL_ROOT, "assets", "fonts", f)));
  add(fonts.length ? "fail" : "ok", "caption fonts", fonts.length ? `missing ${fonts.join(", ")}` : "bundled (Geist Mono, Lato, Courier Prime — OFL)");
  if (!missing.length && !fonts.length) { const p = realProbe(); add(p.ok ? "ok" : "fail", "real encode + caption burn", p.detail); }
  add(fc.filters.zscale && fc.filters.tonemap ? "ok" : "warn", "HDR → SDR (zscale+tonemap)", fc.filters.zscale && fc.filters.tonemap ? "present" : "missing — fine for SDR footage; HDR clips will be refused rather than misrendered");
  if (ctx) {
    const { cfg, paths } = ctx;
    for (const [label, p] of [["project folder", paths.project], ["output folder", existsSync(paths.output) ? paths.output : paths.project]]) {
      try { accessSync(p, constants.W_OK); add("ok", `${label} writable`, p); } catch { add("fail", `${label} writable`, p); }
    }
    const files = [paths.narration, ...paths.takes].filter(Boolean);
    for (const f of files) add(existsSync(f) ? "ok" : "fail", "narration file", f);
    add(existsSync(paths.media) ? "ok" : "warn", "media folder", paths.media);
    const needsKey = [cfg.voice_cleanup.source === "elevenlabs" && "voice cleanup", cfg.transcription.source === "elevenlabs" && "transcription", cfg.music.source === "elevenlabs" && "music generation", cfg.voice_synthesis.enabled && "voice synthesis"].filter(Boolean);
    if (needsKey.length) { const k = findKey({ projectDir: paths.project }); add(k ? "ok" : "warn", "ElevenLabs key", k ? `found in ${k.from} (not tested — doctor makes no paid calls); used for ${needsKey.join(", ")}` : `needed for ${needsKey.join(", ")} — set ELEVENLABS_API_KEY or the project's .env · prices: ${PRICING_URL}`); }
    else add("ok", "ElevenLabs key", "not needed by this project's settings");
    if (cfg.presentation.hook === "typed") { const { findChrome } = await import("./hook/hook.mjs"); const c = await findChrome(); add(c ? "ok" : "warn", "typed hook browser", c ?? "missing — npm install, then npx playwright-core install chromium"); }
  }
  return rows;
}
