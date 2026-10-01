# Your next video — the repeatable prompt

Each video is its own folder. Your settings from last time are a good starting point: copy the
previous `project.toml` into the new folder (not the `.video-loop` or `output` folders), put the
new narration and media in `media/`, and paste:

```text
Start my next video with video-loop. Read AGENTS.md and follow it.

New project folder: ~/Videos/<new-video>   (media is in its media/ folder)
Start from the settings in ~/Videos/<previous-video>/project.toml — same captions, music
approach and profile unless I say otherwise. Update the title and narration path.

Run doctor and ingest, look at the new material, and ask me only what is new or different this
time, in one message with your recommendations (e.g. does this recording need voice cleanup, a
new music brief or reuse my track). Ask before anything that costs ElevenLabs credits. Never
approve for me. Then write the edit plan, show me the board, and preview after I approve.
```

Generated music is cached per project; to reuse a track you liked, copy it into the new
project's `media/` and use `music.source = "file"`.
