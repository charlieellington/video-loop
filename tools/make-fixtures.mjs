#!/usr/bin/env node
// make-fixtures.mjs — how the fictional example and test media were made (maintainers only).
// Plain English: every picture, clip, voice and music file in examples/fictional-book and
// tests/fixtures is synthetic and invented — generated here with eSpeak NG (synthetic speech),
// ffmpeg test-pattern sources and tools/synth-music.py. Nothing is a real person or real footage.
// Users never run this; the generated files are committed. Re-running regenerates them.
//   node tools/make-fixtures.mjs        (needs espeak-ng, ffmpeg, python3)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EX = join(ROOT, "examples", "fictional-book"), MEDIA = join(EX, "media"), FX = join(ROOT, "tests", "fixtures");
const TMP = join(ROOT, ".fixture-tmp");
const ff = (...a) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...a], { stdio: "inherit" });
const dur = (f) => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString();
for (const d of [MEDIA, join(MEDIA, "book pages"), join(MEDIA, "clips"), join(EX, "plan"), FX, TMP]) mkdirSync(d, { recursive: true });

const EN = ["This is the story of how we made a book for Pip.", "Pip is a small fox who collects moons.",
  "Every night she climbs the hill behind the bakery, and catches one in a jam jar.", "We drew her first on paper, then on the laptop, page by page.",
  "Here is the cover. Here she is on the hill.", "And on the last page, she lets every moon go.", "Whose story would you like to keep?"];
const NL = ["Dit boek is voor Pip, de vos die manen verzamelt.", "Ze las het één keer, en toen nog een keer, in het café.", "Wiens verhaal wil jij bewaren?"];
const GAP = 0.45;

/** Sentences → one narration with known sentence windows (the timing truth for transcript checks). */
function speak(lines, voice, out, speed = 150) {
  const parts = []; let t = 0.35; const windows = [];
  lines.forEach((s, k) => {
    const w = join(TMP, `${voice}-${k}.wav`);
    execFileSync("espeak-ng", ["-v", voice, "-s", String(speed), "-w", w, s]);
    const raw = join(TMP, `${voice}-${k}-48k.wav`); ff("-i", w, "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,aresample=48000", "-ac", "1", raw);
    const d = dur(raw); windows.push({ text: s, start_s: +t.toFixed(3), end_s: +(t + d).toFixed(3) }); t += d + GAP; parts.push(raw);
  });
  const list = parts.flatMap((p) => ["-i", p]);
  const graph = `aevalsrc=0:s=48000:d=0.35[lead];` + parts.map((_, k) => `[${k}:a]apad=pad_dur=${GAP}[p${k}]`).join(";") + `;[lead]${parts.map((_, k) => `[p${k}]`).join("")}concat=n=${parts.length + 1}:v=0:a=1,volume=0.9[a]`;
  ff(...list, "-filter_complex", graph, "-map", "[a]", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out);
  return windows;
}

// --- narration (English, example) + Dutch fixture + noisy fixture --------------------------------
const enWav = join(TMP, "en.wav"), enWin = speak(EN, "en-gb-x-rp", enWav, 148);
ff("-i", enWav, "-c:a", "aac", "-b:a", "96k", join(MEDIA, "narration.m4a"));
const nlWav = join(TMP, "nl.wav"), nlWin = speak(NL, "nl", nlWav, 140);
ff("-i", nlWav, "-c:a", "aac", "-b:a", "96k", join(FX, "dutch-phrase.m4a"));
// noisy: the same English narration under pink noise + mains hum + a little hiss (a "kitchen" room)
ff("-i", enWav, "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.06:r=48000:seed=3", "-f", "lavfi", "-i", "sine=f=50:r=48000",
  "-filter_complex", "[2:a]volume=0.05[h];[1:a][h]amix=inputs=2:normalize=0[n];[0:a][n]amix=inputs=2:duration=first:normalize=0[a]", "-map", "[a]", "-ac", "1", "-c:a", "aac", "-b:a", "128k", join(FX, "noisy-narration.m4a"));
writeFileSync(join(FX, "speech-windows.json"), JSON.stringify({ note: "sentence windows of the generated narration (seconds) — the timing truth transcripts are checked against", en: enWin, nl: nlWin }, null, 1));

// --- stills: three book pages (cream paper, a moon, a caption line) -------------------------------
const FONT = join(ROOT, "assets", "fonts", "Lato-Black.ttf").replace(/:/g, "\\:");
const page = (file, title, moonX, moonY, r, bg) => ff("-f", "lavfi", "-i", `color=c=${bg}:s=1200x1600:d=1`, "-vf",
  `geq=r='if(lt(hypot(X-${moonX},Y-${moonY}),${r}),250,r(X,Y))':g='if(lt(hypot(X-${moonX},Y-${moonY}),${r}),226,g(X,Y))':b='if(lt(hypot(X-${moonX},Y-${moonY}),${r}),140,b(X,Y))',` +
  `drawtext=fontfile='${FONT}':text='${title}':fontsize=84:fontcolor=0x2b2b2b:x=(w-tw)/2:y=h-260`, "-frames:v", "1", file);
page(join(MEDIA, "book pages", "página 1 – cover.png"), "Pip and the Paper Moon", 600, 640, 260, "0xF4EBDD");
page(join(MEDIA, "book pages", "página 2 – the hill.png"), "On the hill", 860, 420, 120, "0xE9E2F2");
page(join(MEDIA, "book pages", "página 3 – één maan.png"), "Every moon goes home", 420, 520, 180, "0xDDEBF0");

// --- clips: WhatsApp-sized portrait with ambience, landscape silent, square with sound, rotated ----
ff("-f", "lavfi", "-i", "gradients=s=576x1024:c0=0x0b1a3a:c1=0x2a3f7a:x0=0:y0=0:x1=0:y1=1024:d=6:r=30", "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.25:r=48000:d=6:seed=9",
  "-filter_complex", "[0:v]geq=lum='if(lt(hypot(X-(120+40*T),Y-(260-8*T)),70),235,lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)',noise=alls=8:allf=t[v];[1:a]lowpass=f=500,volume=0.6[a]",
  "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-shortest", join(MEDIA, "clips", "hill at night.mp4"));
ff("-f", "lavfi", "-i", "color=c=0x1d1a16:s=1280x720:d=5:r=30", "-vf", "geq=r='if(lt(hypot(X-640,Y-380),150+20*sin(4*T)),245,r(X,Y))':g='if(lt(hypot(X-640,Y-380),150+20*sin(4*T)),210,g(X,Y))':b='if(lt(hypot(X-640,Y-380),150+20*sin(4*T)),110,b(X,Y))'",
  "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-an", join(MEDIA, "clips", "jam jar (landscape, no sound).mp4"));
ff("-f", "lavfi", "-i", "cellauto=s=720x720:rule=110:r=30:scroll=1", "-t", "5", "-f", "lavfi", "-i", "sine=f=880:d=5:samples_per_frame=4800",
  "-filter_complex", "[0:v]negate,colorchannelmixer=rr=0.3:gg=0.25:bb=0.2,format=yuv420p[v];[1:a]volume=0.05,tremolo=f=6:d=0.9[a]", "-map", "[v]", "-map", "[a]",
  "-c:v", "libx264", "-crf", "30", "-c:a", "aac", "-b:a", "64k", "-shortest", join(MEDIA, "clips", "sketching.mp4"));
const rotTmp = join(TMP, "bakery-landscape.mp4");
ff("-f", "lavfi", "-i", "color=c=0x3b2416:s=576x1024:d=5:r=30", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-filter_complex",
  "[0:v]drawbox=x=120:y=300:w=140:h=180:color=0xffc66b@0.9:t=fill,drawbox=x=320:y=300:w=140:h=180:color=0xffd98a@0.8:t=fill,drawbox=x=220:y=620:w=140:h=260:color=0x6b3b1e:t=fill,transpose=1[v]",
  "-map", "[v]", "-map", "1:a", "-t", "5", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", rotTmp);
ff("-display_rotation", "90", "-i", rotTmp, "-c", "copy", join(MEDIA, "clips", "bakery (stored sideways, silent).mp4"));

// --- talking-head fixture (fictional "Charlie-style" format): the picture is the voice's own waveform ---
// so speech/picture sync can be measured frame by frame after cutting and cleanup.
const th = (wav, out, label) => ff("-i", wav, "-filter_complex",
  `[0:a]showwaves=s=360x640:mode=cline:rate=30:colors=white:scale=sqrt[w];color=c=0x26323f:s=360x640:r=30[bg];[bg][w]overlay=shortest=1,format=yuv420p,drawtext=fontfile='${FONT}':text='${label}':fontsize=26:fontcolor=white:x=20:y=30[v]`,
  "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-crf", "34", "-preset", "slow", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", out);
const t1 = join(TMP, "take1.wav"), t2 = join(TMP, "take2.wav");
ff("-i", enWav, "-t", String(enWin[2].end_s + 0.3), "-c:a", "pcm_s16le", t1);
ff("-ss", String(enWin[3].start_s - 0.3), "-i", enWav, "-c:a", "pcm_s16le", t2);
th(t1, join(FX, "talking-head take 1.mp4"), "take 1");
th(t2, join(FX, "talking-head take 2.mp4"), "take 2");
ff("-i", join(FX, "talking-head take 1.mp4"), "-i", join(FX, "noisy-narration.m4a"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", join(FX, "talking-head noisy.mp4"));

// --- demo music bed: tools/synth-music.py (deterministic, synthesized from scratch, no samples) ----
const bed = join(TMP, "bed.wav"); execFileSync("python3", [join(ROOT, "tools", "synth-music.py"), bed, "45"], { stdio: "inherit" });
ff("-i", bed, "-c:a", "aac", "-b:a", "128k", join(MEDIA, "demo-music-bed.m4a"));
rmSync(TMP, { recursive: true, force: true });
console.log("fixtures written:", MEDIA, FX);
