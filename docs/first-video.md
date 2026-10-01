# Your first video — the starter prompt

1. Make a folder for the video anywhere (it does not go inside this repository), e.g.
   `~/Videos/my-first-video`, and copy in your narration recording and your clips and photos
   (into a `media` subfolder). Originals are never changed; copies are fine.
2. Open **this repository** in your coding agent (Claude Code, Codex, Cursor…) and paste:

```text
I want to make a short video with video-loop. Read AGENTS.md and follow it exactly.

My project folder: ~/Videos/my-first-video   (narration + clips + photos are in its media/ folder)
Style to start from: bene (voice-over with pictures throughout) — or: charlie (talking head)

Start with intake (prompts/intake.md): create the project if needed, run doctor and ingest, look
at the contact sheets, then ask me all your intake questions in ONE message with your
recommendation for each — including whether my recording needs voice cleanup, which caption look
(show me both), what music (my own file, generated from a brief, or none), where it will be posted
and how it should end. Ask before anything that costs ElevenLabs credits. Never approve for me.
```

3. Answer the questions. The agent writes the edit plan, shows you the board
   (`node bin/video-loop.mjs review <folder> --open`), and renders a preview after you approve.
4. Leave notes on the preview at the moments they apply ("Add note at 0:12.4"), press **Save
   notes to project** (or Download/Copy and give them to your agent), and ask for the next revision.
