# Optional integrations

None of these are needed to make a video locally.

- **Typed-text opening hook** (`presentation.hook = "typed"`, Charlie's profile): needs the
  optional `playwright-core` package (`npm install` installs it) and a Chromium build
  (`npx playwright-core install chromium`, or set `VIDEO_LOOP_CHROME`). Doctor checks it only
  when the hook is switched on. A base voice-over project never loads it.
- **Synthetic narration** (`voice_synthesis`): off by default and not used by any command in this
  release beyond validation. If you enable it you must name an explicit `voice_id`; there is no
  voice lookup or cloning. Narration should be your own recording.
- **Conductor or other agent hosts:** open the repository as a normal workspace; nothing needs
  configuring. Projects live outside the repository, so several can run side by side — each keeps
  its own `.video-loop` state and scratch folders, and the review server picks a free port.
- **Sending, emailing, uploading, posting:** deliberately not included. The tool ends at a master
  file, an `.srt` and a manifest. Publishing stays a human step.
- **Remote machines / dispatch:** not part of this tool. If you run it on another computer, copy
  the project folder there; the review page works over any local web server or SSH tunnel to
  `video-loop review`.
