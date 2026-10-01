# Media notice — the fictional example

Everything in this folder is invented and synthetic, made for this repository by
`tools/make-fixtures.mjs`, and dedicated to the public domain (CC0 1.0):

- `media/narration.m4a` — synthetic speech (eSpeak NG, voice `en-gb-x-rp`), seven invented sentences.
- `media/book pages/*.png` — generated pages (flat colour, a circle "moon", a line of Lato text).
- `media/clips/*.mp4` — generated with FFmpeg test sources (gradients, cellular automata, shapes).
  Deliberately varied: 576×1024 portrait (WhatsApp-sized) with sound, 1280×720 landscape with no
  sound track, 720×720 square with sound, and one stored sideways (rotation metadata) with a silent track.
- `media/demo-music-bed.m4a` — synthesized by `tools/synth-music.py` (no samples).
- `plan/transcript.json` — word timings from a live ElevenLabs Scribe run on `narration.m4a`,
  checked against the known sentence windows (`tests/fixtures/speech-windows.json`): 0 of 76 words
  outside them. Bound to the narration by its sha256.
- `plan/edit.json` — the example's edit plan (word numbers only).

No real person, place, voice or footage appears anywhere.
