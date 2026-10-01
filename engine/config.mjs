// config.mjs — reads a project's settings and resolves them into one checked configuration.
// Plain English: settings are layered — built-in defaults, then the chosen style profile, then the
// project's own project.toml, then one-off overrides typed on the command line (--set a.b=value).
// The result is validated once, here. Relative paths are resolved against the project folder,
// never against wherever the terminal happens to be. Secrets never live in these files.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { SCHEMA, SCHEMA_VERSION, defaults, checkLayer, checkCombinations } from "./schema.mjs";
import { Failure, sha256, stableJson } from "./util.mjs";

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROFILES_DIR = join(TOOL_ROOT, "profiles");

const SECRETISH = /(api[_-]?key|secret|token|password)/i;

function readToml(path, what) {
  try { return parseToml(readFileSync(path, "utf8")); }
  catch (e) { throw new Failure(`${what} ${path} is not valid TOML: ${e.message.split("\n")[0]}`); }
}

function deepMerge(base, layer) {
  for (const [k, v] of Object.entries(layer ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) deepMerge(base[k], v);
    else base[k] = structuredClone(v);
  }
  return base;
}

function scanForSecrets(layer, where, path = []) {
  for (const [k, v] of Object.entries(layer ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) scanForSecrets(v, where, [...path, k]);
    else if (SECRETISH.test(k)) throw new Failure(`${where}: "${[...path, k].join(".")}" looks like a secret. Secrets belong in ELEVENLABS_API_KEY (environment or the project's .env), never in settings files.`);
  }
}

/** "a.b=value" -> {a:{b:value}}; the value is read as TOML so numbers/booleans/strings all work. */
export function parseOverride(expr) {
  const m = expr.match(/^([a-z_]+(?:\.[a-z_]+)+)=(.*)$/);
  if (!m) throw new Failure(`--set expects section.key=value (got "${expr}")`);
  let value;
  try { value = parseToml(`v = ${m[2]}`).v; } catch { value = m[2]; }
  const keys = m[1].split("."); const out = {}; let cur = out;
  keys.slice(0, -1).forEach((k) => { cur = cur[k] = {}; });
  cur[keys.at(-1)] = value;
  return out;
}

export function loadProfile(name) {
  if (!name) return {};
  if (!/^[a-z0-9-]+$/.test(name)) throw new Failure(`profile name "${name}" must be lower-case letters, digits or dashes`);
  const p = join(PROFILES_DIR, `${name}.toml`);
  if (!existsSync(p)) throw new Failure(`no such profile "${name}" (looked for ${p})`);
  const layer = readToml(p, "profile");
  delete layer.about;      // profiles carry a plain-English [about] note that is not a setting
  return layer;
}

/**
 * Resolve a project's effective configuration.
 * @param projectFile absolute path to project.toml
 * @param overrides array of "a.b=value" strings
 */
export function loadConfig(projectFile, overrides = []) {
  if (!existsSync(projectFile)) throw new Failure(`no project file at ${projectFile}`, ["video-loop init <folder>"]);
  const project = readToml(projectFile, "project file");
  const projectDir = dirname(projectFile);
  if (project.schema_version !== SCHEMA_VERSION)
    throw new Failure(`${projectFile}: schema_version must be ${SCHEMA_VERSION} (got ${JSON.stringify(project.schema_version)})`);
  const cli = overrides.map(parseOverride).reduce((a, l) => deepMerge(a, l), {});
  const profileName = cli.project?.profile ?? project.project?.profile ?? "";
  const profile = loadProfile(profileName);
  const problems = [
    ...checkLayer(profile, `profile ${profileName}`),
    ...checkLayer(project, "project.toml"),
    ...checkLayer(cli, "--set"),
  ];
  if (problems.length) throw new Failure(`settings problems:\n  - ${problems.join("\n  - ")}`);
  scanForSecrets(project, "project.toml"); scanForSecrets(profile, `profile ${profileName}`);
  const cfg = deepMerge(deepMerge(deepMerge(defaults(), profile), project), cli);
  const combo = checkCombinations(cfg);
  if (combo.length) throw new Failure(`settings do not fit together:\n  - ${combo.join("\n  - ")}`);
  return { cfg, projectDir, projectFile, profileName, paths: resolvePaths(cfg, projectDir) };
}

/** Every path setting, made absolute against the project folder. */
export function resolvePaths(cfg, projectDir) {
  const abs = (p) => (!p ? "" : isAbsolute(p) ? p : resolve(projectDir, p));
  return {
    project: projectDir,
    media: abs(cfg.project.media_dir),
    output: abs(cfg.project.output_dir),
    state: join(projectDir, ".video-loop"),
    narration: cfg.narration.source ? abs(cfg.narration.source) : "",
    takes: cfg.narration.takes.map(abs),
    transcript: abs(cfg.transcription.transcript),
    musicFile: abs(cfg.music.file),
    abs,
  };
}

/** The non-secret effective configuration, and its fingerprint (saved with each revision). */
export function configFingerprint(cfg, { omit = ["review"] } = {}) {
  const c = structuredClone(cfg); omit.forEach((k) => delete c[k]);
  return sha256(stableJson(c)).slice(0, 16);
}

export const schemaKeys = () => Object.keys(SCHEMA);
