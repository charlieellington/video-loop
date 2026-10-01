// probe.mjs — the one place that asks ffprobe what a media file really contains.
// Plain English: a phone clip is often stored sideways with a "rotate me" note, so it PLAYS
// upright. ffmpeg applies that note when it decodes, so every filter must be built on the DISPLAY
// size, not the stored size. This file also answers "does this file have sound?", "is it a still
// photo?" and "is it HDR?" by asking ffprobe, never by trusting the file extension.
// Extracted from the away-loop lab's probe.mjs (rotation rule unchanged) and extended for audio.

import { execFileSync } from "node:child_process";
import { FFPROBE, Failure } from "./util.mjs";

/** Raw ffprobe JSON. */
export const ffprobeJson = (args) => JSON.parse(execFileSync(FFPROBE,
  ["-v", "error", "-of", "json", ...args], { encoding: "utf8", maxBuffer: 1 << 24 }));

const HDR_TRC = new Set(["arib-std-b67", "smpte2084"]);
const STILL_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "tiff", "gif", "heic", "hevc_image", "jpegxl"]);

/**
 * Everything the engine needs to know about one file, from the streams themselves.
 * kind: "video" | "image" | "audio" | "none"
 */
export function probeMedia(file) {
  let j;
  // NOTE ":stream_side_data=rotation" — asking for side_data_list alone returns EMPTY objects on
  // ffprobe 7.x and rotation silently reads as 0 (a real bug in the source pipeline).
  try {
    j = ffprobeJson(["-show_entries",
      "stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,color_transfer,sample_rate,channels,duration,start_time,nb_frames,tags:stream_disposition=attached_pic:stream_side_data=rotation:format=duration,format_name", file]);
  } catch (e) {
    return { kind: "none", error: `ffprobe could not read it (${String(e.message).split("\n")[0]})` };
  }
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic));
  const a = streams.find((s) => s.codec_type === "audio");
  const fmtDur = parseFloat(j.format?.duration ?? "NaN");
  const out = { has_video: !!v, has_audio: !!a, format: j.format?.format_name ?? "" };
  if (a) out.audio = { codec: a.codec_name, sample_rate: +a.sample_rate || null, channels: a.channels ?? null,
    duration_s: parseFloat(a.duration ?? fmtDur), start_s: parseFloat(a.start_time ?? "0") || 0 };
  if (v) {
    const rot = Number((v.side_data_list ?? []).find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0);
    const swap = Math.abs(rot) % 180 === 90;
    const [W, H] = swap ? [v.height, v.width] : [v.width, v.height];
    const rate = (v.avg_frame_rate && v.avg_frame_rate !== "0/0") ? v.avg_frame_rate : (v.r_frame_rate ?? "30/1");
    const [fn, fd] = rate.split("/").map(Number);
    const still = STILL_CODECS.has(v.codec_name) || /image2|png_pipe|jpeg_pipe|webp_pipe/.test(out.format)
      || (!Number.isFinite(fmtDur) && !a);
    out.video = { codec: v.codec_name, W, H, rot, fps: fd ? fn / fd : fn, frameRate: rate,
      transfer: v.color_transfer ?? null, hdr: HDR_TRC.has(v.color_transfer) };
    out.kind = still ? "image" : "video";
  } else out.kind = a ? "audio" : "none";
  out.duration_s = out.kind === "image" ? null : (Number.isFinite(fmtDur) ? fmtDur : out.audio?.duration_s ?? null);
  return out;
}

/** Display geometry of a video (rotation applied). Throws when there is no picture. */
export function probeDisplayGeometry(media) {
  const m = probeMedia(media);
  if (!m.has_video) throw new Failure(`no video stream in ${media}`);
  return { W: m.video.W, H: m.video.H, rot: m.video.rot, durS: m.duration_s, fps: m.video.fps, frameRate: m.video.frameRate };
}

/** Container duration in seconds. */
export const durationS = (media) => parseFloat(ffprobeJson(["-show_entries", "format=duration", media]).format.duration);
export const durationMs = (media) => Math.round(durationS(media) * 1000);

/** Audio stream duration in ms (falls back to the container). */
export function audioDurationMs(media) {
  const j = ffprobeJson(["-select_streams", "a:0", "-show_entries", "stream=duration:format=duration", media]);
  const d = parseFloat(j.streams?.[0]?.duration ?? j.format?.duration);
  return Math.round(d * 1000);
}
