# Setup

Plain English: what to install, how to check it works, what using ElevenLabs costs, and what to
do when something is missing.

## 1. Node.js
Node 20.19 or newer (`.node-version` pins the tested 20.19.5; also tested with 22.23.2).
`node --version` to check.

## 2. FFmpeg with libass — read this, it changed
Captions are burned in with libass. **Today's default Homebrew `ffmpeg` (9.0.x) is built without
libass**, so `brew install ffmpeg` alone gives you an FFmpeg that cannot burn captions (Homebrew's
own dependency list shows it; `video-loop doctor` fails with "missing: ass"). Routes, honestly labelled:

| Route | Status |
|---|---|
| Static FFmpeg 9.0.2 for Apple silicon from ffmpeg.martin-riedl.de: download `ffmpeg.zip` and `ffprobe.zip`, unzip anywhere, then `export VIDEO_LOOP_FFMPEG=/path/to/ffmpeg VIDEO_LOOP_FFPROBE=/path/to/ffprobe` | **Verified 1 Oct 2026**: doctor passes, the full example renders. Changes nothing else on the machine. |
| Homebrew FFmpeg 7.1.1_3 (an older bottle that included libass) | **Verified** on the machine this release was built on. No longer what `brew install ffmpeg` gives you. |
| Homebrew `ffmpeg-full` (keg-only), selected explicitly as below | **Verified 5 Oct 2026**, version 9.0.2 already installed on the collection Mac: doctor and all 20 tests passed, including offline example renders. Installation itself was not repeated. |
| Linux distribution FFmpeg (usually built with libass) | Untested. |

Whatever you choose, `node bin/video-loop.mjs doctor` is the judge: it lists every filter the
engine needs and makes a real one-second encode with a burned caption in a bundled font.
HDR footage (iPhone HLG/Dolby Vision exports) needs `zscale` + `tonemap` (both routes above have
them). Without them HDR clips are refused rather than shown washed out; SDR clips are unaffected.

To select an installed `ffmpeg-full` build for the current shell:

```bash
export VIDEO_LOOP_FFMPEG="$(brew --prefix ffmpeg-full)/bin/ffmpeg"
export VIDEO_LOOP_FFPROBE="$(brew --prefix ffmpeg-full)/bin/ffprobe"
```

## 3. The repository
```bash
git clone https://github.com/charlieellington/video-loop.git && cd video-loop
npm install
node bin/video-loop.mjs doctor
node bin/video-loop.mjs example ~/Videos/pip-example   # offline, no key
```
`npm test` runs the automated checks (about a minute; uses a fake ElevenLabs, never the real one).

## 4. ElevenLabs (optional)
Used for: Scribe transcription, Audio Isolation (voice cleanup) and Music. Create an API key in
ElevenLabs → Developers → API keys, with the permissions for the features you will use
(speech-to-text, audio isolation, music generation — a key without `music_generation` is refused
with a message naming the permission). Then either `export ELEVENLABS_API_KEY=…` or put
`ELEVENLABS_API_KEY=…` in a `.env` file **inside your video project folder** (see `.env.example`).
video-loop never reads keys from your home directory and never writes them anywhere.

Costs are usage-based and change; see https://elevenlabs.io/pricing/api. What is sent where:
- voice cleanup sends **only the narration recording** you chose to clean;
- transcription sends the narration version you chose (original or cleaned);
- music generation sends only your text brief and the length — no audio or footage.
Each happens only when you run the command for it, and is cached so caption, volume or picture
changes never send it again.

## Troubleshooting
| Message | Fix |
|---|---|
| `filters missing: ass` | your FFmpeg has no libass — section 2 |
| `HDR … no zscale/tonemap` | use an FFmpeg with zimg (section 2) or an SDR export of that clip |
| `… with no picture at 5.90s (near word 19 …)` | a voice-over pause has no picture: add a cover, extend one, or `"hold_until_next": true` |
| `lacks the "music_generation" permission` | enable it for the key in ElevenLabs, or supply a music file |
| `ended without a clear result — it may or may not have been charged` | check your ElevenLabs usage page, then rerun with `--retry` deliberately |
| `the approval … no longer matches — changed since approval: …` | something you approved changed; run `board`, look, `approve` again |
| `the music is 26.0s but the film is 31.0s` | `music generate` again (sized to the new edit) or `music.loop = true` |
| `narration … is silent / too short / has no audio stream` | export the recording again with sound |
