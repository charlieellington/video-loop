// render-cut.mjs — cuts the picture and the narration from the same cut list, as separate tracks.
// Plain English: from the exact millisecond in/out points this makes (1) the picture of the kept
// pieces, fitted to the chosen canvas and frame rate, and (2) the narration on its own, with tiny
// 6 ms fades at each join so nothing clicks. Keeping the voice separate until the final mix is what
// lets music and b-roll sound be adjusted later without touching the narration. Extracted from the
// away-loop lab's laneA/render.mjs (single ffmpeg pass, 6 ms fades, optional alternating punch-in,
// join-scaled duration tolerance); the warm grade and punch-ins are now profile choices.

import { ffmpeg, sec, Failure, log } from "./util.mjs";
import { durationMs, audioDurationMs } from "./probe.mjs";

const FADE = 0.006, ZOOM = 1.06, MIN_PUNCH_TOGGLE_S = 1.2, CROP_TOP_BIAS = 0.35;
// The lab's "L1 paper warm" grade (Charlie's pick), applied to talking-head footage only.
export const GRADES = {
  natural: null,
  warm: "colortemperature=temperature=5700:mix=0.65:pl=0.6,curves=all='0/0.018 0.20/0.21 0.50/0.515 0.80/0.81 1/0.985':interp=pchip,eq=saturation=0.90:contrast=1.015",
};
export const tolerance = (n) => 100 + Math.max(0, n - 10) * 4;   // ±100 ms + 4 ms per join beyond ten
/** Standard-colour tags on every frame (encoders take colour info from frames, not only from options). */
export const BT709 = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
export const HDR_TONEMAP = "zscale=t=linear:npl=203,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p";

/** Even render size for a scale factor. */
export const renderSize = (cfg, scale) => ({ W: 2 * Math.round(cfg.canvas.width * scale / 2), H: 2 * Math.round(cfg.canvas.height * scale / 2) });

/** Fit any picture into W×H by policy: blur (blurred self behind), crop (fill), contain (black bars). */
export function fitChain(label, W, H, fit, out) {
  if (fit === "crop") return `[${label}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[${out}]`;
  if (fit === "contain") return `[${label}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[${out}]`;
  return `[${label}]split=2[${out}a][${out}b];[${out}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${Math.max(8, Math.round(W / 24))},eq=brightness=-0.05[${out}bg];` +
    `[${out}b]scale=${W}:${H}:force_original_aspect_ratio=decrease[${out}fg];[${out}bg][${out}fg]overlay=(W-w)/2:(H-h)/2,setsar=1[${out}]`;
}

/** The picture of the kept segments (no audio). */
export function renderPicture({ cuts, spine, cfg, scale, out, hdr = false }) {
  if (cuts.segments.some((s) => s.in_frame == null)) throw new Failure("internal: cuts are not snapped to frames");
  const { W, H } = renderSize(cfg, scale); const fps = cfg.canvas.fps;
  const own = spine.hasOwnPicture; const grade = own ? GRADES[cfg.presentation.grade] : null;
  const parts = []; let punch = false; const pattern = [];
  cuts.segments.forEach((s, k) => {
    const durS = (s.out_ms - s.in_ms) / 1000;
    if (cfg.editorial.punch_in && k > 0 && durS >= MIN_PUNCH_TOGGLE_S) punch = !punch;
    pattern.push(punch ? "Z" : "·");
    // frame-exact: the spine is first put on the canvas frame grid, then cut by frame number
    const chain = [`trim=start_frame=${s.in_frame}:end_frame=${s.out_frame}`, "setpts=PTS-STARTPTS", ...(hdr ? [HDR_TONEMAP] : [])];
    parts.push(`[g${k}]${chain.join(",")}[r${k}]`);
    parts.push(fitChain(`r${k}`, W, H, own ? cfg.canvas.fit : "crop", `f${k}`));
    const post = [...(punch ? [`scale=trunc(iw*${ZOOM}/2)*2:trunc(ih*${ZOOM}/2)*2`, `crop=${W}:${H}:(in_w-${W})/2:(in_h-${H})*${CROP_TOP_BIAS}`] : []), ...(grade ? [grade] : []), "format=yuv420p", "setsar=1"];
    parts.push(`[f${k}]${post.join(",")}[v${k}]`);
  });
  parts.unshift(`[0:v]fps=${fps},split=${cuts.segments.length}${cuts.segments.map((_, k) => `[g${k}]`).join("")}`);
  parts.push(`${cuts.segments.map((_, k) => `[v${k}]`).join("")}concat=n=${cuts.segments.length}:v=1:a=0,${BT709}[v]`);
  ffmpeg(["-i", spine.file, "-filter_complex", parts.join(";"), "-map", "[v]", "-an",
    "-c:v", "libx264", "-preset", scale < 1 ? "veryfast" : "fast", "-crf", scale < 1 ? "23" : "17", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-r", String(fps), out]);
  const got = durationMs(out), d = got - cuts.expected_duration_ms, tol = tolerance(cuts.segments.length);
  log(`PICTURE: ${cuts.segments.length} segment(s) → ${W}×${H} @ ${fps} fps${grade ? ` · ${cfg.presentation.grade} grade` : ""}${cfg.editorial.punch_in ? ` · punch-in ${pattern.join("")}` : ""} · ${got} ms (expected ${cuts.expected_duration_ms}, Δ${d})`);
  if (Math.abs(d) > tol) throw new Failure(`picture length is off by ${d} ms (tolerance ±${tol} ms)`);
  return { file: out, W, H, duration_ms: got };
}

/** The narration of the kept segments, with 6 ms edge fades (no overlapping crossfades: those shift time). */
export function renderVoice({ cuts, wav, out }) {
  const parts = cuts.segments.map((s, k) => {
    const d = (s.out_ms - s.in_ms) / 1000;
    return `[0:a]atrim=start=${sec(s.in_ms)}:end=${sec(s.out_ms)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${FADE},afade=t=out:st=${Math.max(0, d - 0.008).toFixed(3)}:d=${FADE}[a${k}]`;
  });
  parts.push(`${cuts.segments.map((_, k) => `[a${k}]`).join("")}concat=n=${cuts.segments.length}:v=0:a=1[a]`);
  ffmpeg(["-i", wav, "-filter_complex", parts.join(";"), "-map", "[a]", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]);
  const got = audioDurationMs(out), d = got - cuts.expected_duration_ms;
  if (Math.abs(d) > 20) throw new Failure(`narration cut length is off by ${d} ms`);
  return { file: out, duration_ms: got };
}
