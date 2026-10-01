# Verification — what was checked for this release, and how

Plain English: the record of what was actually tested on 1 October 2026, what was tested only
against a fake ElevenLabs, and what was not tested. Each line says which. Re-run the automatic
part with `npm test`; the rest with the commands shown.

## Tested setup
- macOS 26.3 (Apple silicon, arm64), Node 20.19.5, npm 10.
- FFmpeg 7.1.1 (Homebrew bottle 7.1.1_3, with libass + zimg) — main development build.
- FFmpeg 9.0.2 static build for arm64 (ffmpeg.martin-riedl.de) via `VIDEO_LOOP_FFMPEG` /
  `VIDEO_LOOP_FFPROBE` — doctor + full example render passed.
- Current Homebrew `ffmpeg` 9.0.2 formula: **no libass** (from its dependency list) — not usable
  for captions; doctor reports it. Linux and Intel Macs: untested.
- ElevenLabs: Scribe `scribe_v2` (live), Audio Isolation (live), Music `music_v1` (**live call
  refused**: the available key lacks the `music_generation` permission — see below).

## Automated checks (`npm test`, 20 tests, all passing)
Core arithmetic and contracts; fake-ElevenLabs failure paths (no key, missing permission, rate
limit, timeout with no silent resend and an explicit `--retry`, non-audio and empty replies,
shifted / drifting / word-dropping cleanup refused, cleanup cache reuse, switching narration
invalidates the approval, unsupported music length, music cache reuse); placeholder-frame
detection; b-roll sound placement; review server ranges/traversal/feedback; two example projects
rendered concurrently from outside the repository with no API key, originals unchanged.

## Acceptance matrix

| Check | Result | How it was verified |
|---|---|---|
| Clean clone | PASS — see "Fresh-clone rehearsal" below | fresh `git clone` of the bundle into an empty folder, `npm install`, doctor, example, `npm test`; no API key in the environment |
| Narration and coverage | PASS | `.m4a` audio-only example: 100% covered incl. pauses/tail (pause gaps are refused until covered or deliberately held), 0 placeholder frames in every render, duration Δ ≤ 1 ms vs timeline |
| Both profiles | PASS | Bene-style example and a fictional Charlie-style talking head (two takes → reel, typed hook, interlude, warm grade, punch-ins, mono-box captions, music moments) through the same engine. With hook/interludes/grade/music switched off, none appear even though the edit plan still contains hook and interlude blocks and the music file exists; 720×1280 @ 25 fps reached the master |
| Media handling | PASS | paths with spaces and accents (`página 3 – één maan.png`, temp dirs `vl test ü-…`), 576×1024 portrait, 1280×720 landscape, 720×720 square, a clip stored sideways (shown upright), clips with no sound track and with a silent track, an HLG-tagged clip (tone-mapped); media hashes identical before and after rendering |
| Live ElevenLabs — Scribe | PASS (live) | fictional English narration: 76 words, `eng` p=0.97, 0 words outside the known sentence windows; Dutch fixture: 28 words, `nld` p=0.996, 0 outside; cleaned narration: 76 words |
| Live ElevenLabs — Audio Isolation | PASS (live) | noisy fictional narration (26 s): background −39.3 → −62.0 dB, 100% of speech frames kept, 0 ms shift, 0 ms drift; returned `audio/mpeg` 44.1 kHz; transcript of the cleaned version = clean source except 1 word (75/76 identical, max 40 ms timing difference). Noisy talking head (12 s): −39.2 → −69.5 dB, speech/picture offset identical to the clean source (−60/−65 ms with the sync meter) |
| Live ElevenLabs — Music | **NOT VERIFIED LIVE** | the only available key is refused with HTTP 401 "missing the permission music_generation". The request path, sizing (film + 1.5 s, 3–600 s bounds), caching, reuse, non-audio and timeout handling are covered by the fake-server tests; mixing is identical to the file path (verified) |
| Voice cleanup | PASS | noise reduced, original kept and selectable, loudness-matched comparison page, start/end alignment + drift + speech-retention checks, talking-head sync after cleanup; no repeat isolation on caption/music revisions (cache); switching narration invalidates the transcript binding and the approval |
| Music behaviour | PASS (file source) | continuous bed under a no-hook voice-over, ducked under speech; revision 2 lowered `level_db` −18 → −24 and every narration pause measured exactly 6.0 dB quieter; no regeneration on caption/volume revisions |
| Audio failures | PASS (fake server) | as listed under automated checks; continuing with the original is the explicit `voice select original` |
| Captions | PASS | all three presets burned and frame-checked; highlight shows before / within / after a word with no layout jump; accented Dutch (één, café) renders; caption fixes change display only (cuts identical r001 vs r002); ASS braces/backslashes escaped |
| Timing | PASS | cuts snapped to the frame grid (sound and picture cut at the same instants); hook + interlude offsets applied once (unit test + render); sync meter on the talking-head preview: −55 ms vs source −60 ms in face sections; stale approvals refused after narration/config/edit changes |
| Review loop | PASS (browser) | local server with range requests; real Chromium: playback, seeking, three notes added at the playhead, saved to the project (claimed only after the server confirmed), downloaded as `feedback-r001.json`; `revise` → r002 with a visual swap, a caption fix and a quieter bed; r001 preview byte-identical afterwards |
| Independence | PASS | two projects rendered at the same time with separate state and scratch folders; base example runs without the optional hook module or Chromium |
| Master | PASS | 1080×1920 @ 30 fps H.264/AAC 48 kHz stereo, −14.27 LUFS, −2.85 dBTP (r002 of the example loop); 720×1280 @ 25 fps master for the plain Charlie-style project; bt709 colour tags |
| Release contents | PASS | tracked files and history scanned for personal paths, client names, emails and keys: none; fonts OFL with licence texts; example media generated (CC0) |

## Findings fixed during verification
- Sound and picture were cut at slightly different instants (picture snaps to frames) — up to a
  frame of drift per segment. Cuts and insert points are now snapped to the frame grid.
- Reel takes: each take's sound is now trimmed to its picture's whole-frame length.
- An `atrim` after `adelay` placed kept b-roll sound at the start of the film. Fixed + regression test.
- True peak could exceed −1.5 dBTP with music moments; the limiter now steps down until it fits.
- The review page script ran before the player existed. Fixed (found in the browser test).
- The placeholder check flagged real magenta in footage; it now counts whole placeholder frames.
- Output colour tags were partly unknown; every picture stage now tags bt709.

## Not covered / limitations
- Live ElevenLabs Music (permission). Stage 1 is **not fully ready for Bene** until one live music
  generation passes: enable `music_generation` on the key (or use a key that has it) and run
  `video-loop music generate` on the example with `music.source = "elevenlabs"`.
- Synthetic narration bridges and the face touch-up from the private pipeline were not extracted.
- Listening: no human listening pass happened in this unattended build. The measurements above
  (noise floor, speech retention, loudness, peaks) are not a substitute for listening to the
  cleaned voice and the mix.
- The `typewriter-highlight` box shows the whole phrase's box from the phrase start (words fill
  in); it does not grow word by word.
- Windows, Linux and Intel Macs are untested.

## Fresh-clone rehearsal
From the Git bundle, into a new folder whose path contains a space, with an empty temporary HOME
(so no personal configuration or credential files exist) and no `ELEVENLABS_API_KEY`:
`git clone video-loop.bundle "…/video loop"` → `npm install` → `node bin/video-loop.mjs doctor`
(OK) → `node bin/video-loop.mjs example "…/my example"` (preview rendered: 540×960 @ 30 fps,
23.83 s, −14.3 LUFS, −2.41 dBTP, 0 placeholder frames) → `npm test` (20/20 pass).

## Re-running the measurements
```bash
npm test
node bin/video-loop.mjs example /tmp/pip && node bin/video-loop.mjs review /tmp/pip --open
node tools/measure-sync.mjs <video> 4.3-10.3 --crop 540:480:0:160   # talking-head fixture only
```
