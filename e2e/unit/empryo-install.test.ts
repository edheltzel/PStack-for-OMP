import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoDir } from "./py-ci.ts";
import { applyEmpryo, formatEmpryo, planEmpryo, runEmpryo, toEmpryoAgent } from "../../scripts/pstack.mjs";

const cli = fileURLToPath(new URL("../../scripts/pstack.mjs", import.meta.url));
const repo = repoDir();
const yes = () => true;
const no = () => false;

function write(root: string, rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pstack-empryo-home-"));
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pstack-empryo-root-"));
  for (const slug of ["ps-how", "ps-why", "ps-poteto-mode"]) {
    write(root, `skills/${slug}/SKILL.md`, `---\nname: ${slug}\ndescription: ${slug} skill.\n---\n\n# ${slug}\n`);
  }
  write(root, "skills/AGENTS.md", "# skills\n");
  for (const name of ["poteto-agent.md", "comment-sicko.md", "how-explorer.md"]) {
    cpSync(join(repo, "agents", name), join(root, "agents", name));
  }
  cpSync(join(repo, "empryo/poteto.md"), join(root, "empryo/poteto.md"));
  return root;
}

function frontmatter(text: string): { head: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error("no frontmatter");
  return { head: m[1] ?? "", body: text.slice(m[0].length) };
}

function field(head: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*(.*)$`, "m").exec(head)?.[1];
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (rel: string) => {
    const full = rel ? join(dir, rel) : dir;
    for (const name of readdirSync(full).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, child));
      if (st.isSymbolicLink()) out[child] = `-> ${readlinkSync(join(dir, child))}`;
      else if (st.isDirectory()) {
        out[`${child}/`] = "dir";
        walk(child);
      } else out[child] = readFileSync(join(dir, child), "utf8");
    }
  };
  walk("");
  return out;
}

function install(root: string, home: string, detect = yes) {
  return runEmpryo({ root, home, mode: "install", dryRun: false, detect });
}

function changed(result: { actions: { kind: string }[]; manifestChanged?: boolean }): number {
  const quiet = new Set(["keep", "reuse", "foreign"]);
  return result.actions.filter((a) => !quiet.has(a.kind)).length + (result.manifestChanged ? 1 : 0);
}

function psSkills(root: string): string[] {
  return readdirSync(join(root, "skills"))
    .filter((name) => name.startsWith("ps-") && existsSync(join(root, "skills", name, "SKILL.md")))
    .sort();
}

describe("toEmpryoAgent", () => {
  const agents = readdirSync(join(repo, "agents")).filter((name) => name.endsWith(".md")).sort();

  it("covers the 8 real agents", () => {
    expect(agents).toHaveLength(8);
  });

  for (const name of agents) {
    it(`translates agents/${name} to Empryo keys`, () => {
      const text = readFileSync(join(repo, "agents", name), "utf8");
      const out = toEmpryoAgent(text);
      const src = frontmatter(text);
      const dst = frontmatter(out);
      expect(dst.head).not.toMatch(/^model:\s*["']?@/m);
      expect(dst.head).not.toMatch(/^thinking-level:/m);
      expect(dst.head).not.toMatch(/^autoload-skills:/m);
      expect(field(dst.head, "name")).toBe(field(src.head, "name"));
      expect(field(dst.head, "description")).toBe(field(src.head, "description"));
      expect(dst.body).toBe(src.body);
      if (/^model:\s*["']?@smol/m.test(src.head)) expect(field(dst.head, "model")).toBe("fast");
      const level = field(src.head, "thinking-level");
      if (level) expect(field(dst.head, "effort")).toBe(level);
      if (/^autoload-skills:/m.test(src.head)) {
        expect(dst.head).toMatch(/^skills:\n {2}- ps-poteto-mode$/m);
      }
    });
  }

  it("maps @smol, thinking-level and both list styles", () => {
    const inline = toEmpryoAgent(
      '---\nname: a\ndescription: b\nmodel: "@smol"\nthinking-level: high\nautoload-skills: [poteto-mode, ps-how]\n---\n\nBody.\n',
    );
    expect(inline).toBe(
      "---\nname: a\ndescription: b\nmodel: fast\neffort: high\nskills:\n  - ps-poteto-mode\n  - ps-how\n---\n\nBody.\n",
    );
    const block = toEmpryoAgent('---\nname: a\nautoload-skills:\n  - poteto-mode\nmodel: "@default"\n---\nB\n');
    expect(block).toBe("---\nname: a\nskills:\n  - ps-poteto-mode\n---\nB\n");
  });
});

describe("pstack empryo", () => {
  it("install links every skills/ps-* and writes translated agents, poteto and the manifest", () => {
    const home = tempHome();
    const result = install(repo, home);
    const skills = psSkills(repo);
    expect(skills.length).toBeGreaterThan(0);
    for (const slug of skills) {
      const link = join(home, ".agents/skills", slug);
      expect(lstatSync(link).isSymbolicLink(), slug).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(repo, "skills", slug)));
    }
    const agents = readdirSync(join(repo, "agents")).filter((name) => name.endsWith(".md"));
    for (const name of agents) {
      const out = readFileSync(join(home, ".empryo/agents/pstack", name), "utf8");
      expect(out).toBe(toEmpryoAgent(readFileSync(join(repo, "agents", name), "utf8")));
    }
    expect(readFileSync(join(home, ".empryo/agents/pstack/poteto.md"), "utf8")).toBe(
      readFileSync(join(repo, "empryo/poteto.md"), "utf8"),
    );
    const manifest = JSON.parse(readFileSync(join(home, ".empryo/pstack.json"), "utf8"));
    expect(realpathSync(manifest.root)).toBe(realpathSync(repo));
    expect(manifest.links).toHaveLength(skills.length);
    expect(manifest.files).toHaveLength(agents.length + 1);
    expect(formatEmpryo(result)).toContain(`Linked (${skills.length})`);
  });

  it("second install reports no changes", () => {
    const root = fixtureRoot();
    const home = tempHome();
    install(root, home);
    const before = snapshot(home);
    const again = install(root, home);
    expect(changed(again)).toBe(0);
    expect(formatEmpryo(again)).toContain("no changes");
    expect(snapshot(home)).toEqual(before);
  });

  it("reuses an existing symlink into this checkout instead of duplicating it", () => {
    const root = fixtureRoot();
    const home = tempHome();
    mkdirSync(join(home, ".empryo/skills"), { recursive: true });
    mkdirSync(join(home, ".agents/skills"), { recursive: true });
    symlinkSync(join(root, "skills/ps-how"), join(home, ".empryo/skills/ps-how"));
    symlinkSync(join(root, "skills/ps-why"), join(home, ".agents/skills/ps-why"));
    const result = install(root, home);
    expect(existsSync(join(home, ".agents/skills/ps-how"))).toBe(false);
    expect(readlinkSync(join(home, ".agents/skills/ps-why"))).toBe(join(root, "skills/ps-why"));
    const reused = result.actions.filter((a: { kind: string }) => a.kind === "reuse").map((a: { path: string }) => a.path);
    expect(reused.sort()).toEqual([".agents/skills/ps-why", ".empryo/skills/ps-how"]);
    const manifest = JSON.parse(readFileSync(join(home, ".empryo/pstack.json"), "utf8"));
    expect(manifest.links).toEqual([".agents/skills/ps-poteto-mode"]);
    runEmpryo({ root, home, mode: "remove", dryRun: false });
    expect(lstatSync(join(home, ".empryo/skills/ps-how")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, ".agents/skills/ps-why")).isSymbolicLink()).toBe(true);
  });

  it("skips an unowned real dir or file at a target and leaves it untouched", () => {
    const root = fixtureRoot();
    const home = tempHome();
    write(home, ".agents/skills/ps-how/SKILL.md", "mine\n");
    write(home, ".empryo/agents/pstack/poteto.md", "my poteto\n");
    const result = install(root, home);
    expect(readFileSync(join(home, ".agents/skills/ps-how/SKILL.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(home, ".empryo/agents/pstack/poteto.md"), "utf8")).toBe("my poteto\n");
    const foreign = result.actions.filter((a: { kind: string }) => a.kind === "foreign").map((a: { path: string }) => a.path);
    expect(foreign.sort()).toEqual([".agents/skills/ps-how", ".empryo/agents/pstack/poteto.md"]);
    expect(formatEmpryo(result)).toContain("Not ours, left alone (2)");
    const manifest = JSON.parse(readFileSync(join(home, ".empryo/pstack.json"), "utf8"));
    expect(manifest.links).not.toContain(".agents/skills/ps-how");
    expect(manifest.files).not.toContain(".empryo/agents/pstack/poteto.md");
    const checked = runEmpryo({ root, home, mode: "check", dryRun: false });
    expect(checked.ok).toBe(false);
    expect(formatEmpryo(checked)).toContain("2 blocked by files pstack does not own");
  });

  it("check reports missing and drift", () => {
    const root = fixtureRoot();
    const home = tempHome();
    const fresh = runEmpryo({ root, home, mode: "check", dryRun: false });
    expect(fresh.ok).toBe(false);
    expect(snapshot(home)).toEqual({});
    install(root, home);
    expect(runEmpryo({ root, home, mode: "check", dryRun: false }).ok).toBe(true);
    write(home, ".empryo/agents/pstack/poteto-agent.md", "edited\n");
    write(root, "skills/ps-new/SKILL.md", "---\nname: ps-new\ndescription: New.\n---\n");
    const before = snapshot(home);
    const check = runEmpryo({ root, home, mode: "check", dryRun: false });
    expect(check.ok).toBe(false);
    const text = formatEmpryo(check);
    expect(text).toMatch(/Missing \(1\)\n {2}\.agents\/skills\/ps-new/);
    expect(text).toMatch(/Drift \(1\)\n {2}\.empryo\/agents\/pstack\/poteto-agent\.md/);
    expect(snapshot(home)).toEqual(before);
  });

  it("remove deletes only manifest entries and leaves user files", () => {
    const root = fixtureRoot();
    const home = tempHome();
    write(home, ".agents/skills/mine/SKILL.md", "mine\n");
    write(home, ".empryo/agents/pstack/custom.md", "custom\n");
    write(home, ".empryo/agents/other.md", "other\n");
    install(root, home);
    const result = runEmpryo({ root, home, mode: "remove", dryRun: false });
    expect(formatEmpryo(result)).toContain("Unlinked (3)");
    expect(snapshot(home)).toEqual({
      ".agents/": "dir",
      ".agents/skills/": "dir",
      ".agents/skills/mine/": "dir",
      ".agents/skills/mine/SKILL.md": "mine\n",
      ".empryo/": "dir",
      ".empryo/agents/": "dir",
      ".empryo/agents/other.md": "other\n",
      ".empryo/agents/pstack/": "dir",
      ".empryo/agents/pstack/custom.md": "custom\n",
    });
  });

  it("skips with one line when Empryo is not detected", () => {
    const root = fixtureRoot();
    const home = tempHome();
    const result = install(root, home, no);
    expect(result.detected).toBe(false);
    expect(result.actions).toEqual([]);
    expect(formatEmpryo(result).split("\n")).toHaveLength(1);
    expect(formatEmpryo(result)).toContain("not detected");
    expect(snapshot(home)).toEqual({});
  });

  it("detects Empryo from <home>/.empryo/config.json", () => {
    const root = fixtureRoot();
    const home = tempHome();
    write(home, ".empryo/config.json", "{}\n");
    const plan = planEmpryo({ root, home, mode: "install", detect: undefined });
    expect(plan.detected).toBe(true);
  });

  it("reconcile leaves an install from another checkout alone", () => {
    const root = fixtureRoot();
    const other = fixtureRoot();
    const home = tempHome();
    install(root, home);
    const before = snapshot(home);
    const plan = planEmpryo({ root: other, home, mode: "reconcile" });
    expect(plan.actions).toEqual([]);
    applyEmpryo(other, home, plan);
    expect(snapshot(home)).toEqual(before);
    expect(formatEmpryo({ ...plan, dryRun: false })).toContain("installed from");
  });

  it("dry-run install writes nothing", () => {
    const root = fixtureRoot();
    const home = tempHome();
    const result = runEmpryo({ root, home, mode: "install", dryRun: true, detect: yes });
    expect(formatEmpryo(result)).toContain("dry run, nothing written");
    expect(result.actions.some((a: { kind: string }) => a.kind === "link")).toBe(true);
    expect(snapshot(home)).toEqual({});
  });

  it("CLI install, check and remove run against HOME only", () => {
    const root = fixtureRoot();
    const home = tempHome();
    write(home, ".empryo/config.json", "{}\n");
    const env = { ...process.env, HOME: home, EMPRYO_HOME: join(home, ".empryo") };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, "empryo", ...args, "--root", root], { encoding: "utf8", env });
    expect(run("check").status).toBe(1);
    const dry = run("install", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(existsSync(join(home, ".empryo/pstack.json"))).toBe(false);
    const done = run("install");
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("Linked (3)");
    expect(run("check").status).toBe(0);
    expect(run("remove").status).toBe(0);
    expect(existsSync(join(home, ".empryo/pstack.json"))).toBe(false);
    expect(existsSync(join(home, ".agents/skills/ps-how"))).toBe(false);
    expect(run("bogus").status).toBe(2);
    rmSync(home, { recursive: true, force: true });
  });
});
