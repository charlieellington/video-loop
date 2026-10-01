# Editorial plan — writing `edit.json` for the current revision

Plain English: the agent decides which words to keep and what picture shows over them. It writes
word NUMBERS only — never timestamps. The engine turns numbers into exact times, refuses anything
that does not fit, and shows the result on the board for the person to approve.

## Inputs
- `output/transcript.txt` — every word with its number and time (the line `transcript_sha256`
  must be copied into the plan).
- `.video-loop/sources.json` + contact sheets — what each picture/clip shows, its shape, sound.
- `project.toml` and the profile (`profiles/<name>.toml`): shot length guidance, face policy,
  whether every moment needs a picture (`editorial.full_cover`), hook/interludes switches.

## Method
1. **Find the spine.** What is the one story? Where does it sag or repeat? A repeated beat ships
   once — keep the best take of it.
2. **Cut by words.** Keep ranges of words (`segments`). Remove false starts, repeats and weak
   tails. Do not remove words from the middle of a sentence unless it still sounds natural.
   English filler removal does not apply to other languages; read the language first.
3. **Plan the picture.** For each beat choose a cover from material that exists: a clip (with an
   in-point `start_s`) or a still. Guidance: about `editorial.shot_target_s` seconds per shot —
   follow the speech, not a metronome. Match what is said where possible; open on the subject;
   close on the line or question.
4. **Cover everything when the format needs it.** In a voice-over (`recorded-audio`) every
   moment needs a picture, including pauses between sentences and the tail. Gaps up to
   `editorial.hold_gap_ms` are held automatically; longer pauses need a deliberate choice —
   `"hold_until_next": true` on the shot before the pause, a still, or reuse. The board lists
   every uncovered moment; approval is impossible until there are none.
5. **Sound of b-roll.** Muted by default. Keep a clip's own sound only when it means something
   (`"sound": "keep"`, `"sound_gain_db": -16` = 16 dB under the voice).
6. **Caption corrections.** If the transcript misheard a word, add `"caption_fixes": {"12": "Pip"}`.
   This changes displayed text only — never what is cut.
7. **Music brief** (if ElevenLabs music was chosen): one or two sentences in `music.prompt`.

## The file: `.video-loop/revisions/<rev>/edit.json`
```json
{
  "contract": "video-loop/edit@1",
  "transcript_sha256": "<from output/transcript.txt>",
  "notes": "why this cut and this picture order",
  "segments": [ { "first_word_i": 0, "last_word_i": 41, "reason": "…" } ],
  "covers": [ { "over_words": [0, 11], "media": "media/cover.png", "why": "…" },
              { "over_words": [12, 19], "media": "media/clip.mp4", "start_s": 1.5, "hold_until_next": true, "sound": "keep", "sound_gain_db": -16, "fit": "auto" } ],
  "caption_fixes": { "28": "bakery," },
  "interludes": [ { "after_word_i": 35, "clips": [ { "media": "media/clip.mp4", "start_s": 1, "dur_s": 1.5 } ] } ],
  "hook": { "duration_s": 4, "shots": [ { "media": "media/clip.mp4", "t0": 0, "t1": 4, "in_s": 0 } ], "lines": [ { "text": "…", "start": 0.4, "step": 0.3, "end": 3.9 } ] }
}
```
`interludes` and `hook` are used only when switched on in settings. Then run `video-loop board
<project>`, look at the board yourself, fix problems, and show it to the person.
