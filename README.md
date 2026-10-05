# video-loop

Make and revise short narrated videos on your own computer, with your coding agent doing the
editing. You bring a recorded voice-over (or a talking-head recording) and your clips and photos.
The agent reads the transcript, proposes which words to keep and what picture shows over each
line, and you approve a storyboard. Then the tool renders a preview with real captions and the
real music mix, you leave notes against the timeline, and the agent makes the next revision. When
you are happy, it renders the master. Everything stays on your machine unless you choose an
ElevenLabs feature.

**What it is not.** It is not a timeline editor and it does not watch your video for you. The
agent works from the word-timed transcript, contact sheets and still frames — and writes word
numbers, never timestamps. The engine turns those numbers into exact cuts and refuses anything
that does not fit. Taste stays with you: the first cut needs your approval, and the tool never
posts a finished video.
ElevenLabs operations send the selected recording or music brief only when you choose them.

## Requirements

- macOS (tested on macOS 26.3, Apple silicon). Linux should work but is untested.
- **Node.js 20.19–24.x** (tested 20.19.5 and 22.23.2).
- **FFmpeg with libass** (captions) — see [docs/setup.md](docs/setup.md). Heads-up: today's default
  Homebrew `ffmpeg` (9.0.x) is built *without* libass. `video-loop doctor` tells you.
- Optional: an **ElevenLabs API key** for transcription (Scribe), voice cleanup (Audio
  Isolation) and generated music. These are paid by usage — [current prices](https://elevenlabs.io/pricing/api).
  Without a key you can still use a prepared transcript, your own music file, and no cleanup.
- Optional: Chromium via Playwright, only for the typed-text opening hook.

## Quick start

```bash
git clone https://github.com/charlieellington/video-loop.git && cd video-loop
npm install
node bin/video-loop.mjs doctor                      # checks FFmpeg, libass, fonts — with a real test render
node bin/video-loop.mjs example ~/Videos/pip-example  # renders the fictional example, no API key needed
node bin/video-loop.mjs review ~/Videos/pip-example --open
```

Then start your own: open this folder in your coding agent and paste the starter prompt from
[docs/first-video.md](docs/first-video.md). For every video after that, use
[docs/next-video.md](docs/next-video.md).

## The method

```
init → doctor → ingest → (voice clean → listen → voice select) → agent writes edit.json
     → board → (music generate) → approve → preview → review + notes → revise → … → finish
```

- **Recorded voice first.** Your narration is the spine. A voice recording (`.m4a`, `.wav`,
  `.mp3`) gets pictures over every moment; a talking-head video shows you where no b-roll covers it.
- **Optional voice cleanup, before anything is cut.** ElevenLabs Audio Isolation removes
  background noise from the narration only (never music or b-roll sound). You hear original and
  cleaned side by side at the same loudness and choose. The original is never changed. The tool
  checks the cleaned version did not shift, drift or drop words before it can be chosen.
- **Edits are word numbers.** The transcript is bound to the exact recording (and its timings) by
  fingerprint. Change the narration and old plans and approvals stop matching — on purpose.
- **Approval is bound to what you saw.** Narration, transcript, edit, settings, music and media
  are fingerprinted at approval. Change any of them and the preview refuses until you approve again.
- **Every revision is kept.** `output/r001`, `output/r002`, … each with its preview, captions
  file, evidence frames and a manifest saying exactly what produced it.
- **Captions:** `outline-phrase`, `typewriter-highlight` (words appear as spoken, current word
  inverted — really rendered, frame-checked) and `mono-box`. Corrections change displayed words
  only, never the cut. A plain `.srt` is always written.
- **Music:** none, your own file, or generated once by ElevenLabs from a brief and reused for every
  revision. It sits a set number of dB under the voice and dips while you speak.

## Conventions

| Exit code | Meaning |
|---|---|
| 0 | done |
| 1 | something failed (the message says what, and what to do) |
| 2 | waiting for a person or the agent (write the edit plan, choose a narration, generate music…) |
| 3 | the plan needs approval, or changed since it was approved |
| 64 | usage error |

A project is any folder with a `project.toml`; its working records live in `.video-loop/` next
to it and renders in `output/`. Your media files are never written to. Settings are explained in
[docs/configuration.md](docs/configuration.md); the agent's contract in [AGENTS.md](AGENTS.md).

## The fictional example

`examples/fictional-book` — "Pip and the Paper Moon", a 24-second story about making a book for an
imaginary fox. Synthetic voice, generated pages and clips, a synthesized music bed: no real person
or footage anywhere. It deliberately includes a WhatsApp-sized portrait clip, a landscape clip, a
square clip, a clip stored sideways, silent clips, and file names with spaces and accents. It
renders offline with the bundled word-timed transcript.

## Profiles

Two starting styles, both just settings: `profiles/bene.toml` (recorded voice-over, pictures
throughout, about 2.5-second shots, natural colour, outlined phrase captions, continuous ducked
music bed when you choose one) and `profiles/charlie.toml` (talking-head takes, warm grade,
alternating punch-ins, cream/ink mono captions, typed hook and music "moments"). Anything in a
profile can be overridden in `project.toml`.

## What is in the repository

| Path | What it is |
|---|---|
| `bin/video-loop.mjs` | the command line |
| `engine/` | the engine: narration, cleanup, transcription, cuts, timeline, covers, captions, music, mix, board, review server, evidence |
| `prompts/` | intake, editorial plan and feedback prompts for your agent |
| `profiles/`, `templates/project.toml` | starting styles and the project template |
| `assets/` | bundled OFL fonts and a CC0 typing sound (licences in `THIRD_PARTY_NOTICES.md`) |
| `examples/fictional-book/` | the runnable fictional example |
| `docs/` | setup, configuration, first and next video, optional integrations, verification |
| `tests/` | automated checks (`npm test`), including a fake ElevenLabs for every failure path |
| `tools/` | maintainers only: how the fixtures were made, the sync meter, the demo music synthesizer |

## How this was built

Extracted from a private pipeline Charlie Ellington used to make his own weekly videos
(word-index cutting with integer-millisecond arithmetic, cover assembly, loudness mastering,
typed hooks), then generalised so another person's format runs through the same engine as a
profile. Built with Claude Code. Verification notes, including what was checked live against
ElevenLabs and what was not, are in [docs/verification.md](docs/verification.md).

## Thank you

FFmpeg and libass do the real work. Fonts: Geist Mono (Vercel), Lato (Łukasz Dziedzic),
Courier Prime (Quote-Unquote Apps) — all SIL Open Font License. Typing sound: CC0 (freesound
215744). ElevenLabs for Scribe, Audio Isolation and Music.

## Licence and support

MIT for the code (see `LICENSE`); bundled assets keep their own licences (`THIRD_PARTY_NOTICES.md`).
This is shared as-is: issues and pull requests are welcome, but no maintenance or support is promised.
