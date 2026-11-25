# scripts

## Purpose

Maintainer CLI for this package. `pstack.mjs` is `pstack sync` (vendor official skills), `pstack bump` (semver) and `pstack empryo` (native Empryo install).

## Ownership

- `pstack.mjs` - `pstack sync` (`--dry-run`, `--force`, `--no-empryo`), `pstack bump <patch|minor|major>` (`--dry-run`, `--tag`, `--release`) and `pstack empryo <install|check|remove> [--dry-run]`.

## Local Contracts

- Source of truth is `https://github.com/cursor/plugins.git` folder `pstack/skills`. Not `backnotprop/pstack`. Not skills.sh. `npx skills add` is not the path (it would install a second skill tree).
- Layout map: upstream `skills/<name>/` → package `skills/ps-<name>/`. YAML `name` gets the `ps-` prefix. Sibling links `../<name>/` become `../ps-<name>/`.
- One skill tree: sibling `skills/` at the package root. Do not write `.omp/skills`, `.claude-plugin/skills`, or agent skill dirs.
- Sync writes only into `skills/ps-*`, then reconciles Empryo links only when the Empryo manifest `~/.empryo/pstack.json` exists and was installed from this checkout (another root is reported and skipped). `--no-empryo` skips it. Empryo install rules live in [empryo/AGENTS.md](../empryo/AGENTS.md).
- Do not restore `poteto-mode/playbooks/shipping.md` (this fork deleted it).
- Default apply adds missing official files and leaves diverged local forks (omp adaptations) in place. `--force` overwrites diverged files except local subtractions.
- `bump <kind>` writes `package.json` version (omp + pi) and `.claude-plugin/plugin.json` only. Marketplace catalog has no version field. After commit, `bump --tag` tags that HEAD sha; `bump --release` pushes the tag and `gh release create --target <sha>`. Kind and --tag together are refused.

## Work Guidance

Keep sync a fetch + layout rewrite. Keep bump a JSON version rewrite. Do not fold either into `extensions/pstack.ts`.

## Verification

```bash
node scripts/pstack.mjs sync --dry-run
node scripts/pstack.mjs bump patch --dry-run
node scripts/pstack.mjs empryo check --dry-run
npx vitest run e2e/unit/sync-skills.test.ts
npx vitest run e2e/unit/empryo-install.test.ts
```

## Child DOX Index

None.
