# empryo

## Purpose

Native Empryo support. Empryo has no extension API, so pstack installs into the folders Empryo already scans, the way SoulStack does.

## Ownership

- `poteto.md`: the `poteto` profile (an Empryo agent file). It is Empryo's only form of sticky poteto-mode and is per tab by design.
- Installer: `pstack empryo <install|check|remove>` in `scripts/pstack.mjs`.

## Local Contracts

- Skills: each `skills/ps-*` is symlinked into `~/.agents/skills/`. A symlink that already points at this checkout from `~/.empryo/skills` or `~/.agents/skills` counts as installed.
- Agents: `agents/*.md` are translated into `~/.empryo/agents/pstack/`. Translation:

  | omp | Empryo |
  | --- | --- |
  | `model: "@default"` / `"@slow"` | dropped (Empryo picks) |
  | `model: "@smol"` | `model: fast` |
  | `thinking-level: X` | `effort: X` |
  | `autoload-skills: [name]` | `skills: [ps-name]` |

- `poteto.md` is copied to `~/.empryo/agents/pstack/poteto.md`.
- Ownership lives in the manifest `~/.empryo/pstack.json`. Install, reconcile and remove touch only paths in it; anything else is reported as not ours and left alone.
- `npm run sync` reconciles the Empryo install after writing `skills/ps-*` when the manifest exists: links new skills, unlinks removed ones, refreshes agents. `--no-empryo` skips it.

## Probe results (Empryo headless, 2026-11-25)

- An agent file with omp keys (`model: "@default"`, `thinking-level`, `autoload-skills`) loads without error, but `autoload-skills` is ignored: ps-poteto-mode was not loaded. Hence the translation.
- A translated agent in a subfolder (`.empryo/agents/pstack/`) loads by name and its `skills: [ps-poteto-mode]` is loaded.

## Work Guidance

Keep skill files unchanged; `npm run sync` owns them. Empryo wording lives in `poteto.md` and the translation.

## Verification

```bash
npx vitest run e2e/unit/empryo-install.test.ts e2e/unit/sync-skills.test.ts
npm run empryo -- check
empryo --headless --agent poteto "name the skills loaded in your context"
```

## Child DOX Index

None.
