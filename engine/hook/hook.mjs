// hook.mjs — the optional typed-text opening (big words typing themselves over b-roll).
// Plain English: renders scene.html in a headless browser one frame at a time (so word timing is
// exact), adds each shot's own sound and a soft typing sound on every line, and returns a short
// clip that the film starts with. Used only when presentation.hook = "typed"; it needs the optional
// playwright-core package and a Chromium build. A base voice-over project never loads this file.
// Adapted from the away-loop lab's hook-typed/make-hook.mjs: no music bed of its own (the film's
// music owns that), no fade to black, and paths come from the project.

import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { ffmpeg, ensureDir, Failure, log } from "../util.mjs";
import { durationMs, probeMedia } from "../probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "..");
const FPS = 30;

/** A Chromium the hook can drive: VIDEO_LOOP_CHROME, playwright's own, or any in the Playwright cache. */
export async function findChrome() {
  if (process.env.VIDEO_LOOP_CHROME && existsSync(process.env.VIDEO_LOOP_CHROME)) return process.env.VIDEO_LOOP_CHROME;
  let pw; try { pw = await import("playwright-core"); } catch { return null; }
  try { const p = pw.chromium.executablePath(); if (p && existsSync(p)) return p; } catch {}
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(homedir(), ".cache/ms-playwright"));
  if (!existsSync(cache)) return null;
  for (const d of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort((a, b) => +b.split("-")[1] - +a.split("-")[1])) {
    for (const rel of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-linux/chrome", "chrome-linux64/chrome"]) if (existsSync(join(cache, d, rel))) return join(cache, d, rel);
  }
  return null;
}

/**
 * spec = edit.hook: {duration_s, shots:[{media,t0,t1,in_s}], lines:[{text,start,step,end,fade_at?}], typing?:true}
 * Returns {file (mp4 with audio), duration_ms, fits}.
 */
export async function renderHook({ spec, paths, outDir, W, H }) {
  const chrome = await findChrome();
  if (!chrome) throw new Failure("presentation.hook = \"typed\" needs a Chromium for the headless render", ["npm install (installs playwright-core)", "npx playwright-core install chromium", "or set presentation.hook = \"none\""]);
  const { chromium } = await import("playwright-core");
  ensureDir(join(outDir, "frames"));
  const shots = spec.shots.map((s, i) => {
    const src = paths.abs(s.media); if (!existsSync(src)) throw new Failure(`hook shot ${i} not found: ${s.media}`);
    const use = join(outDir, `shot-${i}.mp4`);   // browser-decodable H.264 copy (also normalises rotation/HDR handling)
    if (!existsSync(use)) ffmpeg(["-ss", String(s.in_s ?? 0), "-t", String((s.t1 - s.t0) + 0.5), "-i", src, "-an", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", use]);
    return { ...s, in_s: 0, srcResolved: src, srcIn: s.in_s ?? 0, src: `file://${use}` };
  });
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--allow-file-access-from-files", "--force-color-profile=srgb", "--autoplay-policy=no-user-gesture-required"] });
  let fits;
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    await page.addInitScript((h) => { window.HOOK = h; }, { ...spec, shots, fade_out: false });
    await page.goto(`file://${join(HERE, "scene.html")}`);
    await page.waitForFunction(() => window.ready === true, { timeout: 60000 });
    const bad = await page.evaluate(() => window.videoError || null);
    if (bad) throw new Failure(`hook: a shot could not be decoded in the browser (${bad})`);
    fits = await page.evaluate(() => window.fits);
    const n = Math.round(spec.duration_s * FPS);
    for (let i = 0; i < n; i++) { await page.evaluate((t) => window.seekTo(t), i / FPS); await page.screenshot({ path: join(outDir, "frames", `${String(i).padStart(5, "0")}.png`) }); }
  } finally { await browser.close(); }
  const video = join(outDir, "video.mp4");
  ffmpeg(["-framerate", String(FPS), "-i", join(outDir, "frames", "%05d.png"), "-vf", `scale=${W}:${H}`, "-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", video]);
  // sound: each shot's own ambience + a typing burst at every line's reveal (CC0 typing sample)
  const sfx = join(TOOL, "assets", "sfx", "typing-keys.mp3"); const inputs = [], parts = [], mix = [];
  shots.forEach((s, i) => {
    const d = s.t1 - s.t0; inputs.push("-ss", String(s.srcIn), "-t", d.toFixed(3), "-i", s.srcResolved);
    const hasA = probeMedia(s.srcResolved).has_audio;
    parts.push(hasA ? `[${i}:a]aresample=48000,aformat=channel_layouts=mono,apad=whole_dur=${d.toFixed(3)},atrim=end=${d.toFixed(3)},afade=t=in:d=0.15,afade=t=out:st=${(d - 0.15).toFixed(2)}:d=0.15[a${i}]` : `aevalsrc=0:s=48000:d=${d.toFixed(3)}[a${i}]`);
  });
  parts.push(`${shots.map((_, i) => `[a${i}]`).join("")}concat=n=${shots.length}:v=0:a=1,volume=0.32[amb]`); mix.push("[amb]");
  let idx = shots.length;
  if (spec.typing !== false) spec.lines.forEach((l, k) => {
    const len = Math.min(4.9, Math.max(0.8, l.text.split(" ").length * l.step + 0.3));
    inputs.push("-ss", String([0.4, 4.2, 8.1][k % 3]), "-t", len.toFixed(2), "-i", sfx);
    parts.push(`[${idx}:a]aformat=channel_layouts=mono,afade=t=in:d=0.05,afade=t=out:st=${(len - 0.25).toFixed(2)}:d=0.25,volume=0.5,adelay=${Math.round(l.start * 1000)}:all=1[t${k}]`); mix.push(`[t${k}]`); idx++;
  });
  parts.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0[out]`);
  const audio = join(outDir, "audio.wav");
  ffmpeg([...inputs, "-filter_complex", parts.join(";"), "-map", "[out]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", "-t", String(spec.duration_s), audio]);
  const file = join(outDir, "hook.mkv");
  ffmpeg(["-i", video, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s16le", "-shortest", file]);
  rmSync(join(outDir, "frames"), { recursive: true, force: true });
  writeFileSync(join(outDir, "fits.json"), JSON.stringify(fits, null, 1));
  log(`HOOK: typed opening ${spec.duration_s}s · ${fits.map((f) => `${f.size}px "${f.rows.join(" / ")}"`).join(" | ")}`);
  return { file, video, audio, duration_ms: durationMs(video), fits, name: basename(file) };
}
