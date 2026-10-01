# AGENTS.md — how a coding agent makes a video with video-loop

You are helping a person make and revise a short narrated video on their own computer. You
supply editorial judgement; the engine does every timestamp, render and check. Any agent that can
run shell commands and look at images can follow this. (`CLAUDE.md` just points here.)

## Ground rules
- **Ask before anything that costs money.** Voice cleanup, ElevenLabs transcription and music
  generation are paid by usage. Each is a deliberate step the person has chosen in `project.toml`.
  Never resend a paid request that ended unclearly — the tool refuses unless `--retry` is given;
  only pass it after the person agrees.
- **Never write timestamps.** Plans use word numbers from `output/transcript.txt`.
- **Never approve on the person's behalf.** Run `approve` only after they have looked at the board
  and said yes. Approval is bound to exactly what they saw.
- **Never modify their media files**, never publish or upload, never put API keys in files you
  create (keys live in `ELEVENLABS_API_KEY` or the project's `.env`).
- **Read exit codes.** 0 done · 1 failed (read the message) · 2 waiting for you/them (do the NEXT
  step printed) · 3 needs approval · 64 usage.
- **Look at images.** Contact sheets (`.video-loop/cache/thumbs/`), the board's caption sample and
  the evidence frames (`output/<rev>/preview-frames/`) are how you see the video.

## The loop (commands take the project folder)
1. **Set up:** `node bin/video-loop.mjs init <folder> --profile bene|charlie`, ask them to put
   narration + clips + photos in `<folder>/media`, then `doctor <folder>`.
2. **Intake:** follow `prompts/intake.md`. Run `ingest <folder>`. Ask all intake questions in one
   message with a recommendation for each; record answers in `project.toml`.
3. **Voice cleanup (only if chosen):** `voice clean <folder>` → they listen to
   `output/voice-compare.html` (both at equal loudness) → `voice select <folder> cleaned|original`
   → `ingest <folder>` again (transcribes the chosen version).
4. **Edit plan:** follow `prompts/editorial-plan.md`; write `.video-loop/revisions/<rev>/edit.json`.
5. **Board:** `board <folder>`; fix every listed problem (uncovered moments, missing media). Look at
   `output/<rev>/review.html` and the caption sample yourself first, then show them
   (`review <folder> --open`).
6. **Music (only if ElevenLabs music was chosen):** agree the brief in `music.prompt`, then
   `music generate <folder>`. It is reused for every later revision; regenerate only on request.
7. **Approve** (after their yes): `approve <folder>`.
8. **Preview:** `preview <folder>`. Read the WARN lines and the manifest
   (`output/<rev>/preview-manifest.json`); look at the evidence frames. Tell them what to listen
   for: clarity of the voice, music level, any clipped word or pumping.
9. **Feedback:** they leave notes in the review page (Save to project / Download / Copy) or in
   chat. `revise <folder>` and follow `prompts/feedback-revision.md`. Back to step 5.
10. **Finish:** when they accept a preview, `finish <folder>`. Report the master path, its length,
    loudness and the `.srt`. Nothing is posted.

## Where things live (per project)
`project.toml` settings · `media/` their files (read-only to you) · `output/transcript.txt` the
numbered words · `.video-loop/revisions/rNNN/` edit.json, cuts, timeline, approval, feedback,
changes.md, manifests · `output/rNNN/` review page, preview/master, `.srt`, voice-only, frames.

## When something fails
Read the message — it names the cause and the next step. Common ones: FFmpeg without libass
(docs/setup.md), an uncovered moment in a voice-over (add a cover or `hold_until_next`), a key
missing a permission (ElevenLabs → API keys → enable it), music shorter than the film (generate a
longer one or set `music.loop = true`). More in the troubleshooting section of docs/setup.md.
