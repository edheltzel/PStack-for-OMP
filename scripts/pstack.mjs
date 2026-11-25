#!/usr/bin/env node
/**
 * Maintainer CLI: vendor official skills (`sync`) and bump package versions (`bump`).
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_REPO = "https://github.com/cursor/plugins.git";
export const UPSTREAM_SKILLS = "pstack/skills";
export const UPSTREAM_PLUGIN_JSON = "pstack/.cursor-plugin/plugin.json";
/** Paths this fork removed on purpose. Relative to upstream skills/. */
export const LOCAL_SUBTRACTIONS = Object.freeze(["poteto-mode/playbooks/shipping.md"]);

const TEXT = /\.(md|txt|json|yml|yaml|ts|js|mjs|cjs|sh)$/i;
const HELP = `Usage: pstack <command> [options]

Commands:
  sync    Pull official skills from cursor/plugins into skills/ps-*
  bump    Bump package.json + Claude plugin version (omp/pi share package.json)
  empryo  Install pstack into Empryo: skill links, translated agents, poteto profile

pstack sync [--dry-run] [--force] [--no-empryo] [--from DIR] [--repo URL] [--ref REF] [--root DIR]

pstack bump <patch|minor|major> [--dry-run] [--root DIR]
pstack bump --tag [--release] [--dry-run] [--root DIR]

pstack empryo <install|check|remove> [--dry-run] [--root DIR]

SoT is github.com/cursor/plugins (pstack/skills), not backnotprop/pstack or skills.sh.
Writes into the existing skills/ps-* tree. Touches Empryo links only when ~/.empryo/pstack.json exists (--no-empryo skips).
empryo links skills/ps-* into ~/.agents/skills, writes agents + poteto into ~/.empryo/agents/pstack, and owns only paths in ~/.empryo/pstack.json. check exits 1 on missing or drift.
bump writes package.json and .claude-plugin/plugin.json. omp and pi use package.json.
Commit those files, then --tag on that HEAD (git tag vX.Y.Z <sha>). --release pushes the tag and gh release create --target <sha>.
`;

export const VERSION_FILES = Object.freeze(["package.json", ".claude-plugin/plugin.json"]);
export const BUMP_KINDS = Object.freeze(["patch", "minor", "major"]);

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "";
  const opts = {
    command,
    dryRun: false,
    force: false,
    from: null,
    repo: UPSTREAM_REPO,
    ref: null,
    root: null,
    help: false,
    kind: null,
    tag: false,
    release: false,
    noEmpryo: false,
    action: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--from") opts.from = args[++i];
    else if (a === "--repo") opts.repo = args[++i];
    else if (a === "--ref") opts.ref = args[++i];
    else if (a === "--root") opts.root = args[++i];
    else if (a === "--tag") opts.tag = true;
    else if (a === "--release") opts.release = true;
    else if (a === "--no-empryo") opts.noEmpryo = true;
    else if (command === "empryo" && EMPRYO_MODES.includes(a) && opts.action == null) opts.action = a;
    else if (command === "bump" && BUMP_KINDS.includes(a) && opts.kind == null) opts.kind = a;
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rewriteLayout(text, slugs, ownSlug) {
  let out = text;
  if (ownSlug && !ownSlug.startsWith("ps-")) {
    out = out.replace(new RegExp(`^(name:\\s*)${escapeRegExp(ownSlug)}\\s*$`, "m"), `$1ps-${ownSlug}`);
  }
  const sorted = [...slugs].filter((s) => s && !s.startsWith("ps-")).sort((a, b) => b.length - a.length);
  for (const slug of sorted) {
    const dest = `ps-${slug}`;
    const reSlug = escapeRegExp(slug);
    out = out.replace(new RegExp(`(?<![\\w-])skills/${reSlug}/`, "g"), `skills/${dest}/`);
    out = out.replace(new RegExp(`\\.\\./${reSlug}/`, "g"), `../${dest}/`);
  }
  return out;
}

function isTextPath(rel) {
  return TEXT.test(rel);
}

function listSkillSlugs(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
    .sort();
}

function walkFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir).sort().reverse()) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else out.push(relative(root, full).split("\\").join("/"));
    }
  }
  return out.sort();
}

export function resolveUpstreamSkillsDir(fromDir) {
  const abs = resolve(fromDir);
  const nested = join(abs, UPSTREAM_SKILLS);
  if (existsSync(join(nested, "how", "SKILL.md")) || existsSync(nested)) {
    const slugs = listSkillSlugs(nested);
    if (slugs.length) return nested;
  }
  const slugs = listSkillSlugs(abs);
  if (slugs.length) return abs;
  throw new Error(`no upstream skills at ${fromDir} (expected ${UPSTREAM_SKILLS} or a skills dir)`);
}

function readJsonVersion(path) {
  if (!existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

function findPluginVersion(start) {
  const abs = resolve(start);
  return (
    readJsonVersion(join(abs, UPSTREAM_PLUGIN_JSON)) ||
    readJsonVersion(join(abs, ".cursor-plugin/plugin.json")) ||
    readJsonVersion(join(abs, "..", ".cursor-plugin/plugin.json"))
  );
}

function gitRev(dir) {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return (result.stdout || "").trim() || null;
}

export function fetchUpstream(opts) {
  const dest = opts.dest;
  const args = ["clone", "--depth", "1", "--filter=blob:none", "--sparse"];
  if (opts.ref) args.push("--branch", opts.ref);
  args.push(opts.repo, dest);
  const clone = spawnSync("git", args, { encoding: "utf8" });
  if (clone.status !== 0) {
    throw new Error(`git clone failed (${clone.status}): ${(clone.stderr || clone.stdout || "").trim()}`);
  }
  const sparse = spawnSync(
    "git",
    ["-C", dest, "sparse-checkout", "set", UPSTREAM_SKILLS, "pstack/.cursor-plugin"],
    { encoding: "utf8" },
  );
  if (sparse.status !== 0) {
    throw new Error(`git sparse-checkout failed (${sparse.status}): ${(sparse.stderr || sparse.stdout || "").trim()}`);
  }
  return {
    skillsDir: resolveUpstreamSkillsDir(dest),
    sha: gitRev(dest),
    version: findPluginVersion(dest),
    repo: opts.repo,
  };
}

function transformedBytes(relInSkill, raw, slugs, slug) {
  if (!isTextPath(relInSkill)) return raw;
  let text;
  try {
    text = raw.toString("utf8");
  } catch {
    return raw;
  }
  return Buffer.from(rewriteLayout(text, slugs, slug), "utf8");
}

export function planSync(args) {
  const upstreamSkills = args.upstreamSkills;
  const destSkills = args.destSkills;
  const force = Boolean(args.force);
  const slugs = listSkillSlugs(upstreamSkills);
  if (!slugs.length) throw new Error(`no SKILL.md trees under ${upstreamSkills}`);
  const subtraction = new Set(LOCAL_SUBTRACTIONS);
  /** @type {{kind: string, destRel: string, src: string, bytes?: Buffer}[]} */
  const actions = [];
  let unchanged = 0;
  let diverged = 0;
  let skipped = 0;

  for (const slug of slugs) {
    const srcRoot = join(upstreamSkills, slug);
    const destRoot = join(destSkills, `ps-${slug}`);
    for (const rel of walkFiles(srcRoot)) {
      const upRel = `${slug}/${rel}`;
      const destRel = `skills/ps-${slug}/${rel}`;
      if (subtraction.has(upRel)) {
        actions.push({ kind: "skip", destRel, src: upRel });
        skipped += 1;
        continue;
      }
      const srcPath = join(srcRoot, rel);
      const raw = readFileSync(srcPath);
      const bytes = transformedBytes(rel, raw, slugs, slug);
      const destPath = join(destRoot, rel);
      if (!existsSync(destPath)) {
        actions.push({ kind: "add", destRel, src: upRel, bytes });
        continue;
      }
      const current = readFileSync(destPath);
      if (current.equals(bytes)) {
        unchanged += 1;
        continue;
      }
      if (force) {
        actions.push({ kind: "update", destRel, src: upRel, bytes });
        continue;
      }
      actions.push({ kind: "diverged", destRel, src: upRel });
      diverged += 1;
    }
  }

  return { slugs, actions, unchanged, diverged, skipped };
}

export function applyPlan(root, plan) {
  const written = [];
  for (const action of plan.actions) {
    if (action.kind !== "add" && action.kind !== "update") continue;
    const path = join(root, action.destRel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, action.bytes);
    written.push(action.destRel);
  }
  return written;
}

export function formatReport(info) {
  const of = (kind) => info.plan.actions.filter((a) => a.kind === kind);
  const added = of("add");
  const updated = of("update");
  const skipped = of("skip");
  const diverged = of("diverged");
  const perSkill = new Map();
  for (const a of diverged) {
    const skill = a.destRel.split("/")[1];
    perSkill.set(skill, (perSkill.get(skill) || 0) + 1);
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = [
    `pstack sync${info.dryRun ? " (dry run, nothing written)" : ""}`,
    `  from  ${info.repo}${info.sha ? ` @ ${info.sha}` : ""}${info.version ? ` (v${info.version})` : ""}`,
    `  path  cursor/plugins pstack/skills → skills/ps-*`,
  ];
  const section = (title, items) => {
    if (!items.length) return;
    lines.push("", title);
    for (const item of items) lines.push(`  ${item}`);
  };
  section(`Added (${added.length})`, added.map((a) => a.destRel));
  section(`Updated (${updated.length})`, updated.map((a) => a.destRel));
  section(
    `Kept local edits in ${plural(perSkill.size, "skill")} (${plural(diverged.length, "file")}); --force takes upstream`,
    [...perSkill].sort(([a], [b]) => a.localeCompare(b)).map(([skill, n]) => `${skill} (${plural(n, "file")})`),
  );
  section(`Skipped (${skipped.length}), deleted on purpose by this fork`, skipped.map((a) => a.destRel));
  lines.push(
    "",
    `${plural(info.plan.slugs.length, "skill")}: ${added.length} added, ${updated.length} updated, ${diverged.length} kept local, ${skipped.length} skipped, ${info.plan.unchanged} unchanged`,
  );
  if (info.empryo) lines.push("", formatEmpryo(info.empryo));
  return lines.join("\n");
}

export function runSync(opts) {
  const root = resolve(opts.root);
  const destSkills = join(root, "skills");
  const home = resolve(opts.home ?? defaultHome());
  let tmp = null;
  let fetched = {
    skillsDir: "",
    sha: null,
    version: null,
    repo: opts.from ? opts.from : opts.repo,
  };
  try {
    if (opts.from) {
      fetched.skillsDir = resolveUpstreamSkillsDir(opts.from);
      fetched.sha = gitRev(opts.from) || gitRev(fetched.skillsDir);
      fetched.version = findPluginVersion(opts.from) || findPluginVersion(fetched.skillsDir);
    } else {
      tmp = mkdtempSync(join(tmpdir(), "pstack-sync-"));
      fetched = fetchUpstream({ repo: opts.repo, ref: opts.ref, dest: tmp });
    }
    const plan = planSync({
      upstreamSkills: fetched.skillsDir,
      destSkills,
      force: opts.force,
    });
    if (!opts.dryRun) applyPlan(root, plan);
    const info = {
      repo: fetched.repo,
      sha: fetched.sha,
      version: fetched.version,
      dryRun: Boolean(opts.dryRun),
      plan,
    };
    if (!opts.noEmpryo && existsSync(join(home, EMPRYO_MANIFEST))) {
      const extraSkills = [
        ...new Set(plan.actions.filter((a) => a.kind === "add").map((a) => a.destRel.split("/")[1])),
      ];
      info.empryo = runEmpryo({ root, home, mode: "reconcile", dryRun: opts.dryRun, extraSkills });
    }
    return info;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

export const EMPRYO_MANIFEST = ".empryo/pstack.json";
export const EMPRYO_AGENTS = ".empryo/agents/pstack";
export const EMPRYO_SKILLS = ".agents/skills";
export const EMPRYO_ALT_SKILLS = ".empryo/skills";
export const EMPRYO_MODES = Object.freeze(["install", "check", "remove"]);
const EMPRYO_PLAN_MODES = Object.freeze([...EMPRYO_MODES, "reconcile"]);
const EMPRYO_CHANGES = new Set(["link", "relink", "write", "update", "unlink", "delete", "forget"]);

function defaultHome() {
  return process.env.HOME || homedir();
}

function unquote(value) {
  return value.trim().replace(/^["']|["']$/g, "");
}

export function toEmpryoAgent(text) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return text;
  const lines = m[1].split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) {
      out.push(lines[i]);
      continue;
    }
    const key = kv[1];
    const value = unquote(kv[2]);
    if (key === "model") {
      if (value === "@smol") out.push("model: fast");
      else if (!value.startsWith("@")) out.push(lines[i]);
    } else if (key === "thinking-level") {
      out.push(`effort: ${value}`);
    } else if (key === "autoload-skills") {
      const names = value.startsWith("[")
        ? value.slice(1, -1).split(",").map(unquote).filter(Boolean)
        : value
          ? [value]
          : [];
      while (i + 1 < lines.length && /^\s+-\s*\S/.test(lines[i + 1])) {
        i += 1;
        names.push(unquote(lines[i].replace(/^\s+-\s*/, "")));
      }
      out.push("skills:", ...names.map((name) => `  - ${name.startsWith("ps-") ? name : `ps-${name}`}`));
    } else {
      out.push(lines[i]);
    }
  }
  return `---\n${out.join("\n")}\n---\n${text.slice(m[0].length)}`;
}

export function detectEmpryo(home, env = process.env) {
  const onPath = (env.PATH || "").split(delimiter).some((dir) => dir && existsSync(join(dir, "empryo")));
  return onPath || existsSync("/Applications/Empryo.app") || existsSync(join(home, ".empryo", "config.json"));
}

function lexists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isLink(path) {
  return lexists(path) && lstatSync(path).isSymbolicLink();
}

function isFile(path) {
  return lexists(path) && lstatSync(path).isFile();
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pointsAt(path, target) {
  if (!lexists(path)) return false;
  try {
    return realpathSync(path) === realOrSelf(target);
  } catch {
    return false;
  }
}

function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function readManifest(home) {
  const path = join(home, EMPRYO_MANIFEST);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON: ${path}`);
  }
  return {
    text,
    root: typeof json.root === "string" ? json.root : null,
    links: Array.isArray(json.links) ? json.links : [],
    files: Array.isArray(json.files) ? json.files : [],
  };
}

function empryoFiles(root) {
  const out = new Map();
  const agentsDir = join(root, "agents");
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir).filter((n) => n.endsWith(".md")).sort()) {
      out.set(`${EMPRYO_AGENTS}/${name}`, toEmpryoAgent(readFileSync(join(agentsDir, name), "utf8")));
    }
  }
  const poteto = join(root, "empryo", "poteto.md");
  if (existsSync(poteto)) out.set(`${EMPRYO_AGENTS}/poteto.md`, readFileSync(poteto, "utf8"));
  return out;
}

function releaseOwned(home, owned, wantLinks, wantFiles, actions) {
  for (const rel of [...owned.links].sort()) {
    if (wantLinks.has(rel)) continue;
    const abs = join(home, rel);
    if (isLink(abs)) actions.push({ kind: "unlink", path: rel });
    else if (!lexists(abs)) actions.push({ kind: "forget", path: rel });
    else actions.push({ kind: "foreign", path: rel });
  }
  for (const rel of [...owned.files].sort()) {
    if (wantFiles.has(rel)) continue;
    const abs = join(home, rel);
    if (isFile(abs)) actions.push({ kind: "delete", path: rel });
    else if (!lexists(abs)) actions.push({ kind: "forget", path: rel });
    else actions.push({ kind: "foreign", path: rel });
  }
}

export function planEmpryo(args) {
  const root = resolve(args.root);
  const home = resolve(args.home ?? defaultHome());
  const mode = args.mode;
  if (!EMPRYO_PLAN_MODES.includes(mode)) throw new Error(`empryo mode must be one of: ${EMPRYO_MODES.join(", ")}`);
  const detect = args.detect ?? detectEmpryo;
  const plan = { mode, root, home, detected: true, skipped: null, actions: [], manifest: null, manifestChanged: false, ok: true };
  if (mode === "install" && !detect(home)) {
    return {
      ...plan,
      detected: false,
      skipped: "Empryo not detected (no empryo on PATH, /Applications/Empryo.app or ~/.empryo/config.json); skipped",
    };
  }
  const current = readManifest(home);
  if (mode === "reconcile") {
    if (!current) return { ...plan, skipped: `no ~/${EMPRYO_MANIFEST}; skipped` };
    if (current.root && realOrSelf(current.root) !== realOrSelf(root)) {
      return { ...plan, skipped: `installed from ${current.root}; skipped` };
    }
  }
  const owned = { links: new Set(current?.links ?? []), files: new Set(current?.files ?? []) };
  const actions = plan.actions;
  if (mode === "remove") {
    releaseOwned(home, owned, new Set(), new Set(), actions);
    return { ...plan, manifestChanged: Boolean(current), ok: !actions.some((a) => EMPRYO_CHANGES.has(a.kind)) };
  }

  const keepLinks = [];
  const keepFiles = [];
  const slugs = [
    ...new Set([
      ...listSkillSlugs(join(root, "skills")).filter((name) => name.startsWith("ps-")),
      ...(args.extraSkills ?? []),
    ]),
  ].sort();
  const wantLinks = new Set();
  for (const slug of slugs) {
    const rel = `${EMPRYO_SKILLS}/${slug}`;
    const alt = `${EMPRYO_ALT_SKILLS}/${slug}`;
    const abs = join(home, rel);
    const target = join(root, "skills", slug);
    const mine = owned.links.has(rel);
    wantLinks.add(rel);
    if (pointsAt(abs, target)) {
      actions.push({ kind: mine ? "keep" : "reuse", path: rel, target });
      if (mine) keepLinks.push(rel);
    } else if (!lexists(abs) && pointsAt(join(home, alt), target)) {
      actions.push({ kind: "reuse", path: alt, target });
    } else if (!lexists(abs)) {
      actions.push({ kind: "link", path: rel, target });
      keepLinks.push(rel);
    } else if (mine && isLink(abs)) {
      actions.push({ kind: "relink", path: rel, target });
      keepLinks.push(rel);
    } else {
      actions.push({ kind: "foreign", path: rel });
    }
  }

  const want = empryoFiles(root);
  for (const [rel, content] of want) {
    const abs = join(home, rel);
    const mine = owned.files.has(rel);
    if (!lexists(abs)) {
      actions.push({ kind: "write", path: rel, content });
      keepFiles.push(rel);
    } else if (!mine || !isFile(abs)) {
      actions.push({ kind: "foreign", path: rel });
    } else if (readFileSync(abs, "utf8") === content) {
      actions.push({ kind: "keep", path: rel });
      keepFiles.push(rel);
    } else {
      actions.push({ kind: "update", path: rel, content });
      keepFiles.push(rel);
    }
  }
  releaseOwned(home, owned, wantLinks, new Set(want.keys()), actions);

  const manifest = { version: 1, root, links: keepLinks.sort(), files: keepFiles.sort() };
  const manifestChanged = mode !== "check" && current?.text !== manifestText(manifest);
  const blocked = mode === "check" && actions.some((a) => a.kind === "foreign");
  return { ...plan, manifest, manifestChanged, ok: !blocked && !actions.some((a) => EMPRYO_CHANGES.has(a.kind)) };
}

export function applyEmpryo(root, home, plan) {
  const done = [];
  if (plan.skipped || plan.mode === "check") return done;
  const base = resolve(home);
  for (const action of plan.actions) {
    const abs = join(base, action.path);
    if (action.kind === "link" || action.kind === "relink") {
      if (action.kind === "relink") unlinkSync(abs);
      mkdirSync(dirname(abs), { recursive: true });
      symlinkSync(action.target, abs);
    } else if (action.kind === "write" || action.kind === "update") {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, action.content);
    } else if (action.kind === "unlink" || action.kind === "delete") {
      unlinkSync(abs);
    } else {
      continue;
    }
    done.push(action.path);
  }
  const manifestPath = join(base, EMPRYO_MANIFEST);
  if (plan.mode === "remove") {
    if (existsSync(manifestPath)) {
      unlinkSync(manifestPath);
      done.push(EMPRYO_MANIFEST);
    }
    const agentsDir = join(base, EMPRYO_AGENTS);
    if (existsSync(agentsDir) && readdirSync(agentsDir).length === 0) rmdirSync(agentsDir);
  } else if (plan.manifestChanged) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, manifestText(plan.manifest));
    done.push(EMPRYO_MANIFEST);
  }
  return done;
}

export function runEmpryo(opts) {
  const plan = planEmpryo({
    root: opts.root,
    home: opts.home,
    mode: opts.mode,
    detect: opts.detect,
    extraSkills: opts.extraSkills,
  });
  if (!opts.dryRun) applyEmpryo(plan.root, plan.home, plan);
  return { ...plan, dryRun: Boolean(opts.dryRun) };
}

export function formatEmpryo(result) {
  if (result.skipped) return `Empryo ${result.mode}: ${result.skipped}`;
  const of = (...kinds) => result.actions.filter((a) => kinds.includes(a.kind)).map((a) => a.path);
  const lines = [
    `Empryo ${result.mode}${result.dryRun ? " (dry run, nothing written)" : ""}`,
    `  home  ${result.home}`,
    `  root  ${result.root}`,
  ];
  const section = (title, items) => {
    if (!items.length) return;
    lines.push("", `${title.replace("{n}", String(items.length))}`);
    for (const item of items) lines.push(`  ${item}`);
  };
  const check = result.mode === "check";
  if (check) {
    section("Missing ({n})", of("link", "write"));
    section("Drift ({n})", of("relink", "update"));
    section("Stale ({n}), owned but no longer shipped", of("unlink", "delete", "forget"));
  } else {
    section("Linked ({n})", of("link"));
    section("Relinked ({n})", of("relink"));
    section("Wrote ({n})", of("write"));
    section("Updated ({n})", of("update"));
    section("Unlinked ({n})", of("unlink"));
    section("Deleted ({n})", of("delete"));
    section("Forgot ({n}), already gone", of("forget"));
  }
  section("Reused ({n}), already linked to this checkout", of("reuse"));
  section("Not ours, left alone ({n})", of("foreign"));
  const changes = result.actions.filter((a) => EMPRYO_CHANGES.has(a.kind)).length;
  const kept = of("keep").length;
  if (check) {
    lines.push("", result.ok ? `ok: ${kept} installed and current` : `${changes} missing or drifted, ${of("foreign").length} blocked by files pstack does not own; run pstack empryo install`);
  } else if (!changes && !result.manifestChanged) {
    lines.push("", `no changes (${kept} unchanged)`);
  } else {
    lines.push("", `${changes} changed, ${kept} unchanged${result.manifestChanged ? `, ~/${EMPRYO_MANIFEST} ${result.mode === "remove" ? "removed" : "written"}` : ""}`);
  }
  return lines.join("\n");
}

export function bumpSemver(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a patch.minor.major version: ${version}`);
  if (!BUMP_KINDS.includes(kind)) throw new Error(`kind must be patch, minor, or major`);
  let major = Number(m[1]);
  let minor = Number(m[2]);
  let patch = Number(m[3]);
  if (kind === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}


function gitOut(spawn, root, args) {
  const result = spawn("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return (result.stdout || "").trim();
}

function committedVersion(spawn, root, rel) {
  const raw = gitOut(spawn, root, ["show", `HEAD:${rel}`]);
  const json = JSON.parse(raw);
  if (typeof json.version !== "string") throw new Error(`no version in HEAD:${rel}`);
  return json.version;
}

function requireCommittedVersions(spawn, root) {
  const diff = spawn("git", ["-C", root, "diff", "--quiet", "HEAD", "--", ...VERSION_FILES], {
    encoding: "utf8",
  });
  if (diff.status !== 0) {
    throw new Error("version files are not committed; commit then pstack bump --tag");
  }
  const pkg = committedVersion(spawn, root, "package.json");
  const plugin = committedVersion(spawn, root, ".claude-plugin/plugin.json");
  if (pkg !== plugin) throw new Error(`HEAD versions differ: package.json ${pkg} vs plugin.json ${plugin}`);
  return pkg;
}
function peeledTag(spawn, root, tag) {
  const result = spawn("git", ["-C", root, "rev-parse", `${tag}^{commit}`], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return (result.stdout || "").trim();
}

function ensureTag(spawn, root, tag, sha) {
  const existing = peeledTag(spawn, root, tag);
  if (existing) {
    if (existing !== sha) throw new Error(`tag ${tag} points at ${existing}, not ${sha}`);
    return;
  }
  gitOut(spawn, root, ["tag", "-a", tag, sha, "-m", tag]);
  const tagged = gitOut(spawn, root, ["rev-parse", `${tag}^{commit}`]);
  if (tagged !== sha) throw new Error(`tag ${tag} points at ${tagged}, not ${sha}`);
}

export function runBump(opts, spawn = spawnSync) {
  const root = opts.root;
  if (opts.kind && (opts.tag || opts.release)) {
    throw new Error("bump <kind> only writes files; commit, then pstack bump --tag");
  }
  if (opts.kind) {
    if (!BUMP_KINDS.includes(opts.kind)) throw new Error("usage: pstack bump <patch|minor|major>");
    const docs = [];
    for (const rel of VERSION_FILES) {
      const path = join(root, rel);
      if (!existsSync(path)) throw new Error(`missing ${rel}`);
      let json;
      try {
        json = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        throw new Error(`invalid JSON: ${rel}`);
      }
      if (typeof json.version !== "string") throw new Error(`no version in ${rel}`);
      docs.push({ rel, path, json });
    }
    const from = docs[0].json.version;
    for (const doc of docs) {
      if (doc.json.version !== from) {
        throw new Error(`versions differ: ${docs[0].rel} ${from} vs ${doc.rel} ${doc.json.version}`);
      }
    }
    const to = bumpSemver(from, opts.kind);
    if (!opts.dryRun) {
      for (const doc of docs) {
        doc.json.version = to;
        writeFileSync(doc.path, `${JSON.stringify(doc.json, null, 2)}\n`);
      }
    }
    return {
      from,
      to,
      files: docs.map((d) => d.rel),
      tag: `v${to}`,
      dryRun: Boolean(opts.dryRun),
      ran: [],
      sha: null,
    };
  }
  if (!opts.tag && !opts.release) {
    throw new Error("usage: pstack bump <patch|minor|major> | pstack bump --tag [--release]");
  }
  const version = requireCommittedVersions(spawn, root);
  const sha = gitOut(spawn, root, ["rev-parse", "HEAD"]);
  const tag = `v${version}`;
  const ran = [];
  if (opts.tag || opts.release) {
    if (!opts.dryRun) ensureTag(spawn, root, tag, sha);
    ran.push(`git tag ${tag} ${sha}`);
  }
  if (opts.release) {
    if (!opts.dryRun) {
      gitOut(spawn, root, ["push", "origin", `refs/tags/${tag}`]);
      const rel = spawn(
        "gh",
        ["release", "create", tag, "--title", tag, "--notes", `pstack ${version}`, "--target", sha],
        { encoding: "utf8", cwd: root },
      );
      if (rel.status !== 0) {
        throw new Error((rel.stderr || rel.stdout || `gh release create ${tag} failed`).trim());
      }
    }
    ran.push(`git push origin refs/tags/${tag}`);
    ran.push(`gh release create ${tag} --target ${sha}`);
  }
  return { from: version, to: version, files: [...VERSION_FILES], tag, dryRun: Boolean(opts.dryRun), ran, sha };
}

export function formatBump(info) {
  const lines = [`${info.from} -> ${info.to}`, `files: ${info.files.join(", ")}`];
  if (info.dryRun) lines.push("dry-run");
  for (const step of info.ran) lines.push(step);
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2), io = process) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : err}\n${HELP}`);
    return 2;
  }
  if (opts.help || !opts.command) {
    io.stdout.write(HELP);
    return opts.help ? 0 : 2;
  }
  if (opts.command !== "sync" && opts.command !== "bump" && opts.command !== "empryo") {
    io.stderr.write(`unknown command: ${opts.command}\n${HELP}`);
    return 2;
  }
  if (opts.command === "empryo" && !opts.action) {
    io.stderr.write(`empryo needs one of: ${EMPRYO_MODES.join(", ")}\n${HELP}`);
    return 2;
  }
  try {
    const root = opts.root ? resolve(opts.root) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
    if (opts.command === "bump") {
      const report = runBump({ ...opts, root });
      io.stdout.write(`${formatBump(report)}\n`);
      return 0;
    }
    if (opts.command === "empryo") {
      const result = runEmpryo({ root, home: defaultHome(), mode: opts.action, dryRun: opts.dryRun });
      io.stdout.write(`${formatEmpryo(result)}\n`);
      return result.mode === "check" && !result.ok ? 1 : 0;
    }
    const report = runSync({ ...opts, root });
    io.stdout.write(`${formatReport(report)}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  process.exit(main());
}
