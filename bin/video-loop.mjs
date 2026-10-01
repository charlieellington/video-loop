#!/usr/bin/env node
// video-loop.mjs — the command line. Plain English: reads the command and its options, runs it,
// and turns the outcome into a clear message and an exit code your agent can act on:
//   0 done · 1 something failed · 2 waiting for you or your agent · 3 needs (re)approval · 64 usage.
import { Pending, NeedsApproval } from "../engine/util.mjs";
import * as C from "../engine/commands.mjs";

const HELP = `video-loop — make and revise short narrated videos on your own computer.

Every command takes the project folder (the one with project.toml).

  video-loop init <folder> [--profile bene|charlie] [--narration <file>] [--title <text>]
  video-loop doctor [<folder>]              check this computer (and the project's chosen features)
  video-loop ingest <folder> [--bind-import] inventory media, prepare narration, transcribe
  video-loop voice clean <folder> [--retry]  ElevenLabs noise removal on the narration only
  video-loop voice select <folder> original|cleaned
  video-loop board <folder>                 build the storyboard for the current revision
  video-loop music generate <folder> [--regenerate] [--retry]   ElevenLabs music from the brief
  video-loop approve <folder>               record the user's approval of exactly this plan
  video-loop preview <folder>               render the preview (captions + real music mix)
  video-loop review <folder> [--open] [--port N]   local review page with feedback notes
  video-loop revise <folder> [--notes <feedback.json>]   start the next revision
  video-loop finish <folder>                render the master from the accepted preview's plan
  video-loop example [<folder>]             copy and render the fictional example offline

Options for any project command: --set section.key=value (one-off setting), --env-file <path>.
Exit codes: 0 done · 1 failed · 2 waiting for a person/agent step · 3 needs approval · 64 usage.`;

function parse(argv) {
  const o = { _: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") o.set.push(argv[++i]);
    else if (a.startsWith("--")) { const [k, v] = a.slice(2).split("="); const flagOnly = ["retry", "regenerate", "open", "bind-import", "force", "keep-temp"].includes(k); o[k] = v ?? (flagOnly ? true : argv[++i]); }
    else o._.push(a);
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);
const o = parse(rest); const opts = { ...o, overrides: o.set, bindImport: !!o["bind-import"], envFile: o["env-file"] };
const sub = ["voice", "music"].includes(cmd) ? o._.shift() : null;
const folder = o._.shift(); opts._ = o._;
const table = { init: () => C.cmdInit(folder, opts), doctor: () => C.cmdDoctor(folder), ingest: () => C.cmdIngest(folder, opts), board: () => C.cmdBoard(folder, opts),
  approve: () => C.cmdApprove(folder, opts), preview: () => C.cmdPreview(folder, opts), finish: () => C.cmdFinish(folder, opts), review: () => C.cmdReview(folder, opts),
  revise: () => C.cmdRevise(folder, opts), voice: () => C.cmdVoice(sub, folder, opts), music: () => C.cmdMusic(sub, folder, opts), example: () => C.cmdExample(folder, opts) };

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); process.exit(cmd ? 0 : 64); }
if (!table[cmd]) { console.error(`unknown command "${cmd}"\n\n${HELP}`); process.exit(64); }
try { await table[cmd](); process.exit(0); }
catch (e) {
  const label = e instanceof Pending ? "WAITING" : e instanceof NeedsApproval ? "NEEDS APPROVAL" : "FAILED";
  console.error(`\n${label}: ${e.message}`);
  if (e.next?.length) console.error(`NEXT:\n  - ${e.next.map((s) => s.replace(/<project>/g, folder ?? "<project>")).join("\n  - ")}`);
  if (!(e.exitCode)) console.error(e.stack);
  process.exit(e.exitCode ?? 1);
}
