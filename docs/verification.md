# Verification — what was checked for this release, and how

Plain English: the record of what was actually tested on 1 October 2026, what was tested only
against a fake ElevenLabs, and what was not tested, with the 5 October release attempt below.
Each line says which. Re-run the automatic
part with `npm test`; the rest with the commands shown.

## Tested setup
- macOS 26.3 (Apple silicon, arm64), Node 20.19.5, npm 10.
- FFmpeg 7.1.1 (Homebrew bottle 7.1.1_3, with libass + zimg) — main development build.
- FFmpeg 9.0.2 static build for arm64 (ffmpeg.martin-riedl.de) via `VIDEO_LOOP_FFMPEG` /
  `VIDEO_LOOP_FFPROBE` — doctor + full example render passed.
- Current Homebrew `ffmpeg` 9.0.2 formula: **no libass** (from its dependency list) — not usable
  for captions; doctor reports it. Linux and Intel Macs: untested.
- ElevenLabs: Scribe `scribe_v2` (live), Audio Isolation (live), Music `music_v1` (**live generation
  still refused**: permission enabled, but insufficient account/key credits — see below).

## Collection check on 5 October 2026

Restored the complete repository from the verified Stage 1 bundle at `0a19585` on a second
Apple-silicon Mac. `npm ci` succeeded. Node 22.23.2 rejected the original `node --test tests/`
command before discovering tests, so the package script now selects `tests/*.test.mjs` explicitly.
With Homebrew `ffmpeg-full` 9.0.2 selected through `VIDEO_LOOP_FFMPEG` and `VIDEO_LOOP_FFPROBE`,
doctor passed its real caption-burn check and all 20 tests passed, including two concurrent
offline example renders. The default FFmpeg 9.0.2 on PATH still lacks libass; select the full
build explicitly. No live ElevenLabs calls were made during collection; the music permission
limitation remained open. Human listening was subsequently explicitly waived
by Charlie for release; it is not a pending release check.

## Release attempt on 5 October 2026

One actual `music generate` command requested a 26-second instrumental track for the fictional
book example (`music_v1`, `/v1/music`, `mp3_44100_192`). The explicitly configured operator key was
valid but the server returned HTTP 401: “missing the permission music_generation”. The environment
and the documented env-file held the same key. No playable track was returned, no ambiguous
request was retried, and no additional transcription or isolation was purchased. Available browser
access required sign-in, so the key permission could not be changed in this session.

Charlie then enabled Music Generation on the configured key. One subsequent actual 26-second
request got past the permission check but was refused with HTTP 401: “You have insufficient
credits to generate this song. Please upgrade your plan to continue.” No playable track was
returned. The operator's available subscription does not permit automatic usage overage, and
available browser access still requires sign-in. Funding or an explicitly configured funded key
is now needed; the missing-permission blocker has been resolved.

The tool's error handling was corrected: this real HTTP 401 credit refusal now names the credit
balance/key usage limit instead of claiming the key was rejected. A fake-provider regression
check verifies this response and preserves the message for a genuinely invalid key. All 21
automated tests passed after this fix, with no skips on Node 22.23.2 / FFmpeg-full 9.0.2.

Charlie explicitly authorised proceeding with publication on 5 October while showing live Music
generation as **unproven**. No further paid Music request will be made for this release. Live
generation, a mix using the generated track, and its reuse across revisions have not passed.
The existing file-source example and fake-provider tests do not substitute for those live checks.
Public-clone verification is recorded separately below after publication.

Automated checks were rerun: doctor's real caption encode passed and all 20 tests passed with no
skips on Node 22.23.2 and FFmpeg-full 9.0.2. The actual offline example rendered at 540×960/30 fps,
23.833 s (−1 ms from its timeline), −14.32 LUFS and −2.71 dBTP, with 0 placeholder frames and 0
clipped samples in either original stereo channel. The narration-envelope comparison against the
voice-only output found 0 ms start/end lag (correlations 0.926/0.937); this checks presence/alignment,
not intelligibility. Highlight-caption evidence frames were visually inspected.

A real local browser played and sought the preview and saved a note at 5 s into the project.
`revise` carried it into r002; lowering the supplied synthetic bed by 6 dB and changing a display
caption rendered successfully (−14.32 LUFS, −2.73 dBTP, same duration and word cuts). The track hash
was reused and the r001 preview stayed byte-identical. This is the file-source revision flow;
generated-track reuse remains unverified live.

The standalone history audit inspected 120 reachable file versions (21 binary versions) across all
10 commits through `853008e`: no credential values, personal machine paths, private client/planning
references or absolute imports were found by the targeted scan. The tracked media list was checked
against the fixture generator and notices; narration and talking-head fixtures are synthetic. MIT
code and OFL font licences are included. The typing sound's original supersnd/Freesound page was
checked and labels sample 215744 CC0. This is a bounded release-content review, not a claim that a
pattern scan proves the absence of every possible secret.

Human listening is explicitly waived for release. Automated semantic audio inspection of the
fictional r002 supplied-music preview (Gemini via AIStudio) reported understandable synthetic
narration, an audible quieter synth bed, and no obvious clipped words or severe pumping. This is
a subjective model assessment, not a human listening pass or proof of live Music generation.
The measurements and visual inspection are recorded separately.

## Public release verification — 5 October 2026

The repository is public at `https://github.com/charlieellington/video-loop` (anonymous HTTP 200).
A fresh anonymous HTTPS clone at `2c114af` into a path with spaces passed `npm install`, doctor's
actual caption encode and `node bin/video-loop.mjs example` with an initially empty temporary
HOME, explicitly selected Node 22.23.2 / FFmpeg-full 9.0.2, and no API key or private configuration.
An initial minimal PATH omitted npm; adding the already-installed Node binary directory fixed the
verification environment before installation. No engine change was needed.

The fresh public example rendered at 540×960/30 fps, 23.833 s (−1 ms from its timeline),
−14.32 LUFS, −2.71 dBTP, 0 placeholder frames and no render warnings. The 21 passing engine
tests and earlier browser feedback/revision checks remain valid: changes after `4ff6a67` update
documentation only. Live generated music remains **unproven**, explicitly accepted as a release
limitation; no further paid Music requests were made.

The fresh clone's own local review server also played and sought the preview and saved a 5-second
note into the project's feedback JSON. README/docs relative links were checked: none are broken.

## Automated checks (`npm test`, 21 tests, all passing)
Core arithmetic and contracts; fake-ElevenLabs failure paths (no key, missing permission, rate
limit, timeout with no silent resend and an explicit `--retry`, non-audio and empty replies,
shifted / drifting / word-dropping cleanup refused, cleanup cache reuse, switching narration
invalidates the approval, unsupported music length, music cache reuse); placeholder-frame
detection; b-roll sound placement; review server ranges/traversal/feedback; two example projects
rendered concurrently from outside the repository with no API key, originals unchanged.

## Acceptance matrix

| Check | Result | How it was verified |
|---|---|---|
| Clean clone | PASS — public GitHub and bundle | fresh anonymous public clone at `2c114af`, `npm install`, doctor and offline example with empty temporary HOME/no key; 21 engine tests already passed. Earlier bundle rehearsals are recorded below |
| Narration and coverage | PASS | `.m4a` audio-only example: 100% covered incl. pauses/tail (pause gaps are refused until covered or deliberately held), 0 placeholder frames in every render, duration Δ ≤ 1 ms vs timeline |
| Both profiles | PASS | Bene-style example and a fictional Charlie-style talking head (two takes → reel, typed hook, interlude, warm grade, punch-ins, mono-box captions, music moments) through the same engine. With hook/interludes/grade/music switched off, none appear even though the edit plan still contains hook and interlude blocks and the music file exists; 720×1280 @ 25 fps reached the master |
| Media handling | PASS | paths with spaces and accents (`página 3 – één maan.png`, temp dirs `vl test ü-…`), 576×1024 portrait, 1280×720 landscape, 720×720 square, a clip stored sideways (shown upright), clips with no sound track and with a silent track, an HLG-tagged clip (tone-mapped); media hashes identical before and after rendering |
| Live ElevenLabs — Scribe | PASS (live) | fictional English narration: 76 words, `eng` p=0.97, 0 words outside the known sentence windows; Dutch fixture: 28 words, `nld` p=0.996, 0 outside; cleaned narration: 76 words |
| Live ElevenLabs — Audio Isolation | PASS (live) | noisy fictional narration (26 s): background −39.3 → −62.0 dB, 100% of speech frames kept, 0 ms shift, 0 ms drift; returned `audio/mpeg` 44.1 kHz; transcript of the cleaned version = clean source except 1 word (75/76 identical, max 40 ms timing difference). Noisy talking head (12 s): −39.2 → −69.5 dB, speech/picture offset identical to the clean source (−60/−65 ms with the sync meter) |
| Live ElevenLabs — Music | **UNPROVEN LIVE — released with explicit waiver** | after Music Generation permission was enabled, the actual 26-second request was refused with HTTP 401 for insufficient credits. No generated audio was returned. Request sizing, caching/reuse, credit/auth failures, non-audio and timeout handling are covered by fake-server tests; file-source mixing is verified |
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
- Live ElevenLabs Music generation, generated-track mixing and reuse are **unproven**. Charlie
  explicitly waived this release gate on 5 October and asked to publish with the limitation
  visible. Supplied-file and no-music paths are verified. A future live check needs a funded key
  with Music Generation access; no successful generation is claimed for this release.
- Synthetic narration bridges and the face touch-up from the private pipeline were not extracted.
- Human listening review was explicitly waived by Charlie on 5 October 2026. No human listening
  pass happened, and none is claimed. Automated measurements (noise floor, speech retention,
  loudness and peaks) establish only the properties they measure. People making their own videos
  still review and choose their narration and final preview.
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
