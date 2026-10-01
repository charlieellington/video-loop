# Feedback → the next revision

Plain English: the person watches the preview and leaves notes (in the review page, a downloaded
`feedback-rNNN.json`, or simply in chat). The agent turns each note into a specific change,
starts a new revision so the old one stays watchable, and renders again.

1. `video-loop revise <project>` (or `--notes <downloaded file>`) — opens the next revision, copies
   the edit plan forward and files the notes in `.video-loop/revisions/<new>/feedback/`.
2. For each note, decide the smallest change and where it lives:
   - a different picture → `covers[].media` / `start_s` in the new `edit.json`;
   - a caption word → `caption_fixes` (display only; cuts unchanged);
   - a cut, a trim, a different take → `segments`;
   - music quieter/louder → `music.level_db` in `project.toml` (no new music is generated);
   - a different music mood → a new `music.prompt`, then `video-loop music generate` (paid, deliberate);
   - b-roll sound → `sound` / `sound_gain_db` on that cover;
   - caption look/position → `[captions]` in `project.toml`.
   If a note is unclear, ask — don't guess at taste.
3. Write what changed, note by note, in `.video-loop/revisions/<new>/changes.md`.
4. `video-loop board` → show the person → `video-loop approve` → `video-loop preview`.
   Narration and its transcript are reused; only changed work is redone.
5. When they accept a preview: `video-loop finish <project>`. Nothing is uploaded or posted.
